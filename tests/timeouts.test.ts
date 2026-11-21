import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner } from "../src/index.js";
import type { FlowDefinition, FlowNode, PluginConfig } from "../src/index.js";

// How long a step may run: its own `timeout`, else the default for one step
// (maxNodeDurationMs, or 30 s and 120 s for agent steps). Containers, sleep
// and wait get no default. An agent step's limit is also its turn's limit in
// OpenClaw, which otherwise stops the turn after 600 s.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-timeouts-"));
const cfg: PluginConfig = { stateDir: path.join(tmpDir, "state"), memoryDir: path.join(tmpDir, "memory") };
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A default short enough for a test to outlast. */
const shortDefault: PluginConfig = { ...cfg, maxNodeDurationMs: 100 };
/** Outlasts that default, but stays within its own limit. */
const slow: FlowNode = { name: "slow", do: "exec", command: "sleep 0.4 && echo done", timeout: "5s", output: "slow" };

describe("step time limits: containers", () => {
  const containers: Array<[string, FlowNode]> = [
    ["condition", { name: "gate", do: "condition", if: "inputs.go", then: [slow] }],
    ["branch", { name: "route", do: "branch", on: "inputs.kind", paths: { a: [slow] } }],
    ["loop", { name: "each", do: "loop", over: "inputs.items", as: "item", nodes: [slow] }],
    ["parallel", { name: "both", do: "parallel", nodes: [slow] }],
  ];
  for (const [kind, node] of containers) {
    it(`a ${kind} runs as long as the steps inside it take, each within its own limit`, async () => {
      const flow: FlowDefinition = { flow: `slow-${kind}`, nodes: [node] };
      const result = await new FlowRunner(shortDefault).run(flow, { go: true, kind: "a", items: [1, 2] });
      assert.equal(result.status, "completed", result.error);
    });
  }

  it("a timeout set on a container still caps everything inside it", async () => {
    const flow: FlowDefinition = {
      flow: "capped-loop",
      nodes: [{ name: "each", do: "loop", over: "inputs.items", as: "item", timeout: "100ms", nodes: [slow] }],
    };
    const result = await new FlowRunner(cfg).run(flow, { items: [1] });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Node "each" timed out after 100ms/);
  });

  it("a single step still gets the default", async () => {
    const flow: FlowDefinition = { flow: "slow-step", nodes: [{ ...slow, timeout: undefined }] };
    const result = await new FlowRunner(shortDefault).run(flow, {});
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out after 100ms/);
  });

  it("records no limit for a loop without one, and each agent step's own inside it", async () => {
    const runner = new FlowRunner(cfg) as any;
    const seen: any[] = [];
    runner.tryOpenClawAgent = async () => {
      seen.push(runner.getStore().get("loop-agents")?.running, runner.getStore().get("loop-agents:loop:each:0")?.running);
      return "OK";
    };
    const flow: FlowDefinition = {
      flow: "loop-agents",
      nodes: [{ name: "each", do: "loop", over: "inputs.items", as: "item", nodes: [
        { name: "ask", do: "agent", sessionKey: "agent:main:item-{{ item }}", task: "Handle {{ item }}", timeout: "2h" },
      ] }],
    };
    const result = await runner.run(flow, { items: [1] }, "loop-agents");
    assert.equal(result.status, "completed", result.error);
    const [loop, step] = seen;
    assert.equal(loop?.node, "each");
    assert.equal(loop?.timeoutMs, undefined);
    assert.equal(step?.node, "ask");
    assert.equal(step?.timeoutMs, 7_200_000);
  });
});

describe("step time limits: sleep and wait", () => {
  it("a sleep lasts its duration, past the default", async () => {
    const flow: FlowDefinition = { flow: "long-nap", nodes: [{ name: "nap", do: "sleep", duration: "400ms" }] };
    const result = await new FlowRunner(shortDefault).run(flow, {});
    assert.equal(result.status, "completed", result.error);
  });

  it("a wait for an event waits past the default", async () => {
    const runner = new FlowRunner(shortDefault);
    const flow: FlowDefinition = {
      flow: "long-wait",
      nodes: [{ name: "hold", do: "wait", for: "event", event: "go", output: "payload" }],
    };
    const done = runner.run(flow, {}, "long-wait");
    await sleep(400);
    assert.equal(runner.sendEvent("long-wait", "go", { n: 1 }), true, "the wait is still listening");
    const result = await done;
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(result.state.payload, { n: 1 });
  });
});

describe("an agent step's limit is also its turn's limit in OpenClaw", () => {
  // A stand-in for the openclaw CLI that writes down the arguments it got.
  const bin = path.join(tmpDir, "bin");
  const argsFile = path.join(tmpDir, "openclaw-args");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "openclaw"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho OK\n`, { mode: 0o755 });

  /** Run one agent step and return the --timeout it passed to openclaw agent. */
  async function timeoutPassed(config: PluginConfig, timeout?: string): Promise<string | undefined> {
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      fs.rmSync(argsFile, { force: true });
      const flow: FlowDefinition = {
        flow: "agent-timeout",
        nodes: [{ name: "ask", do: "agent", sessionKey: "agent:main:hook:x", task: "Do it", ...(timeout ? { timeout } : {}) }],
      };
      const result = await new FlowRunner(config).run(flow, {});
      assert.equal(result.status, "completed", result.error);
      const args = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
      assert.equal(args[0], "agent");
      assert.equal(args.at(-2), "--message", "the task stays the last argument");
      const i = args.indexOf("--timeout");
      return i < 0 ? undefined : args[i + 1];
    } finally {
      process.env.PATH = savedPath;
    }
  }

  it("passes the step's timeout in seconds", async () => {
    assert.equal(await timeoutPassed(cfg, "2h"), "7200");
  });

  it("passes the default limit when the step sets none", async () => {
    assert.equal(await timeoutPassed(cfg), "120");
    assert.equal(await timeoutPassed({ ...cfg, maxNodeDurationMs: 45_000 }), "45");
  });

  it("rounds up to whole seconds, so the runner's own timer fires first", async () => {
    assert.equal(await timeoutPassed(cfg, "1500ms"), "2");
  });
});
