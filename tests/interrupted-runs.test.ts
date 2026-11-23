import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { FlowRunner, StepRegistry, startFlowServer } from "../src/index.js";
import type { ExecutionStore, FlowDefinition, InstanceRecord, PluginConfig, RunOwner, StorageConfig } from "../src/index.js";
import { HEARTBEAT_MS, OWNER_STALE_MS, engineOwner, leaseSettled } from "../src/core/ownership.js";
import { reconcilePass } from "../src/plugin/index.js";

// A run whose process is killed before it can record its end used to say
// "running" for good. Each run now names the process executing it, a process
// says it is alive in the store while it has runs there, and reconcile() fails
// the runs whose process is gone.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(check: () => T | Promise<T>, ms = 15_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A `hold` step waits here until the test opens its gate, so "the run is
 *  still going" never depends on how fast the machine is. */
function gates() {
  const all = new Map<string, { opened: Promise<void>; open: () => void }>();
  return (name: string) => {
    let g = all.get(name);
    if (!g) {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      g = { opened, open };
      all.set(name, g);
    }
    return g;
  };
}

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "run-flow.ts");

/** Start `flow` in another process against the same store. */
function runElsewhere(cfg: PluginConfig, flow: FlowDefinition, instanceId: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", fixture, JSON.stringify(cfg), JSON.stringify(flow), JSON.stringify(instanceId)], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

/** A pid that belonged to a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

const postgres = !!process.env.CLAWFLOW_TEST_POSTGRES_URL;

/** What a pass answers when it had nothing to do. */
const nothing = { failed: [], unowned: 0, errors: [] };

/** A record another process is writing: a read that lands inside a JSON write
 *  sees half a file, which is "not there yet", not a failure. */
async function peek(store: ExecutionStore, id: string): Promise<InstanceRecord | null> {
  try { return await store.get(id); } catch { return null; }
}

for (const backend of ["json", "sqlite", "postgres"] as const) {
  describe(`interrupted runs: ${backend}`, { skip: backend === "postgres" && !postgres }, () => {
    function setup(t: { after: (fn: () => unknown) => void }) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawflow-interrupted-"));
      const namespace = `test-${randomUUID()}`;
      const storage: StorageConfig = backend === "json" ? { backend }
        : backend === "sqlite" ? { backend, path: path.join(dir, "state.sqlite") }
        : { backend, connectionStringEnv: "CLAWFLOW_TEST_POSTGRES_URL", namespace };
      const registry = new StepRegistry();
      const gate = gates();
      const ran: string[] = [];
      registry.register({ name: "hold", allowedKeys: ["gate"], run: async (input) => { await gate(String(input.gate)).opened; return "released"; } });
      registry.register({ name: "mark", allowedKeys: ["as"], run: (input) => { ran.push(String(input.as)); return ran.length; } });
      const cfg: PluginConfig = { stateDir: dir, storage };
      const runner = new FlowRunner({ ...cfg, customSteps: registry });
      const store = runner.getStore();
      const children: ChildProcess[] = [];
      t.after(async () => {
        for (const child of children) await kill(child);
        await until(async () => { try { await runner.close(); return true; } catch { return false; } }, 5_000, "the runs of this test to end");
        fs.rmSync(dir, { recursive: true, force: true });
      });

      /** Make the store's last word from `ownerId` older by `ms`. */
      const age = async (ownerId: string, ms: number) => {
        if (backend === "json") {
          const file = path.join(dir, "_owners", `${ownerId}.json`);
          const then = new Date(fs.statSync(file).mtimeMs - ms);
          fs.utimesSync(file, then, then);
        } else if (backend === "sqlite") {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(path.join(dir, "state.sqlite"));
          try { db.prepare("UPDATE clawflow_owners SET heartbeat_ms = heartbeat_ms - ? WHERE id = ?").run(ms, ownerId); }
          finally { db.close(); }
        } else {
          const { Client } = await import("pg");
          const client = new Client({ connectionString: process.env.CLAWFLOW_TEST_POSTGRES_URL });
          await client.connect();
          try { await client.query("UPDATE clawflow_owners SET heartbeat_ms = heartbeat_ms - $1 WHERE namespace = $2 AND id = $3", [ms, namespace, ownerId]); }
          finally { await client.end(); }
        }
      };
      const elsewhere = (flow: FlowDefinition, instanceId: string) => {
        const child = runElsewhere(cfg, flow, instanceId);
        children.push(child);
        return child;
      };
      return { dir, cfg, runner, store, gate, ran, age, elsewhere };
    }

    /** An engine process that is not this one. */
    const someone = (pid: number): RunOwner => ({ id: randomUUID(), pid, host: os.hostname(), startedAt: new Date().toISOString() });

    /** Stops for ten minutes inside the first iteration of a loop. */
    const napping = { flow: "napping", nodes: [
      { name: "first", do: "code", run: "1", output: "first" },
      { name: "list", do: "code", run: "[1, 2]", output: "items" },
      { name: "batch", do: "loop", over: "items", as: "item", nodes: [{ name: "nap", do: "sleep", duration: "10m" }] },
      { name: "never", do: "code", run: "2", output: "never" },
    ] } as unknown as FlowDefinition;

    it("a run whose process is killed is marked failed, with the step it was on", async (t) => {
      const { runner, store, age, elsewhere } = setup(t);
      const child = elsewhere(napping, "killed");
      const iteration = "killed:loop:batch:0";
      await until(async () => (await peek(store, iteration))?.running?.node === "nap", 20_000, "the other process to reach its sleep");

      const owner = (await store.get("killed"))!.owner!;
      assert.equal(owner.pid, child.pid, "the run names the process executing it");
      assert.notEqual(owner.id, engineOwner.id);
      assert.deepEqual((await store.listRuns({ status: "running" })).runs[0].owner, owner, "a list row carries it too");

      // Alive: nothing is touched, however often this runs.
      assert.deepEqual(await runner.reconcile({ full: true }), nothing);
      assert.equal((await store.get("killed"))!.status, "running");

      await kill(child);
      // A store on this machine sees the pid is gone at once. A shared database
      // cannot know whose machine the pid was on, and waits for the heartbeat.
      if (backend === "postgres") {
        assert.deepEqual((await runner.reconcile()).failed, [], "a fresh heartbeat still counts as alive");
        await age(owner.id, OWNER_STALE_MS + 1_000);
      }
      const result = await runner.reconcile();
      assert.deepEqual(result.failed.map((r) => r.instanceId), ["killed"]);
      assert.equal(result.failed[0].flowName, "napping");

      const record = (await store.get("killed"))!;
      assert.equal(record.status, "failed");
      assert.match(record.error!, /^Interrupted: the process running this flow stopped during step "batch"/);
      assert.equal(record.running, undefined);
      assert.deepEqual(record.trace.map((e) => [e.node, e.status]), [["first", "ok"], ["list", "ok"], ["batch", "error"]]);
      assert.equal(record.trace[2].error, record.error);
      assert.equal(record.state.never, undefined);

      const sub = (await store.get(iteration))!;
      assert.equal(sub.status, "failed", "the loop iteration it was inside is ended too");
      assert.match(sub.error!, /during step "nap"/);
      assert.equal(sub.running, undefined);

      const status = await runner.runStatus("killed");
      assert.equal(status!.status, "failed");
      assert.equal(status!.finished, true);
      assert.equal((await store.listRuns({ status: "running" })).total, 0);
      assert.deepEqual(await store.owners(), [], "the dead process is forgotten");
      assert.deepEqual(await runner.reconcile({ full: true }), nothing, "a second pass finds nothing");
    });

    it("a pid that exists is not proof: only the heartbeat says a process is alive", async (t) => {
      const { runner, store, age } = setup(t);
      // The owner's pid now belongs to another live process (this one), as
      // after a reboot. Its heartbeat is what went quiet.
      const owner = someone(process.pid);
      await store.beat(owner);
      await store.create("reused-pid", "flow", {}, owner);
      assert.deepEqual((await runner.reconcile({ full: true })).failed, []);

      await age(owner.id, OWNER_STALE_MS - 30_000);
      assert.deepEqual((await runner.reconcile({ full: true })).failed, [], "quiet for less than the limit is still alive");

      await age(owner.id, 60_000);
      const result = await runner.reconcile();
      assert.deepEqual(result.failed.map((r) => r.instanceId), ["reused-pid"]);
      assert.equal((await store.get("reused-pid"))!.status, "failed");

      // Heard from again: back to alive, with a fresh age.
      await store.beat(owner);
      const [beat] = await store.owners();
      assert.equal(beat.id, owner.id);
      assert.ok(beat.ageMs < 5_000, `age ${beat.ageMs}`);
    });

    it("a run whose owner the store never heard from, or has forgotten, is interrupted", async (t) => {
      const { runner, store } = setup(t);
      await store.create("no-heartbeat", "flow", {}, someone(process.pid));
      const result = await runner.reconcile({ full: true });
      assert.deepEqual(result.failed.map((r) => r.instanceId), ["no-heartbeat"]);
    });

    it(backend === "postgres"
      ? "a shared database does not judge a process by its pid"
      : "a store on this machine sees at once that the owner's pid is gone", async (t) => {
      const { runner, store } = setup(t);
      const owner = someone(await exitedPid());
      await store.beat(owner);
      await store.create("dead-pid", "flow", {}, owner);
      const result = await runner.reconcile();
      if (backend === "postgres") {
        assert.deepEqual(result.failed, []);
        assert.equal((await store.get("dead-pid"))!.status, "running");
      } else {
        assert.deepEqual(result.failed.map((r) => r.instanceId), ["dead-pid"]);
      }
    });

    it("a pid on another host proves nothing", async (t) => {
      const { runner, store } = setup(t);
      const owner = { ...someone(await exitedPid()), host: "another-host" };
      await store.beat(owner);
      await store.create("elsewhere", "flow", {}, owner);
      assert.deepEqual((await runner.reconcile({ full: true })).failed, []);
      assert.equal((await store.get("elsewhere"))!.status, "running");
    });

    it("a run with no owner on record is left alone unless asked", async (t) => {
      const { runner, store } = setup(t);
      await store.create("legacy", "flow", {});
      await store.update("legacy", { running: { node: "wait-for-reply", do: "wait", startedAt: new Date(Date.now() - 90_000).toISOString() } });
      assert.deepEqual(await runner.reconcile(), { ...nothing, unowned: 1 });
      assert.equal((await store.get("legacy"))!.status, "running");

      const result = await runner.reconcile({ unowned: true });
      assert.deepEqual(result.failed.map((r) => r.instanceId), ["legacy"]);
      assert.equal(result.unowned, 0);
      const record = (await store.get("legacy"))!;
      assert.equal(record.status, "failed");
      assert.match(record.error!, /^Interrupted: the run was left marked running during step "wait-for-reply"/);
    });

    it("a run executing in this process is never touched; one it dropped is failed", async (t) => {
      const { runner, store, gate } = setup(t);
      const flow = { flow: "held", nodes: [{ name: "hold", do: "hold", gate: "live" }] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "live-here");
      await until(async () => (await store.get("live-here"))?.running?.node === "hold");
      assert.equal((await store.get("live-here"))!.owner!.id, engineOwner.id);

      // A record that names this process while nothing here is executing it.
      await store.create("dropped", "flow", {}, engineOwner);
      const result = await runner.reconcile({ full: true });
      assert.deepEqual(result.failed.map((r) => r.instanceId), ["dropped"]);
      assert.match(result.failed[0].error, /^Interrupted: the run was left marked running, with no process running it/);
      assert.equal((await store.get("live-here"))!.status, "running");

      gate("live").open();
      assert.equal((await going).status, "completed");
    });

    it("a run that was failed while its process was only stalled stops at its next step and stays failed", async (t) => {
      const { runner, store, gate, ran } = setup(t);
      const flow = { flow: "stalled", nodes: [
        { name: "hold", do: "hold", gate: "stalled", output: "held" },
        { name: "after", do: "mark", as: "after" },
      ] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "stalled-run");
      await until(async () => (await store.get("stalled-run"))?.running?.node === "hold");

      // What a reconcile pass in another process writes once this one's
      // heartbeat has gone quiet for too long.
      const verdict = "Interrupted: the process running this flow stopped during step \"hold\", before the run could finish.";
      await store.amend("stalled-run", () => ({ status: "failed", error: verdict, running: undefined }));

      const failedRecord = await store.get("stalled-run");

      gate("stalled").open();
      const result = await going;
      assert.equal(result.ok, false);
      assert.equal(result.status, "failed");
      assert.equal(result.error, verdict);
      assert.deepEqual(ran, [], "nothing after the step it was on runs");
      assert.deepEqual(await store.get("stalled-run"), failedRecord, "the step that finished late wrote nothing: no output, no trace entry, no new timestamp");
    });

    it("a run failed from outside stops inside a loop, not after it", async (t) => {
      const { runner, store, gate, ran } = setup(t);
      const flow = { flow: "stalled-loop", nodes: [
        { name: "list", do: "code", run: "[1, 2, 3]", output: "items" },
        { name: "each", do: "loop", over: "items", as: "item", nodes: [
          { name: "hold", do: "hold", gate: "in-loop" },
          { name: "work", do: "mark", as: "iteration" },
        ] },
        { name: "after", do: "mark", as: "after" },
      ] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "stalled-loop-run");
      await until(async () => (await store.get("stalled-loop-run:loop:each:0"))?.running?.node === "hold");
      await store.amend("stalled-loop-run", () => ({ status: "failed", error: "Interrupted: test", running: undefined }));

      gate("in-loop").open(); // every iteration's hold would now pass at once
      const result = await going;
      assert.equal(result.status, "failed");
      assert.equal(result.error, "Interrupted: test");
      assert.deepEqual(ran, [], "no step of any iteration runs once the run has failed");
      assert.equal(await store.get("stalled-loop-run:loop:each:1"), null, "the next iteration never starts");
      assert.equal((await store.get("stalled-loop-run"))!.status, "failed");
    });

    it("a run cancelled by another process stops inside a loop too", async (t) => {
      const { runner, store, gate, ran } = setup(t);
      const flow = { flow: "cancelled-loop", nodes: [
        { name: "list", do: "code", run: "[1, 2, 3]", output: "items" },
        { name: "each", do: "loop", over: "items", as: "item", nodes: [
          { name: "hold", do: "hold", gate: "cancel-loop" },
          { name: "work", do: "mark", as: "iteration" },
        ] },
      ] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "cancelled-loop-run");
      await until(async () => (await store.get("cancelled-loop-run:loop:each:0"))?.running?.node === "hold");
      // What cancel() writes from a process that does not hold the run.
      await store.amend("cancelled-loop-run", () => ({ status: "cancelled", error: "Cancelled elsewhere", running: undefined }));
      gate("cancel-loop").open();
      const result = await going;
      assert.equal(result.status, "cancelled");
      assert.equal(result.error, "Cancelled elsewhere");
      assert.deepEqual(ran, []);
      assert.equal((await store.get("cancelled-loop-run"))!.status, "cancelled");
    });

    it("a failed run does not become a paused one when the late step is an approval", async (t) => {
      const { runner, store } = setup(t);
      const flow = { flow: "late-approval", nodes: [{ name: "gate", do: "wait", for: "approval" }] } as unknown as FlowDefinition;
      // Fail the run just after the step has recorded that it started. (Not an
      // async wrapper: the JSON store calls its own update() synchronously.)
      const update = store.update.bind(store);
      (store as ExecutionStore).update = (id, patch) => {
        const written = update(id, patch);
        if (patch.running?.node !== "gate") return written;
        const failed = store.amend(id, () => ({ status: "failed", error: "Interrupted: test", running: undefined }));
        return failed instanceof Promise ? failed.then(() => written) : written;
      };
      const result = await runner.run(flow, {}, "late-approval-run");
      (store as ExecutionStore).update = update;
      assert.equal(result.status, "failed");
      const record = (await store.get("late-approval-run"))!;
      assert.equal(record.status, "failed");
      assert.equal(record.resumeToken, undefined);
      assert.equal(record.waitingFor, undefined);
      assert.deepEqual(await runner.listApprovals(), [], "no approval is left pending for a failed run");
    });

    it("cancelling a run that was failed while it executed here stops it and leaves it failed", async (t) => {
      const { runner, store, ran } = setup(t);
      const flow = { flow: "cancel-failed", nodes: [
        { name: "hold", do: "hold", gate: "never-opened" },
        { name: "after", do: "mark", as: "after" },
      ] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "cancel-failed-run");
      await until(async () => (await store.get("cancel-failed-run"))?.running?.node === "hold");
      await store.amend("cancel-failed-run", () => ({ status: "failed", error: "Interrupted: test", running: undefined }));
      const failedRecord = await store.get("cancel-failed-run");

      assert.deepEqual(await runner.cancel("cancel-failed-run"), { ok: false, instanceId: "cancel-failed-run", error: "finished", status: "failed" });
      const result = await going;
      assert.equal(result.status, "failed");
      assert.deepEqual(ran, []);
      assert.deepEqual(await store.get("cancel-failed-run"), failedRecord);
    });

    it("a stalled run on its last step does not turn a failed run into a completed one", async (t) => {
      const { runner, store, gate } = setup(t);
      const flow = { flow: "last-step", nodes: [{ name: "hold", do: "hold", gate: "last" }] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "last-step-run");
      await until(async () => (await store.get("last-step-run"))?.running?.node === "hold");
      await store.amend("last-step-run", () => ({ status: "failed", error: "Interrupted: test", running: undefined }));
      gate("last").open();
      const result = await going;
      assert.equal(result.status, "failed");
      assert.equal(result.error, "Interrupted: test");
      assert.equal((await store.get("last-step-run"))!.status, "failed");
      assert.equal((await runner.runStatus("last-step-run"))!.status, "failed");
    });

    it("a run paused and resumed between a pass's look and its write is not failed", async (t) => {
      const { runner, store, gate } = setup(t);
      const flow = { flow: "reclaimed", nodes: [
        { name: "before", do: "hold", gate: "before" },
        { name: "approve", do: "wait", for: "approval" },
        { name: "after", do: "hold", gate: "after" },
      ] } as unknown as FlowDefinition;
      const first = runner.run(flow, {}, "reclaimed-run");
      await until(async () => (await store.get("reclaimed-run"))?.running?.node === "before");

      // The pass has read the run as running. Before it decides, the run
      // reaches its approval and pauses, so it is not executing here...
      let resumed: Promise<unknown> | undefined;
      const listRuns = store.listRuns.bind(store);
      const owners = store.owners.bind(store);
      const amend = store.amend.bind(store);
      let listed = false;
      let paused: Awaited<typeof first> | undefined;
      (store as ExecutionStore).listRuns = async (opts) => { const page = await listRuns(opts); listed = true; return page; };
      (store as ExecutionStore).owners = async () => {
        if (listed && !paused) {
          gate("before").open();
          paused = await first;
        }
        return owners();
      };
      // ...and before the pass writes, it is approved and going again.
      (store as ExecutionStore).amend = async (id, change) => {
        if (id === "reclaimed-run" && !resumed) {
          resumed = runner.resume(paused!.resumeToken!, flow, true);
          await until(async () => (await store.get("reclaimed-run"))?.running?.node === "after");
        }
        return amend(id, change);
      };
      const result = await runner.reconcile({ full: true });
      (store as ExecutionStore).listRuns = listRuns;
      (store as ExecutionStore).owners = owners;
      (store as ExecutionStore).amend = amend;

      assert.deepEqual(result, nothing);
      assert.ok(resumed, "the pass did get as far as its write");
      assert.equal((await store.get("reclaimed-run"))!.status, "running");
      gate("after").open();
      assert.equal(((await resumed) as { status: string }).status, "completed");
    });

    it("the same, when another process paused it, went idle and took it again", async (t) => {
      const { runner, store } = setup(t);
      const other = someone(process.pid);
      await store.beat(other);
      await store.create("retaken", "flow", {}, other);

      const owners = store.owners.bind(store);
      const amend = store.amend.bind(store);
      let step = 0;
      (store as ExecutionStore).owners = async () => {
        // After the pass has listed the run: it pauses, and its process, with
        // no run left, stops saying it is alive.
        if (step === 1) {
          step = 2;
          await amend("retaken", () => ({ status: "paused", owner: undefined, claim: undefined }));
          await store.forgetOwner(other.id);
        }
        return owners();
      };
      const listRuns = store.listRuns.bind(store);
      (store as ExecutionStore).listRuns = async (opts) => { const page = await listRuns(opts); if (step === 0) step = 1; return page; };
      (store as ExecutionStore).amend = async (id, change) => {
        // Before the pass writes: the same process resumes it.
        if (id === "retaken" && step === 2) {
          step = 3;
          await store.beat(other);
          await amend("retaken", () => ({ status: "running", owner: other, claim: "second-claim" }));
        }
        return amend(id, change);
      };
      const result = await runner.reconcile({ full: true });
      (store as ExecutionStore).owners = owners;
      (store as ExecutionStore).amend = amend;
      (store as ExecutionStore).listRuns = listRuns;

      assert.equal(step, 3, "the pass did get as far as its write");
      assert.deepEqual(result, nothing);
      assert.equal((await store.get("retaken"))!.status, "running");
    });

    it("a resumed run belongs to the process that resumed it", async (t) => {
      const { runner, store, gate, age } = setup(t);
      const flow = { flow: "approve-then-hold", nodes: [
        { name: "gate", do: "wait", for: "approval" },
        { name: "hold", do: "hold", gate: "resumed" },
      ] } as unknown as FlowDefinition;
      const paused = await runner.run(flow, {}, "resumed-run");
      assert.equal(paused.status, "paused");

      // The process that paused it is long gone. A paused run has no process:
      // it is not failed, and whoever resumes it becomes its owner.
      const gone = someone(await exitedPid());
      await store.beat(gone);
      await age(gone.id, OWNER_STALE_MS * 2);
      await store.amend("resumed-run", () => ({ owner: gone }));
      assert.deepEqual((await runner.reconcile({ full: true })).failed, []);
      assert.equal((await store.get("resumed-run"))!.status, "paused");
      assert.equal((await runner.runStatus("resumed-run"))!.status, "paused");

      const going = runner.resume(paused.resumeToken!, flow, true);
      await until(async () => (await store.get("resumed-run"))?.running?.node === "hold");
      assert.equal((await store.get("resumed-run"))!.owner!.id, engineOwner.id);
      assert.deepEqual((await runner.reconcile({ full: true })).failed, []);
      gate("resumed").open();
      assert.equal((await going).status, "completed");
    });

    it("a process says it is alive only while it has runs", async (t) => {
      const { runner, store, gate } = setup(t);
      const flow = (name: string) => ({ flow: name, nodes: [{ name: "hold", do: "hold", gate: name }] }) as unknown as FlowDefinition;
      assert.deepEqual(await store.owners(), []);

      const one = runner.run(flow("one"), {}, "one");
      const two = runner.run(flow("two"), {}, "two");
      await until(async () => (await store.get("two"))?.running?.node === "hold");
      const beats = await store.owners();
      assert.deepEqual(beats.map(({ ageMs, ...owner }) => owner), [engineOwner]);
      assert.ok(beats[0].ageMs < 5_000, `age ${beats[0].ageMs}`);

      gate("one").open();
      await one;
      await leaseSettled(store);
      assert.equal((await store.owners()).length, 1, "still held by the other run");

      gate("two").open();
      await two;
      await leaseSettled(store);
      assert.deepEqual(await store.owners(), [], "an idle process is not an owner");
      assert.equal((await store.listRuns({})).runs.every((r) => r.owner === undefined), true, "a finished run's row names no owner");
    });

    it("every run a process takes is preceded by a fresh heartbeat", async (t) => {
      const { runner, store, gate, age } = setup(t);
      const flow = (name: string) => ({ flow: name, nodes: [{ name: "hold", do: "hold", gate: name }] }) as unknown as FlowDefinition;
      const first = runner.run(flow("first"), {}, "first");
      await until(async () => (await store.get("first"))?.running?.node === "hold");

      // The process was stalled past the limit and comes back: before its
      // timer has fired, it takes another run.
      await age(engineOwner.id, OWNER_STALE_MS + 10_000);
      const second = runner.run(flow("second"), {}, "second");
      await until(async () => (await store.get("second"))?.running?.node === "hold");
      assert.ok((await store.owners())[0].ageMs < 5_000, "the store heard from it before the second run was created");

      // A pass elsewhere had forgotten it altogether.
      await store.forgetOwner(engineOwner.id);
      const third = runner.run(flow("third"), {}, "third");
      await until(async () => (await store.get("third"))?.running?.node === "hold");
      assert.deepEqual((await store.owners()).map((b) => b.id), [engineOwner.id]);

      for (const name of ["first", "second", "third"]) gate(name).open();
      await Promise.all([first, second, third]);
    });

    it("a run is not started when the store cannot hear from the process", async (t) => {
      const { runner, store } = setup(t);
      const beat = store.beat.bind(store);
      (store as ExecutionStore).beat = () => { throw new Error("disk full"); };
      const flow = { flow: "no-beat", nodes: [{ name: "one", do: "code", run: "1" }] } as unknown as FlowDefinition;
      await assert.rejects(runner.run(flow, {}, "no-beat-run"), /disk full/);
      assert.equal(await store.get("no-beat-run"), null, "no record names a process the store never heard from");
      (store as ExecutionStore).beat = beat;
      assert.equal((await runner.run(flow, {}, "no-beat-run")).status, "completed", "and nothing is left held");
    });

    it("a run dropped because its last write failed is found by the next pass", async (t) => {
      const { runner, store } = setup(t);
      await runner.reconcile(); // this process's first pass is behind it
      const flow = { flow: "dropped", nodes: [{ name: "one", do: "code", run: "1", output: "one" }] } as unknown as FlowDefinition;
      const update = store.update.bind(store);
      (store as ExecutionStore).update = (id, patch) => {
        if (patch.status === "completed") throw new Error("write failed");
        return update(id, patch);
      };
      await assert.rejects(runner.run(flow, {}, "dropped-at-end"), /write failed/);
      (store as ExecutionStore).update = update;
      assert.equal((await store.get("dropped-at-end"))!.status, "running");
      await leaseSettled(store);
      assert.deepEqual((await store.owners()).map((b) => b.id), [engineOwner.id], "the process stays on record, so a pass in any process looks for its run");

      const result = await runner.reconcile(); // not asked to look at everything
      assert.deepEqual(result.failed.map((r) => r.instanceId), ["dropped-at-end"]);
      assert.match(result.failed[0].error, /^Interrupted: the run was left marked running/);
    });

    it("so is one dropped before its first step, and one dropped as it was resumed", async (t) => {
      const { runner, store } = setup(t);
      await runner.reconcile();
      const update = store.update.bind(store);
      (store as ExecutionStore).update = (id, patch) => {
        if (patch.status === "failed") throw new Error("write failed");
        return update(id, patch);
      };
      const needsInput = { flow: "needs-input", inputs: { order: { required: true } }, nodes: [{ name: "one", do: "code", run: "1" }] } as unknown as FlowDefinition;
      await assert.rejects(runner.run(needsInput, {}, "dropped-at-start"), /write failed/);
      (store as ExecutionStore).update = update;
      assert.deepEqual((await runner.reconcile()).failed.map((r) => r.instanceId), ["dropped-at-start"]);

      const gated = { flow: "gated", nodes: [{ name: "gate", do: "wait", for: "approval" }, { name: "one", do: "code", run: "1" }] } as unknown as FlowDefinition;
      const paused = await runner.run(gated, {}, "dropped-at-resume");
      await assert.rejects(runner.resume(paused.resumeToken!, gated, true, () => { throw new Error("caller failed"); }), /caller failed/);
      assert.equal((await store.get("dropped-at-resume"))!.status, "running");

      assert.deepEqual((await runner.reconcile()).failed.map((r) => r.instanceId), ["dropped-at-resume"]);
    });

    it("one run that cannot be settled does not stop the pass, and is tried again", async (t) => {
      const { runner, store } = setup(t);
      const gone = someone(await exitedPid());
      await store.beat({ ...gone, host: "another-host" });
      for (const id of ["a", "b", "c"]) await store.create(id, "flow", {}, gone);
      await store.forgetOwner(gone.id);

      const amend = store.amend.bind(store);
      (store as ExecutionStore).amend = (id, change) => {
        if (id === "b") throw new Error("locked");
        return amend(id, change);
      };
      const first = await runner.reconcile();
      (store as ExecutionStore).amend = amend;
      assert.deepEqual(first.failed.map((r) => r.instanceId).sort(), ["a", "c"]);
      assert.deepEqual(first.errors, [{ instanceId: "b", error: "locked" }]);

      const second = await runner.reconcile(); // looks again without being asked to
      assert.deepEqual(second.failed.map((r) => r.instanceId), ["b"]);
      assert.deepEqual(second.errors, []);
    });

    it("the heartbeat is renewed for as long as a run is going", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { runner, store, gate, age } = setup(t);
      const flow = { flow: "long", nodes: [{ name: "hold", do: "hold", gate: "long" }] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "long-run");
      await until(async () => (await store.get("long-run"))?.running?.node === "hold");

      await age(engineOwner.id, 90_000);
      assert.ok((await store.owners())[0].ageMs >= 90_000);
      t.mock.timers.tick(HEARTBEAT_MS);
      await leaseSettled(store);
      assert.ok((await store.owners())[0].ageMs < 5_000, "one interval later the store has heard from it again");

      // A reconcile pass elsewhere took this process for gone and forgot it:
      // its next beat says it is alive again.
      await store.forgetOwner(engineOwner.id);
      t.mock.timers.tick(HEARTBEAT_MS);
      await leaseSettled(store);
      assert.deepEqual((await store.owners()).map((b) => b.id), [engineOwner.id]);

      gate("long").open();
      await going;
      await leaseSettled(store);
      t.mock.timers.tick(HEARTBEAT_MS * 3);
      await leaseSettled(store);
      assert.deepEqual(await store.owners(), [], "no heartbeat once the run is over");
    });

    it("a pass with no process gone does not read the runs", async (t) => {
      const { runner, store, gate, age } = setup(t);
      const flow = { flow: "quiet", nodes: [{ name: "hold", do: "hold", gate: "quiet" }] } as unknown as FlowDefinition;
      const going = runner.run(flow, {}, "quiet-run");
      await until(async () => (await store.get("quiet-run"))?.running?.node === "hold");
      await runner.reconcile(); // this process's first pass reads them once

      let reads = 0;
      const listRuns = store.listRuns.bind(store);
      (store as ExecutionStore).listRuns = (opts) => { reads++; return listRuns(opts); };
      await runner.reconcile();
      await runner.reconcile();
      assert.equal(reads, 0);

      // Another process goes quiet: now they are read, and its run is failed.
      const quiet = { ...someone(process.pid), host: "another-host" };
      await store.beat(quiet);
      await store.create("theirs", "flow", {}, quiet);
      await runner.reconcile();
      assert.equal(reads, 0, "its heartbeat is fresh");
      await age(quiet.id, OWNER_STALE_MS + 1_000);
      assert.deepEqual((await runner.reconcile()).failed.map((r) => r.instanceId), ["theirs"]);
      assert.ok(reads > 0);
      assert.equal((await store.get("quiet-run"))!.status, "running");
      (store as ExecutionStore).listRuns = listRuns;
      gate("quiet").open();
      await going;
    });

    it("POST /runs/reconcile runs a pass now, and fails ownerless runs when told to", async (t) => {
      const { dir, runner, store } = setup(t);
      const server = startFlowServer({ runner, serve: { port: 0 }, workspace: dir, controlToken: () => "test-token", logger: { info() {}, warn() {}, error() {} } });
      await once(server, "listening");
      t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/flows/runs/reconcile`;
      const post = (body?: unknown, token = "test-token") => fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      await store.create("gone", "flow", {}, someone(process.pid));
      await store.create("legacy", "flow", {});
      assert.equal((await post(undefined, "wrong")).status, 401);
      assert.equal((await post({ unowned: "yes" })).status, 400);
      assert.equal((await store.get("gone"))!.status, "running");

      const first = await post();
      assert.equal(first.status, 200);
      const body = await first.json() as { ok: boolean; failed: Array<{ instanceId: string; error: string }>; unowned: number };
      assert.equal(body.ok, true);
      assert.deepEqual(body.failed.map((r) => r.instanceId), ["gone"]);
      assert.match(body.failed[0].error, /^Interrupted/);
      assert.equal(body.unowned, 1);

      const second = await (await post({ unowned: true })).json() as typeof body;
      assert.deepEqual(second.failed.map((r) => r.instanceId), ["legacy"]);
      assert.equal(second.unowned, 0);
    });

    it("the serving process's pass logs each run it fails", async (t) => {
      const { runner, store } = setup(t);
      await store.create("logged", "nightly", {}, someone(process.pid));
      await store.create("legacy", "flow", {});
      const lines: string[] = [];
      const log = { info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`) };
      await reconcilePass(runner, log);
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^warn clawflow: run logged \(nightly\) marked failed: Interrupted/);
      assert.match(lines[1], /^info clawflow: 1 run\(s\) say "running" with no process on record/);

      // A run whose process left no trace in the store at all: the usual pass
      // has nothing that points to it, the periodic full one finds it.
      await store.amend("legacy", () => ({ status: "cancelled" }));
      await store.create("no-trace", "nightly", {}, someone(process.pid));
      lines.length = 0;
      await reconcilePass(runner, log);
      assert.deepEqual(lines, []);
      await reconcilePass(runner, log, { full: true });
      assert.match(lines[0], /^warn clawflow: run no-trace \(nightly\) marked failed/);
    });
  });
}

