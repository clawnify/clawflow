import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

import plugin from "../src/plugin/index.js";
import { FlowRunner, listRuns, readRunValue, runView, summarizeRun, sweepRuns } from "../src/index.js";
import { writeRunIndex } from "../src/core/store.js";
import type { RunPage, RunSummary } from "../src/index.js";

const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-runs-"));
  roots.push(dir);
  return dir;
}

interface Seed {
  id?: string;
  flow?: string;
  status?: string;
  createdAt: string;
  updatedAt?: string;
  state?: Record<string, unknown>;
  trace?: unknown[];
}

/** Write a stored run the way StateStore does: stateDir/<instanceId>.json. */
function seed(dir: string, s: Seed): string {
  const id = s.id ?? randomUUID();
  const record = {
    instanceId: id,
    flowName: s.flow ?? "digest",
    status: s.status ?? "completed",
    state: s.state ?? { inputs: {} },
    completedNodes: {},
    trace: s.trace ?? [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt ?? s.createdAt,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record));
  return id;
}

const minute = (i: number) => new Date(Date.UTC(2026, 8, 25, 10, i)).toISOString();

describe("listRuns", () => {
  it("returns the newest 20 by default, with the total and a cursor", () => {
    const dir = stateDir();
    for (let i = 0; i < 45; i++) seed(dir, { createdAt: minute(i) });
    const page = listRuns(dir);
    assert.equal(page.runs.length, 20);
    assert.equal(page.runs[0].createdAt, minute(44));
    assert.equal(page.total, 45);
    assert.equal(typeof page.next_cursor, "string");
  });

  it("walks every run exactly once, including runs started in the same millisecond", () => {
    const dir = stateDir();
    for (let i = 0; i < 30; i++) seed(dir, { createdAt: i >= 10 && i < 14 ? minute(10) : minute(i) });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page: RunPage = listRuns(dir, { limit: 7, cursor });
      seen.push(...page.runs.map((r) => r.instanceId));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    assert.equal(seen.length, 30);
    assert.equal(new Set(seen).size, 30);
  });

  it("filters by flow and status, and never lists sub-flow instances", () => {
    const dir = stateDir();
    const parent = seed(dir, { flow: "digest", status: "failed", createdAt: minute(1) });
    seed(dir, { flow: "outreach", createdAt: minute(2) });
    // A loop iteration's instance file, as the runner writes it.
    fs.writeFileSync(
      path.join(dir, `${parent}_loop_each_0.json`),
      JSON.stringify({ instanceId: `${parent}:loop:each:0`, flowName: "digest:loop:each", status: "completed", createdAt: minute(3) }),
    );
    assert.deepEqual(listRuns(dir).runs.map((r) => r.instanceId).includes(parent), true);
    assert.equal(listRuns(dir).total, 2);
    assert.equal(listRuns(dir, { flow: "outreach" }).total, 1);
    assert.equal(listRuns(dir, { status: "failed" }).runs[0].instanceId, parent);
  });

  it("rejects a page size out of range and a cursor it did not issue", () => {
    const dir = stateDir();
    assert.throws(() => listRuns(dir, { limit: 0 }));
    assert.throws(() => listRuns(dir, { limit: 101 }));
    assert.throws(() => listRuns(dir, { cursor: "nope" }));
  });
});

function bigRun() {
  const leads = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `Lead ${i}`, note: "x".repeat(80) }));
  return {
    instanceId: "run-1",
    flowName: "outreach",
    status: "completed" as const,
    state: { inputs: { max_pages: 2 }, leads },
    completedNodes: { fetch: leads },
    trace: [
      { node: "fetch", do: "http", status: "ok" as const, output: leads, durationMs: 40 },
      { node: "notify", do: "code", status: "ok" as const, output: "sent", durationMs: 1 },
    ],
    createdAt: minute(1),
    updatedAt: minute(2),
  };
}

describe("runView / summarizeRun", () => {
  it("returns a small run whole", () => {
    const small = { ...bigRun(), state: { inputs: {} }, completedNodes: {}, trace: [] };
    assert.equal(runView(small), small);
  });

  it("summarizes a run too big to return: sizes instead of values, outputs dropped from the trace", () => {
    const view = runView(bigRun()) as RunSummary;
    assert.equal(view.summary, true);
    assert.ok(JSON.stringify(view).length < 4_000);
    const leads = view.state.find((e) => e.path === "state.leads");
    assert.equal(leads?.type, "array");
    assert.equal(leads?.length, 300);
    assert.equal(view.trace[0].node, "fetch");
    assert.ok((view.trace[0].outputChars ?? 0) > 20_000);
    assert.equal("output" in view.trace[0], false);
    assert.ok(view.fullChars > 40_000);
  });

  it("summarizes the FlowResult flow_run returns as well as a stored record", () => {
    const { completedNodes: _c, createdAt: _a, updatedAt: _u, ...result } = bigRun();
    const view = summarizeRun({ ...result, ok: true });
    assert.equal(view.instanceId, "run-1");
    assert.equal(view.status, "completed");
  });
});

