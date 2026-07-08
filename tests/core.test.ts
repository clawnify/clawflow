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
        { name: "double", do: "code" as const, run: "input * 2", input: "inputs.x", output: "result" },
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
        { name: "greet", do: "code" as const, run: "`Hello ${state.inputs.name}`", input: "inputs", output: "greeting" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { name: "World" });
    assert.equal(result.state.greeting, "Hello World");
  });

  it("supports multi-statement body with explicit return", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-multi",
      nodes: [
        { name: "calc", do: "code" as const, run: "const x = input + 1;\nreturn x * 2;", input: "inputs.x", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { x: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.state.result, 12);
  });

  it("supports semicolon-separated multi-statement body", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-semi",
      nodes: [
        { name: "calc", do: "code" as const, run: "const a = input.x; const b = input.y; return a + b;", input: "inputs", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { x: 3, y: 7 });
    assert.equal(result.ok, true);
    assert.equal(result.state.result, 10);
  });

  it("prevents mutation of state", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-frozen-state",
      nodes: [
        { name: "mutate", do: "code" as const, run: "state.inputs.x = 999; return 1;", input: "inputs", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { x: 1 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /runtime error/);
    assert.match(result.error!, /frozen/i);
  });

  it("prevents mutation of input", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-frozen-input",
      nodes: [
        { name: "mutate", do: "code" as const, run: "input.x = 999; return 1;", input: "inputs", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, { x: 1 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /runtime error/);
    assert.match(result.error!, /frozen/i);
  });

  it("provides helpful error for const in expression mode", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-const-hint",
      nodes: [
        { name: "bad", do: "code" as const, run: "const x = 1", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /syntax error/);
    assert.match(result.error!, /const/);
  });

  it("provides helpful error for require() usage", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-require-hint",
      nodes: [
        { name: "bad", do: "code" as const, run: "require('fs')", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /require/);
  });

  it("IIFE expressions return their value (not treated as multi-statement)", async () => {
    const flow: FlowDefinition = {
      flow: "test-code-iife",
      nodes: [
        {
          name: "build",
          do: "code" as const,
          run: "(function() { var a = 'hello'; var b = 'world'; return a + ' ' + b; })()",
          output: "result",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.result, "hello world");
  });
});

// ---- FlowRunner: code node diagnostics ------------------------------------------

describe("FlowRunner — code node diagnostics", () => {
  after(cleanup);

  it("shows available keys when accessing missing property on input", async () => {
    const flow: FlowDefinition = {
      flow: "test-diag-missing-key",
      nodes: [
        {
          name: "bad_access",
          do: "code" as const,
          run: "input.email_to",
          input: "inputs.payload",
          output: "result",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {
      payload: { client: "Acme", order: 123 },
      email_to: "user@example.com",
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /email_to/);
    assert.match(result.error!, /Input keys:/);
    assert.match(result.error!, /client/);
    assert.match(result.error!, /state\.inputs\.email_to/);
  });

  it("catches chained access on missing property via Proxy", async () => {
    const flow: FlowDefinition = {
      flow: "test-diag-undefined-chain",
      nodes: [
        {
          name: "bad_chain",
          do: "code" as const,
          run: "input.nested.deep",
          input: "inputs.payload",
          output: "result",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {
      payload: { client: "Acme" },
      email_to: "user@example.com",
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /runtime error/);
    assert.match(result.error!, /'nested' is not a key in input/);
    assert.match(result.error!, /Input keys:/);
  });

  it("does not throw for valid property access", async () => {
    const flow: FlowDefinition = {
      flow: "test-diag-valid",
      nodes: [
        {
          name: "good_access",
          do: "code" as const,
          run: "input.client",
          input: "inputs.payload",
          output: "result",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {
      payload: { client: "Acme" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.result, "Acme");
  });
});

// ---- FlowRunner: exec node ------------------------------------------------------

describe("FlowRunner — agent node field resolution", () => {
  after(cleanup);

  // agent nodes shell out to the openclaw CLI, so we can't drive them end-to-end
  // here. This asserts the generic pre-resolution pass (execNode → resolveNodeFields)
  // interpolates the CLI-selector fields, which is the whole point of classifying
  // agent/sessionKey/sessionId/channel as "template" in NODE_FIELD_MODES.
  it("interpolates agent/sessionKey/sessionId/channel templates; leaves the node unmutated", () => {
    const runner = new FlowRunner(cfg) as any;
    const node = {
      name: "reply",
      do: "agent",
      task: "answer {{ inputs.q }}",
      agent: "{{ route.slug }}",
      sessionKey: "agent:{{ route.slug }}:slack:{{ inputs.channel }}",
      sessionId: "{{ route.sid }}",
      channel: "{{ route.channel }}",
    };
    const state = {
      route: { slug: "ops", sid: "sess-9", channel: "slack" },
      inputs: { q: "hi", channel: "c123" },
    };
    const resolved = runner.resolveNodeFields(node, state);

    assert.equal(resolved.agent, "ops");
    assert.equal(resolved.sessionKey, "agent:ops:slack:c123");
    assert.equal(resolved.sessionId, "sess-9");
    assert.equal(resolved.channel, "slack");
    assert.equal(resolved.task, "answer hi");
    // original node is not mutated (flows are reused across runs)
    assert.equal(node.agent, "{{ route.slug }}");
    assert.equal(node.sessionId, "{{ route.sid }}");
  });

  it("builds openclaw agent selector args from target fields", () => {
    const runner = new FlowRunner(cfg) as any;
    // all selectors pass through in order; --channel is delivery, not a target
    assert.deepEqual(
      runner.buildAgentArgs({ agent: "ops", sessionKey: "s-key", sessionId: "s-id", channel: "slack" }),
      ["--agent", "ops", "--session-key", "s-key", "--session-id", "s-id", "--channel", "slack"],
    );
    // sessionKey only, no agent → key alone (openclaw scopes it)
    assert.deepEqual(runner.buildAgentArgs({ sessionKey: "agent:main:slack:c1" }), [
      "--session-key", "agent:main:slack:c1",
    ]);
    // no target selector at all → fall back to a routable default agent
    assert.deepEqual(runner.buildAgentArgs({}), ["--agent", "main"]);
    assert.deepEqual(runner.buildAgentArgs({ channel: "slack" }), ["--channel", "slack", "--agent", "main"]);
    // a bare sessionId is a target → no default-agent fallback
    assert.deepEqual(runner.buildAgentArgs({ sessionId: "sess-9" }), ["--session-id", "sess-9"]);
  });
});

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
        { name: "run-it", do: "exec" as const, command: "echo '{{ inputs.msg }}'", output: "result" },
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
          if: "inputs.user.role == 'admin'",
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
          name: "process", do: "loop" as const, over: "inputs.items", as: "item",
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
          name: "process_sheets", do: "loop" as const, over: "inputs.sheets", as: "sheet",
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

// ---- FlowRunner: wait for approval (with token, preview, trace) -----------------

describe("FlowRunner — wait for approval (enhanced)", () => {
  after(cleanup);

  it("pauses with token and preview", async () => {
    const flow: FlowDefinition = {
      flow: "test-approval-token",
      nodes: [
        { name: "prep", do: "code" as const, run: "({ files: ['/a.pdf', '/b.pdf'] })", output: "data" },
        {
          name: "review", do: "wait" as const, for: "approval",
          prompt: "Review files for {{ inputs.client }}",
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
    assert.equal(pending[0].flowName, "test-approval-token");
    assert.equal(pending[0].node, "review");
  });

  it("resumes with token and preserves pre-approval trace", async () => {
    const flow: FlowDefinition = {
      flow: "test-approval-resume",
      nodes: [
        { name: "step1", do: "code" as const, run: "'first'", output: "v1" },
        { name: "gate", do: "wait" as const, for: "approval", prompt: "Approve?", output: "approval" },
        { name: "step2", do: "code" as const, run: "'second'", output: "v2" },
      ],
    };
    const runner = new FlowRunner(cfg);

    const paused = await runner.run(flow, {});
    assert.equal(paused.status, "paused");
    assert.equal(paused.state.v1, "first");

    // Pre-approval trace: step1 (ok) + gate (paused)
    assert.equal(paused.trace.length, 2);
    assert.equal(paused.trace[0].node, "step1");
    assert.equal(paused.trace[0].status, "ok");
    assert.equal(paused.trace[1].node, "gate");
    assert.equal(paused.trace[1].status, "paused");

    // Resume with the token
    const resumed = await runner.resume(paused.resumeToken!, flow, true);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.state.v1, "first");
    assert.equal(resumed.state.v2, "second");

    // All 3 trace entries preserved
    assert.equal(resumed.trace.length, 3);
    assert.equal(resumed.trace[0].node, "step1");
    assert.equal(resumed.trace[0].status, "ok");
    assert.equal(resumed.trace[1].node, "gate");
    assert.equal(resumed.trace[1].status, "ok");
    assert.equal(resumed.trace[2].node, "step2");
    assert.equal(resumed.trace[2].status, "ok");

    // Approval output
    const approvalOutput = resumed.state.approval as { approved: boolean; approvedAt: string };
    assert.equal(approvalOutput.approved, true);
    assert.ok(approvalOutput.approvedAt);

    // Token resolved from pending
    const remaining = runner.listApprovals().filter(a => a.token === paused.resumeToken);
    assert.equal(remaining.length, 0);
  });

  it("cancels when denied and preserves trace", async () => {
    const flow: FlowDefinition = {
      flow: "test-approval-cancel",
      nodes: [
        { name: "prep", do: "code" as const, run: "'done'", output: "v1" },
        { name: "gate", do: "wait" as const, for: "approval", prompt: "Proceed?" },
        { name: "after", do: "code" as const, run: "'should not run'", output: "v2" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const paused = await runner.run(flow, {});
    const cancelled = await runner.resume(paused.resumeToken!, flow, false);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.state.v1, "done");
    assert.equal(cancelled.state.v2, undefined);
    assert.equal(cancelled.trace.length, 2);
    assert.equal(cancelled.trace[0].status, "ok");
    assert.equal(cancelled.trace[1].status, "skipped");
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
        { name: "save", do: "memory" as const, action: "write", key: "test-key", value: "{{ inputs.data }}" },
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

    // Verify memoization: step1 appears in trace with negligible duration
    const memoizedEntry = resumed.trace.find((t) => t.node === "step1");
    assert.ok(memoizedEntry);
    assert.ok(memoizedEntry!.durationMs <= 5, `memoized step should be near-instant, got ${memoizedEntry!.durationMs}ms`);
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
    inputs: { body: "hello world" },
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

  it("resolves array index {{ arr[0].field }}", () => {
    const s = { ...state, business: [{ name: "Acme", id: 1 }, { name: "Beta", id: 2 }] };
    assert.equal(runner.resolveTemplate("{{ business[0].name }}", s), "Acme");
    assert.equal(runner.resolveTemplate("{{ business[1].id }}", s), "2");
  });

  it("resolves array index in mixed string", () => {
    const s = { ...state, items: ["a", "b", "c"] };
    assert.equal(runner.resolveTemplate("val={{ items[0] }}", s), "val=a");
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

  it("allows inputs refs without prior nodes", () => {
    const flow: FlowDefinition = {
      flow: "inputs-ref",
      nodes: [
        { name: "greet", do: "ai" as const, prompt: "Hello {{ inputs.name }}", output: "msg" },
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
        { name: "run", do: "exec" as const, command: "echo '{{ inputs.x }}'", output: "out" },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true);
  });

  it("catches branch path placed as sibling of paths", () => {
    const flow: FlowDefinition = {
      flow: "misplaced-branch-path",
      nodes: [
        { name: "classify", do: "code" as const, run: "'densita'", output: "order_type" },
        {
          name: "route", do: "branch" as const, on: "order_type",
          paths: {
            densita: [{ name: "d1", do: "code" as const, run: "'ok'", output: "x" }],
          },
          // This is the bug: diametri is a sibling of paths, not inside it
          diametri: [{ name: "d2", do: "code" as const, run: "'ok'", output: "y" }],
        } as any,
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("Unknown field \"diametri\"")));
  });

  it("catches unknown fields on any node type", () => {
    const flow: FlowDefinition = {
      flow: "unknown-field",
      nodes: [
        { name: "bad", do: "ai" as const, prompt: "hello", bogus: true } as any,
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("Unknown field \"bogus\"")));
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

  it("validates env field structure", () => {
    const flow: FlowDefinition = {
      flow: "env-valid",
      env: { API_KEY: null, MODE: "prod" },
      nodes: [{ name: "a", do: "code" as const, run: "'ok'", output: "x" }],
    };
    assert.equal(validateFlow(flow).ok, true);
  });

  it("rejects non-string env values", () => {
    const flow: FlowDefinition = {
      flow: "env-bad",
      env: { BAD: 123 as any },
      nodes: [{ name: "a", do: "code" as const, run: "'ok'", output: "x" }],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("must be a string or null")));
  });

  it("allows {{ env.X }} template references without errors", () => {
    const flow: FlowDefinition = {
      flow: "env-ref",
      nodes: [{
        name: "call",
        do: "http" as const,
        url: "https://api.example.com",
        headers: { Authorization: "Bearer {{ env.TOKEN }}" },
        output: "resp",
      }],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true);
  });

  it("accepts an agent node with a session key", () => {
    const flow: FlowDefinition = {
      flow: "agent-session",
      nodes: [{
        name: "reply",
        do: "agent" as const,
        task: "answer",
        session: "agent:main:slack:channel:agent",
        output: "r",
      }] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("rejects a session-key-shaped agentId (should use session)", () => {
    const flow: FlowDefinition = {
      flow: "agent-bad-id",
      nodes: [{
        name: "reply",
        do: "agent" as const,
        task: "answer",
        agentId: "agent:main:slack:channel:agent",
        output: "r",
      }] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes("session-key-shaped")));
  });

  it("allows combining agentId with a bare session key (agent scopes the key)", () => {
    const flow: FlowDefinition = {
      flow: "agent-both",
      nodes: [{
        name: "reply",
        do: "agent" as const,
        task: "answer",
        agentId: "ops",
        session: "incident-42",
        output: "r",
      }] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("validates template refs in agentId/session (dynamic fields)", () => {
    const flow: FlowDefinition = {
      flow: "agent-dynamic-target",
      nodes: [
        { name: "route", do: "code" as const, run: "({ slug: 'ops' })", output: "route" },
        {
          name: "reply",
          do: "agent" as const,
          task: "answer",
          agentId: "{{ route.slug }}",
          session: "{{ route.slug }}-42",
          output: "r",
        },
      ] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("accepts an agent node with channel and sessionId selectors", () => {
    const flow: FlowDefinition = {
      flow: "agent-selectors",
      nodes: [{
        name: "reply",
        do: "agent" as const,
        task: "answer",
        agentId: "ops",
        sessionId: "sess-9",
        channel: "slack",
        output: "r",
      }] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("flags an undefined template ref in agentId", () => {
    const flow: FlowDefinition = {
      flow: "agent-bad-ref",
      nodes: [{
        name: "reply",
        do: "agent" as const,
        task: "answer",
        agentId: "{{ nope.slug }}",
        output: "r",
      }] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.field === "agentId" && e.message.includes("nope")),
      JSON.stringify(result.errors),
    );
  });

  it("accepts the new agent/sessionKey names with no deprecation warnings", () => {
    const flow: FlowDefinition = {
      flow: "agent-new-names",
      nodes: [{
        name: "reply",
        do: "agent" as const,
        task: "answer",
        agent: "ops",
        sessionKey: "incident-42",
        output: "r",
      }] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
  });

  it("warns (non-blocking) on deprecated agentId/session aliases", () => {
    const flow: FlowDefinition = {
      flow: "agent-deprecated",
      nodes: [{
        name: "reply",
        do: "agent" as const,
        task: "answer",
        agentId: "ops",
        session: "incident-42",
        output: "r",
      }] as any,
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true, JSON.stringify(result.errors)); // aliases still work
    assert.ok(result.warnings.some((w) => w.field === "agentId" && /deprecated/.test(w.message)));
    assert.ok(result.warnings.some((w) => w.field === "session" && /deprecated/.test(w.message)));
  });
});

// ---- Attachments (multimodal) -------------------------------------------------------

describe("attachments — unit tests", () => {
  after(cleanup);

  it("passes content parts to inferenceFn", async () => {
    // Create a tiny 1x1 PNG in the temp dir
    const pngPath = path.join(tmpDir, "test.png");
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    // Minimal valid 1x1 white PNG (67 bytes)
    const pngBuf = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
      "Nl7BcQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(pngPath, pngBuf);

    let capturedContent: unknown = undefined;
    const mockCfg: PluginConfig = {
      ...cfg,
      inferenceFn: async (req) => {
        capturedContent = req.content;
        return { text: "I see a white pixel" };
      },
    };

    const flow: FlowDefinition = {
      flow: "test-attachments",
      nodes: [
        {
          name: "describe-img",
          do: "ai" as const,
          prompt: "What is in this image?",
          attachments: [pngPath],
          output: "desc",
        },
      ],
    };

    const runner = new FlowRunner(mockCfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.desc, "I see a white pixel");

    // Verify content parts structure
    assert.ok(Array.isArray(capturedContent));
    const parts = capturedContent as any[];
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, "text");
    assert.ok(parts[0].text.includes("What is in this image?"));
    assert.equal(parts[1].type, "image_url");
    assert.ok(parts[1].image_url.url.startsWith("data:image/png;base64,"));
  });

  it("passes URL attachments without reading files", async () => {
    let capturedContent: unknown = undefined;
    const mockCfg: PluginConfig = {
      ...cfg,
      inferenceFn: async (req) => {
        capturedContent = req.content;
        return { text: "nice image" };
      },
    };

    const flow: FlowDefinition = {
      flow: "test-url-attachment",
      nodes: [
        {
          name: "describe-url",
          do: "ai" as const,
          prompt: "Describe",
          attachments: ["https://example.com/photo.jpg"],
          output: "desc",
        },
      ],
    };

    const runner = new FlowRunner(mockCfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);

    const parts = capturedContent as any[];
    assert.equal(parts[1].type, "image_url");
    assert.equal(parts[1].image_url.url, "https://example.com/photo.jpg");
  });

  it("handles PDF attachments with file type", async () => {
    const pdfPath = path.join(tmpDir, "test.pdf");
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    // Minimal PDF header
    fs.writeFileSync(pdfPath, "%PDF-1.4 minimal");

    let capturedContent: unknown = undefined;
    const mockCfg: PluginConfig = {
      ...cfg,
      inferenceFn: async (req) => {
        capturedContent = req.content;
        return { text: "document summary" };
      },
    };

    const flow: FlowDefinition = {
      flow: "test-pdf-attachment",
      nodes: [
        {
          name: "read-pdf",
          do: "ai" as const,
          prompt: "Summarize this PDF",
          attachments: [pdfPath],
          output: "summary",
        },
      ],
    };

    const runner = new FlowRunner(mockCfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);

    const parts = capturedContent as any[];
    assert.equal(parts[1].type, "file");
    assert.equal(parts[1].file.filename, "test.pdf");
    assert.ok(parts[1].file.file_data.startsWith("data:application/pdf;base64,"));
  });

  it("resolves templates in attachment paths", async () => {
    const pngPath = path.join(tmpDir, "templated.png");
    const pngBuf = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
      "Nl7BcQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(pngPath, pngBuf);

    let capturedContent: unknown = undefined;
    const mockCfg: PluginConfig = {
      ...cfg,
      inferenceFn: async (req) => {
        capturedContent = req.content;
        return { text: "ok" };
      },
    };

    const flow: FlowDefinition = {
      flow: "test-template-attachment",
      nodes: [
        {
          name: "analyze",
          do: "ai" as const,
          prompt: "Analyze",
          attachments: ["{{ inputs.imgPath }}"],
          output: "result",
        },
      ],
    };

    const runner = new FlowRunner(mockCfg);
    const result = await runner.run(flow, { imgPath: pngPath });
    assert.equal(result.ok, true);

    const parts = capturedContent as any[];
    assert.equal(parts.length, 2);
    assert.equal(parts[1].type, "image_url");
  });

  it("rejects unsupported file extensions", async () => {
    const txtPath = path.join(tmpDir, "bad.txt");
    fs.writeFileSync(txtPath, "hello");

    const mockCfg: PluginConfig = {
      ...cfg,
      inferenceFn: async () => ({ text: "nope" }),
    };

    const flow: FlowDefinition = {
      flow: "test-bad-ext",
      nodes: [
        {
          name: "bad",
          do: "ai" as const,
          prompt: "Read",
          attachments: [txtPath],
          output: "x",
        },
      ],
    };

    const runner = new FlowRunner(mockCfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("Unsupported attachment type"));
  });

  it("sends no content parts when attachments is empty", async () => {
    let capturedContent: unknown = "NOT_SET";
    const mockCfg: PluginConfig = {
      ...cfg,
      inferenceFn: async (req) => {
        capturedContent = req.content;
        return { text: "plain" };
      },
    };

    const flow: FlowDefinition = {
      flow: "test-no-attachments",
      nodes: [
        { name: "plain", do: "ai" as const, prompt: "Hi", output: "msg" },
      ],
    };

    const runner = new FlowRunner(mockCfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(capturedContent, undefined);
  });

  it("validates attachment template refs", () => {
    const flow: FlowDefinition = {
      flow: "test-attachment-ref",
      nodes: [
        {
          name: "analyze",
          do: "ai" as const,
          prompt: "Check",
          attachments: ["{{ inputs.path }}"],
          output: "result",
        },
      ],
    };
    const result = validateFlow(flow);
    assert.equal(result.ok, true);
  });
});

// ---- Attachments — integration (real OpenRouter calls) --------------------------------

// Load .env from project root if OPENROUTER_API_KEY not already set
if (!process.env.OPENROUTER_API_KEY) {
  const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../.env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  }
}
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const fixturesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");

describe("attachments — OpenRouter integration", { skip: !OPENROUTER_KEY }, () => {
  after(cleanup);

  it("sends an image and counts people", async () => {
    const pngPath = path.join(fixturesDir, "test.jpg");

    const flow: FlowDefinition = {
      flow: "integration-image",
      nodes: [
        {
          name: "count",
          do: "ai" as const,
          prompt: "How many people are in this image? Answer with just the number.",
          attachments: [pngPath],
          model: "google/gemini-2.0-flash-001",
          output: "answer",
        },
      ],
    };

    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true, `Expected ok but got error: ${result.error}`);
    const answer = String(result.state.answer).trim().toLowerCase();
    assert.ok(answer.includes("2") || answer.includes("two"), `Expected answer to contain "2" or "two", got: "${answer}"`);
  });

  it("structured output from image attachment", async () => {
    const pngPath = path.join(fixturesDir, "test.jpg");

    const flow: FlowDefinition = {
      flow: "integration-image-schema",
      nodes: [
        {
          name: "analyze",
          do: "ai" as const,
          prompt: "Analyze this image.",
          attachments: [pngPath],
          model: "google/gemini-2.0-flash-001",
          schema: { people_count: "number", description: "string" },
          output: "analysis",
        },
      ],
    };

    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true, `Expected ok but got error: ${result.error}`);
    const analysis = result.state.analysis as Record<string, unknown>;
    assert.equal(typeof analysis, "object", "Expected structured object output");
    assert.ok("people_count" in analysis, `Missing people_count in: ${JSON.stringify(analysis)}`);
    assert.ok("description" in analysis, `Missing description in: ${JSON.stringify(analysis)}`);
    assert.equal(analysis.people_count, 2, `Expected people_count=2, got: ${analysis.people_count}`);
  });

  it("structured output from PDF attachment", async () => {
    const pdfPath = path.join(fixturesDir, "test.pdf");

    const flow: FlowDefinition = {
      flow: "integration-pdf-schema",
      nodes: [
        {
          name: "extract",
          do: "ai" as const,
          prompt: "Extract info from this PDF.",
          attachments: [pdfPath],
          model: "google/gemini-2.0-flash-001",
          schema: { title: "string", page_count: "number" },
          output: "extracted",
        },
      ],
    };

    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true, `Expected ok but got error: ${result.error}`);
    const extracted = result.state.extracted as Record<string, unknown>;
    assert.equal(typeof extracted, "object", "Expected structured object output");
    assert.ok("title" in extracted, `Missing title in: ${JSON.stringify(extracted)}`);
    assert.ok(String(extracted.title).toLowerCase().includes("smallpdf"), `Expected title to contain "smallpdf", got: ${extracted.title}`);
  });

  it("sends a PDF and reads the title", async () => {
    const pdfPath = path.join(fixturesDir, "test.pdf");

    const flow: FlowDefinition = {
      flow: "integration-pdf",
      nodes: [
        {
          name: "read-title",
          do: "ai" as const,
          prompt: "What is the title in this PDF? Answer with just the title text.",
          attachments: [pdfPath],
          model: "google/gemini-2.0-flash-001",
          output: "title",
        },
      ],
    };

    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true, `Expected ok but got error: ${result.error}`);
    const title = String(result.state.title).trim().toLowerCase();
    assert.ok(title.includes("smallpdf"), `Expected title to contain "smallpdf", got: "${title}"`);
  });
});

// ---- Anthropic integration ----------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

describe("attachments — Anthropic integration", { skip: !ANTHROPIC_KEY }, () => {
  after(cleanup);

  // Temporarily hide OpenRouter key so callDirectApi falls through to Anthropic
  let savedOR: string | undefined;
  before(() => { savedOR = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY; });
  after(() => { if (savedOR) process.env.OPENROUTER_API_KEY = savedOR; });

  it("sends an image and describes it", async () => {
    const pngPath = path.join(fixturesDir, "test.jpg");
    const flow: FlowDefinition = {
      flow: "anthropic-image",
      nodes: [
        {
          name: "describe",
          do: "ai" as const,
          prompt: "How many people are in this image? Answer with just the number.",
          attachments: [pngPath],
          model: "claude-sonnet-4-20250514",
          output: "answer",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true, `Expected ok but got error: ${result.error}`);
    const answer = String(result.state.answer).trim().toLowerCase();
    assert.ok(answer.includes("2") || answer.includes("two"), `Expected "2" or "two", got: "${answer}"`);
  });

  it("sends a PDF and extracts info", async () => {
    const pdfPath = path.join(fixturesDir, "test.pdf");
    const flow: FlowDefinition = {
      flow: "anthropic-pdf",
      nodes: [
        {
          name: "extract",
          do: "ai" as const,
          prompt: "What is the title in this PDF? Answer with just the title text.",
          attachments: [pdfPath],
          model: "claude-sonnet-4-20250514",
          output: "title",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true, `Expected ok but got error: ${result.error}`);
    const title = String(result.state.title).trim().toLowerCase();
    assert.ok(title.includes("smallpdf"), `Expected title to contain "smallpdf", got: "${title}"`);
  });
});

// ---- OpenAI integration -------------------------------------------------------------

const OPENAI_KEY = process.env.OPENAI_API_KEY;

describe("attachments — OpenAI integration", { skip: !OPENAI_KEY }, () => {
  after(cleanup);

  // Temporarily hide OpenRouter + Anthropic keys so callDirectApi falls through to OpenAI
  let savedOR: string | undefined;
  let savedAnthropic: string | undefined;
  before(() => {
    savedOR = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
    savedAnthropic = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  });
  after(() => {
    if (savedOR) process.env.OPENROUTER_API_KEY = savedOR;
    if (savedAnthropic) process.env.ANTHROPIC_API_KEY = savedAnthropic;
  });

  it("sends an image and describes it", async () => {
    const pngPath = path.join(fixturesDir, "test.jpg");
    const flow: FlowDefinition = {
      flow: "openai-image",
      nodes: [
        {
          name: "describe",
          do: "ai" as const,
          prompt: "How many people are in this image? Answer with just the number.",
          attachments: [pngPath],
          model: "gpt-4o-mini",
          output: "answer",
        },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true, `Expected ok but got error: ${result.error}`);
    const answer = String(result.state.answer).trim().toLowerCase();
    assert.ok(answer.includes("2") || answer.includes("two"), `Expected "2" or "two", got: "${answer}"`);
  });
});

// ---- FlowRunner — env support -----------------------------------------------------

describe("FlowRunner — env", () => {
  after(cleanup);

  it("resolves {{ env.X }} from flow env defaults", async () => {
    const flow: FlowDefinition = {
      flow: "env-default",
      env: { GREETING: "hello" },
      nodes: [
        { name: "echo", do: "code" as const, run: "input", input: "env.GREETING", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.result, "hello");
  });

  it("process.env overrides flow env defaults", async () => {
    process.env.TEST_CF_OVERRIDE = "from-process";
    try {
      const flow: FlowDefinition = {
        flow: "env-override",
        env: { TEST_CF_OVERRIDE: "default-val" },
        nodes: [
          { name: "echo", do: "code" as const, run: "input", input: "env.TEST_CF_OVERRIDE", output: "result" },
        ],
      };
      const runner = new FlowRunner(cfg);
      const result = await runner.run(flow, {});
      assert.equal(result.ok, true);
      assert.equal(result.state.result, "from-process");
    } finally {
      delete process.env.TEST_CF_OVERRIDE;
    }
  });

  it("fails when required env var (null) is missing", async () => {
    delete process.env.MISSING_VAR;
    const flow: FlowDefinition = {
      flow: "env-required",
      env: { MISSING_VAR: null },
      nodes: [
        { name: "a", do: "code" as const, run: "'ok'", output: "x" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("Missing required env vars"));
    assert.ok(result.error?.includes("MISSING_VAR"));
  });

  it("resolves {{ env.TOKEN }} in http headers via templates", async () => {
    const flow: FlowDefinition = {
      flow: "env-template",
      env: { TOKEN: "my-secret-token" },
      nodes: [
        { name: "show", do: "code" as const, run: "input", input: "env.TOKEN", output: "tok" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.tok, "my-secret-token");
  });

  it("required env var satisfied by process.env succeeds", async () => {
    process.env.TEST_CF_REQUIRED = "provided";
    try {
      const flow: FlowDefinition = {
        flow: "env-required-ok",
        env: { TEST_CF_REQUIRED: null },
        nodes: [
          { name: "echo", do: "code" as const, run: "input", input: "env.TEST_CF_REQUIRED", output: "result" },
        ],
      };
      const runner = new FlowRunner(cfg);
      const result = await runner.run(flow, {});
      assert.equal(result.ok, true);
      assert.equal(result.state.result, "provided");
    } finally {
      delete process.env.TEST_CF_REQUIRED;
    }
  });

  it("shell-expands $(command) in env values", async () => {
    const flow: FlowDefinition = {
      flow: "env-shell",
      env: { GREETING: "$(echo hello-from-shell)" },
      nodes: [
        { name: "echo", do: "code" as const, run: "input", input: "env.GREETING", output: "result" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(result.state.result, "hello-from-shell");
  });

  it("fails early when $(command) returns empty", async () => {
    const flow: FlowDefinition = {
      flow: "env-shell-empty",
      env: { BAD: "$(printf '')" },
      nodes: [
        { name: "a", do: "code" as const, run: "'ok'", output: "x" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("returned empty"));
  });

  it("fails early when $(command) errors", async () => {
    const flow: FlowDefinition = {
      flow: "env-shell-fail",
      env: { BAD: "$(nonexistent_command_xyz_123)" },
      nodes: [
        { name: "a", do: "code" as const, run: "'ok'", output: "x" },
      ],
    };
    const runner = new FlowRunner(cfg);
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("failed to resolve"));
  });

  it("process.env overrides $(command) — no shell exec needed", async () => {
    process.env.TEST_CF_SHELL_SKIP = "already-set";
    try {
      const flow: FlowDefinition = {
        flow: "env-shell-skip",
        env: { TEST_CF_SHELL_SKIP: "$(echo should-not-run)" },
        nodes: [
          { name: "echo", do: "code" as const, run: "input", input: "env.TEST_CF_SHELL_SKIP", output: "result" },
        ],
      };
      const runner = new FlowRunner(cfg);
      const result = await runner.run(flow, {});
      assert.equal(result.ok, true);
      assert.equal(result.state.result, "already-set");
    } finally {
      delete process.env.TEST_CF_SHELL_SKIP;
    }
  });
});

// ---- flow_edit deep node targeting --------------------------------------------------

describe("flow_edit deep node targeting", () => {
  // Capture the flow_edit execute function from the plugin
  let flowEdit: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;

  before(async () => {
    const plugin = (await import("../src/plugin/index.js")).default;
    const tools: Record<string, (id: string, params: Record<string, unknown>) => Promise<unknown>> = {};
    const mockApi = {
      registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }, _opts?: unknown) => {
        tools[def.name] = def.execute as typeof tools[string];
      },
      config: {},
    };
    plugin.register(mockApi as any);
    flowEdit = tools["flow_edit"] as typeof flowEdit;
    assert.ok(flowEdit, "flow_edit tool should be registered");
  });

  /** Helper: build a flow with nested nodes for testing */
  function makeNestedFlow(): FlowDefinition {
    return {
      flow: "test-deep-edit",
      nodes: [
        { name: "setup", do: "code" as const, run: "'init'", output: "init" },
        {
          name: "router", do: "branch" as const, on: "init",
          paths: {
            a: [
              { name: "stepA1", do: "code" as const, run: "'a1'", output: "a1" },
              { name: "stepA2", do: "code" as const, run: "'a2'", output: "a2" },
            ],
            b: [
              { name: "stepB1", do: "code" as const, run: "'b1'", output: "b1" },
            ],
          },
        },
        { name: "final", do: "code" as const, run: "'done'", output: "done" },
      ],
    };
  }

  function makeConditionFlow(): FlowDefinition {
    return {
      flow: "test-deep-condition",
      nodes: [
        { name: "check", do: "code" as const, run: "true", output: "flag" },
        {
          name: "gate", do: "condition" as const, if: "flag == true",
          then: [
            { name: "thenStep", do: "code" as const, run: "'yes'", output: "thenOut" },
          ],
          else: [
            { name: "elseStep", do: "code" as const, run: "'no'", output: "elseOut" },
          ],
        },
      ],
    };
  }

  function makeLoopFlow(): FlowDefinition {
    return {
      flow: "test-deep-loop",
      nodes: [
        { name: "data", do: "code" as const, run: "[1,2,3]", output: "items" },
        {
          name: "myLoop", do: "loop" as const, over: "items", as: "item",
          nodes: [
            { name: "process", do: "code" as const, run: "'processed'", output: "result" },
          ],
        },
      ],
    };
  }

  function makeParallelFlow(): FlowDefinition {
    return {
      flow: "test-deep-parallel",
      nodes: [
        {
          name: "par", do: "parallel" as const,
          nodes: [
            { name: "branch1", do: "code" as const, run: "'b1'", output: "r1" },
            { name: "branch2", do: "code" as const, run: "'b2'", output: "r2" },
          ],
        },
      ],
    };
  }

  // ---- Update nested nodes ----

  it("updates a node nested inside a branch path", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "stepA1",
      fields: { run: "'updated-a1'" },
    });
    assert.ok(result.content[0].text.includes("updated"));
    const updated = result.details as FlowDefinition;
    const router = updated.nodes[1] as any;
    assert.equal(router.paths.a[0].run, "'updated-a1'");
  });

  it("updates a node nested inside a condition then block", async () => {
    const flow = makeConditionFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "thenStep",
      fields: { run: "'updated-yes'" },
    });
    assert.ok(result.content[0].text.includes("updated"));
    const updated = result.details as FlowDefinition;
    const gate = updated.nodes[1] as any;
    assert.equal(gate.then[0].run, "'updated-yes'");
  });

  it("updates a node nested inside a condition else block", async () => {
    const flow = makeConditionFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "elseStep",
      fields: { run: "'updated-no'" },
    });
    assert.ok(result.content[0].text.includes("updated"));
    const updated = result.details as FlowDefinition;
    const gate = updated.nodes[1] as any;
    assert.equal(gate.else[0].run, "'updated-no'");
  });

  it("updates a node nested inside a loop", async () => {
    const flow = makeLoopFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "process",
      fields: { run: "'loop-updated'" },
    });
    assert.ok(result.content[0].text.includes("updated"));
    const updated = result.details as FlowDefinition;
    const loop = updated.nodes[1] as any;
    assert.equal(loop.nodes[0].run, "'loop-updated'");
  });

  it("updates a node nested inside a parallel block", async () => {
    const flow = makeParallelFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "branch2",
      fields: { run: "'par-updated'" },
    });
    assert.ok(result.content[0].text.includes("updated"));
    const updated = result.details as FlowDefinition;
    const par = updated.nodes[0] as any;
    assert.equal(par.nodes[1].run, "'par-updated'");
  });

  it("replaces a nested node entirely", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "stepB1",
      replace: { name: "stepB1", do: "code" as const, run: "'replaced'", output: "b1new" },
    });
    assert.ok(result.content[0].text.includes("updated"));
    const updated = result.details as FlowDefinition;
    const router = updated.nodes[1] as any;
    assert.equal(router.paths.b[0].run, "'replaced'");
    assert.equal(router.paths.b[0].output, "b1new");
  });

  // ---- Remove nested nodes ----

  it("removes a node nested inside a branch path", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "remove", node: "stepA2",
    });
    assert.ok(result.content[0].text.includes("removed"));
    const updated = result.details as FlowDefinition;
    const router = updated.nodes[1] as any;
    assert.equal(router.paths.a.length, 1);
    assert.equal(router.paths.a[0].name, "stepA1");
  });

  it("removes a node from a loop with multiple children", async () => {
    const flow: FlowDefinition = {
      flow: "test-loop-remove",
      nodes: [
        { name: "data", do: "code" as const, run: "[1,2]", output: "items" },
        {
          name: "myLoop", do: "loop" as const, over: "items", as: "item",
          nodes: [
            { name: "step1", do: "code" as const, run: "'a'", output: "r1" },
            { name: "step2", do: "code" as const, run: "'b'", output: "r2" },
          ],
        },
      ],
    };
    const result = await flowEdit("test", {
      flow, action: "remove", node: "step1",
    });
    assert.ok(result.content[0].text.includes("removed"));
    const updated = result.details as FlowDefinition;
    const loop = updated.nodes[1] as any;
    assert.equal(loop.nodes.length, 1);
    assert.equal(loop.nodes[0].name, "step2");
  });

  // ---- Add into nested containers ----

  it("adds a node inside a branch path via parent", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "add", parent: "router/a",
      nodeDefinition: { name: "stepA3", do: "code" as const, run: "'a3'", output: "a3" },
    });
    assert.ok(result.content[0].text.includes("added"));
    const updated = result.details as FlowDefinition;
    const router = updated.nodes[1] as any;
    assert.equal(router.paths.a.length, 3);
    assert.equal(router.paths.a[2].name, "stepA3");
  });

  it("adds a node inside a loop via parent", async () => {
    const flow = makeLoopFlow();
    const result = await flowEdit("test", {
      flow, action: "add", parent: "myLoop",
      nodeDefinition: { name: "extra", do: "code" as const, run: "'extra'", output: "extra" },
    });
    assert.ok(result.content[0].text.includes("added"));
    const updated = result.details as FlowDefinition;
    const loop = updated.nodes[1] as any;
    assert.equal(loop.nodes.length, 2);
    assert.equal(loop.nodes[1].name, "extra");
  });

  it("adds a node inside a condition then block via parent", async () => {
    const flow = makeConditionFlow();
    const result = await flowEdit("test", {
      flow, action: "add", parent: "gate/then",
      nodeDefinition: { name: "thenExtra", do: "code" as const, run: "'extra'", output: "thenExtra" },
    });
    assert.ok(result.content[0].text.includes("added"));
    const updated = result.details as FlowDefinition;
    const gate = updated.nodes[1] as any;
    assert.equal(gate.then.length, 2);
    assert.equal(gate.then[1].name, "thenExtra");
  });

  it("adds at a specific position inside a nested parent", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "add", parent: "router/a", position: 0,
      nodeDefinition: { name: "stepA0", do: "code" as const, run: "'a0'", output: "a0" },
    });
    assert.ok(result.content[0].text.includes("added"));
    const updated = result.details as FlowDefinition;
    const router = updated.nodes[1] as any;
    assert.equal(router.paths.a[0].name, "stepA0");
    assert.equal(router.paths.a.length, 3);
  });

  // ---- Move nested nodes ----

  it("moves a nested node to a different position within same parent", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "move", node: "stepA2", parent: "router/a", position: 0,
    });
    assert.ok(result.content[0].text.includes("moved"));
    const updated = result.details as FlowDefinition;
    const router = updated.nodes[1] as any;
    assert.equal(router.paths.a[0].name, "stepA2");
    assert.equal(router.paths.a[1].name, "stepA1");
  });

  // ---- Not-found still works ----

  it("returns error for non-existent nested node", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "doesNotExist",
      fields: { run: "'x'" },
    });
    assert.ok(result.content[0].text.includes("not found"));
  });

  // ---- Top-level still works alongside deep targeting ----

  it("still updates top-level nodes", async () => {
    const flow = makeNestedFlow();
    const result = await flowEdit("test", {
      flow, action: "update", node: "setup",
      fields: { run: "'top-level-updated'" },
    });
    assert.ok(result.content[0].text.includes("updated"));
    const updated = result.details as FlowDefinition;
    assert.equal(updated.nodes[0].run, "'top-level-updated'");
  });
});

// ---- FlowRunner — ai node provider selection ------------------------------------

describe("FlowRunner — ai node providers", () => {
  after(cleanup);

  const clawnifyProvider = {
    baseUrl: "https://api.clawnify.example/v1",
    api: "openai-completions" as const,
    apiKey: "test-key",
    models: { fast: "clawnify-lite", smart: "clawnify-pro", best: "clawnify-max" },
  };

  it("maps model tiers to a provider's model IDs (via defaultProvider)", async () => {
    let capturedModel = "";
    const runner = new FlowRunner({
      ...cfg,
      defaultProvider: "clawnify",
      providers: { clawnify: clawnifyProvider },
      inferenceFn: async (req) => { capturedModel = req.model; return { text: "ok" }; },
    });
    const flow: FlowDefinition = {
      flow: "prov-tier",
      nodes: [{ name: "gen", do: "ai" as const, prompt: "hi", model: "smart", output: "out" }],
    };
    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.equal(capturedModel, "clawnify-pro");
  });

  it("normalizes an unknown model to the provider's smart tier (Option A)", async () => {
    let capturedModel = "";
    const runner = new FlowRunner({
      ...cfg,
      providers: { clawnify: clawnifyProvider },
      inferenceFn: async (req) => { capturedModel = req.model; return { text: "ok" }; },
    });
    const flow: FlowDefinition = {
      flow: "prov-normalize",
      nodes: [{
        name: "gen", do: "ai" as const, prompt: "hi",
        provider: "clawnify", model: "anthropic/claude-sonnet-4.6", output: "out",
      }],
    };
    await runner.run(flow, {});
    assert.equal(capturedModel, "clawnify-pro");
  });

  it("passes through a value that is already a provider model ID", async () => {
    let capturedModel = "";
    const runner = new FlowRunner({
      ...cfg,
      providers: { clawnify: clawnifyProvider },
      inferenceFn: async (req) => { capturedModel = req.model; return { text: "ok" }; },
    });
    const flow: FlowDefinition = {
      flow: "prov-passthrough",
      nodes: [{
        name: "gen", do: "ai" as const, prompt: "hi",
        provider: "clawnify", model: "clawnify-max", output: "out",
      }],
    };
    await runner.run(flow, {});
    assert.equal(capturedModel, "clawnify-max");
  });

  it("routes the request to the provider baseUrl with its API key", async () => {
    const origFetch = globalThis.fetch;
    let seenUrl = "";
    let seenAuth = "";
    let seenBody: any = {};
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url);
      seenAuth = init?.headers?.Authorization ?? "";
      seenBody = JSON.parse(init?.body ?? "{}");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "routed" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const runner = new FlowRunner({
        ...cfg,
        defaultProvider: "clawnify",
        providers: { clawnify: clawnifyProvider },
      });
      const flow: FlowDefinition = {
        flow: "prov-route",
        nodes: [{ name: "gen", do: "ai" as const, prompt: "hi", model: "fast", output: "out" }],
      };
      const result = await runner.run(flow, {});
      assert.equal(result.ok, true);
      assert.equal(result.state.out, "routed");
      assert.equal(seenUrl, "https://api.clawnify.example/v1/chat/completions");
      assert.equal(seenAuth, "Bearer test-key");
      assert.equal(seenBody.model, "clawnify-lite");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("does not fall back to a stray OPENROUTER_API_KEY when a provider is selected", async () => {
    const origFetch = globalThis.fetch;
    const origKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-shared-should-not-be-used";
    let seenUrl = "";
    globalThis.fetch = (async (url: any) => {
      seenUrl = String(url);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const runner = new FlowRunner({
        ...cfg,
        defaultProvider: "clawnify",
        providers: { clawnify: clawnifyProvider },
      });
      const flow: FlowDefinition = {
        flow: "prov-no-env-leak",
        nodes: [{ name: "gen", do: "ai" as const, prompt: "hi", output: "out" }],
      };
      await runner.run(flow, {});
      assert.ok(!seenUrl.includes("openrouter.ai"), `expected clawnify route, got ${seenUrl}`);
      assert.ok(seenUrl.startsWith("https://api.clawnify.example/v1"));
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = origKey;
    }
  });

  it("fails the node when the selected provider is unknown", async () => {
    const runner = new FlowRunner({ ...cfg });
    const flow: FlowDefinition = {
      flow: "prov-unknown",
      nodes: [{ name: "gen", do: "ai" as const, prompt: "hi", provider: "nope", output: "out" }],
    };
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /unknown provider .*nope/);
  });

  it("fails the node when the selected provider has no API key", async () => {
    const runner = new FlowRunner({
      ...cfg,
      providers: { clawnify: { baseUrl: "https://api.clawnify.example/v1", apiKeyEnv: "DEFINITELY_UNSET_KEY_XYZ" } },
    });
    const flow: FlowDefinition = {
      flow: "prov-nokey",
      nodes: [{ name: "gen", do: "ai" as const, prompt: "hi", provider: "clawnify", output: "out" }],
    };
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /no API key/);
  });
});