describe("interrupted runs: the state directory", () => {
  /** A dead engine process, as the store last heard from it. */
  const dead = async (): Promise<RunOwner> => ({ id: randomUUID(), pid: await exitedPid(), host: os.hostname(), startedAt: new Date().toISOString() });

  it("a run file cut short by a kill mid-write does not stop a pass", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawflow-interrupted-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = new FlowRunner({ stateDir: dir });
    const store = runner.getStore();
    const owner = await dead();
    await store.beat(owner);
    for (const id of ["p", "q"]) await store.create(id, "flow", {}, owner);
    await store.create("p:loop:batch:1", "flow:loop:batch", {});
    fs.writeFileSync(path.join(dir, "p_loop_batch_0.json"), "");

    const result = await runner.reconcile();
    assert.deepEqual(result.failed.map((r) => r.instanceId).sort(), ["p", "q"]);
    assert.deepEqual(result.errors, []);
    assert.equal((await store.get("p:loop:batch:1"))!.status, "failed", "the iteration that can be read is ended");
  });

  it("two spellings of one directory are one store", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawflow-interrupted-"));
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    t.after(() => { fs.rmSync(link, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const registry = new StepRegistry();
    registry.register({ name: "hold", allowedKeys: [], run: async () => { await opened; return "released"; } });
    const direct = new FlowRunner({ stateDir: dir, customSteps: registry });
    const linked = new FlowRunner({ stateDir: link, customSteps: registry });
    assert.equal(linked.getStore().identity, direct.getStore().identity);

    const going = direct.run({ flow: "held", nodes: [{ name: "hold", do: "hold" }] } as unknown as FlowDefinition, {}, "held-run");
    await until(async () => (await direct.getStore().get("held-run"))?.running?.node === "hold");
    assert.deepEqual(await linked.reconcile({ full: true }), nothing, "a run live through one spelling is live through the other");
    open();
    assert.equal((await going).status, "completed");
  });
});

// The whole path, with real processes: an engine serving a workspace is killed
// while a run is asleep, and the engine started in its place settles the run
// by itself, on its own timer.
describe("interrupted runs: an engine killed and started again", () => {
  const serveFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "serve-engine.ts");

  async function freePort(): Promise<number> {
    const { createServer } = await import("node:net");
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  async function startEngine(workspace: string): Promise<{ child: ChildProcess; base: string }> {
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", serveFixture, workspace, String(port)], { stdio: ["ignore", "ignore", "inherit"] });
    const base = `http://127.0.0.1:${port}/flows`;
    await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20_000, "the engine to serve");
    return { child, base };
  }

  it("the run it left running is failed within seconds of the restart", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clawflow-restart-"));
    fs.mkdirSync(path.join(workspace, "flows"));
    fs.writeFileSync(path.join(workspace, "flows", "napper.json"), JSON.stringify({
      flow: "napper",
      nodes: [{ name: "nap", do: "sleep", duration: "10m" }, { name: "after", do: "code", run: "1", output: "after" }],
    }));
    const engines: ChildProcess[] = [];
    t.after(async () => {
      for (const child of engines) await kill(child);
      fs.rmSync(workspace, { recursive: true, force: true });
    });
    type Status = { status: string; finished: boolean; error?: string };
    const status = async (base: string, id: string) => await (await fetch(`${base}/runs/${id}/status`)).json() as Status;

    const first = await startEngine(workspace);
    engines.push(first.child);
    const started = await (await fetch(`${first.base}/napper/run`, { method: "POST", body: "{}" })).json() as { instanceId: string };
    const id = started.instanceId;
    await until(async () => (await status(first.base, id)).status === "running", 10_000, "the run to start");
    // Still there once it has had time to fail on its own, were it going to.
    await sleep(300);
    assert.equal((await status(first.base, id)).status, "running");

    await kill(first.child);
    const second = await startEngine(workspace);
    engines.push(second.child);
    const ended = await until(async () => {
      const now = await status(second.base, id);
      return now.finished ? now : null;
    }, 15_000, "the new engine to settle the run");
    assert.equal(ended.status, "failed");
    assert.match(ended.error!, /^Interrupted: the process running this flow stopped during step "nap"/);
  });
});
