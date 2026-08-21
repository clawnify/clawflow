import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner } from "../src/index.js";
import { TriggerStore } from "../src/core/triggers.js";
import { TriggerScheduler, assertValidSchedule } from "../src/core/scheduler.js";
import { publishDraft } from "../src/core/manage.js";
import type { FlowDefinition, PluginConfig } from "../src/index.js";

const tmpDir = path.join(os.tmpdir(), `ocf-scheduler-test-${Date.now()}`);
const workspace = path.join(tmpDir, "workspace");
const flowsDir = path.join(workspace, "flows");
const baseCfg: PluginConfig = {
  stateDir: path.join(tmpDir, "state"),
  memoryDir: path.join(tmpDir, "memory"),
};

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeDraft(name: string, run: string): void {
  const def: FlowDefinition = {
    flow: name,
    nodes: [{ name: "step1", do: "code", run, output: "result" }],
  };
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(path.join(flowsDir, `${name}.json`), JSON.stringify(def, null, 2));
}

function harness() {
  const store = new TriggerStore(workspace);
  const runner = new FlowRunner(baseCfg);
  const scheduler = new TriggerScheduler({
    runner,
    store,
    workspace,
    flowsDir,
    logger: silent,
  });
  return { store, scheduler };
}

describe("assertValidSchedule", () => {
  it("accepts a standard 5-field expression with a timezone", () => {
    assert.doesNotThrow(() => assertValidSchedule("0 9 * * *", "Europe/Rome"));
  });

  it("rejects an unparseable expression", () => {
    assert.throws(() => assertValidSchedule("not a cron"), /Invalid schedule/);
  });

  it("rejects an invalid timezone", () => {
    assert.throws(() => assertValidSchedule("0 9 * * *", "Mars/Olympus"), /Invalid schedule/);
  });

  it("rejects sub-minute schedules — agents can write these", () => {
    assert.throws(() => assertValidSchedule("* * * * * *"), /minimum interval is 60s/);
    assert.throws(() => assertValidSchedule("*/5 * * * * *"), /minimum interval is 60s/);
  });

  it("accepts every-minute, the fastest allowed cadence", () => {
    assert.doesNotThrow(() => assertValidSchedule("* * * * *"));
  });
});

