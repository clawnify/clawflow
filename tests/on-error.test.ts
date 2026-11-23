import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FlowRunner, StepRegistry, transpileToCloudflare, validateFlow } from "../src/index.js";
import type { FlowDefinition, FlowNode, PluginConfig } from "../src/index.js";

// onError: "continue". A step that fails after its retries does not end the
// run: it is recorded as an error, its output key holds { error }, and the
// next step runs. So a flow can write down that its own step failed.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-on-error-"));
const cfg: PluginConfig = {
  stateDir: path.join(tmpDir, "state"),
  memoryDir: path.join(tmpDir, "memory"),
};

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A runner with two steps of its own: `boom` always throws and counts its
 *  attempts; `flaky` throws for the items named in `failFor`. */
function harness() {
  const registry = new StepRegistry();
  const calls = { boom: 0 };
  registry.register({
    name: "boom",
    allowedKeys: ["message"],
    run: (input) => {
      calls.boom++;
      throw new Error(String(input.message ?? "boom"));
    },
  });
  registry.register({
    name: "flaky",
    allowedKeys: ["item", "failFor"],
    run: (input) => {
      if ((input.failFor as unknown[]).includes(input.item)) throw new Error(`cannot do ${input.item}`);
      return `did ${input.item}`;
    },
  });
  return { runner: new FlowRunner({ ...cfg, customSteps: registry }), registry, calls };
}

/** A node of a custom step type, which the built-in node union does not list. */
const node = (n: Record<string, unknown>) => n as unknown as FlowNode;

