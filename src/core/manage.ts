import * as http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import type { FlowOps } from "./ops.js";
import { FLOW_OP_SPECS } from "./op-specs.js";

// ---- Management API -------------------------------------------------------------
// Loopback-only HTTP server exposing the flow_* operations, so out-of-process
// harness shims (e.g. a Hermes-side plugin) can register the same tool surface
// and forward calls without linking against this package. This is deliberately
// NOT the flow server (serve.ts): that one is tunnel-exposed for webhook
// triggers; this one binds 127.0.0.1 only and requires a bearer token.
//
// Endpoints:
//   GET  /ops           — list op specs (name, description, parameters) for discovery
//   POST /ops/:name     — execute an op; JSON body = params; returns { text, details? }
//   GET  /ops/health    — health check (auth required, like everything else)

export interface ManageServerOpts {
  ops: FlowOps;
  /** Bearer token required on every request. */
  token: string;
  /** Default: 18794. Use 0 for an ephemeral port (tests). */
  port?: number;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export const DEFAULT_MANAGE_PORT = 18794;

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// Guard against double-init when register() is called more than once
// (OpenClaw calls it during discovery and again at gateway startup).
let activeServer: http.Server | null = null;

function json(res: http.ServerResponse, status: number, body: unknown): void {
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

/** Constant-time bearer-token check (hash both sides so lengths always match). */
function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(presented, expected);
}

export function startManagementServer(opts: ManageServerOpts): http.Server {
  if (activeServer) return activeServer;

  const { ops, token } = opts;
  const port = opts.port ?? DEFAULT_MANAGE_PORT;
  const log = opts.logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  const opNames = new Set(FLOW_OP_SPECS.map((s) => s.name));

  const server = http.createServer(async (req, res) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && pathname === "/ops/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/ops") {
      json(res, 200, { ops: FLOW_OP_SPECS });
      return;
    }

    const match = pathname.match(/^\/ops\/([a-z_]+)$/);
    if (!match || req.method !== "POST") {
      json(res, 404, { error: "Not found" });
      return;
    }

    const opName = match[1];
    if (!opNames.has(opName)) {
      json(res, 404, { error: `Unknown op: "${opName}"` });
      return;
    }

    let params: unknown = {};
    try {
      const rawBody = await readBody(req);
      if (rawBody) params = JSON.parse(rawBody);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    try {
      const result = await ops.execute(opName, params);
      json(res, 200, result);
    } catch (err) {
      log.error(
        `[clawflow] manage op "${opName}" error: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  activeServer = server;
  server.on("close", () => {
    if (activeServer === server) activeServer = null;
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.warn(
        `[clawflow] port ${port} already in use — skipping management server (another clawflow instance likely owns it)`,
      );
      activeServer = null;
      return;
    }
    log.error(`[clawflow] management server error: ${err.message}`);
  });

  // Loopback only — this surface must never be reachable off-box.
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    log.info(`[clawflow] management API listening on 127.0.0.1:${boundPort}/ops`);
  });

  return server;
}
