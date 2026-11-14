import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { FlowRunner, type StorageConfig } from "../src/index.js";
import { startFlowServer } from "../src/core/serve.js";

for (const backend of ["json", "sqlite", "postgres"] as const) {
  describe(`${backend} authenticated management`, { skip: backend === "postgres" && !process.env.CLAWFLOW_TEST_POSTGRES_URL }, () => {
    it("reads actual child IDs, pages/filter descendants, resumes and declines durable approvals", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "clawflow-control-"));
      const storage: StorageConfig = backend === "postgres"
        ? { backend, connectionStringEnv: "CLAWFLOW_TEST_POSTGRES_URL", namespace: randomUUID() } : { backend };
      const runner = new FlowRunner({ stateDir: dir, storage });
      mkdirSync(join(dir, "flows"));
      const flow = { flow: "approve", nodes: [{ name: "gate", do: "wait", for: "approval" }, { name: "done", do: "code", run: "42", output: "answer" }] } as const;
      writeFileSync(join(dir, "flows/approve.json"), JSON.stringify(flow));
      const server = startFlowServer({ runner, serve: { port: 0 }, workspace: dir, controlToken: () => "test-token", logger: { info() {}, warn() {}, error() {} } });
      await once(server, "listening");
      t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await runner.close(); rmSync(dir, { recursive: true, force: true }); });
      const base = `http://127.0.0.1:${(server.address() as any).port}/flows/runs`;
      const request = (p: string, options: RequestInit = {}) => fetch(base + p, { ...options, headers: { Authorization: "Bearer test-token", "X-ClawFlow-Backend": backend, ...options.headers } });
      assert.equal((await fetch(base)).status, 401);
      assert.equal((await request("", { headers: { "X-ClawFlow-Backend": "wrong" } })).status, 503);
      const store = runner.getStore();
      await store.create("root_%", "example", {});
      for (let n = 0; n < 23; n++) await store.create(`root_%:loop:items:${n}`, "child", { n });
      await store.create("root_%:loop:other:0", "child", {});
      // Case-insensitive filesystems cannot retain this distinct legacy JSON ID.
      if (backend !== "json") await store.create("root_%:loop:ITEMS:0", "child", {});
      await store.create("root_AB:loop:items:0", "unrelated", {});
      const old = { ...(await store.get("root_%"))!, instanceId: "oldest-checkpoint",
        createdAt: "2001-01-01T00:00:00.000Z", updatedAt: "2002-01-01T00:00:00.000Z" };
      const childOld = { ...old, instanceId: "root_%:loop:other:999", updatedAt: "1900-01-01T00:00:00.000Z" };
      if (backend === "json") {
        for (const record of [old, childOld]) writeFileSync(join(dir, record.instanceId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json"), JSON.stringify(record));
      } else await (store as any).importRecords([old, childOld], []);
      const active = await (await request("?status=running&limit=1&include_oldest=1")).json() as any;
      assert.equal(active.total, 2, "children are excluded from the root count");
      assert.equal(active.oldest.instanceId, "oldest-checkpoint");
      assert.notEqual(active.runs[0].instanceId, active.oldest.instanceId);
      assert.equal(active.oldest.updatedAt, "2002-01-01T00:00:00.000Z");
      assert.equal(active.runs.length, 1);
      const empty = await (await request("?status=paused&include_oldest=1")).json() as any;
      assert.equal(empty.oldest, null);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const p = await store.listSubRuns("root_%", { node: "items", limit: 4, cursor });
        assert.equal(p.total, 23);
        seen.push(...p.runs.map(x => x.instanceId)); cursor = p.next_cursor ?? undefined;
      } while (cursor);
      assert.equal(new Set(seen).size, 23);
      const child = await (await request("/" + encodeURIComponent("root_%:loop:items:22"))).json() as any;
      assert.equal(child.run.state.n, 22);
      const detail = await (await request("/root_%25?include_subruns=1&node=items")).json() as any;
      assert.equal(detail.run.subFlows.items.length, 20);
      assert.equal(detail.run.subFlows.items[0].iteration, 3);
      assert.equal(detail.run.subFlowsTruncated.items.total, 23);
      assert.equal((await request("?limit=101")).status, 400);
      assert.equal((await request("/missing")).status, 404);
      for (const approved of [true, false]) {
        const paused = await runner.run(flow as any, {});
        const res = await request(`/${paused.instanceId}/resume`, { method: "POST", body: JSON.stringify({ approved }) });
        assert.equal(res.status, approved ? 202 : 200);
        for (let n = 0; n < 100 && (await store.get(paused.instanceId))!.status === "running"; n++) await new Promise(r => setTimeout(r, 5));
        assert.equal((await store.get(paused.instanceId))!.status, approved ? "completed" : "cancelled");
        assert.equal((await runner.listApprovals()).length, 0);
        assert.equal((await request(`/${paused.instanceId}/resume`, { method: "POST", body: '{"approved":true}' })).status, 409);
      }
      const alias = await runner.run(flow as any, {}, "alias!");
      assert.equal((await request("/alias_/resume", { method: "POST", body: '{"approved":false}' })).status, 404,
        "a filename-safe alias must not cancel a different actual ID");
      await runner.resume(alias.instanceId, flow as any, false);
      const get = store.get.bind(store);
      store.get = () => { throw new Error("db secret must never appear"); };
      const failed = await request("/root_%25");
      assert.equal(failed.status, 503);
      assert.ok(!(await failed.text()).includes("secret"));
      store.get = get;
    });
  });
}