describe('onError: "continue"', () => {
  it("records the failure, puts { error } under the step's output key, and runs the next step", async () => {
    const { runner } = harness();
    const flow: FlowDefinition = {
      flow: "records-failure",
      nodes: [
        node({ name: "work", do: "boom", message: "model unavailable", onError: "continue", output: "work" }),
        { name: "note", do: "code", run: "state.work.error ? 'failed: ' + state.work.error : 'fine'", output: "note" },
      ],
    };
    const result = await runner.run(flow, {}, "records-failure-1");

    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.state.work, { error: "model unavailable" });
    assert.equal(result.state.note, "failed: model unavailable");
    assert.deepEqual(
      result.trace.map((t) => [t.node, t.status, t.error]),
      [["work", "error", "model unavailable"], ["note", "ok", undefined]],
    );

    const record = await runner.getStore().get("records-failure-1");
    assert.equal(record?.status, "completed");
    assert.deepEqual(record?.state.work, { error: "model unavailable" });
    assert.equal(record?.running, undefined);
  });

  it("uses the step's retries first", async () => {
    const { runner, calls } = harness();
    const flow: FlowDefinition = {
      flow: "retries-first",
      nodes: [
        node({ name: "work", do: "boom", onError: "continue", output: "work", retry: { limit: 3, delay: 1 } }),
      ],
    };
    const result = await runner.run(flow, {});
    assert.equal(result.status, "completed");
    assert.equal(calls.boom, 3);
  });

  it("lets a template read the error, and reads as empty for a step that succeeded", async () => {
    const { runner } = harness();
    const flow: FlowDefinition = {
      flow: "templates",
      nodes: [
        node({ name: "bad", do: "boom", message: "nope", onError: "continue", output: "bad" }),
        node({ name: "good", do: "flaky", item: "a", failFor: [], onError: "continue", output: "good" }),
        { name: "said", do: "code", run: "({ bad: state.bad.error, good: state.good })", output: "said" },
        { name: "check", do: "condition", if: "good.error", then: [{ name: "never", do: "code", run: "1", output: "never" }], output: "goodFailed" },
      ],
    };
    const result = await runner.run(flow, {});
    assert.equal(result.status, "completed");
    assert.deepEqual(result.state.said, { bad: "nope", good: "did a" });
    assert.equal(result.state.goodFailed, false);
    assert.equal("never" in result.state, false);
  });

  it("lets a flow write its own step's failure to memory (the README example)", async () => {
    const { runner } = harness();
    const flow: FlowDefinition = {
      flow: "writes-failure",
      nodes: [
        node({ name: "work", do: "boom", message: "model unavailable", onError: "continue", output: "work" }),
        {
          name: "failed",
          do: "condition",
          if: "work.error",
          then: [
            { name: "record", do: "memory", action: "write", key: "order-{{ inputs.order }}", value: "failed: {{ work.error }}" },
          ],
        },
      ],
    };
    const result = await runner.run(flow, { order: 42 });
    assert.equal(result.status, "completed");
    const stored = JSON.parse(fs.readFileSync(path.join(cfg.memoryDir!, "order-42.json"), "utf8"));
    assert.equal(stored.value, "failed: model unavailable");
  });

  it("keeps a loop going past the item whose step failed", async () => {
    const { runner } = harness();
    const flow: FlowDefinition = {
      flow: "loop-goes-on",
      nodes: [
        {
          name: "each",
          do: "loop",
          over: "inputs.items",
          as: "item",
          output: "results",
          nodes: [
            node({ name: "work", do: "flaky", item: "{{ item }}", failFor: ["b"], onError: "continue", output: "work" }),
          ],
        },
        { name: "summary", do: "code", run: "state.results.map((r) => r.work.error ?? r.work)", output: "summary" },
      ],
    };
    const result = await runner.run(flow, { items: ["a", "b", "c"] });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.state.summary, ["did a", "cannot do b", "did c"]);
  });

  it("covers a step that runs out of time", async () => {
    const { runner } = harness();
    const flow: FlowDefinition = {
      flow: "times-out",
      nodes: [
        { name: "wait", do: "sleep", duration: "5s", timeout: "50ms", onError: "continue", output: "wait" },
        { name: "after", do: "code", run: "'ran'", output: "after" },
      ],
    };
    const result = await runner.run(flow, {});
    assert.equal(result.status, "completed");
    assert.match((result.state.wait as { error: string }).error, /timed out after 50ms/);
    assert.equal(result.state.after, "ran");
  });

  it("does not turn a cancel into a continue", async () => {
    const { runner } = harness();
    const flow: FlowDefinition = {
      flow: "cancelled",
      nodes: [
        { name: "wait", do: "sleep", duration: "5s", onError: "continue", output: "wait" },
        { name: "after", do: "code", run: "'ran'", output: "after" },
      ],
    };
    const done = runner.run(flow, {}, "cancelled-1");
    await sleep(100);
    await runner.cancel("cancelled-1", "stop");
    const result = await done;
    assert.equal(result.status, "cancelled");
    assert.equal("after" in result.state, false);
    assert.equal(result.trace.at(-1)?.status, "cancelled");
  });

  it("still fails the run without it, and with \"fail\"", async () => {
    const { runner } = harness();
    for (const onError of [undefined, "fail"] as const) {
      const flow: FlowDefinition = {
        flow: "fails",
        nodes: [
          node({ name: "work", do: "boom", message: "nope", output: "work", ...(onError ? { onError } : {}) }),
          { name: "after", do: "code", run: "'ran'", output: "after" },
        ],
      };
      const result = await runner.run(flow, {});
      assert.equal(result.status, "failed");
      assert.equal(result.error, 'Node "work": nope');
      assert.equal("after" in result.state, false);
    }
  });
});

describe("onError: validation and transpiling", () => {
  it("accepts continue and fail on built-in and custom steps, and rejects anything else", () => {
    const { registry } = harness();
    const ok = validateFlow({
      flow: "valid",
      nodes: [
        { name: "a", do: "code", run: "1", onError: "continue" },
        node({ name: "b", do: "boom", onError: "fail" }),
      ],
    }, { registry });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));

    const bad = validateFlow({
      flow: "invalid",
      nodes: [{ name: "a", do: "code", run: "1", onError: "ignore" as "continue" }],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0].message, /"onError" on node "a" must be "fail" or "continue"/);
  });

  it("wraps the step in a try block in Cloudflare output", () => {
    const out = transpileToCloudflare({
      flow: "to-cloudflare",
      nodes: [
        { name: "fetch", do: "http", url: "https://example.com", onError: "continue", output: "fetched" },
        { name: "plain", do: "http", url: "https://example.com", output: "plain" },
      ],
    });
    assert.match(out, /try \{\n\s+const fetch = await step\.do\("fetch"/);
    assert.match(out, /\} catch \(err\) \{\n\s+state\["fetched"\] = \{ error: err instanceof Error \? err\.message : String\(err\) \};\n\s+\}/);
    assert.equal(out.split("try {").length - 1, 1, "only the step that asked for it is wrapped");
  });
});