describe("TriggerScheduler", () => {
  before(cleanup);
  after(cleanup);

  it("arms only enabled triggers and disarms paused ones", () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("armed", "1");

    const on = store.create({ flowName: "armed", cron: "0 9 * * *" });
    const off = store.create({ flowName: "armed", cron: "0 10 * * *", enabled: false });

    scheduler.start();
    assert.ok(scheduler.nextRun(on.id), "enabled trigger is armed");
    assert.equal(scheduler.nextRun(off.id), null, "disabled trigger is not armed");

    store.update(on.id, { enabled: false });
    scheduler.sync();
    assert.equal(scheduler.nextRun(on.id), null, "pausing disarms on next sync");
    scheduler.stop();
  });

  it("records nextRunAt when arming", () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("nextrun", "1");
    const rec = store.create({ flowName: "nextrun", cron: "0 9 * * *", tz: "Europe/Rome" });

    scheduler.start();
    const stored = store.get(rec.id);
    assert.ok(stored?.nextRunAt, "nextRunAt persisted");
    assert.equal(
      new Date(stored!.nextRunAt!).toISOString(),
      scheduler.nextRun(rec.id)!.toISOString(),
      "persisted value matches the armed timer",
    );
    scheduler.stop();
  });

  it("runs the published version, not the draft", async () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("versioned", "'v1'");
    publishDraft(workspace, "versioned");
    // Draft moves on; the published version must still be what fires.
    writeDraft("versioned", "'draft-edit'");

    const rec = store.create({ flowName: "versioned", cron: "0 9 * * *" });
    const result = await scheduler.runNow(rec.id);

    assert.equal(result?.ok, true);
    assert.equal(result?.state.result, "v1", "fired the published version");
    scheduler.stop();
  });

  it("honors a pinned version", async () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("pinned", "'one'");
    publishDraft(workspace, "pinned");
    writeDraft("pinned", "'two'");
    publishDraft(workspace, "pinned");

    const rec = store.create({ flowName: "pinned", cron: "0 9 * * *", version: 1 });
    const result = await scheduler.runNow(rec.id);
    assert.equal(result?.state.result, "one", "ran v1, not latest");
    scheduler.stop();
  });

  it("passes the record's inputs to the flow", async () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("with-inputs", "state.inputs.customer");
    const rec = store.create({
      flowName: "with-inputs",
      cron: "0 9 * * *",
      inputs: { customer: "acme" },
    });

    const result = await scheduler.runNow(rec.id);
    assert.equal(result?.state.result, "acme");
    scheduler.stop();
  });

  it("records a skip when the flow is missing instead of throwing", async () => {
    cleanup();
    const { store, scheduler } = harness();
    const rec = store.create({ flowName: "ghost", cron: "0 9 * * *" });

    const result = await scheduler.runNow(rec.id);
    assert.equal(result, null);
    const stored = store.get(rec.id);
    assert.equal(stored?.lastStatus, "skipped");
    assert.match(stored?.lastError ?? "", /not found/);
    scheduler.stop();
  });

  it("records run bookkeeping after a successful fire", async () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("bookkeeping", "1");
    const rec = store.create({ flowName: "bookkeeping", cron: "0 9 * * *" });

    await scheduler.runNow(rec.id);
    const stored = store.get(rec.id);
    assert.equal(stored?.lastStatus, "ok");
    assert.ok(stored?.lastRunAt, "lastRunAt stamped");
    assert.ok(stored?.lastInstanceId, "instance id recorded");
    scheduler.stop();
  });

  it("does not fire a paused trigger even if its timer survives", async () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("paused", "1");
    const rec = store.create({ flowName: "paused", cron: "0 9 * * *" });
    store.update(rec.id, { enabled: false });

    // Simulate the armed timer firing after the record was paused.
    const fire = (scheduler as unknown as {
      fire: (r: unknown) => Promise<unknown>;
    }).fire.bind(scheduler);
    const result = await fire(rec);

    assert.equal(result, null, "re-read the record and declined to run");
    assert.equal(store.get(rec.id)?.lastStatus, undefined, "no run recorded");
    scheduler.stop();
  });

  it("picks up a trigger written out-of-process", () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("offbox", "1");
    scheduler.start();

    // The Clawnify hook server / dashboard writes records through TriggerStore
    // imported from dist — a different process, same directory.
    const offBox = new TriggerStore(workspace);
    const rec = offBox.create({ flowName: "offbox", cron: "0 9 * * *" });
    assert.equal(scheduler.nextRun(rec.id), null, "not armed until the next resync");

    scheduler.sync();
    assert.ok(scheduler.nextRun(rec.id), "armed after resync");
    scheduler.stop();
  });

  it("picks up an out-of-process edit and re-arms to the new cadence", () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("retimed", "1");
    const rec = store.create({ flowName: "retimed", cron: "0 9 * * *", tz: "UTC" });
    scheduler.start();
    const before = scheduler.nextRun(rec.id)!;

    new TriggerStore(workspace).update(rec.id, { cron: "0 10 * * *" });
    scheduler.sync();

    const after = scheduler.nextRun(rec.id)!;
    assert.notEqual(before.toISOString(), after.toISOString(), "re-armed to the new time");
    assert.equal(after.getUTCHours(), 10);
    scheduler.stop();
  });

  it("does not rebuild an unchanged timer on resync", () => {
    cleanup();
    const { store, scheduler } = harness();
    writeDraft("stable", "1");
    const rec = store.create({ flowName: "stable", cron: "0 9 * * *" });
    scheduler.start();

    const jobs = (scheduler as unknown as { jobs: Map<string, unknown> }).jobs;
    const first = jobs.get(rec.id);
    scheduler.sync();
    assert.equal(jobs.get(rec.id), first, "same timer survives a no-op resync");

    store.update(rec.id, { cron: "0 11 * * *" });
    scheduler.sync();
    assert.notEqual(jobs.get(rec.id), first, "a real change rebuilds it");
    scheduler.stop();
  });

  it("fires repeatedly on its own timer, end to end", async () => {
    cleanup();
    const store = new TriggerStore(workspace);
    writeDraft("ticker", "'tick'");

    // Count real fires through the runner so this proves the timer RE-ARMS,
    // not just that it fired once.
    const inner = new FlowRunner(baseCfg);
    const fired: string[] = [];
    const counting = {
      run: (def: FlowDefinition, inputs: unknown, instanceId: string) => {
        fired.push(instanceId);
        return inner.run(def, inputs, instanceId);
      },
    };
    const scheduler = new TriggerScheduler({
      runner: counting,
      store,
      workspace,
      flowsDir,
      logger: silent,
    });

    // Sub-minute is rejected at the tool boundary; written straight to the
    // store here so the timer path itself can be exercised in-test.
    const rec = store.create({ flowName: "ticker", cron: "* * * * * *" });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 3200));
    scheduler.stop();

    assert.ok(
      fired.length >= 2,
      `expected the timer to re-arm and fire at least twice, got ${fired.length}`,
    );
    assert.equal(new Set(fired).size, fired.length, "each fire gets its own instance id");

    const stored = store.get(rec.id);
    assert.equal(stored?.lastStatus, "ok", "the timer fired the flow unattended");
    assert.ok(stored?.lastRunAt, "run was recorded");
    assert.ok(stored?.nextRunAt, "next occurrence recorded after firing");
  });

});
