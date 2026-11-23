import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner, StepRegistry, startFlowServer } from "../src/index.js";
import { TriggerStore } from "../src/core/triggers.js";
import { TriggerScheduler } from "../src/core/scheduler.js";
import type { FlowDefinition, PluginConfig } from "../src/index.js";

// Two rules about runs that would overlap.
//
// A trigger runs one instance at a time, whether a tick or run-now started it.
// A flow that says `overlap: "skip"` runs one instance at a time whoever starts
// it: a trigger, the flow server, or a direct runner.run (the flow_run tool).
// Without the field, runs of one flow overlap freely, which is what starting
// one run per work item relies on.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-overlap-"));
const workspace = path.join(tmpDir, "workspace");
const flowsDir = path.join(workspace, "flows");
const cfg: PluginConfig = {
  stateDir: path.join(tmpDir, "state"),
  memoryDir: path.join(tmpDir, "memory"),
};
const silent = { info: () => {}, warn: () => {}, error: () => {} };

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

/** A flow whose run lasts `duration`, so a second start lands while it is going. */
function slowFlow(name: string, overlap?: "allow" | "skip", duration = "400ms"): FlowDefinition {
  return {
    flow: name,
    ...(overlap ? { overlap } : {}),
    nodes: [
      { name: "work", do: "sleep", duration },
      { name: "done", do: "code", run: "1", output: "result" },
    ],
  };
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

/** A flow whose run lasts until the test opens the gate named after it. */
function heldFlow(name: string, overlap?: "skip"): FlowDefinition {
  return {
    flow: name,
    ...(overlap ? { overlap } : {}),
    nodes: [
      { name: "work", do: "hold" as "code", gate: name } as never,
      { name: "done", do: "code", run: "1", output: "result" },
    ],
  };
}

function writeFlow(def: FlowDefinition): void {
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(path.join(flowsDir, `${def.flow}.json`), JSON.stringify(def, null, 2));
}

describe('overlap: "skip" on a flow', () => {
  it("refuses a second run while one is going, and writes no record for it", async () => {
    const runner = new FlowRunner(cfg);
    const flow = slowFlow("single", "skip");

    const first = runner.run(flow, {}, "single-first");
    const second = await runner.run(flow, {}, "single-second");

    assert.equal(second.ok, false);
    assert.equal(second.status, "skipped");
    assert.equal(second.runningInstanceId, "single-first");
    assert.match(second.error ?? "", /already running \(run single-first\)/);
    assert.equal(await runner.getStore().get("single-second"), null, "a refused start leaves nothing behind");

    assert.equal((await first).status, "completed");
    const third = await runner.run(flow, {}, "single-third");
    assert.equal(third.status, "completed", "the next run starts once the first has ended");
  });

  it("lets exactly one of two starts in the same instant run", async () => {
    const runner = new FlowRunner(cfg);
    const flow = slowFlow("single-race", "skip", "200ms");
    const results = await Promise.all([
      runner.run(flow, {}, "race-a"),
      runner.run(flow, {}, "race-b"),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["completed", "skipped"]);
  });

  it("is seen by another runner on the same store (a second plugin registration)", async () => {
    const flow = slowFlow("single-shared", "skip");
    const first = new FlowRunner(cfg).run(flow, {}, "shared-first");
    const second = await new FlowRunner(cfg).run(flow, {}, "shared-second");
    assert.equal(second.status, "skipped");
    assert.equal(second.runningInstanceId, "shared-first");
    await first;
  });

  it("does not count a run paused at an approval as going", async () => {
    const runner = new FlowRunner(cfg);
    const flow: FlowDefinition = {
      flow: "single-approval",
      overlap: "skip",
      nodes: [
        { name: "gate", do: "wait", for: "approval", prompt: "Go?" },
        { name: "done", do: "code", run: "1", output: "result" },
      ],
    };
    const first = await runner.run(flow, {}, "approval-first");
    assert.equal(first.status, "paused");
    const second = await runner.run(flow, {}, "approval-second");
    assert.equal(second.status, "paused", "a paused run holds nothing back");
  });

  it("leaves a flow without the field free to overlap", async () => {
    const runner = new FlowRunner(cfg);
    const flow = slowFlow("fan-out", undefined, "200ms");
    const results = await Promise.all([
      runner.run(flow, {}, "fan-a"),
      runner.run(flow, {}, "fan-b"),
      runner.run(flow, {}, "fan-c"),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["completed", "completed", "completed"]);
  });

  it("is rejected by validation when it is neither allow nor skip", async () => {
    const runner = new FlowRunner(cfg);
    const result = await runner.run({ ...slowFlow("bad-overlap"), overlap: "queue" as "skip" }, {});
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /"overlap" must be "allow" or "skip"/);
  });
});

describe("a trigger runs one instance at a time", () => {
  function harness() {
    const store = new TriggerStore(workspace);
    const runner = new FlowRunner(cfg);
    const scheduler = new TriggerScheduler({ runner, store, workspace, flowsDir, logger: silent, resyncMs: 0 });
    return { store, runner, scheduler };
  }

  it("refuses run-now while its previous run is going, and says why on the record", async () => {
    writeFlow(slowFlow("hourly"));
    const { store, scheduler } = harness();
    const trigger = store.create({ flowName: "hourly", cron: "0 * * * *" });

    const first = scheduler.runNow(trigger.id);
    const going = scheduler.runInFlight(trigger.id);
    assert.ok(going, "the run is in flight as soon as it is started");

    assert.equal(await scheduler.runNow(trigger.id), null);
    const skipped = store.get(trigger.id)!;
    assert.equal(skipped.lastStatus, "skipped");
    assert.match(skipped.lastError ?? "", new RegExp(`previous run \\(${going}\\) is still going`));

    const result = await first;
    assert.equal(result?.status, "completed");
    assert.equal(scheduler.runInFlight(trigger.id), undefined);
    const done = store.get(trigger.id)!;
    assert.equal(done.lastStatus, "ok");
    assert.equal(done.lastInstanceId, going);

    const again = await scheduler.runNow(trigger.id);
    assert.equal(again?.status, "completed", "run-now works again once the run has ended");
  });

  it("still sees the run from a scheduler built while it is going (the plugin registered again)", async () => {
    writeFlow(slowFlow("reloaded"));
    const { store, scheduler } = harness();
    const trigger = store.create({ flowName: "reloaded", cron: "0 * * * *" });

    const first = scheduler.runNow(trigger.id);
    const going = scheduler.runInFlight(trigger.id);

    const replacement = harness().scheduler;
    assert.equal(replacement.runInFlight(trigger.id), going);
    assert.equal(await replacement.runNow(trigger.id), null);
    await first;
    assert.equal(replacement.runInFlight(trigger.id), undefined);
  });

  it("records a tick that was skipped because the previous run was still going", async () => {
    writeFlow(slowFlow("ticker", undefined, "10ms"));
    const store = new TriggerStore(workspace);
    let inFlight = 0;
    let maxInFlight = 0;
    const slowRunner = {
      run: async (def: FlowDefinition, inputs: unknown, instanceId: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(2_500);
        inFlight--;
        return new FlowRunner(cfg).run(def, inputs, instanceId);
      },
    };
    const scheduler = new TriggerScheduler({ runner: slowRunner, store, workspace, flowsDir, logger: silent, resyncMs: 0 });
    // Per-second, which assertValidSchedule refuses for stored schedules; the
    // store itself does not validate, and the test needs ticks inside one run.
    const trigger = store.create({ flowName: "ticker", cron: "* * * * * *" });

    scheduler.start();
    try {
      await until(() => store.get(trigger.id)?.lastStatus === "skipped", 4_000, "a skipped tick on the record");
      assert.match(store.get(trigger.id)?.lastError ?? "", /is still going/);
    } finally {
      scheduler.stop();
      while (inFlight > 0) await sleep(50);
    }
    assert.equal(maxInFlight, 1, `runs overlapped: ${maxInFlight} at once`);
  });

  it('records a skip, and no instance, when its flow says overlap: "skip" and another run is going', async () => {
    const flow = slowFlow("single-scheduled", "skip");
    writeFlow(flow);
    const { store, runner, scheduler } = harness();
    const trigger = store.create({ flowName: "single-scheduled", cron: "0 * * * *" });

    const byHand = runner.run(flow, {}, "by-hand");
    assert.equal(await scheduler.runNow(trigger.id), null);

    const record = store.get(trigger.id)!;
    assert.equal(record.lastStatus, "skipped");
    assert.match(record.lastError ?? "", /already running \(run by-hand\)/);
    assert.equal(record.lastInstanceId, undefined, "nothing ran, so there is no instance to point at");
    await byHand;
  });
});

describe("flow server: refused starts", () => {
  let server: ReturnType<typeof startFlowServer>;
  let base = "";
  let store: TriggerStore;
  let scheduler: TriggerScheduler;

  async function call(method: string, p: string, body?: unknown) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  before(async () => {
    writeFlow(heldFlow("http-single", "skip"));
    writeFlow(slowFlow("http-many", undefined, "50ms"));
    writeFlow(heldFlow("http-scheduled"));
    const registry = new StepRegistry();
    holdStep(registry);
    const runner = new FlowRunner({ ...cfg, customSteps: registry });
    store = new TriggerStore(workspace);
    scheduler = new TriggerScheduler({ runner, store, workspace, flowsDir, logger: silent, resyncMs: 0 });
    server = startFlowServer({
      runner,
      serve: { port: 0, flowsDir },
      workspace,
      logger: silent,
      triggers: () => ({ store, scheduler }),
    });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/flows`;
  });

  after(async () => {
    scheduler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers 409 flow_running for a flow that says overlap: "skip", naming the run in flight', async () => {
    const first = await call("POST", "/http-single/run", {});
    assert.equal(first.status, 202);

    const second = await call("POST", "/http-single/run", {});
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "flow_running");
    assert.equal(second.body.runningInstanceId, first.body.instanceId);
    // An http step does not fail on a status code: a caller that stores
    // `instanceId` must not be handed another run's id under that key.
    assert.equal("instanceId" in second.body, false);

    gate("http-single").open();
    await until(async () => (await call("GET", `/runs/${first.body.instanceId}/status`)).body.finished, 4_000, "the first run to end");
    const third = await call("POST", "/http-single/run", {});
    assert.equal(third.status, 202);
    await until(async () => (await call("GET", `/runs/${third.body.instanceId}/status`)).body.finished, 4_000, "the third run to end");
  });

  it("starts every run of a flow without the field", async () => {
    const a = await call("POST", "/http-many/run", {});
    const b = await call("POST", "/http-many/run", {});
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.notEqual(a.body.instanceId, b.body.instanceId);
    for (const id of [a.body.instanceId, b.body.instanceId]) {
      await until(async () => (await call("GET", `/runs/${id}/status`)).body.finished, 4_000, `run ${id} to end`);
    }
  });

  it("answers 409 trigger_running for run-now while the trigger's run is going", async () => {
    const trigger = store.create({ flowName: "http-scheduled", cron: "0 * * * *" });
    const first = await call("POST", `/triggers/${trigger.id}/run`);
    assert.equal(first.status, 202);
    const going = await until(() => scheduler.runInFlight(trigger.id), 2_000, "the run to start");

    const second = await call("POST", `/triggers/${trigger.id}/run`);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "trigger_running");
    assert.equal(second.body.runningInstanceId, going);

    gate("http-scheduled").open();
    await until(() => !scheduler.runInFlight(trigger.id), 4_000, "the run to end");
    assert.equal(store.get(trigger.id)?.lastStatus, "ok");
  });
});
