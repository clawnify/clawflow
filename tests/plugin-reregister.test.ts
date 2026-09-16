import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

process.env.CLAWFLOW_SERVE = "1"; // the test process is not `openclaw gateway run`
import plugin, { activeTriggerScheduler } from "../src/plugin/index.js";
import type { FlowDefinition } from "../src/index.js";

const roots: string[] = [];

type ToolResult = { content: Array<{ type: string; text: string }> };
type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

/** Register the plugin against a mock api on a given workspace. */
function register(workspace: string): Tool {
  const tools = new Map<string, Tool>();
  const api = {
    registerTool: (def: Tool) => tools.set(def.name, def),
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
  const tool = tools.get("flow_trigger");
  assert.ok(tool, "flow_trigger tool was not registered");
  return tool!;
}

function writeFlow(workspace: string, name: string): void {
  const def: FlowDefinition = {
    flow: name,
    nodes: [{ name: "step1", do: "code", run: "return 1", output: "result" }],
  };
  fs.mkdirSync(path.join(workspace, "flows"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "flows", `${name}.json`),
    JSON.stringify(def, null, 2),
  );
}

after(() => {
  activeTriggerScheduler()?.stop();
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugin re-registration", () => {
  it("retires the previous scheduler so a trigger is armed exactly once", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-rereg-"));
    roots.push(workspace);
    writeFlow(workspace, "digest");

    // First registration (gateway boot): create a trigger, it gets armed.
    const tool = register(workspace);
    const out = await tool.execute("t", {
      action: "create",
      flow: "digest",
      cron: "0 8 * * *",
      tz: "Europe/Amsterdam",
    });
    const id = out.content[0].text.match(/[●○] (\S+)/)?.[1];
    assert.ok(id, `no trigger id in output:\n${out.content[0].text}`);

    const first = activeTriggerScheduler();
    assert.ok(first, "no scheduler armed after first registration");
    assert.ok(first!.nextRun(id!), "trigger not armed on the first scheduler");

    // OpenClaw re-runs register() on config/agent reloads within the same
    // process. Before the guard, this armed a second timer for the same
    // trigger and the flow fired twice at 08:00.
    register(workspace);

    const second = activeTriggerScheduler();
    assert.ok(second, "no scheduler armed after re-registration");
    assert.notEqual(second, first, "re-registration must arm a fresh scheduler");
    assert.equal(first!.nextRun(id!), null, "previous scheduler still holds the trigger");
    assert.ok(second!.nextRun(id!), "trigger not armed on the replacement scheduler");
  });
});
