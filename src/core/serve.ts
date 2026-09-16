import * as http from "http";
import * as path from "path";
import type { FlowDefinition, ServeConfig } from "./types.js";
import type { FlowRunner } from "./runner.js";
import { validateFlow } from "./validate.js";
import type { CreateTriggerInput, TriggerRecord, TriggerStore } from "./triggers.js";
import { assertValidSchedule, type TriggerScheduler } from "./scheduler.js";
import { resolveRunnableFlow } from "./manage.js";

// ---- Flow Server ----------------------------------------------------------------
// Lightweight HTTP server that runs flows on POST. Trigger semantics (webhooks,
// cron, manual UI) live in the calling platform, not the flow format — this
// server is a generic invocation endpoint.
//
// Endpoints:
//   POST /:basePath/:flowName/run  — run a flow with the JSON body as inputs
//   POST /:basePath/validate       — statically validate a flow definition
//   GET  /:basePath/health         — health check

export interface FlowServerOpts {
  runner: FlowRunner;
  serve: ServeConfig;
  /**
   * Workspace root — where published versions live (.clawflow/versions).
   * Defaults to $OPENCLAW_WORKSPACE, then cwd, matching resolveFlowsDir.
   */
  workspace?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /**
   * Trigger CRUD for the dashboard (/:basePath/triggers). An accessor, not a
   * captured instance: register() re-runs on plugin reloads and replaces the
   * scheduler while this server instance survives (activeServer guard), so
   * the routes must reach the scheduler that is armed right now, never the
   * one that was armed when the server first started.
   */
  triggers?: () => { store: TriggerStore; scheduler: TriggerScheduler } | null;
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// Guard against double-init when register() is called more than once
// (OpenClaw calls it during discovery and again at gateway startup).
let activeServer: http.Server | null = null;

function resolveWorkspace(workspace?: string): string {
  return workspace ?? process.env.OPENCLAW_WORKSPACE ?? process.cwd();
}

function resolveFlowsDir(serve: ServeConfig, workspace: string): string {
  return serve.flowsDir ?? path.join(workspace, "flows");
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startFlowServer(opts: FlowServerOpts): http.Server {
  if (activeServer) return activeServer;

  const { runner, serve, logger } = opts;
  const basePath = (serve.path ?? "/flows").replace(/\/+$/, "");
  const workspace = resolveWorkspace(opts.workspace);
  const flowsDir = resolveFlowsDir(serve, workspace);
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // Health check
    if (req.method === "GET" && pathname === `${basePath}/health`) {
      json(res, 200, { ok: true, flowsDir });
      return;
    }

    // Validate a flow definition: POST /:basePath/validate
    // Pure static validation against THIS process's live step registry —
    // custom steps registered by sibling plugins (e.g. Clawnify's
    // clawnify_app/clawnify_action) only exist in the gateway process, so this
    // is the one place an off-box caller can get registry-correct validation.
    // No state, no execution; safe to leave unauthenticated like /health.
    if (req.method === "POST" && pathname === `${basePath}/validate`) {
      try {
        const rawBody = await readBody(req);
        let def: unknown;
        try {
          def = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        if (!def || typeof def !== "object" || Array.isArray(def)) {
          json(res, 400, { error: "Body must be a flow definition object" });
          return;
        }
        json(res, 200, validateFlow(def as FlowDefinition));
      } catch (err) {
        log.error(
          `[clawflow] validate error: ${err instanceof Error ? err.message : String(err)}`,
        );
        json(res, 500, { error: "Internal server error" });
      }
      return;
    }

    // Trigger CRUD — the HTTP twin of the flow_trigger tool, so a schedule
    // made from the dashboard is validated exactly like one the agent makes:
    //   GET    /:basePath/triggers[?flow=]      list (with live nextRunAt)
    //   POST   /:basePath/triggers              create { flow, cron, tz?, inputs?, description?, enabled?, version? }
    //   PATCH  /:basePath/triggers/:id          update any of those, enabled:false pauses
    //   DELETE /:basePath/triggers/:id
    //   POST   /:basePath/triggers/:id/run      fire now (202; the run is async)
    const triggersBase = `${basePath}/triggers`;
    if (pathname === triggersBase || pathname.startsWith(`${triggersBase}/`)) {
      const wired = opts.triggers?.() ?? null;
      if (!wired) {
        json(res, 501, { error: "Trigger scheduler not available on this server" });
        return;
      }
      const { store, scheduler } = wired;
      const rest = pathname.slice(triggersBase.length).replace(/^\//, "");
      const [id, action, extra] = rest ? rest.split("/") : [];
      const withNext = (r: TriggerRecord) => ({
        ...r,
        nextRunAt: scheduler.nextRun(r.id)?.toISOString() ?? r.nextRunAt ?? null,
      });
      const readJson = async (): Promise<Record<string, unknown> | null> => {
        const raw = await readBody(req);
        if (!raw) return {};
        try {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      };
      const validVersion = (v: unknown): v is number | "@published" =>
        v === "@published" || (typeof v === "number" && Number.isInteger(v) && v > 0);
      try {
        if (extra !== undefined) {
          json(res, 404, { error: "Not found" });
          return;
        }
        if (!id && req.method === "GET") {
          const flow = url.searchParams.get("flow") ?? undefined;
          const records = store.list(flow ? { flowName: flow } : undefined);
          json(res, 200, { ok: true, triggers: records.map(withNext) });
          return;
        }
        if (!id && req.method === "POST") {
          const body = await readJson();
          if (!body) {
            json(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const flowName =
            typeof body.flow === "string" ? body.flow
            : typeof body.flowName === "string" ? body.flowName
            : null;
          if (!flowName || typeof body.cron !== "string") {
            json(res, 400, { error: '"flow" and "cron" are required' });
            return;
          }
          if (body.tz !== undefined && typeof body.tz !== "string") {
            json(res, 400, { error: '"tz" must be an IANA timezone string' });
            return;
          }
          if (body.version !== undefined && !validVersion(body.version)) {
            json(res, 400, { error: '"version" must be a positive integer or "@published"' });
            return;
          }
          if (!resolveRunnableFlow(workspace, flowsDir, flowName)) {
            json(res, 404, { error: `Flow not found: ${flowName}` });
            return;
          }
          assertValidSchedule(body.cron, body.tz as string | undefined);
          const input: CreateTriggerInput = {
            flowName,
            cron: body.cron,
            ...(typeof body.tz === "string" ? { tz: body.tz } : {}),
            ...(body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
              ? { inputs: body.inputs as Record<string, unknown> }
              : {}),
            ...(body.version !== undefined ? { version: body.version as number | "@published" } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
            origin: body.origin === "agent" ? "agent" : "dashboard",
          };
          const record = store.create(input);
          scheduler.sync();
          log.info(`[clawflow] trigger ${record.id} created via http → ${flowName} (${record.cron})`);
          json(res, 201, { ok: true, trigger: withNext(store.get(record.id) ?? record) });
          return;
        }
        if (id && !action && req.method === "PATCH") {
          const current = store.get(id);
          if (!current) {
            json(res, 404, { error: `Trigger not found: ${id}` });
            return;
          }
          const body = await readJson();
          if (!body) {
            json(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (body.cron !== undefined && typeof body.cron !== "string") {
            json(res, 400, { error: '"cron" must be a string' });
            return;
          }
          if (body.tz !== undefined && typeof body.tz !== "string") {
            json(res, 400, { error: '"tz" must be an IANA timezone string' });
            return;
          }
          if (body.version !== undefined && !validVersion(body.version)) {
            json(res, 400, { error: '"version" must be a positive integer or "@published"' });
            return;
          }
          const cron = typeof body.cron === "string" ? body.cron : current.cron;
          const tz = typeof body.tz === "string" ? body.tz : current.tz;
          // Re-validate the resulting schedule, not just the field that
          // changed — a new tz can invalidate an expression that was fine.
          assertValidSchedule(cron, tz);
          const patch: Partial<TriggerRecord> = { cron };
          if (typeof body.tz === "string") patch.tz = body.tz;
          if (body.inputs !== undefined) {
            if (body.inputs === null) patch.inputs = undefined;
            else if (typeof body.inputs === "object" && !Array.isArray(body.inputs)) {
              patch.inputs = body.inputs as Record<string, unknown>;
            } else {
              json(res, 400, { error: '"inputs" must be an object' });
              return;
            }
          }
          if (body.version !== undefined) patch.version = body.version as number | "@published";
          if (typeof body.description === "string") patch.description = body.description;
          if (typeof body.enabled === "boolean") {
            patch.enabled = body.enabled;
            if (!body.enabled) patch.nextRunAt = undefined;
          }
          store.update(id, patch);
          scheduler.sync();
          json(res, 200, { ok: true, trigger: withNext(store.get(id)!) });
          return;
        }
        if (id && !action && req.method === "DELETE") {
          if (!store.remove(id)) {
            json(res, 404, { error: `Trigger not found: ${id}` });
            return;
          }
          scheduler.sync();
          log.info(`[clawflow] trigger ${id} deleted via http`);
          json(res, 200, { ok: true, id });
          return;
        }
        if (id && action === "run" && req.method === "POST") {
          if (!store.get(id)) {
            json(res, 404, { error: `Trigger not found: ${id}` });
            return;
          }
          // Same contract as /:flowName/run: acknowledge, then run detached.
          // The outcome lands on the record (lastInstanceId / lastStatus).
          json(res, 202, { ok: true, id });
          scheduler.runNow(id).then((result) => {
            if (result && !result.ok) {
              log.error(`[clawflow] trigger ${id} run-now failed: ${result.error ?? "unknown error"}`);
            }
          }).catch((err) => {
            log.error(`[clawflow] trigger ${id} run-now crashed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return;
        }
        json(res, 404, { error: "Not found" });
      } catch (err) {
        // Everything that throws here is a client-side problem: a schedule the
        // validator rejects, a duplicate id, a record that vanished mid-request.
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Run a flow: POST /:basePath/:flowName/run
    const runPattern = new RegExp(
      `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([a-zA-Z0-9_-]+)/run$`,
    );
    const match = pathname.match(runPattern);

    if (!match || req.method !== "POST") {
      json(res, 404, { error: "Not found" });
      return;
    }

    const flowName = match[1];

    try {
      const loaded = resolveRunnableFlow(workspace, flowsDir, flowName);
      if (!loaded) {
        json(res, 404, { error: `Flow not found: ${flowName}` });
        return;
      }
      const flowDef = loaded.def;

      // Parse request body — entire body becomes the flow's inputs payload.
      let inputs: unknown = {};
      const rawBody = await readBody(req);
      if (rawBody) {
        try {
          inputs = JSON.parse(rawBody);
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
      }

      // Fire-and-forget: start the flow, return immediately with instanceId
      const instanceId = crypto.randomUUID();
      log.info(`[clawflow] run → ${flowName} ${loaded.source} (${instanceId})`);

      // Respond 202 before the flow runs
      json(res, 202, { ok: true, instanceId, flow: flowName });

      // Run asynchronously — don't block the response
      runner.run(flowDef, inputs, instanceId).then((result) => {
        if (!result.ok) {
          log.error(
            `[clawflow] flow "${flowName}" (${instanceId}) failed: ${result.error ?? "unknown error"}`,
          );
        }
      }).catch((err) => {
        log.error(
          `[clawflow] flow "${flowName}" (${instanceId}) crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } catch (err) {
      log.error(
        `[clawflow] run error: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, 500, { error: "Internal server error" });
    }
  });

  activeServer = server;

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.warn(
        `[clawflow] port ${serve.port} already in use — skipping webhook server (another clawflow instance likely owns it)`,
      );
      activeServer = null;
      return;
    }
    log.error(`[clawflow] webhook server error: ${err.message}`);
  });

  server.listen(serve.port, () => {
    log.info(
      `[clawflow] flow server listening on :${serve.port}${basePath}/:flowName/run`,
    );
  });

  return server;
}
