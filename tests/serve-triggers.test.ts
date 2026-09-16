import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner, startFlowServer } from "../src/index.js";
import { TriggerStore } from "../src/core/triggers.js";
import { TriggerScheduler } from "../src/core/scheduler.js";
import type { FlowDefinition, PluginConfig } from "../src/index.js";

// The HTTP twin of the flow_trigger tool. A schedule made from the dashboard
// goes through these routes, so they must validate like the tool does and
// arm the scheduler immediately.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-serve-triggers-"));
const workspace = path.join(tmpDir, "workspace");
const flowsDir = path.join(workspace, "flows");
const cfg: PluginConfig = {
  stateDir: path.join(tmpDir, "state"),
  memoryDir: path.join(tmpDir, "memory"),
};
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let server: ReturnType<typeof startFlowServer>;
let base = "";
let store: TriggerStore;
let scheduler: TriggerScheduler;

function writeFlow(name: string): void {
  const def: FlowDefinition = {
    flow: name,
    nodes: [{ name: "step1", do: "code", run: "1", output: "result" }],
  };
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(path.join(flowsDir, `${name}.json`), JSON.stringify(def, null, 2));
}

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

before(async () => {
  writeFlow("digest");
  const runner = new FlowRunner(cfg);
  store = new TriggerStore(workspace);
  scheduler = new TriggerScheduler({ runner, store, workspace, flowsDir, logger: silent });
  server = startFlowServer({
    runner,
    serve: { port: 0, flowsDir },
    workspace,
    logger: silent,
    triggers: () => ({ store, scheduler }),
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/flows`;
});

after(async () => {
  scheduler.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("trigger routes", () => {
  let id = "";

  it("rejects a schedule for a flow that does not exist", async () => {
    const r = await call("POST", "/triggers", { flow: "nope", cron: "0 8 * * *" });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /Flow not found/);
  });

  it("rejects an invalid schedule with the validator's message", async () => {
    const r = await call("POST", "/triggers", { flow: "digest", cron: "* * * * * *" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /once a minute/);
  });

  it("requires flow and cron", async () => {
    const r = await call("POST", "/triggers", { flow: "digest" });
    assert.equal(r.status, 400);
  });

  it("creates a trigger, arms it, and tags it as dashboard-made", async () => {
    const r = await call("POST", "/triggers", {
      flow: "digest",
      cron: "0 8 * * *",
      tz: "Europe/Amsterdam",
      description: "morning digest",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const t = r.body.trigger;
    id = t.id;
    assert.equal(t.flowName, "digest");
    assert.equal(t.enabled, true);
    assert.equal(t.origin, "dashboard");
    assert.ok(t.nextRunAt, "not armed: no nextRunAt");
    assert.ok(scheduler.nextRun(id), "scheduler did not arm the new trigger");
  });

  it("lists triggers, optionally by flow", async () => {
    const all = await call("GET", "/triggers");
    assert.equal(all.status, 200);
    assert.equal(all.body.triggers.length, 1);
    const none = await call("GET", "/triggers?flow=other");
    assert.equal(none.body.triggers.length, 0);
  });

  it("pauses through PATCH and disarms", async () => {
    const r = await call("PATCH", `/triggers/${id}`, { enabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.trigger.enabled, false);
    assert.equal(r.body.trigger.nextRunAt, null);
    assert.equal(scheduler.nextRun(id), null, "paused trigger still armed");
  });

  it("resumes and retimes, re-validating the schedule", async () => {
    const bad = await call("PATCH", `/triggers/${id}`, { cron: "not a cron" });
    assert.equal(bad.status, 400);
    const r = await call("PATCH", `/triggers/${id}`, { enabled: true, cron: "30 9 * * 1-5" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.trigger.cron, "30 9 * * 1-5");
    assert.ok(r.body.trigger.nextRunAt);
    assert.ok(scheduler.nextRun(id), "resumed trigger not armed");
  });

  it("runs now, detached, and records the run on the trigger", async () => {
    const r = await call("POST", `/triggers/${id}/run`);
    assert.equal(r.status, 202);
    const deadline = Date.now() + 5000;
    let ran = store.get(id);
    while ((!ran?.lastRunAt) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
      ran = store.get(id);
    }
    assert.ok(ran?.lastRunAt, "run-now did not record a run");
    assert.equal(ran?.lastStatus, "ok", `run failed: ${ran?.lastError}`);
  });

  it("404s on unknown ids and deletes", async () => {
    assert.equal((await call("PATCH", "/triggers/missing", { enabled: false })).status, 404);
    assert.equal((await call("POST", "/triggers/missing/run")).status, 404);
    const del = await call("DELETE", `/triggers/${id}`);
    assert.equal(del.status, 200);
    assert.equal(scheduler.nextRun(id), null);
    assert.equal((await call("DELETE", `/triggers/${id}`)).status, 404);
    assert.equal((await call("GET", "/triggers")).body.triggers.length, 0);
  });
});
