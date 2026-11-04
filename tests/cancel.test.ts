import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner, StateStore, startFlowServer, targetsCallerSession, agentStepSessionKey } from "../src/index.js";
import type { FlowDefinition, FlowResult, PluginConfig } from "../src/index.js";

// Cancelling a run: the step it is on is stopped (a shell killed, an agent
// step's child sent SIGTERM, a timer cleared), the run ends "cancelled", and
// nothing after it runs. A run that is not executing in this process (paused,
// or left "running" by a restart) is marked cancelled on its record.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-cancel-"));
const cfg: PluginConfig = { stateDir: path.join(tmpDir, "state"), memoryDir: path.join(tmpDir, "memory") };
const silent = { info: () => {}, warn: () => {}, error: () => {} };

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` is truthy, or fail after `ms`. */
async function until<T>(check: () => T, ms = 3_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number {
  return Number(fs.readFileSync(file, "utf8").trim());
}

/** Start a run without awaiting it, and wait until it is on `node`. The run's
 *  promise comes back in an object: returned bare, the async function would
 *  adopt it and wait for the run to end. */
async function startOn(runner: FlowRunner, flow: FlowDefinition, id: string, node: string): Promise<{ done: Promise<FlowResult> }> {
  const done = runner.run(flow, {}, id);
  await until(() => runner.getStore().get(id)?.running?.node === node, 3_000, `run ${id} on ${node}`);
  return { done };
}

describe("cancel: a run executing in this process", () => {
  it("kills the exec step's process, ends the run cancelled, and runs nothing after it", async () => {
    const runner = new FlowRunner(cfg);
    const pidFile = path.join(tmpDir, "exec.pid");
    const flow: FlowDefinition = {
      flow: "long-exec",
      nodes: [
        { name: "work", do: "exec", command: `echo $$ > ${pidFile}; exec sleep 30`, timeout: "60s" },
        { name: "after", do: "code", run: "1", output: "after" },
      ],
    };
    const { done } = await startOn(runner, flow, "cancel-exec", "work");
    await until(() => fs.existsSync(pidFile) && readPid(pidFile) > 0, 3_000, "pid file");
    const pid = readPid(pidFile);
    assert.equal(alive(pid), true);

    const t0 = Date.now();
    const res = await runner.cancel("cancel-exec");
    assert.deepEqual(res, { ok: true, instanceId: "cancel-exec", status: "cancelled" });
    const result = await done;
    assert.ok(Date.now() - t0 < 2_000, "the run ends at once, not when the step would have");

    assert.equal(result.ok, false);
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "Cancelled");
    const record = runner.getStore().get("cancel-exec")!;
    assert.equal(record.status, "cancelled");
    assert.equal(record.running, undefined);
    assert.deepEqual(record.trace.map((t) => [t.node, t.status]), [["work", "cancelled"]]);
    assert.equal(record.state.after, undefined, "the step after the cancelled one never ran");
    await until(() => !alive(pid), 2_000, "the exec process to exit");
  });

  it("sends the agent step's openclaw process SIGTERM, which is how the CLI aborts its turn", async () => {
    // A stand-in for the openclaw CLI: on SIGTERM it records that it would
    // have sent chat.abort, then exits like the real one (143).
    const bin = path.join(tmpDir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const mark = path.join(tmpDir, "agent-aborted");
    fs.writeFileSync(
      path.join(bin, "openclaw"),
      `#!/bin/sh\ntrap 'kill $child 2>/dev/null; echo aborted > "$CLAWFLOW_TEST_MARK"; exit 143' TERM\nsleep 30 & child=$!\ntouch "$CLAWFLOW_TEST_MARK.started"\nwait $child\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    process.env.CLAWFLOW_TEST_MARK = mark;
    try {
      const runner = new FlowRunner(cfg);
      const flow: FlowDefinition = {
        flow: "long-agent",
        nodes: [{ name: "ask", do: "agent", sessionKey: "agent:main:hook:x", task: "Do it", timeout: "60s" }],
      };
      const { done } = await startOn(runner, flow, "cancel-agent", "ask");
      await until(() => fs.existsSync(`${mark}.started`), 3_000, "the openclaw stand-in to start");
      const res = await runner.cancel("cancel-agent", "Cancelled from the dashboard");
      assert.equal(res.ok, true);
      const result = await done;
      assert.equal(result.status, "cancelled");
      assert.equal(result.error, "Cancelled from the dashboard");
      await until(() => fs.existsSync(mark), 3_000, "the openclaw stand-in to receive SIGTERM");
      assert.equal(fs.readFileSync(mark, "utf8").trim(), "aborted");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.CLAWFLOW_TEST_MARK;
    }
  });

  it("stops a sleep step and a step inside a loop at once", async () => {
    const runner = new FlowRunner(cfg);
    const flow: FlowDefinition = {
      flow: "loop-sleep",
      nodes: [
        { name: "items", do: "code", run: "[1, 2, 3]", output: "items" },
        { name: "each", do: "loop", over: "items", as: "item", timeout: "5m", nodes: [{ name: "nap", do: "sleep", duration: "60s", timeout: "5m" }] },
      ],
    };
    const { done } = await startOn(runner, flow, "cancel-loop", "each");
    await sleep(50);
    const t0 = Date.now();
    await runner.cancel("cancel-loop");
    const result = await done;
    assert.ok(Date.now() - t0 < 1_000);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.trace.map((t) => [t.node, t.status]), [["items", "ok"], ["each", "cancelled"]]);
  });

  it("does not retry a cancelled step", async () => {
    const runner = new FlowRunner(cfg);
    const attempts = path.join(tmpDir, "attempts");
    const flow: FlowDefinition = {
      flow: "retry-exec",
      nodes: [{ name: "work", do: "exec", command: `echo x >> ${attempts}; exec sleep 30`, timeout: "60s", retry: { limit: 3, delay: 0 } }],
    };
    const { done } = await startOn(runner, flow, "cancel-retry", "work");
    await until(() => fs.existsSync(attempts), 3_000, "first attempt");
    await runner.cancel("cancel-retry");
    await done;
    await sleep(200);
    assert.equal(fs.readFileSync(attempts, "utf8").trim().split("\n").length, 1);
  });

  it("is found from another FlowRunner in the same process", async () => {
    // The flow server keeps the runner it started with while flow_run and the
    // scheduler use the newest one, so a cancel must cross runners.
    const a = new FlowRunner(cfg);
    const b = new FlowRunner(cfg);
    const flow: FlowDefinition = { flow: "cross", nodes: [{ name: "nap", do: "sleep", duration: "60s", timeout: "5m" }] };
    const { done } = await startOn(a, flow, "cancel-cross", "nap");
    const res = await b.cancel("cancel-cross");
    assert.deepEqual(res, { ok: true, instanceId: "cancel-cross", status: "cancelled" });
    assert.equal((await done).status, "cancelled");
  });
});