describe("readRunValue", () => {
  it("pages an array, fewer items when a page would not fit", () => {
    const run = bigRun();
    const first = readRunValue(run, "state.leads");
    assert.equal(first.total, 300);
    assert.ok(JSON.stringify(first).length <= 16_000 + 200);
    assert.ok((first.items as unknown[]).length >= 1);
    assert.equal(first.next_offset, (first.items as unknown[]).length);
    const last = readRunValue(run, "state.leads", { offset: 295, limit: 10 });
    assert.equal((last.items as unknown[]).length, 5);
    assert.equal(last.next_offset, null);

    // 20 items of ~2K each would be ~40K: the page shrinks until it fits.
    const wide = { ...run, state: { rows: Array.from({ length: 50 }, (_, i) => ({ i, body: "y".repeat(2_000) })) } };
    const page = readRunValue(wide, "state.rows");
    const count = (page.items as unknown[]).length;
    assert.ok(count > 1 && count < 20, `expected a shrunk page, got ${count} items`);
    assert.ok(JSON.stringify(page).length <= 16_000);
    assert.equal(page.next_offset, count);
  });

  it("pages a long string by characters and walks indexes", () => {
    const run = { ...bigRun(), state: { page: "abcdef".repeat(10_000) } };
    const part = readRunValue(run, "state.page", { offset: 59_990, limit: 50 });
    assert.equal(part.text, "cdefabcdef");
    assert.equal(part.next_offset, null);
    assert.equal(readRunValue(bigRun(), "trace.1.output").text, "sent");
  });

  it("returns an object too big to send as its outline, with paths to pass back", () => {
    const read = readRunValue(bigRun(), "state");
    assert.equal(read.withheld, true);
    const paths = (read.outline as Array<{ path: string }>).map((e) => e.path);
    assert.ok(paths.includes("state.leads"));
  });

  it("names the fields that exist when a path is wrong", () => {
    assert.throws(() => readRunValue(bigRun(), "state.nope"), /leads/);
    assert.throws(() => readRunValue(bigRun(), "trace.9"), /not an index/);
  });
});

describe("sweepRuns", () => {
  const now = Date.UTC(2026, 8, 25);
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const indexDir = (dir: string) => path.join(dir, "_index");

  it("deletes finished runs past retention with their sub-flow files and index entries, and nothing else", async () => {
    const dir = stateDir();
    const old = seed(dir, { status: "completed", createdAt: daysAgo(40) });
    const oldFailed = seed(dir, { status: "failed", createdAt: daysAgo(31) });
    const recent = seed(dir, { status: "completed", createdAt: daysAgo(3) });
    const paused = seed(dir, { status: "paused", createdAt: daysAgo(90) });
    const waiting = seed(dir, { status: "waiting", createdAt: daysAgo(90) });
    fs.writeFileSync(path.join(dir, `${old}_loop_each_0.json`), "{}");
    fs.writeFileSync(path.join(dir, `${old}_loop_each_0_condition_ok_yes.json`), "{}");
    fs.writeFileSync(path.join(dir, `${recent}_loop_each_0.json`), "{}");
    fs.writeFileSync(path.join(dir, "_pending-approvals.json"), "[]");

    assert.deepEqual(await sweepRuns(dir, 30, now), { indexed: 5, runs: 2, files: 4 });
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(
      left,
      [`${paused}.json`, `${recent}.json`, `${recent}_loop_each_0.json`, `${waiting}.json`, "_index", "_pending-approvals.json"].sort(),
    );
    assert.equal(left.includes(`${oldFailed}.json`), false);
    assert.deepEqual(fs.readdirSync(indexDir(dir)).sort(), [`${paused}.json`, `${recent}.json`, `${waiting}.json`].sort());
  });

  it("indexes even when retention is 0, and deletes nothing", async () => {
    const dir = stateDir();
    seed(dir, { status: "completed", createdAt: daysAgo(400) });
    assert.deepEqual(await sweepRuns(dir, 0, now), { indexed: 1, runs: 0, files: 0 });
    assert.equal(fs.readdirSync(indexDir(dir)).length, 1);
  });

  it("backfills once, re-indexes a rewritten record, and drops entries whose run is gone", async () => {
    const dir = stateDir();
    const id = seed(dir, { status: "running", createdAt: minute(1) });
    assert.equal((await sweepRuns(dir, 0, now)).indexed, 1);
    // A second sweep finds the entry current and parses nothing.
    assert.equal((await sweepRuns(dir, 0, now)).indexed, 0);

    const recordFile = path.join(dir, `${id}.json`);
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, status: "completed" }));
    assert.equal((await sweepRuns(dir, 0, now)).indexed, 1);
    assert.equal(listRuns(dir).runs[0].status, "completed");

    fs.writeFileSync(path.join(indexDir(dir), "gone.json"), "{}");
    await sweepRuns(dir, 0, now);
    assert.equal(fs.existsSync(path.join(indexDir(dir), "gone.json")), false);
  });
});

