import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";

import plugin from "../src/plugin/index.js";

type HookResult =
  | { requireApproval?: { title: string; description: string }; block?: boolean }
  | void;
type Hook = (event: {
  toolName?: string;
  tool?: string;
  params?: unknown;
  context?: { sessionKey?: string };
}) => HookResult | Promise<HookResult>;

// Register the plugin against a mock api and return the captured
// before_tool_call handler for the given clawflow config.
function captureHook(clawflowConfig: Record<string, unknown>): Hook {
  let hook: Hook | undefined;
  const api = {
    registerTool: () => {},
    registerHook: (events: string | string[], handler: Hook) => {
      if (events === "before_tool_call" || (Array.isArray(events) && events.includes("before_tool_call"))) {
        hook = handler;
      }
    },
    config: {
      workspace: os.tmpdir(),
      plugins: { entries: { clawflow: { config: clawflowConfig } } },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  plugin.register(api as never);
  assert.ok(hook, "before_tool_call hook was not registered");
  return hook!;
}

describe("clawflow approval gate", () => {
  // Since 1.5.2 flow_create/edit/publish/delete are gated by
  // @clawnify/agent-permissions (always-ask, no rule can pre-approve). This
  // plugin must not gate them too: OpenClaw 2026.9.1 stopped dispatching
  // registerHook for before_tool_call, so a gate here prompts on 2026.7.1 and
  // silently does not on 2026.9.1, and with both live a 2026.7.1 box prompts
  // twice per write.
  it("does not gate create/edit/publish/delete, whatever the config says", async () => {
    for (const approval of [{ enabled: true }, { enabled: true, gateMutations: true }, { enabled: true, skipSessionPatterns: ["email"] }]) {
      const hook = captureHook({ approval });
      for (const tool of ["flow_create", "flow_edit", "flow_publish", "flow_delete"]) {
        const res = await hook({ toolName: tool, params: { flow: "my-flow" } });
        assert.equal(res, undefined, `${tool} must be left to agent-permissions`);
      }
    }
  });

  it("registers no hook at all when the flow_run gate is off", () => {
    let registered = false;
    const api = {
      registerTool: () => {},
      registerHook: () => {
        registered = true;
      },
      config: { workspace: os.tmpdir(), plugins: { entries: { clawflow: { config: { approval: { enabled: false } } } } } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    plugin.register(api as never);
    assert.equal(registered, false, "nothing to gate here when flow_run gating is off");
  });

  it("keeps flow_run behavior: gated when enabled, skipped by pattern", async () => {
    const hook = captureHook({ approval: { skipSessionPatterns: ["email"] } });
    const gated = await hook({ toolName: "flow_run", params: { file: "f" }, context: { sessionKey: "chat:1" } });
    assert.ok(gated && gated.requireApproval, "flow_run should gate in an interactive session");
    const skipped = await hook({ toolName: "flow_run", params: { file: "f" }, context: { sessionKey: "x:email:1" } });
    assert.equal(skipped, undefined, "flow_run should skip a matching session");
  });

  it("does not gate read-only tools", async () => {
    const hook = captureHook({});
    assert.equal(await hook({ toolName: "flow_list", params: {} }), undefined);
    assert.equal(await hook({ toolName: "flow_read", params: { file: "f" } }), undefined);
  });
});

describe("clawflow approval gate — flow_trigger is the authority's too", () => {
  // Schedules commit the box to running a flow unattended; since 1.6.1 the
  // authority (@clawnify/agent-permissions ≥ 0.6.0) asks for every mutating
  // action and lets list through. Nothing is gated here any more.
  it("does not gate any action, whatever the config says", async () => {
    for (const approval of [{ enabled: true }, { enabled: true, gateMutations: true }]) {
      const hook = captureHook({ approval });
      for (const action of ["create", "update", "delete", "pause", "resume", "run_now", "list"]) {
        const res = await hook({ toolName: "flow_trigger", params: { action, id: "trg_1" } });
        assert.equal(res, undefined, `flow_trigger ${action} must be left to agent-permissions`);
      }
    }
  });
});
