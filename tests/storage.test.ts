import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { FlowRunner, StateStore, StepRegistry, createStateStore, importJsonState } from "../src/index.js";
import { SqlStateStore } from "../src/core/sql-store.js";
import type { StorageConfig, ExecutionStore, FlowDefinition, PendingApproval } from "../src/index.js";
import plugin from "../src/plugin/index.js";

const postgres = !!process.env.CLAWFLOW_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe(`${backend} execution storage`, { skip: backend === "postgres" && !postgres }, () => {
    function setup(t: any) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawflow-sql-test-"));
      const storage: StorageConfig = backend === "sqlite"
        ? { backend, path: path.join(dir, "state.sqlite") }
        : { backend, connectionStringEnv: "CLAWFLOW_TEST_POSTGRES_URL", namespace: `test-${randomUUID()}` };
      const handles: ExecutionStore[] = [];
      const open = () => { const s = createStateStore(dir, storage); handles.push(s); return s; };
      t.after(async () => { for (const s of handles) await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      return { dir, storage, open, handles };
    }

    it("reopens paused checkpoints, resumes once, and preserves memoized steps and trace", async (t) => {
      const { dir, storage, handles } = setup(t);
      const registry = new StepRegistry();
      let calls = 0;
      registry.register({ name: "count", allowedKeys: [], run: () => { calls++; return { calls, text: "quote ' and NUL \0" }; } });
      const flow: FlowDefinition = { flow: "durable", nodes: [
        { name: "first", do: "count" as "code", output: "first" },
        { name: "gate", do: "wait", for: "approval", prompt: "Continue?", output: "approval" },
        { name: "last", do: "count" as "code", output: "last" },
      ] };
      const a = new FlowRunner({ stateDir: dir, storage, customSteps: registry });
      const paused = await a.run(flow, { nested: [null, true, 42] }, "restart");
      assert.equal(paused.status, "paused");
      assert.equal((await a.listApprovals()).length, 1);
      const record = await a.getStore().get("restart");
      await a.close();
      const b = new FlowRunner({ stateDir: dir, storage, customSteps: registry });
      handles.push(b.getStore());
      assert.deepEqual(await b.getStore().get("restart"), record);
      const done = await b.resume(paused.resumeToken!, flow);
      assert.equal(done.status, "completed");
      assert.equal(calls, 2, "memoized first step must not execute again after reopening");
      assert.deepEqual(done.trace.map((r) => r.node), ["first", "gate", "last"]);
      assert.equal((await b.listApprovals()).length, 0);
      assert.equal((await b.getStore().get("restart"))?.resumeToken, undefined);
      await assert.rejects(b.resume(paused.resumeToken!, flow), /not found/);
      await assert.rejects(b.run(flow, {}, "restart"), /unique|duplicate/i, "must not overwrite a durable run");
    });

    it("atomically claims concurrent resumes and keeps the token when a transition fails", async (t) => {
      const { dir, storage, handles } = setup(t);
      const a = new FlowRunner({ stateDir: dir, storage });
      const b = new FlowRunner({ stateDir: dir, storage });
      handles.push(a.getStore(), b.getStore());
      const flow: FlowDefinition = { flow: "claim", nodes: [
        { name: "gate", do: "wait", for: "approval" },
        { name: "end", do: "code", run: "42", output: "value" },
      ] };
      const paused = await a.run(flow, {});
      await assert.rejects(Promise.resolve().then(() => a.getStore().resume(paused.resumeToken!, () => { throw new Error("rollback"); })), /rollback/);
      assert.equal((await a.listApprovals()).length, 1);
      assert.equal((await a.getStore().get(paused.instanceId))!.status, "paused");
      const results = await Promise.allSettled([a.resume(paused.resumeToken!, flow), b.resume(paused.resumeToken!, flow)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await a.getStore().get(paused.instanceId))!.state.value, 42);
      assert.equal((await a.listApprovals()).length, 0);
    });

    it("executes parallel children and reuses a successful child when its parent retries", async (t) => {
      const { dir, storage, handles } = setup(t);
      const registry = new StepRegistry();
      let stable = 0, flaky = 0;
      registry.register({ name: "stable", allowedKeys: [], run: () => ++stable });
      registry.register({ name: "flaky", allowedKeys: [], run: () => { if (++flaky === 1) throw new Error("retry"); return 2; } });
      const runner = new FlowRunner({ stateDir: dir, storage, customSteps: registry });
      handles.push(runner.getStore());
      const result = await runner.run({ flow: "children", nodes: [{ name: "branch", do: "condition", if: "true", retry: { limit: 2, delay: 0 }, then: [
        { name: "one", do: "stable" as "code", output: "one" },
        { name: "two", do: "flaky" as "code", output: "two" },
      ] }, { name: "parallel", do: "parallel", nodes: [
        { name: "a", do: "code", run: "1", output: "a" },
        { name: "b", do: "code", run: "2", output: "b" },
      ], output: "parallel" }] }, {});
      assert.equal(result.status, "completed", result.error);
      assert.equal(stable, 1);
      assert.equal(flaky, 2);
      assert.equal((await runner.getStore().listRuns()).total, 1);
      const records = await runner.getStore().list();
      assert.ok(records.length > 1);
      assert.ok(records.every((r) => r.status === "completed" && !r.error));
    });

    it("serializes concurrent mutations from separate handles without losing memoized outputs", async (t) => {
      const { open } = setup(t);
      const a = open(), b = open();
      await a.create("concurrent", "parallel", {});
      await Promise.all(Array.from({ length: 30 }, (_, n) => (n % 2 ? a : b).memoize("concurrent", `n${n}`, { n })));
      assert.equal(Object.keys((await b.get("concurrent"))!.completedNodes).length, 30);
      await a.update("concurrent", { status: "cancelled", error: "stopped" });
      await b.update("concurrent", { status: "completed", error: undefined });
      assert.equal((await a.get("concurrent"))!.status, "cancelled");
      assert.equal((await a.get("concurrent"))!.error, "stopped");
    });

    it("reports cancellation that races with the final checkpoint", async (t) => {
      const { dir, storage, handles, open } = setup(t);
      const runner = new FlowRunner({ stateDir: dir, storage });
      const external = open();
      const store = runner.getStore();
      handles.push(store);
      const update = store.update.bind(store);
      store.update = async (id, patch) => {
        if (patch.status === "completed") await external.update(id, { status: "cancelled", error: "external cancellation" });
        return update(id, patch);
      };
      const result = await runner.run({ flow: "race", nodes: [{ name: "one", do: "code", run: "1" }] }, {});
      assert.equal(result.status, "cancelled");
      assert.equal(result.error, "external cancellation");
      assert.equal((await store.get(result.instanceId))!.status, "cancelled");
    });

    it("commits checkpoint plus approval atomically and only consumes a token once", async (t) => {
      const { open } = setup(t);
      const a = open(), b = open();
      await a.create("approved", "gate", {});
      const approval: PendingApproval = { token: "token", instanceId: "approved", flowName: "gate", node: "gate", prompt: "OK?", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() };
      await a.checkpoint("approved", { status: "paused", resumeToken: "token" }, { node: "first", output: 4 }, approval);
      await assert.rejects(a.checkpoint("approved", { state: { lost: true } }, undefined, approval));
      assert.deepEqual((await a.get("approved"))!.state, {}, "failed approval insert must roll back the checkpoint");
      const consumed = await Promise.all([a.resolveApproval("token"), b.resolveApproval("token")]);
      assert.equal(consumed.filter(Boolean).length, 1);
      assert.deepEqual(consumed.find(Boolean), approval);
    });

    it("pages indexed summaries with tied timestamps, filters, subflows and SQL metacharacters", async (t) => {
      const { open } = setup(t);
      const s = open() as SqlStateStore;
      const source = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), "clawflow-fixture-")));
      t.after(() => fs.rmSync(source.dir, { recursive: true, force: true }));
      const template = source.create("a", "flow' OR 1=1 --", {});
      await s.importRecords(Array.from({ length: 23 }, (_, n) => ({ ...template, instanceId: `r${String(n).padStart(2, "0")}`, state: { large: "x".repeat(10000) }, completedNodes: { first: n }, status: n % 2 ? "completed" : "failed" })), []);
      await s.create("r00:parallel:child:0", "child", {});
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.listRuns({ limit: 4, cursor });
        assert.equal(page.total, 23);
        assert.ok(JSON.stringify(page).length < 3000);
        seen.push(...page.runs.map((r) => r.instanceId));
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      assert.equal(new Set(seen).size, 23);
      assert.deepEqual(seen, [...seen].sort().reverse());
      assert.equal((await s.listRuns({ flow: "flow' OR 1=1 --", status: "failed" })).total, 12);
      assert.equal((await s.listRuns({ flow: "other" })).total, 0);
      assert.throws(() => s.listRuns({ cursor: "bad" }), /cursor/);
      assert.throws(() => s.listRuns({ limit: 101 }), /limit/);
    });

    it("retains active runs and sweeps finished roots with their subflows and approvals", async (t) => {
      const { open } = setup(t);
      const s = open() as SqlStateStore;
      const base = { flowName: "retained", state: {}, completedNodes: {}, trace: [], createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" };
      await s.importRecords([
        { ...base, instanceId: "old", status: "completed" },
        { ...base, instanceId: "old:parallel:child:0", status: "completed" },
        { ...base, instanceId: "old-prefix", status: "running" },
        { ...base, instanceId: "paused", status: "paused" },
        { ...base, instanceId: "waiting", status: "waiting" },
      ], [{ token: "orphan", instanceId: "old", flowName: "retained", node: "gate", prompt: "?", createdAt: base.createdAt, expiresAt: base.updatedAt }]);
      assert.deepEqual(await s.sweep(0), { indexed: 0, runs: 0, files: 0 });
      assert.deepEqual(await s.sweep(30), { indexed: 0, runs: 1, files: 2 });
      assert.deepEqual((await s.list()).map((r) => r.instanceId).sort(), ["old-prefix", "paused", "waiting"]);
      assert.equal((await s.listApprovals()).length, 0);
    });

    it("imports legacy JSON and approvals without changing files, retries safely and refuses conflicts", async (t) => {
      const { dir, storage, open } = setup(t);
      const json = new StateStore(dir);
      const original = json.create("legacy", "imported", { inputs: { x: 1 } });
      json.memoize("legacy", "first", { x: 2 });
      json.update("legacy", { status: "paused", resumeToken: "legacy-token", pausedAtIndex: 1 });
      json.create("legacy:parallel:child:0", "child", {});
      json.addApproval({ token: "legacy-token", instanceId: "legacy", flowName: "imported", node: "gate", prompt: "?", createdAt: original.createdAt, expiresAt: original.updatedAt });
      const before = fs.readFileSync(path.join(dir, "legacy.json"), "utf8");
      assert.deepEqual(await importJsonState(dir, storage as any), { runs: 2, approvals: 1 });
      assert.deepEqual(await importJsonState(dir, storage as any), { runs: 2, approvals: 1 });
      assert.equal(fs.readFileSync(path.join(dir, "legacy.json"), "utf8"), before);
      const sql = open();
      assert.deepEqual(await sql.get("legacy"), json.get("legacy"));
      assert.deepEqual(await sql.listApprovals(), json.listApprovals());
      await sql.update("legacy", { status: "completed" });
      await assert.rejects(importJsonState(dir, storage as any), /Migration conflict/);
      assert.equal((await sql.get("legacy"))!.status, "completed");
      fs.writeFileSync(path.join(dir, "broken.json"), "{bad");
      await assert.rejects(importJsonState(dir, storage as any));
    });

    it("uses the selected backend for plugin run, status list, value reads and cancel", async (t) => {
      const { dir, storage } = setup(t);
      const defs = new Map<string, any>();
      plugin.register({
        registerTool: (def: any, opts: any) => defs.set(typeof def === "function" ? opts.name : def.name, def),
        config: { workspace: dir, plugins: { entries: { clawflow: { config: { stateDir: dir, storage } } } } },
      });
      const run = defs.get("flow_run")({});
      const paused = await run.execute("a", { flow: { flow: "tool", nodes: [{ name: "gate", do: "wait", for: "approval" }] } });
      assert.equal(paused.details.status, "paused");
      const listed = await defs.get("flow_status").execute("b", {});
      assert.equal(listed.details.runs[0].instanceId, paused.details.instanceId);
      const value = await defs.get("flow_status").execute("c", { instanceId: paused.details.instanceId, path: "status" });
      assert.equal(JSON.parse(value.content[0].text).text, "paused");
      const cancelled = await defs.get("flow_cancel").execute("d", { instanceId: paused.details.instanceId });
      assert.equal(cancelled.details.status, "cancelled");
    });

    it("scopes event delivery when two namespaces use the same instance ID", async (t) => {
      const { dir, storage, handles } = setup(t);
      const other: StorageConfig = backend === "sqlite" ? { backend, path: path.join(dir, "events.sqlite") } : { ...storage as any, namespace: `events-${randomUUID()}` };
      const a = new FlowRunner({ storage, stateDir: dir });
      const b = new FlowRunner({ storage: other, stateDir: dir });
      handles.push(a.getStore(), b.getStore());
      const flow: FlowDefinition = { flow: "events", nodes: [{ name: "wait", do: "wait", for: "event", event: "go", timeout: "3s", output: "event" }] };
      const aDone = a.run(flow, {}, "event-id"), bDone = b.run(flow, {}, "event-id");
      for (const runner of [a, b]) {
        let sent = false;
        for (let n = 0; !sent && n < 100; n++) {
          sent = runner.sendEvent("event-id", "go", runner === a ? "a" : "b");
          if (!sent) await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(sent, true);
      }
      assert.equal((await aDone).state.event, "a");
      assert.equal((await bDone).state.event, "b");
    });

    it("isolates live cancellation from other databases or namespaces", async (t) => {
      const { dir, storage, handles } = setup(t);
      const other: StorageConfig = backend === "sqlite" ? { backend, path: path.join(dir, "other.sqlite") } : { ...storage as any, namespace: `other-${randomUUID()}` };
      const a = new FlowRunner({ storage, stateDir: dir });
      const b = new FlowRunner({ storage: other, stateDir: dir });
      handles.push(a.getStore(), b.getStore());
      const done = a.run({ flow: "slow", nodes: [{ name: "wait", do: "sleep", duration: "30s" }] }, {}, "same-id");
      for (let n = 0; !(await a.getStore().get("same-id"))?.running && n < 100; n++) await new Promise((r) => setTimeout(r, 10));
      assert.equal((await a.getStore().get("same-id"))?.running?.node, "wait");
      assert.deepEqual(await b.cancel("same-id"), { ok: false, instanceId: "same-id", error: "not_found" });
      assert.equal((await b.getStore().listRuns()).total, 0);
      await a.cancel("same-id");
      assert.equal((await done).status, "cancelled");
    });
  });
}

it("requires explicit PostgreSQL configuration and never silently falls back", () => {
  assert.throws(() => createStateStore(undefined, { backend: "postgres", connectionStringEnv: "CLAWFLOW_MISSING_TEST_ENV", namespace: "test" }), /connectionStringEnv/);
  assert.throws(() => createStateStore(undefined, { backend: "postgres", connectionStringEnv: "x", namespace: "" }), /namespace/);
  assert.throws(() => createStateStore(undefined, { backend: "unknown" } as any), /Unknown/);
});

// A database outage must not create a second, divergent local history.
it("fails a PostgreSQL write closed when its configured database is unavailable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawflow-unavailable-"));
  const env = `CLAWFLOW_TEST_UNAVAILABLE_${randomUUID().replaceAll("-", "_")}`;
  process.env[env] = `postgresql://clawflow@localhost/test?host=${encodeURIComponent(path.join(dir, "missing-socket"))}`;
  const store = createStateStore(dir, { backend: "postgres", connectionStringEnv: env, namespace: "unavailable" });
  t.after(async () => { await store.close(); delete process.env[env]; fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(store.create("lost", "unavailable", {}));
  assert.deepEqual(fs.readdirSync(dir), []);
});
