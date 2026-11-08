import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { FlowRunner } from "./runner.js";
import type { FlowDefinition } from "./types.js";
import { parseRunPage, readRunValue } from "./runs.js";
import type { InstanceRecord, RunIndexEntry } from "./store.js";

/** Management reads/approval actions require the host's gateway bearer. The
 * existing webhook listener may be behind a public tunnel: loopback alone is
 * not an authorization boundary. No token configured means these routes close. */
export async function controlRequest(
  req: IncomingMessage, res: ServerResponse, url: URL, basePath: string,
  runner: FlowRunner, token: string | undefined,
  json: (res: ServerResponse, status: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
  resolveDefinition: (name: string) => FlowDefinition | null,
): Promise<boolean> {
  const base = `${basePath}/runs`;
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return false;
  const parts = pathname.slice(base.length).split("/").filter(Boolean);
  // Preserve the older cancellation endpoint's contract in serve.ts.
  if (parts.length === 2 && parts[1] === "cancel") return false;
  const supplied = req.headers.authorization;
  const expected = typeof token === "string" && token ? `Bearer ${token}` : "";
  if (!expected || typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    json(res, 401, { error: "Flow management authentication required", code: "flow_unauthorized" });
    return true;
  }
  if (req.headers["x-clawflow-backend"] && req.headers["x-clawflow-backend"] !== runner.storageBackend) {
    json(res, 503, { error: "Restart the flow engine to apply its storage configuration", code: "flow_storage_mismatch" });
    return true;
  }
  let id: string | undefined;
  try { id = parts[0] ? decodeURIComponent(parts[0]) : undefined; }
  catch { json(res, 400, { error: "Invalid instance ID" }); return true; }
  if (id && (id.length > 1024 || /[\x00-\x1f/\\]/.test(id))) {
    json(res, 400, { error: "Invalid instance ID" }); return true;
  }
  const store = runner.getStore();
  const qs = url.searchParams;
  let acknowledged = false;
  try {
    if (req.method === "GET" && (!id || (parts.length === 2 && parts[1] === "subruns"))) {
      const opts = { limit: qs.has("limit") ? Number(qs.get("limit")) : undefined, cursor: qs.get("cursor") || undefined,
        flow: qs.get("flow") || undefined, status: qs.get("status") || undefined, node: qs.get("node") || undefined };
      try { parseRunPage(opts); } catch (err) { json(res, 400, { error: (err as Error).message }); return true; }
      const page = id ? await store.listSubRuns(id, opts) : await store.listRuns(opts);
      json(res, 200, { ok: true, ...page });
      return true;
    }
    if (id && parts.length === 1 && req.method === "GET") {
      const run = await store.get(id);
      if (!run || run.instanceId !== id) { json(res, 404, { error: "Run not found", code: "run_not_found" }); return true; }
      const valuePath = qs.get("path");
      // Full detail keeps the platform's existing per-node last-20 projection.
      // Individual paths bypass the child scan unless they name that projection.
      const detail = (!valuePath || valuePath.startsWith("subFlows")) && qs.get("include_subruns") === "1"
        ? await runDetail(runner, run, qs.get("node") || undefined) : run;
      if (valuePath) {
        try {
          json(res, 200, { ok: true, ...readRunValue(detail, valuePath, {
            offset: qs.has("offset") ? Number(qs.get("offset")) : undefined,
            limit: qs.has("limit") ? Number(qs.get("limit")) : undefined,
            maxChars: qs.has("max_chars") ? Number(qs.get("max_chars")) : undefined,
          }) });
        } catch (err) { json(res, 400, { error: (err as Error).message }); }
      } else json(res, 200, { ok: true, run: detail });
      return true;
    }
    if (id && parts.length === 2 && parts[1] === "resume" && req.method === "POST") {
      let body: { approved?: unknown };
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "Invalid JSON body" }); return true; }
      if (!body || typeof body.approved !== "boolean") { json(res, 400, { error: "approved must be boolean" }); return true; }
      const run = await store.get(id);
      if (!run || run.instanceId !== id) { json(res, 404, { error: "Run not found", code: "run_not_found" }); return true; }
      if (run.status !== "paused" && run.status !== "waiting") {
        json(res, 409, { error: "Run is not paused", code: "run_not_paused" }); return true;
      }
      if (!body.approved) {
        const result = await runner.resume(id, { flow: run.flowName, nodes: [] }, false);
        json(res, 200, { ok: true, status: result.status, instanceId: id });
        return true;
      }
      const flow = resolveDefinition(run.flowName);
      if (!flow || flow.flow !== run.flowName) {
        json(res, 404, { error: "Flow definition not found", code: "flow_definition_required" }); return true;
      }
      // Acknowledge after the durable claim, before executing later steps. A
      // database failure before the claim must not masquerade as accepted work.
      await runner.resume(id, flow, true, (instanceId) => {
        acknowledged = true;
        json(res, 202, { ok: true, status: "resuming", instanceId });
      });
      return true;
    }
    json(res, 404, { error: "Not found", code: "flow_control_not_found" });
  } catch (err) {
    if (!acknowledged) {
      const raced = err instanceof Error && /is not paused|Resume token not found/.test(err.message);
      json(res, raced ? 409 : 503, { error: raced ? "Run is no longer paused" : "Flow storage operation failed", code: raced ? "run_not_paused" : "flow_storage_unavailable" });
    } else console.warn("[clawflow] Resumed flow failed after acknowledgement; inspect its stored status");
  }
  return true;
}

async function runDetail(runner: FlowRunner, run: InstanceRecord, node?: string): Promise<InstanceRecord> {
  const store = runner.getStore();
  const groups = new Map<string, { total: number; rows: RunIndexEntry[] }>();
  let cursor: string | undefined;
  const iteration = (r: RunIndexEntry) => Number.parseInt(r.instanceId.slice(run.instanceId.length + 1).split(":")[2] ?? "0", 10) || 0;
  do {
    const page = await store.listSubRuns(run.instanceId, { limit: 100, cursor, node });
    for (const row of page.runs) {
      const name = row.instanceId.slice(run.instanceId.length + 1).split(":")[1];
      const group = groups.get(name) ?? { total: 0, rows: [] };
      group.total++;
      group.rows.push(row);
      group.rows.sort((a, b) => iteration(a) - iteration(b));
      if (group.rows.length > 20) group.rows.shift();
      groups.set(name, group);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  const subFlows: Record<string, unknown[]> = Object.create(null);
  const omitted: Record<string, unknown> = Object.create(null);
  for (const [name, group] of groups) {
    subFlows[name] = [];
    for (const row of group.rows) {
      const child = await store.get(row.instanceId);
      if (!child) throw new Error("Sub-run changed during detail read");
      subFlows[name].push({ instanceId: child.instanceId, iteration: iteration(row), status: child.status,
        trace: child.trace ?? [], completedNodes: child.completedNodes ?? {} });
    }
    if (group.total > group.rows.length) omitted[name] = { total: group.total, returned: group.rows.length,
      omitted: group.total - group.rows.length, note: "Oldest iterations omitted. Read the paged subruns endpoint for every retained instance." };
  }
  return { ...run, subFlows, ...(node ? { subFlowsNodeFilter: node } : {}),
    ...(Object.keys(omitted).length ? { subFlowsTruncated: omitted } : {}) } as InstanceRecord;
}