describe("cancel: a step's own timeout", () => {
  it("stops the timed-out attempt's process before the next attempt starts", async () => {
    const runner = new FlowRunner(cfg);
    const pids = path.join(tmpDir, "timeout-pids");
    const flow: FlowDefinition = {
      flow: "timeout-exec",
      nodes: [{ name: "work", do: "exec", command: `echo $$ >> ${pids}; exec sleep 30`, timeout: "300ms", retry: { limit: 2, delay: 0 } }],
    };
    const result = await runner.run(flow, {}, "timeout-retry");
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out after 300ms/);
    const started = fs.readFileSync(pids, "utf8").trim().split("\n").map(Number);
    assert.equal(started.length, 2);
    await until(() => started.every((pid) => !alive(pid)), 2_000, "both attempts' processes to exit");
  });
});

describe("an agent step's attempt timeout", () => {
  it("defaults to the 120 s its openclaw process has, not the 30 s step default", async () => {
    const runner = new FlowRunner(cfg) as any;
    let seen: any;
    runner.tryOpenClawAgent = async () => {
      seen = runner.getStore().get("agent-default-timeout")?.running;
      return "OK";
    };
    const flow: FlowDefinition = {
      flow: "agent-default",
      nodes: [
        { name: "ask", do: "agent", agent: "main", task: "Reply OK" },
        { name: "check", do: "exec", command: "true" },
      ],
    };
    await runner.run(flow, {}, "agent-default-timeout");
    assert.equal(seen?.timeoutMs, 120_000);
    assert.equal(seen?.target?.sessionKey, "agent:main:main");
    // maxNodeDurationMs still sets every step's default; other steps keep 30 s
    const configured = new FlowRunner({ ...cfg, maxNodeDurationMs: 45_000 }) as any;
    assert.equal(configured.nodeTimeoutMs({ name: "a", do: "agent", task: "x" }), 45_000);
    assert.equal(runner.nodeTimeoutMs({ name: "e", do: "exec", command: "true" }), 30_000);
    assert.equal(runner.nodeTimeoutMs({ name: "a", do: "agent", task: "x", timeout: "10m" }), 600_000);
  });
});

