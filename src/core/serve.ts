import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import type { FlowDefinition, ServeConfig } from "./types.js";
import type { FlowRunner } from "./runner.js";
import { validateFlow } from "./validate.js";

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
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// Guard against double-init when register() is called more than once
// (OpenClaw calls it during discovery and again at gateway startup).
let activeServer: http.Server | null = null;

function resolveFlowsDir(serve: ServeConfig): string {
  return (
    serve.flowsDir ??
    path.join(process.env.OPENCLAW_WORKSPACE ?? process.cwd(), "flows")
  );
}

function loadFlow(
  flowsDir: string,
  flowName: string,
): FlowDefinition | null {
  const safe = flowName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return null;
  const file = path.join(flowsDir, `${safe}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as FlowDefinition;
  } catch {
    return null;
  }
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
  const flowsDir = resolveFlowsDir(serve);
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
      const flowDef = loadFlow(flowsDir, flowName);
      if (!flowDef) {
        json(res, 404, { error: `Flow not found: ${flowName}` });
        return;
      }

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
      log.info(`[clawflow] run → ${flowName} (${instanceId})`);

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
