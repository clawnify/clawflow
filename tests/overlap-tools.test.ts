import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import plugin from "../src/plugin/index.js";
import type { FlowDefinition } from "../src/index.js";

// The agent's side of the overlap rules: it can set `overlap` on a flow with
// flow_edit, and flow_run and flow_trigger tell it when a start was refused.

const roots: string[] = [];

type ToolResult = { content: Array<{ type: string; text: string }> };
type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

/** Register the plugin against a mock api and return its tools. */
function harness(): { tools: Map<string, Tool>; workspace: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-overlap-tools-"));
  roots.push(workspace);
  const tools = new Map<string, Tool>();
  const api = {
    registerTool: (def: Tool | (() => Tool)) => {
      const tool = typeof def === "function" ? def() : def;
      tools.set(tool.name, tool);
    },
    registerHook: () => {},
    config: {
      workspace,
      plugins: {
        entries: {
          clawflow: {
            config: {
              stateDir: path.join(workspace, "state"),
              memoryDir: path.join(workspace, "memory"),
            },
          },
        },
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  plugin.register(api as never);
  return { tools, workspace };
}

function flowFile(workspace: string, name: string): string {
  return path.join(workspace, "flows", `${name}.json`);
}

function writeFlow(workspace: string, def: FlowDefinition): void {
  fs.mkdirSync(path.join(workspace, "flows"), { recursive: true });
  fs.writeFileSync(flowFile(workspace, def.flow), JSON.stringify(def, null, 2));
}

function slowFlow(name: string, overlap?: "skip"): FlowDefinition {
  return {
    flow: name,
    ...(overlap ? { overlap } : {}),
    nodes: [
      { name: "work", do: "sleep", duration: "400ms" },
      { name: "done", do: "code", run: "1", output: "result" },
    ],
  };
}

const say = (r: ToolResult) => r.content[0].text;

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("flow_create: overlap", () => {
  it("writes overlap into the new flow", async () => {
    const { tools, workspace } = harness();
    await tools.get("flow_create")!.execute("t", {
      file: "made",
      flow: "made",
      overlap: "skip",
      nodes: [{ name: "one", do: "code", run: "1", output: "result" }],
    });
    const made = JSON.parse(fs.readFileSync(flowFile(workspace, "made"), "utf8")) as FlowDefinition;
    assert.equal(made.overlap, "skip");
  });
});

describe("flow_edit: overlap", () => {
  it("sets and clears overlap on a flow, and refuses a value the engine does not know", async () => {
    const { tools, workspace } = harness();
    const edit = tools.get("flow_edit")!;
    writeFlow(workspace, slowFlow("dispatcher"));
    const read = () => JSON.parse(fs.readFileSync(flowFile(workspace, "dispatcher"), "utf8")) as FlowDefinition;

    await edit.execute("t", { action: "set", file: "dispatcher", fields: { overlap: "skip" } });
    assert.equal(read().overlap, "skip");

    const refused = say(await edit.execute("t", { action: "set", file: "dispatcher", fields: { overlap: "queue" } }));
    assert.match(refused, /"overlap" must be "allow" or "skip"/);
    assert.equal(read().overlap, "skip", "a refused edit changes nothing");

    await edit.execute("t", { action: "set", file: "dispatcher", fields: { overlap: null } });
    assert.equal("overlap" in read(), false);
  });
});

describe("flow_run and flow_trigger: a refused start", () => {
  it('flow_run answers "skipped" and names the run in flight for a flow that says overlap: "skip"', async () => {
    const { tools, workspace } = harness();
    const run = tools.get("flow_run")!;
    writeFlow(workspace, slowFlow("single", "skip"));

    // Two calls in the same instant. Which of them starts first is not fixed
    // (the tool reads the flow file before it starts the run); that exactly
    // one runs and the other is told which run is going, is.
    const results = (await Promise.all([
      run.execute("t", { file: "single" }),
      run.execute("t", { file: "single" }),
    ])).map((r) => JSON.parse(say(r)));
    const done = results.find((r) => r.status === "completed");
    const skipped = results.find((r) => r.status === "skipped");

    assert.ok(done && skipped, `expected one completed and one skipped run, got ${results.map((r) => r.status).join(", ")}`);
    assert.equal(skipped.runningInstanceId, done.instanceId);
    assert.match(skipped.error, /already running/);
  });

  it("flow_trigger run_now says the trigger did not run while its previous run is going", async () => {
    const { tools, workspace } = harness();
    const trigger = tools.get("flow_trigger")!;
    writeFlow(workspace, slowFlow("hourly"));

    const created = say(await trigger.execute("t", { action: "create", flow: "hourly", cron: "0 * * * *" }));
    const id = created.match(/[●○] (\S+)/)![1];

    const said = (await Promise.all([
      trigger.execute("t", { action: "run_now", id }),
      trigger.execute("t", { action: "run_now", id }),
    ])).map(say);
    const refused = new RegExp(`Trigger ${id} did not run: Skipped: the previous run \\(.+\\) is still going`);
    assert.equal(said.filter((t) => refused.test(t)).length, 1, said.join("\n"));
    assert.equal(said.filter((t) => /Ran .+ \(completed\)/.test(t)).length, 1, said.join("\n"));
  });
});
