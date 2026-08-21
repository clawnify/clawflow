import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import plugin from "../src/plugin/index.js";
import type { FlowDefinition } from "../src/index.js";

const roots: string[] = [];

type ToolResult = { content: Array<{ type: string; text: string }> };
type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

/** Register the plugin against a mock api and return the flow_trigger tool. */
function harness(): { tool: Tool; workspace: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-trigtool-"));
  roots.push(workspace);
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
  return { tool: tool!, workspace };
}

function writeFlow(workspace: string, name: string, run: string): void {
  const def: FlowDefinition = {
    flow: name,
    nodes: [{ name: "step1", do: "code", run, output: "result" }],
  };
  fs.mkdirSync(path.join(workspace, "flows"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "flows", `${name}.json`),
    JSON.stringify(def, null, 2),
  );
}

const say = (r: ToolResult) => r.content[0].text;
const idFrom = (text: string) => {
  const m = text.match(/[●○] (\S+)/);
  assert.ok(m, `no trigger id in output:\n${text}`);
  return m![1];
};

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("flow_trigger tool", () => {
  it("creates a trigger and reports its schedule", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "digest", "1");

    const out = say(
      await tool.execute("t", {
        action: "create",
        flow: "digest",
        cron: "0 9 * * *",
        tz: "Europe/Rome",
      }),
    );
    assert.match(out, /Scheduled\./);
    assert.match(out, /flow: digest \(latest published\)/);
    assert.match(out, /cron: 0 9 \* \* \* \[Europe\/Rome\]/);
  });

  it("rejects a sub-minute schedule instead of storing it", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "spammy", "1");

    const out = say(
      await tool.execute("t", { action: "create", flow: "spammy", cron: "* * * * * *" }),
    );
    assert.match(out, /minimum interval is 60s/);
    const list = say(await tool.execute("t", { action: "list" }));
    assert.match(list, /No triggers/, "nothing was stored");
  });

  it("rejects an unparseable schedule", async () => {
    const { tool } = harness();
    const out = say(
      await tool.execute("t", { action: "create", flow: "f", cron: "every tuesday" }),
    );
    assert.match(out, /Invalid schedule/);
  });

  it("requires flow and cron on create", async () => {
    const { tool } = harness();
    assert.match(say(await tool.execute("t", { action: "create", cron: "0 9 * * *" })), /"flow" is required/);
    assert.match(say(await tool.execute("t", { action: "create", flow: "f" })), /"cron" is required/);
  });

  it("lists several triggers for one flow and filters by flow", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "multi", "1");
    writeFlow(workspace, "other", "1");
    await tool.execute("t", { action: "create", flow: "multi", cron: "0 * * * *", inputs: { c: "a" } });
    await tool.execute("t", { action: "create", flow: "multi", cron: "0 9 * * *", inputs: { c: "b" } });
    await tool.execute("t", { action: "create", flow: "other", cron: "0 9 * * *" });

    const all = say(await tool.execute("t", { action: "list" }));
    assert.equal((all.match(/[●○] /g) ?? []).length, 3);

    const filtered = say(await tool.execute("t", { action: "list", flow: "multi" }));
    assert.equal((filtered.match(/[●○] /g) ?? []).length, 2, "two schedules on one flow");
  });

  it("pauses and resumes without touching the flow definition", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "pauseme", "1");
    const before = fs.readFileSync(path.join(workspace, "flows", "pauseme.json"), "utf8");
    const id = idFrom(
      say(await tool.execute("t", { action: "create", flow: "pauseme", cron: "0 9 * * *" })),
    );

    assert.match(say(await tool.execute("t", { action: "pause", id })), /Paused/);
    assert.match(say(await tool.execute("t", { action: "list" })), /^○/m);

    assert.match(say(await tool.execute("t", { action: "resume", id })), /Resumed/);
    assert.match(say(await tool.execute("t", { action: "list" })), /^●/m);

    const after = fs.readFileSync(path.join(workspace, "flows", "pauseme.json"), "utf8");
    assert.equal(after, before, "flow definition is byte-identical");
    assert.equal(
      fs.existsSync(path.join(workspace, ".clawflow", "versions", "pauseme")),
      false,
      "pausing did not mint a version",
    );
  });

  it("edits an existing schedule in place", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "editme", "1");
    const id = idFrom(
      say(await tool.execute("t", { action: "create", flow: "editme", cron: "0 9 * * *" })),
    );

    const out = say(
      await tool.execute("t", {
        action: "update",
        id,
        cron: "30 6 * * 1",
        tz: "Europe/Rome",
        inputs: { customer: "acme" },
      }),
    );
    assert.match(out, /Updated\./);
    assert.match(out, /cron: 30 6 \* \* 1 \[Europe\/Rome\]/);

    const listed = say(await tool.execute("t", { action: "list" }));
    assert.match(listed, /30 6 \* \* 1/, "the change persisted");
    assert.doesNotMatch(listed, /0 9 \* \* \*/, "old cadence is gone");
  });

  it("keeps untouched fields when updating one", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "partial", "1");
    const id = idFrom(
      say(await tool.execute("t", {
        action: "create", flow: "partial", cron: "0 9 * * *", tz: "Europe/Rome",
      })),
    );
    const out = say(await tool.execute("t", { action: "update", id, cron: "0 10 * * *" }));
    assert.match(out, /cron: 0 10 \* \* \* \[Europe\/Rome\]/, "timezone survived");
  });

  it("rejects an edit that would produce an invalid schedule", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "badedit", "1");
    const id = idFrom(
      say(await tool.execute("t", { action: "create", flow: "badedit", cron: "0 9 * * *" })),
    );

    assert.match(
      say(await tool.execute("t", { action: "update", id, cron: "* * * * * *" })),
      /minimum interval is 60s/,
    );
    assert.match(
      say(await tool.execute("t", { action: "update", id, tz: "Mars/Olympus" })),
      /Invalid schedule/,
    );
    assert.match(
      say(await tool.execute("t", { action: "list" })),
      /0 9 \* \* \*/,
      "the original schedule is intact",
    );
  });

  it("deletes a trigger", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "gone", "1");
    const id = idFrom(say(await tool.execute("t", { action: "create", flow: "gone", cron: "0 9 * * *" })));

    assert.match(say(await tool.execute("t", { action: "delete", id })), /Deleted/);
    assert.match(say(await tool.execute("t", { action: "list" })), /No triggers/);
  });

  it("errors clearly on a missing id", async () => {
    const { tool } = harness();
    assert.match(say(await tool.execute("t", { action: "pause" })), /"id" is required/);
    assert.match(say(await tool.execute("t", { action: "pause", id: "nope" })), /Trigger not found/);
  });

  it("run_now fires the flow immediately", async () => {
    const { tool, workspace } = harness();
    writeFlow(workspace, "runnow", "'fired'");
    const id = idFrom(say(await tool.execute("t", { action: "create", flow: "runnow", cron: "0 9 * * *" })));

    const out = say(await tool.execute("t", { action: "run_now", id }));
    assert.match(out, /Ran .* → instance .* \(completed\)/);
  });

  it("run_now reports a missing flow instead of pretending it ran", async () => {
    const { tool } = harness();
    const id = idFrom(say(await tool.execute("t", { action: "create", flow: "ghost", cron: "0 9 * * *" })));
    const out = say(await tool.execute("t", { action: "run_now", id }));
    assert.match(out, /did not run/);
  });

  it("rejects an unknown action", async () => {
    const { tool } = harness();
    assert.match(say(await tool.execute("t", { action: "explode" })), /Unknown action/);
  });
});
