import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner, parseDuration, transpileToCloudflare } from "../src/index.js";
import type { FlowDefinition, PluginConfig } from "../src/index.js";

// Use a temp dir for state so tests don't pollute the real store
const tmpDir = path.join(os.tmpdir(), `ocf-test-${Date.now()}`);
const cfg: PluginConfig = { stateDir: path.join(tmpDir, "state"), memoryDir: path.join(tmpDir, "memory") };

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- parseDuration --------------------------------------------------------------

describe("parseDuration", () => {
  it("parses seconds", () => assert.equal(parseDuration("30s"), 30_000));
  it("parses minutes", () => assert.equal(parseDuration("5m"), 300_000));
  it("parses hours", () => assert.equal(parseDuration("2h"), 7_200_000));
  it("parses days", () => assert.equal(parseDuration("1d"), 86_400_000));
  it("parses ms", () => assert.equal(parseDuration("100ms"), 100));
  it("passes through numbers", () => assert.equal(parseDuration(500), 500));
  it("rejects invalid", () => assert.throws(() => parseDuration("nope")));
});

// ---- FlowRunner: code node ------------------------------------------------------

describe("FlowRunner — code node", () => {
  after(cleanup);

  it("evaluates inline expressions", async () => {
    const flow: FlowDefinition = {
      flow: "test-code",
      nodes: [
        { name: "double", do: "code" as const, run: "input * 2", input: "trigger.x", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { x: 21 });
    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.equal(result.state.result, 42);
  });

  it("accesses state in code nodes", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-state",
      nodes: [
        { name: "greet", do: "code" as const, run: "`Hello ${state.trigger.name}`", input: "trigger", output: "greeting" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { name: "World" });
    assert.equal(result.state.greeting, "Hello World");
  });
});

// ---- FlowRunner: branch node ----------------------------------------------------

describe("FlowRunner — branch node", () => {
  after(cleanup);

  it("follows matching path", async () => {
    const flow: FlowDefinition = {
      flow: "test-branch",
      nodes: [
        { name: "set-val", do: "code" as const, run: "'yes'", output: "answer" },
        {
          name: "route", do: "branch" as const, on: "answer",
          paths: { yes: "on-yes", no: "on-no" }, default: "on-no",
        },
        { name: "on-no", do: "code" as const, run: "'took no path'", output: "picked" },
        { name: "on-yes", do: "code" as const, run: "'took yes path'", output: "picked" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.picked, "took yes path");
  });

  it("follows default path", async () => {
    // Branch targets must be the last node in a branch path since execution
    // continues sequentially from the jump target. Place default last.
    const flow: FlowDefinition = {
      flow: "test-branch-default",
      nodes: [
        { name: "set-val", do: "code" as const, run: "'maybe'", output: "answer" },
        {
          name: "route", do: "branch" as const, on: "answer",
          paths: { yes: "on-yes" }, default: "on-default",
        },
        { name: "on-yes", do: "code" as const, run: "'yes path'", output: "picked" },
        { name: "on-default", do: "code" as const, run: "'default path'", output: "picked" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.state.picked, "default path");
  });
});

// ---- FlowRunner: loop node ------------------------------------------------------

describe("FlowRunner — loop node", () => {
  after(cleanup);

  it("iterates over arrays", async () => {
    const flow: FlowDefinition = {
      flow: "test-loop",
      nodes: [
        {
          name: "process", do: "loop" as const, over: "trigger.items", as: "item",
          nodes: [
            { name: "transform", do: "code" as const, run: "input.toUpperCase()", input: "item", output: "transformed" },
          ],
          output: "results",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { items: ["a", "b", "c"] });
    assert.equal(result.ok, true);
    const results = result.state.results as Array<{ transformed: string }>;
    assert.equal(results.length, 3);
    assert.equal(results[0].transformed, "A");
    assert.equal(results[2].transformed, "C");
  });
});

// ---- FlowRunner: parallel node --------------------------------------------------

describe("FlowRunner — parallel node", () => {
  after(cleanup);

  it("runs branches concurrently (mode: all)", async () => {
    const flow: FlowDefinition = {
      flow: "test-parallel",
      nodes: [
        {
          name: "both", do: "parallel" as const, mode: "all",
          nodes: [
            { name: "left", do: "code" as const, run: "'L'", output: "left_val" },
            { name: "right", do: "code" as const, run: "'R'", output: "right_val" },
          ],
          output: "combined",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    // Both outputs should be merged into parent state
    assert.equal(result.state.left_val, "L");
    assert.equal(result.state.right_val, "R");
  });
});

// ---- FlowRunner: wait (approval) ------------------------------------------------

describe("FlowRunner — wait for approval", () => {
  after(cleanup);

  it("pauses at approval gate and resumes", async () => {
    const flow: FlowDefinition = {
      flow: "test-approval",
      nodes: [
        { name: "prep", do: "code" as const, run: "'draft content'", output: "draft" },
        { name: "approve", do: "wait" as const, for: "approval", prompt: "Approve: {{ draft }}" },
        { name: "after", do: "code" as const, run: "'approved!'", output: "final" },
      ],
    };
    const runner = new FlowRunner(cfg);

    // First run — should pause
    const paused = await runner.run(flow, {});
    assert.equal(paused.status, "paused");
    assert.ok(paused.resumeToken);
    assert.equal(paused.waitingFor?.type, "approval");

    // Resume with approval
    const resumed = await runner.resume(paused.resumeToken!, flow, true);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.state.final, "approved!");
  });

  it("cancels when denied", async () => {
    const flow: FlowDefinition = {
      flow: "test-cancel",
      nodes: [
        { name: "approve", do: "wait" as const, for: "approval", prompt: "Proceed?" },
        { name: "after", do: "code" as const, run: "'should not run'", output: "val" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const paused = await runner.run(flow, {});
    const cancelled = await runner.resume(paused.resumeToken!, flow, false);
    assert.equal(cancelled.status, "cancelled");
  });
});

// ---- FlowRunner: memory node ----------------------------------------------------

describe("FlowRunner — memory node", () => {
  after(cleanup);

  it("writes and reads persistent values", async () => {
    const flow: FlowDefinition = {
      flow: "test-memory",
      nodes: [
        { name: "save", do: "memory" as const, action: "write", key: "test-key", value: "{{ trigger.data }}" },
        { name: "load", do: "memory" as const, action: "read", key: "test-key", output: "loaded" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { data: "hello" });
    assert.equal(result.ok, true);
    assert.equal(result.state.loaded, "hello");
  });
});

// ---- FlowRunner: sleep node -----------------------------------------------------

describe("FlowRunner — sleep node", () => {
  after(cleanup);

  it("sleeps for short duration", async () => {
    const flow: FlowDefinition = {
      flow: "test-sleep",
      nodes: [
        { name: "nap", do: "sleep" as const, duration: "100ms" },
        { name: "after", do: "code" as const, run: "'awake'", output: "status" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const t0 = Date.now();
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.status, "awake");
    assert.ok(Date.now() - t0 >= 90, "should have slept ~100ms");
  });
});

// ---- FlowRunner: durable memoization --------------------------------------------

describe("FlowRunner — durable memoization", () => {
  after(cleanup);

  it("skips completed nodes on resume", async () => {
    let callCount = 0;
    const flow: FlowDefinition = {
      flow: "test-memo",
      nodes: [
        { name: "step1", do: "code" as const, run: "'first'", output: "v1" },
        { name: "gate", do: "wait" as const, for: "approval", prompt: "ok?" },
        { name: "step2", do: "code" as const, run: "'second'", output: "v2" },
      ],
    };
    const runner = new FlowRunner(cfg);

    // First run — pauses at gate, step1 is memoized
    const paused = await runner.run(flow, {});
    assert.equal(paused.status, "paused");
    assert.equal(paused.state.v1, "first");

    // Resume — step1 should be skipped (memoized), step2 runs
    const resumed = await runner.resume(paused.resumeToken!, flow, true);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.state.v1, "first");
    assert.equal(resumed.state.v2, "second");

    // Verify memoization: step1 appears in trace with durationMs=0
    const memoizedEntry = resumed.trace.find((t) => t.node === "step1");
    assert.ok(memoizedEntry);
    assert.equal(memoizedEntry!.durationMs, 0);
  });
});

// ---- Transpiler -----------------------------------------------------------------

describe("transpileToCloudflare", () => {
  it("generates a valid WorkflowEntrypoint class", () => {
    const flow: FlowDefinition = {
      flow: "test-transpile",
      description: "Test flow for transpiler",
      nodes: [
        { name: "greet", do: "ai" as const, prompt: "Say hello", output: "greeting", model: "fast" },
        { name: "nap", do: "sleep" as const, duration: "5s" },
        { name: "notify", do: "http" as const, url: "https://example.com", method: "POST",
          body: { msg: "{{ greeting }}" }, retry: { limit: 3, delay: "1s", backoff: "exponential" }, output: "response" },
      ],
    };
    const ts = transpileToCloudflare(flow);
    assert.ok(ts.includes("class TestTranspileWorkflow"));
    assert.ok(ts.includes("extends WorkflowEntrypoint"));
    assert.ok(ts.includes('step.do("greet"'));
    assert.ok(ts.includes('step.sleep("nap"'));
    assert.ok(ts.includes('step.do("notify"'));
    assert.ok(ts.includes("resolveTemplate"));
    assert.ok(ts.includes("retries:"));
  });

  it("handles wait nodes", () => {
    const flow: FlowDefinition = {
      flow: "test-wait-transpile",
      nodes: [
        { name: "gate", do: "wait" as const, for: "approval", prompt: "ok?" },
        { name: "evt", do: "wait" as const, for: "event", event: "stripe-webhook", timeout: "1h", output: "payment" },
      ],
    };
    const ts = transpileToCloudflare(flow);
    assert.ok(ts.includes("step.waitForEvent"));
    assert.ok(ts.includes('"approval"'));
    assert.ok(ts.includes('"stripe-webhook"'));
  });
});
