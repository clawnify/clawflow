import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { TriggerStore } from "../src/core/triggers.js";

const tmpDir = path.join(os.tmpdir(), `ocf-triggers-test-${Date.now()}`);
const workspace = path.join(tmpDir, "workspace");

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function freshStore(): TriggerStore {
  cleanup();
  return new TriggerStore(workspace);
}

describe("TriggerStore", () => {
  before(cleanup);
  after(cleanup);

  it("creates a record with defaults and round-trips it", () => {
    const store = freshStore();
    const created = store.create({ flowName: "daily-digest", cron: "0 9 * * *" });

    assert.equal(created.flowName, "daily-digest");
    assert.equal(created.version, "@published", "defaults to latest published");
    assert.equal(created.enabled, true, "defaults to enabled");
    assert.ok(created.id.startsWith("daily-digest-"));

    const read = store.get(created.id);
    assert.deepEqual(read, created, "survives a write/read round-trip");
  });

  it("persists to .clawflow/triggers alongside versions", () => {
    const store = freshStore();
    const created = store.create({ flowName: "f", cron: "* * * * *" });
    const file = path.join(workspace, ".clawflow", "triggers", `${created.id}.json`);
    assert.ok(fs.existsSync(file), "record written to the expected path");
  });

  it("holds N triggers for one flow with different cadences and inputs", () => {
    const store = freshStore();
    const hourly = store.create({
      flowName: "digest",
      cron: "0 * * * *",
      inputs: { customer: "acme" },
    });
    const daily = store.create({
      flowName: "digest",
      cron: "0 9 * * *",
      tz: "Europe/Rome",
      inputs: { customer: "globex" },
    });

    assert.notEqual(hourly.id, daily.id, "ids are distinct");
    const forFlow = store.list({ flowName: "digest" });
    assert.equal(forFlow.length, 2);
    assert.deepEqual(
      forFlow.map((r) => r.inputs?.customer).sort(),
      ["acme", "globex"],
      "each carries its own inputs",
    );
  });

  it("pauses without touching the flow definition", () => {
    const store = freshStore();
    const created = store.create({ flowName: "f", cron: "0 9 * * *" });
    const paused = store.update(created.id, { enabled: false });

    assert.equal(paused.enabled, false);
    assert.equal(paused.cron, created.cron, "cadence untouched");
    assert.notEqual(paused.updatedAt, undefined);
    assert.equal(store.list({ enabledOnly: true }).length, 0);
    assert.equal(store.list().length, 1, "paused records are still listed");
  });

  it("pins a version and keeps it across updates", () => {
    const store = freshStore();
    const created = store.create({ flowName: "f", cron: "0 9 * * *", version: 3 });
    assert.equal(created.version, 3);
    const touched = store.update(created.id, { lastStatus: "ok" });
    assert.equal(touched.version, 3, "run bookkeeping does not drift the pin");
  });

  it("refuses to overwrite an existing id", () => {
    const store = freshStore();
    const created = store.create({ flowName: "f", cron: "* * * * *" });
    assert.throws(
      () => store.create({ id: created.id, flowName: "f", cron: "* * * * *" }),
      /already exists/,
    );
  });

  it("throws when updating a missing record", () => {
    const store = freshStore();
    assert.throws(() => store.update("nope", { enabled: false }), /not found/);
  });

  it("pauses a flow's triggers when it is soft-deleted, keeping the records", () => {
    const store = freshStore();
    store.create({ flowName: "doomed", cron: "0 9 * * *" });
    store.create({ flowName: "doomed", cron: "0 10 * * *" });
    store.create({ flowName: "survivor", cron: "0 9 * * *" });

    const paused = store.pauseForFlow("doomed");
    assert.equal(paused.length, 2);
    assert.equal(store.list({ flowName: "doomed" }).length, 2, "records survive for restore");
    assert.equal(
      store.list({ flowName: "doomed", enabledOnly: true }).length,
      0,
      "none of them still fire",
    );
    assert.equal(
      store.list({ flowName: "survivor", enabledOnly: true }).length,
      1,
      "unrelated flow untouched",
    );
  });

  it("pauseForFlow reports only what it actually changed", () => {
    const store = freshStore();
    const already = store.create({ flowName: "f", cron: "0 9 * * *", enabled: false });
    const live = store.create({ flowName: "f", cron: "0 10 * * *" });
    const paused = store.pauseForFlow("f");
    assert.deepEqual(paused, [live.id], "already-paused record not reported");
    assert.ok(already.id);
  });

  it("remove() reports whether anything was deleted", () => {
    const store = freshStore();
    const created = store.create({ flowName: "f", cron: "* * * * *" });
    assert.equal(store.remove(created.id), true);
    assert.equal(store.remove(created.id), false, "second delete is a no-op");
  });

  it("skips corrupt files instead of failing the whole listing", () => {
    const store = freshStore();
    store.create({ flowName: "good", cron: "* * * * *" });
    fs.writeFileSync(
      path.join(workspace, ".clawflow", "triggers", "corrupt.json"),
      "{ not json",
    );
    assert.equal(store.list().length, 1, "one good record still lists");
  });

  it("sanitizes ids so a record cannot escape the triggers dir", () => {
    const store = freshStore();
    const created = store.create({ id: "../../escape", flowName: "f", cron: "* * * * *" });
    assert.ok(store.get(created.id), "readable through the store");
    const escaped = path.join(workspace, ".clawflow", "escape.json");
    assert.ok(!fs.existsSync(escaped), "did not write outside the triggers dir");
  });
});
