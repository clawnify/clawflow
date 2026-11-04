import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import plugin from "../src/plugin/index.js";

// The plugin's side of cancelling: flow_cancel is registered and declared in
// the manifest, and flow_run's guard reads the host's session.mainKey.

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-plugin-cancel-"));
after(() => fs.rmSync(workspace, { recursive: true, force: true }));

type ToolResult = { content: Array<{ type: string; text: string }>; details?: any };
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> };
type Def = Tool | ((ctx?: { sessionKey?: string; sessionId?: string }) => Tool);

function register(mainKey?: string) {
  const defs = new Map<string, Def>();
  const api = {
    registerTool: (def: Def, opts?: { name?: string }) => {
      const name = typeof def === "function" ? opts?.name : def.name;
      defs.set(name!, def);
    },
    registerHook: () => {},
    config: {
      workspace,
      ...(mainKey ? { session: { mainKey } } : {}),
      plugins: {
        entries: {
          clawflow: { config: { stateDir: path.join(workspace, "state"), memoryDir: path.join(workspace, "memory") } },
        },
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  plugin.register(api as never);
  const tool = (name: string, ctx?: { sessionKey?: string }): Tool => {
    const def = defs.get(name);
    assert.ok(def, `${name} was not registered`);
    return typeof def === "function" ? def(ctx) : def;
  };
  return { tool, names: [...defs.keys()] };
}

describe("plugin: flow_cancel", () => {
  it("is registered and declared in the manifest's contracts.tools", () => {
    const { names } = register();
    assert.ok(names.includes("flow_cancel"));
    const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    for (const name of names) assert.ok(manifest.contracts.tools.includes(name), `${name} missing from contracts.tools`);
  });

  it("cancels a paused run and reports a finished one", async () => {
    const { tool } = register();
    const paused = await tool("flow_run", { sessionKey: "agent:main:main" }).execute("t1", {
      flow: { flow: "gated", nodes: [{ name: "ok", do: "wait", for: "approval", prompt: "Go?" }] },
    });
    const instanceId = paused.details.instanceId as string;
    assert.equal(paused.details.status, "paused");

    const first = await tool("flow_cancel").execute("t2", { instanceId });
    assert.deepEqual(first.details, { ok: true, instanceId, status: "cancelled" });
    const again = await tool("flow_cancel").execute("t3", { instanceId });
    assert.deepEqual(again.details, { ok: false, instanceId, error: "finished", status: "cancelled" });
  });
});

describe("plugin: flow_run guard with the host's session.mainKey", () => {
  const flow = { flow: "agent-only", nodes: [{ name: "ask", do: "agent", agent: "main", task: "Reply OK" }] };

  it("refuses a step that names only an agent when called from that agent's main session", async () => {
    const { tool } = register("work");
    const res = await tool("flow_run", { sessionKey: "agent:main:work" }).execute("t4", { flow });
    assert.equal(res.details.status, "failed");
    assert.match(res.details.error, /same session as the agent that started this flow/);
  });
});
