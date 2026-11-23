import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner, StepRegistry, startFlowServer } from "../src/index.js";
import type { FlowDefinition, PluginConfig, StorageConfig } from "../src/index.js";

// GET /flows/runs/:id/status: what a caller that started a run with
// POST /flows/:name/run can ask about it afterwards. A flow that hands work to
// other runs uses it to see that a run has ended, and how, instead of waiting
// out that run's whole time limit.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-run-status-"));
const workspace = path.join(tmpDir, "workspace");
const flowsDir = path.join(workspace, "flows");
const cfg: PluginConfig = {
  stateDir: path.join(tmpDir, "state"),
  memoryDir: path.join(tmpDir, "memory"),
};
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(check: () => T | Promise<T>, ms = 4_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A `hold` step waits here until the test opens its gate, so "the run is
 *  still going" never depends on how fast the machine is. */
const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
function gate(name: string) {
  let g = gates.get(name);
  if (!g) {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    g = { opened, open };
    gates.set(name, g);
  }
  return g;
}
function holdStep(registry: StepRegistry): void {
  registry.register({
    name: "hold",
    allowedKeys: ["gate"],
    run: async (input) => {
      await gate(String(input.gate)).opened;
      return "released";
    },
  });
}

function writeFlow(def: FlowDefinition): void {
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(path.join(flowsDir, `${def.flow}.json`), JSON.stringify(def, null, 2));
}

describe("flow server: run status", () => {
  let server: ReturnType<typeof startFlowServer>;
  let base = "";

  async function call(method: string, p: string, body?: unknown, token?: string) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  before(async () => {
    const registry = new StepRegistry();
    registry.register({ name: "boom", allowedKeys: ["message"], run: (input) => { throw new Error(String(input.message ?? "boom")); } });
    holdStep(registry);
    writeFlow({ flow: "slow", nodes: [{ name: "work", do: "hold" as "code", gate: "slow" } as never, { name: "done", do: "code", run: "'secret output'", output: "result" }] });
    writeFlow({ flow: "breaks", nodes: [{ name: "work", do: "boom" as "code", message: "model unavailable" } as never] });
    writeFlow({ flow: "long-error", nodes: [{ name: "work", do: "boom" as "code", message: "x".repeat(5_000) } as never] });
    writeFlow({ flow: "gated", nodes: [{ name: "gate", do: "wait", for: "approval", prompt: "Go?" }, { name: "done", do: "code", run: "1", output: "result" }] });
    server = startFlowServer({
      runner: new FlowRunner({ ...cfg, customSteps: registry }),
      // A token is configured, as on a host: the authenticated run reads
      // require it, the status read does not.
      controlToken: () => "test-token",
      serve: { port: 0, flowsDir },
      workspace,
      logger: silent,
    });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/flows`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("says a run is going, then that it completed", async () => {
    const started = await call("POST", "/slow/run", { order: 42 });
    assert.equal(started.status, 202);
    const id = started.body.instanceId as string;

    const going = await until(async () => {
      const r = await call("GET", `/runs/${id}/status`);
      return r.status === 200 ? r : null;
    }, 2_000, "the run's record");
    assert.equal(going.body.ok, true);
    assert.equal(going.body.instanceId, id);
    assert.equal(going.body.flow, "slow");
    assert.equal(going.body.status, "running");
    assert.equal(going.body.finished, false);

    gate("slow").open();
    const done = await until(async () => {
      const r = await call("GET", `/runs/${id}/status`);
      return r.body.finished ? r : null;
    }, 4_000, "the run to end");
    assert.equal(done.body.status, "completed");
    assert.equal("error" in done.body, false);
    // The answer is the same small shape however much the run produced.
    assert.deepEqual(Object.keys(done.body).sort(), ["createdAt", "finished", "flow", "instanceId", "ok", "status", "updatedAt"]);
    assert.equal(JSON.stringify(done.body).includes("secret output"), false, "no outputs in a status read");
  });

  it("says a failed run failed, and why", async () => {
    const started = await call("POST", "/breaks/run", {});
    const id = started.body.instanceId as string;
    const done = await until(async () => {
      const r = await call("GET", `/runs/${id}/status`);
      return r.body.finished ? r : null;
    }, 4_000, "the run to end");
    assert.equal(done.body.status, "failed");
    assert.equal(done.body.error, 'Node "work": model unavailable');
  });

  it("keeps a long error short", async () => {
    const started = await call("POST", "/long-error/run", {});
    const id = started.body.instanceId as string;
    const done = await until(async () => {
      const r = await call("GET", `/runs/${id}/status`);
      return r.body.finished ? r : null;
    }, 4_000, "the run to end");
    assert.equal(done.body.error.length, 2_000);
  });

  it("says a run paused at an approval is not finished, and gives away no approval token", async () => {
    const started = await call("POST", "/gated/run", {});
    const id = started.body.instanceId as string;
    const paused = await until(async () => {
      const r = await call("GET", `/runs/${id}/status`);
      return r.body.status === "paused" ? r : null;
    }, 4_000, "the run to pause");
    assert.equal(paused.body.finished, false);
    assert.equal("resumeToken" in paused.body, false);
    assert.equal("waitingFor" in paused.body, false);
    // The token itself, read where it is allowed to be read.
    const record = await call("GET", `/runs/${id}`, undefined, "test-token");
    const token = record.body.run.resumeToken as string;
    assert.match(token, /^cf-/);
    assert.equal(JSON.stringify(paused.body).includes(token), false, "the resume token is not in the answer");
  });

  it("lets a flow start a run and read how it ended, through its own http steps", async () => {
    // The README's pattern: start, keep the id, ask later. The worker fails,
    // and the flow that started it finds out without waiting on a time limit.
    writeFlow({
      flow: "dispatcher",
      nodes: [
        { name: "start", do: "http", method: "POST", url: "{{ inputs.base }}/breaks/run", body: { order: "{{ inputs.order }}" }, output: "started" },
        { name: "later", do: "hold" as "code", gate: "dispatcher" } as never,
        { name: "check", do: "http", url: "{{ inputs.base }}/runs/{{ started.instanceId }}/status", output: "run" },
        { name: "free", do: "condition", if: "run.finished == true", then: [
          { name: "note", do: "code", run: "'order ' + state.inputs.order + ' freed: ' + state.run.status", output: "note" },
        ] },
      ],
    });
    const started = await call("POST", "/dispatcher/run", { base, order: 42 });
    assert.equal(started.status, 202);
    const id = started.body.instanceId as string;

    // The dispatcher's next pass comes after the worker has ended.
    const worker = await until(async () => {
      const r = await call("GET", `/runs/${id}`, undefined, "test-token");
      return r.body.run?.state?.started?.instanceId as string | undefined;
    }, 5_000, "the dispatcher to start the worker");
    await until(async () => (await call("GET", `/runs/${worker}/status`)).body.finished, 5_000, "the worker to end");
    gate("dispatcher").open();
    await until(async () => (await call("GET", `/runs/${id}/status`)).body.finished, 5_000, "the dispatcher to end");

    const record = await call("GET", `/runs/${id}`, undefined, "test-token");
    assert.equal(record.body.run.status, "completed");
    assert.equal(record.body.run.state.started.ok, true);
    assert.equal(record.body.run.state.run.status, "failed");
    assert.equal(record.body.run.state.run.error, 'Node "work": model unavailable');
    assert.equal(record.body.run.state.note, "order 42 freed: failed");
  });

  it("answers 404 run_not_found for a run it has never seen", async () => {
    const r = await call("GET", "/runs/no-such-run/status");
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "run_not_found");
  });

  it("needs no token, while the run's record still does", async () => {
    const started = await call("POST", "/slow/run", {});
    const id = started.body.instanceId as string;
    await until(async () => (await call("GET", `/runs/${id}/status`)).status === 200, 2_000, "the run's record");
    const record = await call("GET", `/runs/${id}`);
    assert.equal(record.status, 401);
    assert.equal(record.body.code, "flow_unauthorized");
    await until(async () => (await call("GET", `/runs/${id}/status`)).body.finished, 4_000, "the run to end");
  });
});

describe("runStatus on a SQLite store", () => {
  it("reads the run's summary", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-run-status-sql-"));
    const storage: StorageConfig = { backend: "sqlite", path: path.join(dir, "state.sqlite") };
    const runner = new FlowRunner({ stateDir: dir, storage });
    t.after(async () => {
      await runner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const result = await runner.run({ flow: "sql-flow", nodes: [{ name: "one", do: "code", run: "1", output: "result" }] }, {}, "sql-run");
    assert.equal(result.status, "completed");

    const status = await runner.runStatus("sql-run");
    assert.equal(status?.flow, "sql-flow");
    assert.equal(status?.status, "completed");
    assert.equal(status?.finished, true);
    assert.equal(await runner.runStatus("missing"), null);
  });
});
