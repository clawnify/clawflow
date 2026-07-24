import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";

import {
  FlowRunner,
  FlowOps,
  FLOW_OP_SPECS,
  startManagementServer,
} from "../src/index.js";
import type { FlowDefinition, PluginConfig } from "../src/index.js";

// Temp workspace so tests don't pollute the real one
const tmpDir = path.join(os.tmpdir(), `ocf-ops-test-${Date.now()}`);
const workspace = path.join(tmpDir, "workspace");
const cfg: PluginConfig = {
  stateDir: path.join(tmpDir, "state"),
  memoryDir: path.join(tmpDir, "memory"),
};

function makeOps(): FlowOps {
  return new FlowOps(workspace, new FlowRunner(cfg));
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const SIMPLE_FLOW: FlowDefinition = {
  flow: "ops-simple",
  nodes: [
    { name: "double", do: "code" as const, run: "input * 2", input: "inputs.x", output: "result" },
  ],
};

// ---- FlowOps lifecycle ----------------------------------------------------------

describe("FlowOps — create / list / read / publish / run / delete / restore", () => {
  after(cleanup);
  const ops = makeOps();

  it("creates a flow file", async () => {
    const r = await ops.execute("flow_create", {
      file: "ops-simple",
      flow: "ops-simple",
      description: "doubles x",
      nodes: SIMPLE_FLOW.nodes,
    });
    assert.match(r.text, /created at/);
    assert.ok(fs.existsSync(path.join(workspace, "flows", "ops-simple.json")));
  });

  it("rejects creating over an existing file", async () => {
    const r = await ops.execute("flow_create", {
      file: "ops-simple",
      flow: "ops-simple",
      nodes: SIMPLE_FLOW.nodes,
    });
    assert.match(r.text, /already exists/);
  });

  it("rejects invalid flows", async () => {
    const r = await ops.execute("flow_create", {
      file: "ops-bad",
      flow: "ops-bad",
      nodes: [{ name: "x", do: "nope" }],
    });
    assert.match(r.text, /Validation failed/);
    assert.ok(!fs.existsSync(path.join(workspace, "flows", "ops-bad.json")));
  });

  it("lists flows with metadata", async () => {
    const r = await ops.execute("flow_list", {});
    const flows = r.details as Array<{ flow: string; nodes: number }>;
    assert.equal(flows.length, 1);
    assert.equal(flows[0].flow, "ops-simple");
    assert.equal(flows[0].nodes, 1);
  });

  it("reads a flow with expected inputs", async () => {
    const r = await ops.execute("flow_read", { file: "ops-simple" });
    const detail = r.details as { flow: string; _source: string };
    assert.equal(detail.flow, "ops-simple");
    assert.equal(detail._source, "draft");
  });

  it("edits a flow (add node)", async () => {
    const r = await ops.execute("flow_edit", {
      file: "ops-simple",
      action: "add",
      nodeDefinition: { name: "plus-one", do: "code", run: "input + 1", input: "result", output: "final" },
    });
    assert.match(r.text, /added at position 1/);
  });

  it("publishes a version", async () => {
    const r = await ops.execute("flow_publish", { file: "ops-simple" });
    assert.match(r.text, /as v1/);
    assert.ok(
      fs.existsSync(path.join(workspace, ".clawflow", "versions", "ops-simple", "1.json")),
    );
  });

  it("runs the published version by default", async () => {
    const r = await ops.execute("flow_run", { file: "ops-simple", input: { x: 4 } });
    const out = r.details as { ok: boolean; _source: string; state: { final: number } };
    assert.equal(out.ok, true);
    assert.equal(out._source, "v1");
    assert.equal(out.state.final, 9);
  });

  it("runs the draft when asked", async () => {
    const r = await ops.execute("flow_run", { file: "ops-simple", input: { x: 4 }, draft: true });
    const out = r.details as { ok: boolean; _source: string };
    assert.equal(out.ok, true);
    assert.equal(out._source, "draft");
  });

  it("reports status for completed instances", async () => {
    const r = await ops.execute("flow_status", {});
    const list = r.details as Array<{ status: string }>;
    assert.ok(list.length >= 2);
    assert.ok(list.every((i) => i.status === "completed"));
  });

  it("deletes to bin and restores", async () => {
    const del = await ops.execute("flow_delete", { file: "ops-simple" });
    assert.match(del.text, /moved to bin/);
    assert.ok(!fs.existsSync(path.join(workspace, "flows", "ops-simple.json")));

    const listBin = await ops.execute("flow_restore_from_bin", {});
    const entries = listBin.details as Array<{ name: string }>;
    assert.equal(entries[0].name, "ops-simple");

    const restore = await ops.execute("flow_restore_from_bin", { name: "ops-simple" });
    assert.match(restore.text, /Restored "ops-simple"/);
    assert.ok(fs.existsSync(path.join(workspace, "flows", "ops-simple.json")));
  });

  it("throws on unknown op names", async () => {
    await assert.rejects(() => ops.execute("flow_nope", {}), /Unknown flow op/);
  });
});

// ---- Op specs -------------------------------------------------------------------

describe("FLOW_OP_SPECS", () => {
  it("covers every op the dispatcher accepts, exactly once", async () => {
    const names = FLOW_OP_SPECS.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
    // every spec dispatches (never "Unknown flow op"; missing-param errors are
    // fine — the harness validates params against the schema before calling)
    const ops = makeOps();
    for (const name of names) {
      try {
        await ops.execute(name, {});
      } catch (err) {
        assert.doesNotMatch(String(err), /Unknown flow op/);
      }
    }
  });

  it("carries a JSON-schema parameters object on every spec", () => {
    for (const spec of FLOW_OP_SPECS) {
      assert.equal(typeof spec.description, "string");
      assert.equal((spec.parameters as { type: string }).type, "object");
    }
  });
});

// ---- Management server ----------------------------------------------------------

describe("management server", () => {
  after(cleanup);

  const TOKEN = "test-token-123";
  let server: http.Server;
  let port: number;

  async function request(
    method: string,
    pathname: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
        "Content-Type": "application/json",
      },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    });
    return { status: res.status, body: await res.json() };
  }

  it("starts on an ephemeral port", async () => {
    server = startManagementServer({ ops: makeOps(), token: TOKEN, port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const addr = server.address();
    assert.ok(typeof addr === "object" && addr);
    port = (addr as { port: number }).port;
  });

  it("rejects requests without a token", async () => {
    const r = await request("GET", "/ops");
    assert.equal(r.status, 401);
  });

  it("rejects requests with a wrong token", async () => {
    const r = await request("GET", "/ops", { token: "wrong" });
    assert.equal(r.status, 401);
  });

  it("serves op specs on GET /ops", async () => {
    const r = await request("GET", "/ops", { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.ops.length, FLOW_OP_SPECS.length);
    assert.ok(r.body.ops.some((s: { name: string }) => s.name === "flow_run"));
  });

  it("answers health", async () => {
    const r = await request("GET", "/ops/health", { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("executes an op end-to-end (create → run)", async () => {
    const create = await request("POST", "/ops/flow_create", {
      token: TOKEN,
      body: { file: "manage-flow", flow: "manage-flow", nodes: SIMPLE_FLOW.nodes },
    });
    assert.equal(create.status, 200);
    assert.match(create.body.text, /created at/);

    const run = await request("POST", "/ops/flow_run", {
      token: TOKEN,
      body: { file: "manage-flow", input: { x: 21 } },
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.details.ok, true);
    assert.equal(run.body.details.state.result, 42);
  });

  it("404s unknown ops", async () => {
    const r = await request("POST", "/ops/flow_nope", { token: TOKEN, body: {} });
    assert.equal(r.status, 404);
  });

  it("400s invalid JSON bodies", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ops/flow_list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  it("stops cleanly", async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