describe("run index", () => {
  it("is written by the store for runs, not for sub-flow instances", async () => {
    const dir = stateDir();
    const runner = new FlowRunner({ stateDir: dir });
    const result = await runner.run(
      { flow: "idx", nodes: [{ name: "each", do: "loop", over: "inputs.items", as: "x", nodes: [{ name: "c", do: "code", run: "1" }] }] },
      { items: [1, 2] },
    );
    const entries = fs.readdirSync(path.join(dir, "_index"));
    assert.deepEqual(entries, [`${result.instanceId}.json`]);
    const entry = JSON.parse(fs.readFileSync(path.join(dir, "_index", entries[0]), "utf8"));
    assert.equal(entry.run.status, "completed");
    assert.equal(entry.run.flowName, "idx");
    assert.equal(typeof entry.record.size, "number");
  });

  it("lists from a current entry without reading the record", () => {
    const dir = stateDir();
    const id = seed(dir, { flow: "fast", createdAt: minute(1) });
    const recordFile = path.join(dir, `${id}.json`);
    const pinned = new Date(Date.now() - 60_000);
    fs.utimesSync(recordFile, pinned, pinned);
    writeRunIndex(dir, id, JSON.parse(fs.readFileSync(recordFile, "utf8")));
    // Replace the record with garbage of the same size and the same mtime: the
    // entry still names this version, so a list that parsed the record would
    // drop the run and a list that trusts the entry keeps it.
    fs.writeFileSync(recordFile, "x".repeat(fs.statSync(recordFile).size));
    fs.utimesSync(recordFile, pinned, pinned);
    assert.equal(listRuns(dir).runs[0]?.flowName, "fast");
  });

  it("ignores an entry for an older version of the record", () => {
    const dir = stateDir();
    const id = seed(dir, { status: "running", createdAt: minute(1) });
    const recordFile = path.join(dir, `${id}.json`);
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    writeRunIndex(dir, id, record);
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, status: "completed" }));
    assert.equal(listRuns(dir).runs[0].status, "completed");
  });
});

describe("flow_status tool", () => {
  type ToolResult = { content: Array<{ type: string; text: string }> };
  type Tool = { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<ToolResult> };

  function flowStatus(dir: string): Tool {
    const tools = new Map<string, Tool>();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-runs-ws-"));
    roots.push(workspace);
    plugin.register({
      registerTool: (def: Tool) => tools.set(def.name, def),
      registerHook: () => {},
      config: { workspace, plugins: { entries: { clawflow: { config: { stateDir: dir } } } } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    return tools.get("flow_status")!;
  }

  it("pages the list, summarizes a big run, and reads one value by path", async () => {
    const dir = stateDir();
    for (let i = 0; i < 25; i++) seed(dir, { createdAt: minute(i) });
    const run = bigRun();
    fs.writeFileSync(path.join(dir, `${run.instanceId}.json`), JSON.stringify(run));
    const tool = flowStatus(dir);

    const list = JSON.parse((await tool.execute("t", { limit: 10 })).content[0].text) as RunPage;
    assert.equal(list.runs.length, 10);
    assert.equal(list.total, 26);

    const one = JSON.parse((await tool.execute("t", { instanceId: "run-1" })).content[0].text) as RunSummary;
    assert.equal(one.summary, true);

    const value = JSON.parse(
      (await tool.execute("t", { instanceId: "run-1", path: "state.inputs.max_pages" })).content[0].text,
    ) as { value: number };
    assert.equal(value.value, 2);

    const bad = (await tool.execute("t", { instanceId: "run-1", path: "state.nope" })).content[0].text;
    assert.match(bad, /^Error: .*leads/);
  });
});