describe("cancel: a run not executing in this process", () => {
  it("marks a paused run cancelled, drops its approval, and refuses a later resume", async () => {
    const runner = new FlowRunner(cfg);
    const flow: FlowDefinition = {
      flow: "gate",
      nodes: [
        { name: "ok", do: "wait", for: "approval", prompt: "Go?" },
        { name: "after", do: "code", run: "1", output: "after" },
      ],
    };
    const paused = await runner.run(flow, {}, "cancel-paused");
    assert.equal(paused.status, "paused");
    assert.ok(runner.listApprovals().some((a) => a.instanceId === "cancel-paused"));

    const res = await runner.cancel("cancel-paused");
    assert.deepEqual(res, { ok: true, instanceId: "cancel-paused", status: "cancelled" });
    const record = runner.getStore().get("cancel-paused")!;
    assert.equal(record.status, "cancelled");
    assert.equal(record.resumeToken, undefined);
    assert.deepEqual(record.trace.map((t) => [t.node, t.status]), [["ok", "cancelled"]]);
    assert.ok(!runner.listApprovals().some((a) => a.instanceId === "cancel-paused"));
    // The approval token is gone, and the run itself is no longer paused.
    await assert.rejects(runner.resume(paused.resumeToken!, flow, true), /Resume token not found/);
    await assert.rejects(runner.resume("cancel-paused", flow, true), /not paused \(status: cancelled\)/);
  });

  it("marks a run a restart left running cancelled", async () => {
    const runner = new FlowRunner(cfg);
    runner.getStore().create("orphan-run", "orphan", { inputs: {} });
    const res = await runner.cancel("orphan-run");
    assert.deepEqual(res, { ok: true, instanceId: "orphan-run", status: "cancelled" });
    assert.equal(runner.getStore().get("orphan-run")!.status, "cancelled");
  });

  it("leaves a finished run as it is, and reports an unknown one", async () => {
    const runner = new FlowRunner(cfg);
    const flow: FlowDefinition = { flow: "quick", nodes: [{ name: "one", do: "code", run: "1", output: "one" }] };
    await runner.run(flow, {}, "finished-run");
    assert.deepEqual(await runner.cancel("finished-run"), {
      ok: false,
      instanceId: "finished-run",
      error: "finished",
      status: "completed",
    });
    assert.equal(runner.getStore().get("finished-run")!.status, "completed");
    assert.deepEqual(await runner.cancel("no-such-run"), { ok: false, instanceId: "no-such-run", error: "not_found" });
  });

  it("a run another process holds stops before its next step and keeps the cancel", async () => {
    // Another process cancelling this run can only write its record.
    const runner = new FlowRunner(cfg);
    const flow: FlowDefinition = {
      flow: "elsewhere",
      nodes: [
        { name: "first", do: "exec", command: "sleep 0.4", timeout: "10s" },
        { name: "second", do: "code", run: "1", output: "second" },
      ],
    };
    const { done } = await startOn(runner, flow, "cancel-elsewhere", "first");
    new StateStore(cfg.stateDir).update("cancel-elsewhere", { status: "cancelled", error: "Cancelled elsewhere" });
    const result = await done;
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "Cancelled elsewhere");
    assert.deepEqual(result.trace.map((t) => [t.node, t.status]), [["first", "ok"]]);
    assert.equal(runner.getStore().get("cancel-elsewhere")!.status, "cancelled");
  });
});

