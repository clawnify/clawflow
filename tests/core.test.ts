import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner, parseDuration, transpileToCloudflare, validateFlow } from "../src/index.js";
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

// ---- FlowRunner: exec node ------------------------------------------------------

describe("FlowRunner — exec node", () => {
  after(cleanup);

  it("runs a shell command and captures stdout", async () => {
    const flow: FlowDefinition = {
      flow: "test-exec",
      nodes: [
        { name: "echo-it", do: "exec" as const, command: "echo 'hello from exec'", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    const out = result.state.result as { stdout: string; stderr: string; exitCode: number };
    assert.equal(out.stdout, "hello from exec");
    assert.equal(out.exitCode, 0);
  });

  it("resolves templates in command", async () => {
    const flow: FlowDefinition = {
      flow: "test-exec-template",
      nodes: [
        { name: "run-it", do: "exec" as const, command: "echo '{{ trigger.msg }}'", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { msg: "templated" });
    const out = result.state.result as { stdout: string; stderr: string; exitCode: number };
    assert.equal(out.stdout, "templated");
  });

  it("captures non-zero exit code without throwing", async () => {
    const flow: FlowDefinition = {
      flow: "test-exec-fail",
      nodes: [
        { name: "fail-it", do: "exec" as const, command: "exit 42", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    const out = result.state.result as { stdout: string; stderr: string; exitCode: number };
    assert.equal(out.exitCode, 42);
  });

  it("captures stderr", async () => {
    const flow: FlowDefinition = {
      flow: "test-exec-stderr",
      nodes: [
        { name: "warn-it", do: "exec" as const, command: "echo 'err msg' >&2", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    const out = result.state.result as { stdout: string; stderr: string; exitCode: number };
    assert.equal(out.stderr, "err msg");
  });

  it("uses | json filter to pass objects to commands", async () => {
    const flow: FlowDefinition = {
      flow: "test-exec-json-filter",
      nodes: [
        { name: "set-data", do: "code" as const, run: "({ x: 1, y: 2 })", output: "data" },
        { name: "print-json", do: "exec" as const, command: "echo '{{ data | json }}'", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    const out = result.state.result as { stdout: string };
    assert.deepEqual(JSON.parse(out.stdout), { x: 1, y: 2 });
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
          paths: {
            yes: [{ name: "on-yes", do: "code" as const, run: "'took yes path'", output: "picked" }],
            no: [{ name: "on-no", do: "code" as const, run: "'took no path'", output: "picked" }],
          },
          default: [{ name: "on-default", do: "code" as const, run: "'took no path'", output: "picked" }],
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.picked, "took yes path");
  });

  it("follows default path", async () => {
    const flow: FlowDefinition = {
      flow: "test-branch-default",
      nodes: [
        { name: "set-val", do: "code" as const, run: "'maybe'", output: "answer" },
        {
          name: "route", do: "branch" as const, on: "answer",
          paths: {
            yes: [{ name: "on-yes", do: "code" as const, run: "'yes path'", output: "picked" }],
          },
          default: [{ name: "on-default", do: "code" as const, run: "'default path'", output: "picked" }],
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.state.picked, "default path");
  });

  it("runs multi-step sub-flow in branch path", async () => {
    const flow: FlowDefinition = {
      flow: "test-branch-subflow",
      nodes: [
        { name: "set-val", do: "code" as const, run: "'billing'", output: "category" },
        {
          name: "route", do: "branch" as const, on: "category",
          paths: {
            billing: [
              { name: "step1", do: "code" as const, run: "'looked up invoice'", output: "info" },
              { name: "step2", do: "code" as const, run: "`${state.info} and refunded`", output: "result" },
            ],
            technical: [
              { name: "tech", do: "code" as const, run: "'escalated'", output: "result" },
            ],
          },
        },
        { name: "after", do: "code" as const, run: "'done'", output: "final" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.result, "looked up invoice and refunded");
    assert.equal(result.state.final, "done");
  });
});

// ---- FlowRunner: condition node -------------------------------------------------

describe("FlowRunner — condition node", () => {
  after(cleanup);

  it("runs then branch when condition is true", async () => {
    const flow: FlowDefinition = {
      flow: "test-condition-then",
      nodes: [
        { name: "set-val", do: "code" as const, run: "'premium'", output: "tier" },
        {
          name: "check", do: "condition" as const,
          if: "tier == 'premium'",
          then: [
            { name: "premium-msg", do: "code" as const, run: "'VIP access'", output: "msg" },
          ],
          else: [
            { name: "basic-msg", do: "code" as const, run: "'standard access'", output: "msg" },
          ],
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.msg, "VIP access");
  });

  it("runs else branch when condition is false", async () => {
    const flow: FlowDefinition = {
      flow: "test-condition-else",
      nodes: [
        { name: "set-val", do: "code" as const, run: "'basic'", output: "tier" },
        {
          name: "check", do: "condition" as const,
          if: "tier == 'premium'",
          then: [
            { name: "premium-msg", do: "code" as const, run: "'VIP access'", output: "msg" },
          ],
          else: [
            { name: "basic-msg", do: "code" as const, run: "'standard access'", output: "msg" },
          ],
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.msg, "standard access");
  });

  it("skips else when absent and condition is false", async () => {
    const flow: FlowDefinition = {
      flow: "test-condition-no-else",
      nodes: [
        { name: "set-val", do: "code" as const, run: "false", output: "flag" },
        {
          name: "check", do: "condition" as const,
          if: "flag == true",
          then: [
            { name: "action", do: "code" as const, run: "'ran'", output: "result" },
          ],
        },
        { name: "after", do: "code" as const, run: "'continued'", output: "final" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.result, undefined);
    assert.equal(result.state.final, "continued");
  });

  it("handles nested dotted paths in condition", async () => {
    const flow: FlowDefinition = {
      flow: "test-condition-dotted",
      nodes: [
        {
          name: "check", do: "condition" as const,
          if: "trigger.user.role == 'admin'",
          then: [
            { name: "admin-msg", do: "code" as const, run: "'admin panel'", output: "view" },
          ],
          else: [
            { name: "user-msg", do: "code" as const, run: "'user dashboard'", output: "view" },
          ],
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { user: { role: "admin" } });
    assert.equal(result.state.view, "admin panel");

    const result2 = await runner.run(flow, { user: { role: "viewer" } });
    assert.equal(result2.state.view, "user dashboard");
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

  it("wildcard collects loop outputs for downstream nodes", async () => {
    const flow: FlowDefinition = {
      flow: "test-loop-wildcard",
      nodes: [
        {
          name: "process_sheets", do: "loop" as const, over: "trigger.sheets", as: "sheet",
          nodes: [
            { name: "build-path", do: "code" as const, run: "`/output/foglio_${state.sheet.type}.pdf`", output: "pdfPath" },
          ],
          output: "process_sheets",
        },
        { name: "collect", do: "code" as const, run: "state.process_sheets.map(s => s.pdfPath)", output: "allPaths" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { sheets: [{ type: "densita" }, { type: "diametri" }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.state.allPaths, ["/output/foglio_densita.pdf", "/output/foglio_diametri.pdf"]);
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

// ---- FlowRunner: approve node ---------------------------------------------------

describe("FlowRunner — approve node", () => {
  after(cleanup);

  it("pauses at approve gate with token and preview", async () => {
    const flow: FlowDefinition = {
      flow: "test-approve",
      nodes: [
        { name: "prep", do: "code" as const, run: "({ files: ['/a.pdf', '/b.pdf'] })", output: "data" },
        {
          name: "review", do: "approve" as const,
          prompt: "Review files for {{ trigger.client }}",
          preview: "data.files",
          output: "approval",
        },
        { name: "after", do: "code" as const, run: "'done'", output: "final" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const paused = await runner.run(flow, { client: "ACME" });

    assert.equal(paused.status, "paused");
    assert.ok(paused.resumeToken);
    assert.ok(paused.resumeToken!.startsWith("cf-"));
    assert.equal(paused.waitingFor?.type, "approval");
    assert.equal(paused.waitingFor?.prompt, "Review files for ACME");
    assert.deepEqual(paused.waitingFor?.preview, ["/a.pdf", "/b.pdf"]);

    // Check pending approvals registry
    const pending = runner.listApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].token, paused.resumeToken);
    assert.equal(pending[0].flowName, "test-approve");
    assert.equal(pending[0].node, "review");
  });

  it("resumes with token and preserves pre-approval trace", async () => {
    const flow: FlowDefinition = {
      flow: "test-approve-resume",
      nodes: [
        { name: "step1", do: "code" as const, run: "'first'", output: "v1" },
        { name: "gate", do: "approve" as const, prompt: "Approve?", output: "approval" },
        { name: "step2", do: "code" as const, run: "'second'", output: "v2" },
      ],
    };
    const runner = new FlowRunner(cfg);

    const paused = await runner.run(flow, {});
    assert.equal(paused.status, "paused");
    assert.equal(paused.state.v1, "first");

    // Pre-approval trace should have step1 (ok) and gate (paused)
    assert.equal(paused.trace.length, 2);
    assert.equal(paused.trace[0].node, "step1");
    assert.equal(paused.trace[0].status, "ok");
    assert.ok(paused.trace[0].durationMs > 0 || paused.trace[0].durationMs === 0);
    assert.equal(paused.trace[1].node, "gate");
    assert.equal(paused.trace[1].status, "paused");

    // Resume with the approve token
    const resumed = await runner.resume(paused.resumeToken!, flow, true);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.state.v1, "first");
    assert.equal(resumed.state.v2, "second");

    // Trace should have all 3 entries with original timing preserved
    assert.equal(resumed.trace.length, 3);
    assert.equal(resumed.trace[0].node, "step1");
    assert.equal(resumed.trace[0].status, "ok");
    assert.equal(resumed.trace[1].node, "gate");
    assert.equal(resumed.trace[1].status, "ok"); // updated from paused to ok
    assert.equal(resumed.trace[2].node, "step2");
    assert.equal(resumed.trace[2].status, "ok");

    // Approval output should be stored
    const approvalOutput = resumed.state.approval as { approved: boolean; approvedAt: string; token: string };
    assert.equal(approvalOutput.approved, true);
    assert.ok(approvalOutput.approvedAt);

    // This approval's token should be resolved (removed from pending)
    const remaining = runner.listApprovals().filter(a => a.token === paused.resumeToken);
    assert.equal(remaining.length, 0);
  });

  it("cancels when denied and preserves trace", async () => {
    const flow: FlowDefinition = {
      flow: "test-approve-cancel",
      nodes: [
        { name: "prep", do: "code" as const, run: "'done'", output: "v1" },
        { name: "gate", do: "approve" as const, prompt: "Proceed?" },
        { name: "after", do: "code" as const, run: "'should not run'", output: "v2" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const paused = await runner.run(flow, {});
    const cancelled = await runner.resume(paused.resumeToken!, flow, false);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.state.v1, "done");
    assert.equal(cancelled.state.v2, undefined);

    // Trace should show prep ok, gate skipped
    assert.equal(cancelled.trace.length, 2);
    assert.equal(cancelled.trace[0].status, "ok");
    assert.equal(cancelled.trace[1].status, "skipped");
  });

  it("validates approve node requires prompt", () => {
    const flow: FlowDefinition = {
      flow: "bad-approve",
      nodes: [{ name: "bad", do: "approve" as const, prompt: "" } as any],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("requires")));
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

  it("includes applyFilter in transpiled output", () => {
    const flow: FlowDefinition = {
      flow: "test-filter-transpile",
      nodes: [
        { name: "greet", do: "ai" as const, prompt: "hi" },
      ],
    };
    const ts = transpileToCloudflare(flow);
    assert.ok(ts.includes("applyFilter"));
    assert.ok(ts.includes('"tojson"'));
  });
});

// ---- Template filters -------------------------------------------------------------

describe("template filters", () => {
  let runner: FlowRunner;

  before(() => {
    runner = new FlowRunner(cfg);
  });

  after(cleanup);

  const state = {
    trigger: { body: "hello world" },
    plan: { title: "My Plan", tags: ["a", "b", "c"] },
    data: { count: 42, nested: { x: 1, y: 2 }, text: "  padded  " },
  };

  it("tojson serializes objects", () => {
    assert.equal(runner.resolveTemplate("{{ plan.tags | tojson }}", state), '["a","b","c"]');
  });

  it("tojson passes strings through", () => {
    assert.equal(runner.resolveTemplate("{{ plan.title | tojson }}", state), "My Plan");
  });

  it("json is an alias for tojson", () => {
    assert.equal(runner.resolveTemplate("{{ plan.tags | json }}", state), '["a","b","c"]');
    assert.equal(runner.resolveTemplate("{{ plan.title | json }}", state), "My Plan");
  });

  it("upper converts to uppercase", () => {
    assert.equal(runner.resolveTemplate("{{ plan.title | upper }}", state), "MY PLAN");
  });

  it("lower converts to lowercase", () => {
    assert.equal(runner.resolveTemplate("{{ plan.title | lower }}", state), "my plan");
  });

  it("trim strips whitespace", () => {
    assert.equal(runner.resolveTemplate("{{ data.text | trim }}", state), "padded");
  });

  it("length returns array length", () => {
    assert.equal(runner.resolveTemplate("{{ plan.tags | length }}", state), "3");
  });

  it("length returns string length", () => {
    assert.equal(runner.resolveTemplate("{{ plan.title | length }}", state), "7");
  });

  it("length returns object key count", () => {
    assert.equal(runner.resolveTemplate("{{ data.nested | length }}", state), "2");
  });

  it("unknown filter falls back to string conversion", () => {
    assert.equal(runner.resolveTemplate("{{ data.count | nope }}", state), "42");
  });

  it("works without filter (unchanged behavior)", () => {
    assert.equal(runner.resolveTemplate("{{ plan.title }}", state), "My Plan");
  });

  it("preserves unresolved templates", () => {
    assert.equal(runner.resolveTemplate("{{ missing.path }}", state), "{{missing.path}}");
  });

  it("filter in mixed text", () => {
    assert.equal(
      runner.resolveTemplate("Title: {{ plan.title | upper }}!", state),
      "Title: MY PLAN!",
    );
  });

  // ---- Ternary expressions ----

  it("ternary with string equality (true branch)", () => {
    const s = { ...state, sheet: { type: "diametri" } };
    assert.equal(
      runner.resolveTemplate("{{ sheet.type == 'diametri' ? '_diametri' : '' }}", s),
      "_diametri",
    );
  });

  it("ternary with string equality (false branch)", () => {
    const s = { ...state, sheet: { type: "densita" } };
    assert.equal(
      runner.resolveTemplate("{{ sheet.type == 'diametri' ? '_diametri' : '' }}", s),
      "",
    );
  });

  it("ternary with != operator", () => {
    const s = { ...state, sheet: { type: "densita" } };
    assert.equal(
      runner.resolveTemplate("{{ sheet.type != 'diametri' ? 'other' : 'match' }}", s),
      "other",
    );
  });

  it("ternary with numeric comparison", () => {
    assert.equal(
      runner.resolveTemplate("{{ data.count > 10 ? 'big' : 'small' }}", state),
      "big",
    );
  });

  it("ternary with bare truthy check", () => {
    const s = { ...state, flag: true };
    assert.equal(runner.resolveTemplate("{{ flag ? 'yes' : 'no' }}", s), "yes");
    const s2 = { ...state, flag: false };
    assert.equal(runner.resolveTemplate("{{ flag ? 'yes' : 'no' }}", s2), "no");
  });

  it("ternary in mixed text", () => {
    const s = { ...state, sheet: { type: "diametri" } };
    assert.equal(
      runner.resolveTemplate("script{{ sheet.type == 'diametri' ? '_diametri' : '' }}.py", s),
      "script_diametri.py",
    );
  });

  // ---- Wildcard [*] ----

  it("wildcard collects field from array", () => {
    const s = {
      ...state,
      results: [
        { pdfPath: "/a.pdf", other: 1 },
        { pdfPath: "/b.pdf", other: 2 },
        { pdfPath: "/c.pdf", other: 3 },
      ],
    };
    assert.equal(
      runner.resolveTemplate("{{ results[*].pdfPath }}", s),
      JSON.stringify(["/a.pdf", "/b.pdf", "/c.pdf"]),
    );
  });

  it("wildcard without field returns full array", () => {
    const s = { ...state, items: [1, 2, 3] };
    assert.equal(runner.resolveTemplate("{{ items[*] }}", s), "[1,2,3]");
  });

  it("wildcard preserves unresolved when not array", () => {
    assert.equal(runner.resolveTemplate("{{ plan.title[*].x }}", state), "{{plan.title[*].x}}");
  });
});

// ---- validateFlow ---------------------------------------------------------------

describe("validateFlow", () => {
  it("passes a valid flow", () => {
    const flow: FlowDefinition = {
      flow: "valid",
      nodes: [
        { name: "step1", do: "code" as const, run: "'hello'", output: "greeting" },
        { name: "step2", do: "code" as const, run: "input.length", input: "greeting", output: "len" },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("catches duplicate node names", () => {
    const flow: FlowDefinition = {
      flow: "dupes",
      nodes: [
        { name: "step", do: "code" as const, run: "'a'", output: "x" },
        { name: "step", do: "code" as const, run: "'b'", output: "y" },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("Duplicate")));
  });

  it("catches missing required fields", () => {
    const flow: FlowDefinition = {
      flow: "missing-fields",
      nodes: [
        { name: "bad-ai", do: "ai" as const, prompt: "" } as any,
        { name: "bad-http", do: "http" as const, url: "" } as any,
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("requires")));
  });

  it("catches template referencing node name instead of output key", () => {
    const flow: FlowDefinition = {
      flow: "bad-ref",
      nodes: [
        { name: "get_data", do: "http" as const, url: "https://example.com", output: "api" },
        { name: "use_data", do: "code" as const, run: "'ok'", output: "result" },
      ],
    };
    // This flow is valid — but if someone used {{ get_data.body }} it would fail
    const result = validateFlow(flow);
    assert.equal(result.ok, true);

    // Now test with a bad template ref
    const badFlow: FlowDefinition = {
      flow: "bad-ref2",
      nodes: [
        { name: "get_data", do: "http" as const, url: "https://example.com", output: "api" },
        {
          name: "parse", do: "ai" as const,
          prompt: "Parse this: {{ get_data.body }}",
          output: "parsed",
        },
      ],
    };
    const badResult = validateFlow(badFlow);
    assert.equal(badResult.ok, false);
    assert.ok(badResult.errors.some((e) => e.message.includes("get_data")));
  });

  it("catches bad branch on reference", () => {
    const flow: FlowDefinition = {
      flow: "bad-branch-on",
      nodes: [
        {
          name: "route", do: "branch" as const, on: "nonexistent.field",
          paths: {
            a: [{ name: "path-a", do: "code" as const, run: "'a'", output: "x" }],
          },
        },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("nonexistent")));
  });

  it("catches bad condition if reference", () => {
    const flow: FlowDefinition = {
      flow: "bad-condition-if",
      nodes: [
        {
          name: "check", do: "condition" as const,
          if: "missing_var == true",
          then: [{ name: "action", do: "code" as const, run: "'ok'", output: "x" }],
        },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("missing_var")));
  });

  it("validates sub-flow template refs inside branch paths", () => {
    const flow: FlowDefinition = {
      flow: "branch-subflow-refs",
      nodes: [
        { name: "classify", do: "code" as const, run: "'billing'", output: "category" },
        {
          name: "route", do: "branch" as const, on: "category",
          paths: {
            billing: [
              { name: "lookup", do: "http" as const, url: "https://example.com", output: "invoice" },
              { name: "draft", do: "ai" as const, prompt: "Draft for {{ invoice }}", output: "reply" },
            ],
          },
        },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true);
  });

  it("runner returns validation error instead of executing", async () => {
    const flow: FlowDefinition = {
      flow: "invalid",
      nodes: [
        { name: "bad", do: "ai" as const, prompt: "" } as any,
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("Validation failed"));
  });

  it("allows trigger refs without prior nodes", () => {
    const flow: FlowDefinition = {
      flow: "trigger-ref",
      nodes: [
        { name: "greet", do: "ai" as const, prompt: "Hello {{ trigger.name }}", output: "msg" },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true);
  });

  it("validates exec node requires command", () => {
    const flow: FlowDefinition = {
      flow: "bad-exec",
      nodes: [
        { name: "bad", do: "exec" as const, command: "" } as any,
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("requires")));
  });

  it("validates exec node template refs", () => {
    const flow: FlowDefinition = {
      flow: "exec-ref",
      nodes: [
        { name: "run", do: "exec" as const, command: "echo '{{ trigger.x }}'", output: "out" },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true);
  });

  it("catches unknown node type", () => {
    const flow: FlowDefinition = {
      flow: "unknown-type",
      nodes: [
        { name: "bad", do: "foobar" as any, output: "x" },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("Unknown node type")));
  });
});
