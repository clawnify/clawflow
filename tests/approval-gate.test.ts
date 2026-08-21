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

describe("clawflow approval gate — flow mutation tools", () => {
  it("gates create/edit/publish/delete by default", async () => {
    const hook = captureHook({});
    for (const [tool, verb] of [
      ["flow_create", "Create"],
      ["flow_edit", "Edit"],
      ["flow_publish", "Publish"],
      ["flow_delete", "Delete"],
    ] as const) {
      const res = await hook({ toolName: tool, params: { flow: "my-flow" } });
      assert.ok(res && res.requireApproval, `${tool} should require approval`);
      assert.match(res.requireApproval!.title, new RegExp(`^${verb} clawflow "my-flow"`));
    }
  });

  it("gates mutations even when the flow_run gate is disabled (independent of enabled)", async () => {
    const hook = captureHook({ approval: { enabled: false } });
    const res = await hook({ toolName: "flow_delete", params: { file: "x" } });
    assert.ok(res && res.requireApproval, "mutation must still gate when enabled=false");
  });

  it("does NOT honor skipSessionPatterns for mutations (always require)", async () => {
    const hook = captureHook({ approval: { skipSessionPatterns: ["email"] } });
    const res = await hook({
      toolName: "flow_publish",
      params: { flow: "f" },
      context: { sessionKey: "agent:main:main:email:123" },
    });
    assert.ok(res && res.requireApproval, "mutation must gate even in a skipped session");
  });

  it("kill-switch: gateMutations=false disables mutation gating", async () => {
    const hook = captureHook({ approval: { gateMutations: false } });
    const res = await hook({ toolName: "flow_create", params: { flow: "f" } });
    assert.equal(res, undefined, "gateMutations=false should not gate");
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

describe("clawflow approval gate — flow_trigger", () => {
  it("gates the mutating actions", async () => {
    const hook = captureHook({});
    for (const [action, verb] of [
      ["create", "Schedule"],
      ["update", "Reschedule"],
      ["delete", "Unschedule"],
      ["pause", "Pause schedule for"],
      ["resume", "Resume schedule for"],
      ["run_now", "Run now"],
    ] as const) {
      const res = await hook({
        toolName: "flow_trigger",
        params: { action, flow: "my-flow" },
      });
      assert.ok(res && res.requireApproval, `flow_trigger ${action} should require approval`);
      assert.match(res.requireApproval!.title, new RegExp(`^${verb} clawflow "my-flow"`));
      assert.match(res.requireApproval!.description, /unattended schedule/);
    }
  });

  it("does not gate list", async () => {
    const hook = captureHook({});
    const res = await hook({ toolName: "flow_trigger", params: { action: "list" } });
    assert.ok(!res || !res.requireApproval, "listing triggers is a read, not a mutation");
  });

  it("names the trigger id when there is no flow name in params", async () => {
    const hook = captureHook({});
    const res = await hook({
      toolName: "flow_trigger",
      params: { action: "pause", id: "digest-ab12cd34" },
    });
    assert.match(res!.requireApproval!.title, /"digest-ab12cd34"/);
  });

  it("gates trigger mutations even when the flow_run gate is disabled", async () => {
    const hook = captureHook({ approval: { enabled: false } });
    const res = await hook({
      toolName: "flow_trigger",
      params: { action: "create", flow: "x" },
    });
    assert.ok(res && res.requireApproval, "arming a schedule must still gate");
  });

  it("respects the gateMutations kill-switch", async () => {
    const hook = captureHook({ approval: { gateMutations: false } });
    const res = await hook({
      toolName: "flow_trigger",
      params: { action: "create", flow: "x" },
    });
    assert.ok(!res || !res.requireApproval);
  });
});