describe("cancel over the flow server", () => {
  const runner = new FlowRunner(cfg);
  let server: ReturnType<typeof startFlowServer>;
  let base = "";

  before(async () => {
    server = startFlowServer({ runner, serve: { port: 0, flowsDir: path.join(tmpDir, "flows") }, workspace: tmpDir, logger: silent });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/flows`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function cancel(id: string, body?: unknown) {
    const res = await fetch(`${base}/runs/${id}/cancel`, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("cancels a live run with the caller's reason", async () => {
    const flow: FlowDefinition = { flow: "served", nodes: [{ name: "nap", do: "sleep", duration: "60s", timeout: "5m" }] };
    const { done } = await startOn(runner, flow, "served-run", "nap");
    const res = await cancel("served-run", { reason: "Cancelled by a teammate" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, instanceId: "served-run", status: "cancelled" });
    assert.equal((await done).error, "Cancelled by a teammate");
  });

  it("answers 404 for an unknown run and 409 for a finished one", async () => {
    assert.equal((await cancel("nope")).status, 404);
    assert.equal((await cancel("nope")).body.code, "run_not_found");
    await runner.run({ flow: "done", nodes: [{ name: "one", do: "code", run: "1" }] }, {}, "served-done");
    const finished = await cancel("served-done");
    assert.equal(finished.status, 409);
    assert.equal(finished.body.code, "run_finished");
    assert.equal(finished.body.status, "completed");
  });

  it("does not take a sub-flow id or a bad body", async () => {
    const sub = await fetch(`${base}/runs/x:loop:y:0/cancel`, { method: "POST" });
    assert.equal(sub.status, 404);
    const bad = await fetch(`${base}/runs/served-done/cancel`, { method: "POST", body: "{" });
    assert.equal(bad.status, 400);
  });
});

describe("flow_run guard: a step that names only an agent", () => {
  it("resolves to the agent's main session, as OpenClaw routes it", () => {
    assert.equal(agentStepSessionKey({ agent: "Ops" }), "agent:ops:main");
    assert.equal(agentStepSessionKey({}, "ops"), "agent:ops:main");
    assert.equal(agentStepSessionKey({}, undefined, "Work"), "agent:main:work");
    assert.equal(agentStepSessionKey({ sessionId: "s1" }), undefined);
    assert.equal(agentStepSessionKey({ agent: "ops", sessionKey: "hook:x" }), "agent:ops:hook:x");

    assert.equal(targetsCallerSession({ agent: "main" }, { sessionKey: "agent:main:main" }), true);
    assert.equal(targetsCallerSession({}, { sessionKey: "agent:main:main" }), true);
    assert.equal(targetsCallerSession({ agent: "main" }, { sessionKey: "agent:main:main" }, undefined, "work"), false);
    assert.equal(targetsCallerSession({ agent: "main" }, { sessionKey: "agent:main:user:u1:chat:c1" }), false);
  });

  it("fails such a step at once when flow_run was called from that session, also inside a loop", async () => {
    const runner = new FlowRunner(cfg) as any;
    let calls = 0;
    runner.tryOpenClawAgent = async () => {
      calls++;
      return "OK";
    };
    const flow: FlowDefinition = {
      flow: "nested-agent",
      nodes: [
        { name: "items", do: "code", run: "[1]", output: "items" },
        { name: "each", do: "loop", over: "items", as: "item", nodes: [{ name: "ask", do: "agent", agent: "main", task: "Reply OK" }] },
      ],
    };
    const result = await runner.run(flow, {}, undefined, { caller: { sessionKey: "agent:main:main" } });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /same session as the agent that started this flow/);
    assert.equal(calls, 0);
  });
});
