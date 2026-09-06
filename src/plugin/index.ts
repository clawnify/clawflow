import * as fs from "node:fs";
import * as path from "node:path";

import { FlowRunner, sendEvent } from "../core/runner.js";

import { startFlowServer } from "../core/serve.js";
import { TriggerStore } from "../core/triggers.js";
import { TriggerScheduler, assertValidSchedule } from "../core/scheduler.js";
import { validateFlow } from "../core/validate.js";
import {
  publishDraft,
  listVersions as listVersionsCore,
  readLatestVersion as readLatestVersionCore,
  readVersion as readVersionCore,
  resolveFlowFile as resolveFlowFileCore,
} from "../core/manage.js";
import type { FlowDefinition, FlowNode, PluginConfig, BranchNode, ConditionNode, LoopNode, ParallelNode } from "../core/types.js";

// ---- OpenClaw Plugin: clawflow ---------------------------------------------------
// Registers eleven tools:
//
//   flow_create        — create a new flow definition and save to file
//   flow_delete        — soft-delete a flow (moves to .bin/)
//   flow_restore_from_bin       — restore a flow from the bin or list bin contents
//   flow_run           — execute a flow (inline or from file)
//   flow_resume        — resume after approval gate
//   flow_send_event    — push an event into a waiting flow
//   flow_status        — inspect a running/completed flow instance
//   flow_list          — list all saved flow definitions in the workspace
//   flow_read          — read a flow definition and show expected inputs
//   flow_publish       — publish a draft flow as a numbered version
//   flow_edit          — edit nodes in a flow definition (file or inline)

interface BeforeToolCallEvent {
  toolName?: string;
  /** Older OpenClaw releases used `tool`; kept for back-compat. */
  tool?: string;
  params?: unknown;
  context?: {
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    runId?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

type RequireApprovalDecision = {
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical";
  timeoutMs?: number;
  timeoutBehavior?: "allow" | "deny";
};

interface PluginApi {
  registerTool: (def: object, opts?: { optional?: boolean }) => void;
  registerHook?: (
    events: string | string[],
    handler: (event: BeforeToolCallEvent) =>
      | { requireApproval?: RequireApprovalDecision; block?: boolean; blockReason?: string }
      | void
      | Promise<{ requireApproval?: RequireApprovalDecision; block?: boolean; blockReason?: string } | void>,
    opts: { name: string; description?: string; priority?: number },
  ) => void;
  config?: {
    plugins?: { entries?: Record<string, { config?: PluginConfig }> };
    gateway?: { port?: number; host?: string };
    [key: string]: unknown;
  };
  runtime?: {
    config?: { loadConfig?: () => unknown };
    [key: string]: unknown;
  };
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

function register(api: PluginApi) {
  const rawCfg: PluginConfig =
    api.config?.plugins?.entries?.["clawflow"]?.config ?? {};

  const pluginCfg: PluginConfig = { ...rawCfg };

  // Resolve workspace root once at registration time.
  // Try: env var → api.config.workspace → OpenClaw default → cwd()
  const workspace: string =
    process.env.OPENCLAW_WORKSPACE ??
    (api.config as Record<string, unknown> | undefined)?.workspace as string ??
    (process.env.HOME ? `${process.env.HOME}/.openclaw/workspace` : null) ??
    process.cwd();

  api.logger?.info(`clawflow workspace: ${workspace}`);

  const runner = new FlowRunner(pluginCfg);
  const store = runner.getStore();

  // ---- Flow server (optional) ---------------------------------------------------
  // Skip when spawned as a child agent (CLAWFLOW_NO_SERVE) to avoid port conflicts.
  if (pluginCfg.serve && !process.env.CLAWFLOW_NO_SERVE) {
    startFlowServer({
      runner,
      serve: pluginCfg.serve,
      // Same workspace the flow_* tools use, so a triggered run resolves the
      // published version exactly like flow_run does.
      workspace,
      logger: api.logger,
    });
  }

  // ---- Trigger scheduler --------------------------------------------------------
  // Fires scheduled flows on this box. Skipped for child agents alongside the
  // flow server so a spawned agent never double-fires its parent's triggers.
  const flowsDir = pluginCfg.serve?.flowsDir ?? path.join(workspace, "flows");
  const triggerStore = new TriggerStore(workspace);
  const scheduler = new TriggerScheduler({
    runner,
    store: triggerStore,
    workspace,
    flowsDir,
    logger: api.logger,
  });
  if (!process.env.CLAWFLOW_NO_SERVE) {
    scheduler.start();
  }

  // ---- Approval gate for flow_run -----------------------------------------------
  // Flows can call HTTP, exec, and agent tools, so by default we prompt the user
  // before each run. Disable entirely (`approval.enabled: false`) or skip for
  // specific session contexts (`approval.skipSessionPatterns`) — useful for
  // hook-driven, unattended automation that has no interactive channel to
  // approve in.
  const approvalCfg = pluginCfg.approval ?? {};
  const approvalEnabled = approvalCfg.enabled !== false;
  const skipPatterns = Array.isArray(approvalCfg.skipSessionPatterns)
    ? approvalCfg.skipSessionPatterns.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const approvalTimeoutMs =
    typeof approvalCfg.timeoutMs === "number" && approvalCfg.timeoutMs > 0
      ? approvalCfg.timeoutMs
      : 5 * 60_000;
  const approvalTimeoutBehavior: "allow" | "deny" =
    approvalCfg.timeoutBehavior === "allow" ? "allow" : "deny";
  // Flow authoring (flow_create / flow_edit / flow_publish / flow_delete) and
  // schedule changes (flow_trigger create / update / delete / pause / resume /
  // run_now) are gated by @clawnify/agent-permissions ≥ 0.6.0, the one
  // permission authority on the box, not here. This plugin's own gate for them
  // (1.3 – 1.6.0) was registered through registerHook, which OpenClaw 2026.9.1
  // no longer dispatches for before_tool_call, so it prompted on 2026.7.1 and
  // silently not on 2026.9.1; and with both gates live a 2026.7.1 box prompted
  // twice per write. `approval.gateMutations` is accepted for old configs and
  // ignored. Only the flow_run gate stays here: it is the operator's opt-in,
  // skippable for unattended sessions.

  if (api.registerHook && approvalEnabled) {
    api.registerHook(
      "before_tool_call",
      (event) => {
        const toolName = event.toolName ?? event.tool;
        if (toolName !== "flow_run") return;

        const sessionKey = event.context?.sessionKey ?? "";
        if (skipPatterns.some((pattern) => sessionKey.includes(pattern))) {
          return;
        }

        const p = (event.params ?? {}) as { file?: string; flow?: { flow?: string }; version?: number; draft?: boolean };
        const target = p.file ?? p.flow?.flow ?? "inline flow";
        const variant =
          p.version != null ? ` v${p.version}` : p.draft ? " (draft)" : "";
        return {
          requireApproval: {
            title: `Run clawflow "${target}"${variant}?`,
            description: "Flows may call HTTP, exec, and agent tools.",
            severity: "warning",
            timeoutMs: approvalTimeoutMs,
            timeoutBehavior: approvalTimeoutBehavior,
          },
        };
      },
      {
        name: "clawflow-approval-gate",
        description: "Gate flow_run behind user approval (skippable for unattended sessions). Flow authoring and schedules are gated by agent-permissions.",
      },
    );
  } else if (!api.registerHook) {
    api.logger?.warn(
      "clawflow: registerHook unavailable — flow_run will run without approval gate. Update OpenClaw to enable.",
    );
  }

  // ---- Shared helpers ------------------------------------------------------------
  // Draft/version semantics live in core/manage.ts (engine-owned, shared with
  // out-of-process callers); these closures just bind the plugin's workspace.

  /** Resolve a file param to an absolute path using workspace conventions. */
  function resolveFlowFile(file: string): string {
    return resolveFlowFileCore(workspace, file);
  }

  /** List all published version numbers for a flow, sorted ascending. */
  function listVersions(flowName: string): number[] {
    return listVersionsCore(workspace, flowName);
  }

  /** Read a specific published version. Returns null if not found. */
  function readVersion(flowName: string, version: number): FlowDefinition | null {
    return readVersionCore(workspace, flowName, version);
  }

  /** Get the latest published version definition. Returns null if none published. */
  function readLatestVersion(flowName: string): { version: number; def: FlowDefinition } | null {
    return readLatestVersionCore(workspace, flowName);
  }

  // ---- flow_create --------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_create",
      description: `Create a new clawflow definition and save it to a JSON file.

Builds a FlowDefinition from the provided parameters, validates it, and writes
it to disk. Use this to scaffold a new flow file; use flow_edit to modify it
afterwards and flow_run to execute it.

Node types:
  ai, agent, branch, condition, loop, parallel, http, memory, wait, sleep, code, exec

All nodes require "name" and "do". Templates: {{ outputKey.field }}.`,

      parameters: {
        type: "object",
        required: ["file", "flow", "nodes"],
        properties: {
          file: {
            type: "string",
            description:
              "Filename or path for the new flow file. Plain names like \"my-flow\" are saved to workspace/flows/my-flow.json. Paths with slashes are resolved relative to the workspace.",
          },
          flow: {
            type: "string",
            description: "Unique flow name",
          },
          description: {
            type: "string",
            description: "Human-readable description of what the flow does",
          },
          nodes: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "Array of node definitions",
          },
          inputs: {
            type: "object",
            additionalProperties: true,
            description:
              'Declared inputs the flow expects. Map of name → { type?, required?, description?, default? }. Optional: when omitted, the flow accepts any payload. When present, required inputs are enforced before any node runs.',
          },
          env: {
            type: "object",
            additionalProperties: true,
            description: "Environment variable defaults",
          },
          version: {
            type: "string",
            description: 'Semver version string, e.g. "1.0.0"',
          },
        },
      },

      async execute(
        _id: string,
        params: {
          file: string;
          flow: string;
          description?: string;
          nodes: FlowNode[];
          inputs?: FlowDefinition["inputs"];
          env?: Record<string, string | null>;
          version?: string;
        },
      ) {
        const fs = await import("fs");
        const path = await import("path");

        const base = workspace;

        let abs: string;
        if (params.file.startsWith("/")) {
          abs = params.file;
        } else if (params.file.includes("/")) {
          // Relative path with directory — resolve from workspace root
          abs = path.join(base, params.file);
        } else {
          // Plain name — put in workspace/flows/
          const name = params.file.replace(/\.json$/, "");
          abs = path.join(base, "flows", `${name}.json`);
        }

        if (fs.existsSync(abs))
          return {
            content: [
              {
                type: "text",
                text: `File already exists: ${abs}. Use flow_edit to modify it.`,
              },
            ],
          };

        const flowDef: FlowDefinition = {
          flow: params.flow,
          ...(params.version && { version: params.version }),
          ...(params.description && { description: params.description }),
          ...(params.inputs && { inputs: params.inputs }),
          ...(params.env && { env: params.env }),
          nodes: params.nodes,
        };

        const validation = validateFlow(flowDef);
        if (!validation.ok)
          return {
            content: [
              {
                type: "text",
                text: `Validation failed:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
              },
            ],
          };

        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text",
                text: `Cannot create directory for ${abs}: ${msg}. Is OPENCLAW_WORKSPACE set? Current workspace root: ${base}`,
              },
            ],
          };
        }
        fs.writeFileSync(abs, JSON.stringify(flowDef, null, 2) + "\n");

        return {
          content: [
            {
              type: "text",
              text: `Flow "${params.flow}" created at ${abs}`,
            },
          ],
          details: flowDef,
        };
      },
    },
    { optional: true },
  );

  // ---- flow_delete --------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_delete",
      description: `Delete a flow file by moving it to the bin.

The flow is not permanently removed — it is timestamped and moved to
workspace/.clawflow/bin/ so it can be restored later with flow_restore_from_bin.
Safe for agents to call without fear of data loss.`,

      parameters: {
        type: "object",
        required: ["file"],
        properties: {
          file: {
            type: "string",
            description:
              "Filename or path of the flow to delete. Plain names like \"my-flow\" resolve to workspace/flows/my-flow.json.",
          },
        },
      },

      async execute(
        _id: string,
        params: { file: string },
      ) {
        const fs = await import("fs");
        const path = await import("path");

        const base = workspace;

        let abs: string;
        if (params.file.startsWith("/")) {
          abs = params.file;
        } else if (params.file.includes("/")) {
          abs = path.join(base, params.file);
        } else {
          const name = params.file.replace(/\.json$/, "");
          abs = path.join(base, "flows", `${name}.json`);
        }

        if (!fs.existsSync(abs))
          return {
            content: [{ type: "text", text: `File not found: ${abs}` }],
          };

        const binDir = path.join(base, ".clawflow", "bin");
        fs.mkdirSync(binDir, { recursive: true });

        const basename = path.basename(abs, ".json");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const binPath = path.join(binDir, `${basename}.${ts}.json`);

        fs.renameSync(abs, binPath);

        // Schedules outlive a soft delete, but must not keep firing at a flow
        // that is no longer there. Paused, not removed, so a restore keeps them.
        const pausedIds = triggerStore.pauseForFlow(path.basename(abs, ".json"));
        const pausedNote =
          pausedIds.length > 0
            ? `\nPaused ${pausedIds.length} trigger(s) for this flow: ${pausedIds.join(", ")}`
            : "";

        return {
          content: [
            {
              type: "text",
              text: `Flow moved to bin: ${binPath}${pausedNote}`,
            },
          ],
        };
      },
    },
    { optional: true },
  );

  // ---- flow_restore_from_bin -------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_restore_from_bin",
      description: `Restore a flow from the bin or list bin contents.

Without "name", lists all flows in workspace/.clawflow/bin/ with their timestamps.
With "name", restores the most recent version of that flow back to the flows/
directory. If the flow file already exists, the restore is rejected.`,

      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Flow name to restore (without timestamp). Omit to list all bin contents.",
          },
        },
      },

      async execute(
        _id: string,
        params: { name?: string },
      ) {
        const fs = await import("fs");
        const path = await import("path");

        const base = workspace;
        const binDir = path.join(base, ".clawflow", "bin");

        if (!fs.existsSync(binDir))
          return {
            content: [{ type: "text", text: "Bin is empty." }],
          };

        const files = fs.readdirSync(binDir)
          .filter((f: string) => f.endsWith(".json"))
          .sort()
          .reverse();

        if (files.length === 0)
          return {
            content: [{ type: "text", text: "Bin is empty." }],
          };

        // ---- List mode ---
        if (!params.name) {
          const entries = files.map((f: string) => {
            const match = f.match(/^(.+?)\.(\d{4}-.+)\.json$/);
            return {
              name: match?.[1] ?? f,
              deletedAt: match?.[2] ?? "unknown",
              file: f,
            };
          });
          return {
            content: [
              { type: "text", text: JSON.stringify(entries, null, 2) },
            ],
            details: entries,
          };
        }

        // ---- Restore mode ---
        const prefix = params.name.replace(/\.json$/, "");
        const match = files.find((f: string) => f.startsWith(`${prefix}.`));

        if (!match)
          return {
            content: [
              {
                type: "text",
                text: `No bin entry found for "${prefix}".`,
              },
            ],
          };

        const dest = path.join(base, "flows", `${prefix}.json`);
        if (fs.existsSync(dest))
          return {
            content: [
              {
                type: "text",
                text: `Cannot restore: ${dest} already exists. Delete or rename it first.`,
              },
            ],
          };

        fs.renameSync(path.join(binDir, match), dest);

        return {
          content: [
            {
              type: "text",
              text: `Restored "${prefix}" from bin to ${dest}`,
            },
          ],
        };
      },
    },
    { optional: true },
  );

  // ---- flow_run -----------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_run",
      catalogMode: "direct-only",
      description: `Run an agentic workflow in the clawflow format.

State model:
  The "input" parameter becomes "inputs" in flow state (i.e. state.inputs).
  Flow state = { inputs, env?, ...nodeOutputs }.
  Each node with "output" adds its result to state (e.g. output: "result" → state.result).
  In code nodes: fn(input, state) — "input" is the resolved node.input field, "state" is the full flow state.
  IMPORTANT: inputs contains ALL initial data. If you need different parts of inputs in a code node,
  use object-style input: { "payload": "inputs.payload", "email": "inputs.email_to" }
  or access via state.inputs.field inside the code.

Node types:
  ai       — LLM call, structured or freeform. Use schema: for typed output.
  agent    — delegate to a real OpenClaw agent. Fields mirror the CLI flags: agent
             (a configured slug, e.g. "clawflow" → --agent), sessionKey (a session
             key, e.g. "agent:main:slack:channel:agent" → --session-key), sessionId
             (→ --session-id), channel (→ --channel). A bare session key is scoped by
             agent; an "agent:"-prefixed key is self-scoping. (agentId/session are
             deprecated aliases for agent/sessionKey.)
  branch   — route to different nodes based on a value: { on, paths, default }
  loop     — iterate over a list: { over, as, nodes[] }
  parallel — run nodes concurrently: { nodes[], mode: "all"|"race" }
  http     — call an external API: { url, method, body, headers }
  memory   — persist data: { action: read|write|delete, key, value }
  wait     — pause for approval or event: { for: "approval"|"event", event?, timeout? }
  sleep    — pause for duration: { duration: "5m" }
  code     — inline JS expression: { run: "...", input? }

All nodes support retry: { limit, delay, backoff } and timeout.
Templates: use {{ nodeName.field }} to reference any value in flow state.
Returns instanceId for status tracking and resume.

Versioning: when a flow has published versions, flow_run uses the latest
published version by default. Set draft: true to run the working copy instead.
Set version to run a specific published version.`,

      parameters: {
        type: "object",
        properties: {
          flow: {
            type: "object",
            properties: {
              flow: { type: "string" },
              description: { type: "string" },
              nodes: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            required: ["flow", "nodes"],
            additionalProperties: true,
          },
          file: {
            type: "string",
            description: "Path to a .json flow file (or plain name like \"my-flow\")",
          },
          input: {
            type: "object",
            additionalProperties: true,
            description: "Input data, available as inputs.* in the flow (and at state.inputs in code nodes).",
          },
          draft: {
            type: "boolean",
            description:
              "Run the draft (working copy) instead of the latest published version. Default: false.",
          },
          version: {
            type: "number",
            description:
              "Run a specific published version number. Overrides draft flag.",
          },
        },
      },

      async execute(
        _id: string,
        params: {
          flow?: FlowDefinition;
          file?: string;
          input?: unknown;
          draft?: boolean;
          version?: number;
        },
      ) {
        let flowDef: FlowDefinition;
        let source = "";

        if (params.file) {
          const { readFileSync, existsSync } = await import("fs");
          const pathMod = await import("path");
          const abs = resolveFlowFile(params.file);

          // Determine flow name for version lookup
          const flowName = pathMod.basename(abs, ".json");

          if (params.version != null) {
            // Specific version requested
            const vDef = readVersion(flowName, params.version);
            if (!vDef)
              return {
                content: [
                  {
                    type: "text",
                    text: `Version ${params.version} not found for flow "${flowName}". Available: ${listVersions(flowName).join(", ") || "none (not yet published)"}`,
                  },
                ],
              };
            flowDef = vDef;
            source = `v${params.version}`;
          } else if (!params.draft) {
            // Default: use latest published version if available
            const latest = readLatestVersion(flowName);
            if (latest) {
              flowDef = latest.def;
              source = `v${latest.version}`;
            } else {
              // No published versions — fall back to draft
              if (!existsSync(abs))
                return {
                  content: [{ type: "text", text: `File not found: ${abs}` }],
                };
              flowDef = JSON.parse(readFileSync(abs, "utf8")) as FlowDefinition;
              source = "draft (no published versions)";
            }
          } else {
            // Explicit draft mode
            if (!existsSync(abs))
              return {
                content: [{ type: "text", text: `File not found: ${abs}` }],
              };
            flowDef = JSON.parse(readFileSync(abs, "utf8")) as FlowDefinition;
            source = "draft";
          }
        } else if (params.flow) {
          flowDef = params.flow as FlowDefinition;
          source = "inline";
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Provide either `flow` (inline definition) or `file` (path).",
              },
            ],
          };
        }

        try {
          const result = await runner.run(flowDef, params.input ?? {});
          const out = { ...result, _source: source };
          return {
            content: [
              { type: "text", text: JSON.stringify(out, null, 2) },
            ],
            details: out,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );

  // ---- flow_resume --------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_resume",
      description: `Resume a paused clawflow after an approval gate.
Use the instanceId (= resumeToken) from a flow_run result where status was "paused".
Set approved=true to continue, false to cancel.
You must pass the original flow definition back so the runner can continue.`,

      parameters: {
        type: "object",
        required: ["instanceId", "approved", "flow"],
        properties: {
          instanceId: {
            type: "string",
            description: "The instanceId from the paused flow_run result",
          },
          approved: { type: "boolean" },
          flow: {
            type: "object",
            required: ["flow", "nodes"],
            properties: {
              flow: { type: "string" },
              nodes: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            additionalProperties: true,
          },
        },
      },

      async execute(
        _id: string,
        params: {
          instanceId: string;
          approved: boolean;
          flow: FlowDefinition;
        },
      ) {
        try {
          const result = await runner.resume(
            params.instanceId,
            params.flow,
            params.approved,
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
            details: result,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );

  // ---- flow_send_event ----------------------------------------------------------

  api.registerTool(
    {
      name: "flow_send_event",
      description: `Send an event to a flow instance that is waiting with do: wait / for: event.
This is the equivalent of Cloudflare's instance.sendEvent().
The eventType must match the "event" field on the wait node.
payload is passed as the output of the wait node and into flow state.`,

      parameters: {
        type: "object",
        required: ["instanceId", "eventType"],
        properties: {
          instanceId: { type: "string" },
          eventType: {
            type: "string",
            description: "Must match the 'event' field of the wait node",
          },
          payload: {
            type: "object",
            additionalProperties: true,
          },
        },
      },

      async execute(
        _id: string,
        params: {
          instanceId: string;
          eventType: string;
          payload?: unknown;
        },
      ) {
        const delivered = sendEvent(
          params.instanceId,
          params.eventType,
          params.payload ?? {},
        );
        if (!delivered) {
          return {
            content: [
              {
                type: "text",
                text: `No active waiter found for instance "${params.instanceId}" event "${params.eventType}". The flow may not be waiting, or the event type doesn't match.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Event "${params.eventType}" delivered to instance "${params.instanceId}".`,
            },
          ],
        };
      },
    },
    { optional: true },
  );

  // ---- flow_status --------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_status",
      description: `Get the status and state of a flow instance, or list all instances.
Status values: running | completed | paused | waiting | failed | cancelled`,

      parameters: {
        type: "object",
        properties: {
          instanceId: {
            type: "string",
            description: "Specific instance to inspect. Omit to list all.",
          },
          filter: {
            type: "string",
            description:
              "Filter by status: running | completed | paused | waiting | failed | cancelled",
          },
        },
      },

      async execute(
        _id: string,
        params: { instanceId?: string; filter?: string },
      ) {
        if (params.instanceId) {
          const record = store.get(params.instanceId);
          if (!record)
            return {
              content: [
                {
                  type: "text",
                  text: `Instance not found: ${params.instanceId}`,
                },
              ],
            };
          return {
            content: [
              { type: "text", text: JSON.stringify(record, null, 2) },
            ],
            details: record,
          };
        }
        const records = store.list(params.filter);
        const summary = records.map((r) => ({
          instanceId: r.instanceId,
          flow: r.flowName,
          status: r.status,
          updatedAt: r.updatedAt,
          waitingFor: r.waitingFor,
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
          details: summary,
        };
      },
    },
    { optional: true },
  );

  // ---- flow_list ----------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_list",
      catalogMode: "direct-only",
      description: `List all saved flow definitions in the workspace.

Scans the flows directory for .json files and returns a summary of each flow
including its name, description, declared inputs, version, node count, and file path.
Use this to discover available flows before running or editing them.`,

      parameters: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description:
              "Directory to scan. Defaults to workspace/flows/. Absolute paths are used as-is; relative paths resolve from the workspace root.",
          },
        },
      },

      async execute(
        _id: string,
        params: { dir?: string },
      ) {
        const fs = await import("fs");
        const path = await import("path");

        const base = workspace;

        let dir: string;
        if (!params.dir) {
          dir = path.join(base, "flows");
        } else if (params.dir.startsWith("/")) {
          dir = params.dir;
        } else {
          dir = path.join(base, params.dir);
        }

        if (!fs.existsSync(dir)) {
          return {
            content: [
              {
                type: "text",
                text: `Flows directory not found: ${dir}`,
              },
            ],
          };
        }

        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"));

        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No flow files found in ${dir}`,
              },
            ],
          };
        }

        const flows: Array<{
          file: string;
          flow: string;
          description?: string;
          inputs?: FlowDefinition["inputs"];
          expectedInputs?: string[];
          publishedVersion?: number;
          totalVersions?: number;
          nodes: number;
        }> = [];

        for (const file of files) {
          const abs = path.join(dir, file);
          try {
            const raw = fs.readFileSync(abs, "utf-8");
            const def = JSON.parse(raw) as FlowDefinition;
            if (!def.flow || !Array.isArray(def.nodes)) continue;
            const referenced = extractInputRefs(def.nodes);
            const flowName = file.replace(/\.json$/, "");
            const versions = listVersions(flowName);
            flows.push({
              file: abs,
              flow: def.flow,
              ...(def.description && { description: def.description }),
              ...(def.inputs && { inputs: def.inputs }),
              ...(referenced.length > 0 && { expectedInputs: referenced }),
              ...(versions.length > 0 && {
                publishedVersion: versions[versions.length - 1],
                totalVersions: versions.length,
              }),
              nodes: def.nodes.length,
            });
          } catch {
            // skip non-flow JSON files
          }
        }

        if (flows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No valid flow definitions found in ${dir}`,
              },
            ],
          };
        }

        return {
          content: [
            { type: "text", text: JSON.stringify(flows, null, 2) },
          ],
          details: flows,
        };
      },
    },
    { optional: true },
  );

  // ---- flow_read ----------------------------------------------------------------

  /**
   * Recursively extract unique inputs.* paths from any string values in an
   * object tree. This tells agents what input fields a flow references — used
   * when the flow has no declared inputs block to give a best-effort hint.
   */
  function extractInputRefs(obj: unknown): string[] {
    const paths = new Set<string>();
    const re = /\{\{\s*inputs\.(\w+(?:\.\w+)*)/g;

    function walk(val: unknown): void {
      if (typeof val === "string") {
        let m: RegExpExecArray | null;
        while ((m = re.exec(val)) !== null) paths.add(m[1]);
      } else if (Array.isArray(val)) {
        for (const item of val) walk(item);
      } else if (val && typeof val === "object") {
        for (const v of Object.values(val)) walk(v);
      }
    }
    walk(obj);
    return [...paths].sort();
  }

  /** Find a node by name, searching nested structures (branch paths, loop, parallel, condition). */
  function findNode(nodes: FlowNode[], name: string): FlowNode | undefined {
    for (const n of nodes) {
      if (n.name === name) return n;
      if ("paths" in n && n.paths) {
        for (const branch of Object.values(
          n.paths as Record<string, FlowNode[]>,
        )) {
          const found = findNode(branch, name);
          if (found) return found;
        }
      }
      if ("default" in n && Array.isArray(n.default)) {
        const found = findNode(n.default as FlowNode[], name);
        if (found) return found;
      }
      if ("nodes" in n && Array.isArray(n.nodes)) {
        const found = findNode(n.nodes as FlowNode[], name);
        if (found) return found;
      }
      if ("then" in n && Array.isArray(n.then)) {
        const found = findNode(n.then as FlowNode[], name);
        if (found) return found;
      }
      if ("else" in n && Array.isArray((n as ConditionNode).else)) {
        const found = findNode((n as ConditionNode).else!, name);
        if (found) return found;
      }
    }
    return undefined;
  }

  api.registerTool(
    {
      name: "flow_read",
      description: `Read a flow definition from file and return its contents.

Returns the full flow definition (or a single node if specified). The response
includes the declared "inputs" block when present, plus a best-effort list of
input fields referenced by templates (extracted from {{ inputs.* }} usages).
Use this to inspect a flow before running it or to understand what inputs it
needs.

Versioning: by default reads the draft (working copy). Set version to read
a specific published version. The response includes available version numbers.`,

      parameters: {
        type: "object",
        required: ["file"],
        properties: {
          file: {
            type: "string",
            description:
              "Filename or path to the flow file. Plain names resolve to workspace/flows/<name>.json.",
          },
          node: {
            type: "string",
            description:
              "Name of a specific node to return. Searches nested structures (branches, loops, etc.).",
          },
          version: {
            type: "number",
            description:
              "Read a specific published version instead of the draft.",
          },
        },
      },

      async execute(
        _id: string,
        params: { file: string; node?: string; version?: number },
      ) {
        const fs = await import("fs");
        const pathMod = await import("path");

        const abs = resolveFlowFile(params.file);
        const flowName = pathMod.basename(abs, ".json");
        const versions = listVersions(flowName);

        let flowDef: FlowDefinition;
        let source: string;

        if (params.version != null) {
          const vDef = readVersion(flowName, params.version);
          if (!vDef) {
            return {
              content: [
                {
                  type: "text",
                  text: `Version ${params.version} not found for "${flowName}". Available: ${versions.join(", ") || "none"}`,
                },
              ],
            };
          }
          flowDef = vDef;
          source = `v${params.version}`;
        } else {
          if (!fs.existsSync(abs)) {
            return {
              content: [{ type: "text", text: `File not found: ${abs}` }],
            };
          }
          try {
            flowDef = JSON.parse(fs.readFileSync(abs, "utf-8")) as FlowDefinition;
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to parse ${abs}: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
          source = "draft";
        }

        const referenced = extractInputRefs(flowDef.nodes);

        // Single node mode
        if (params.node) {
          const found = findNode(flowDef.nodes, params.node);
          if (!found) {
            return {
              content: [
                {
                  type: "text",
                  text: `Node "${params.node}" not found in flow "${flowDef.flow}". Nodes: ${flowDef.nodes.map((n) => n.name).join(", ")}`,
                },
              ],
            };
          }
          const nodeInputs = extractInputRefs(found);
          const result = {
            flow: flowDef.flow,
            _source: source,
            _file: abs,
            ...(versions.length > 0 && { _versions: versions }),
            ...(nodeInputs.length > 0 && { expectedInputs: nodeInputs }),
            node: found,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        }

        // Full flow mode
        const result = {
          ...flowDef,
          _source: source,
          _file: abs,
          ...(versions.length > 0 && { _versions: versions }),
          ...(referenced.length > 0 && { _expectedInputs: referenced }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  // ---- flow_publish --------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_publish",
      description: `Publish the current draft of a flow as a new numbered version.

Validates the draft, assigns the next version number (auto-incrementing integer),
and saves an immutable copy to .clawflow/versions/<flowName>/<N>.json.
After publishing, flow_run will use this version by default.

Use this when a flow is ready for production. Edits via flow_edit continue to
modify the draft without affecting published versions.`,

      parameters: {
        type: "object",
        required: ["file"],
        properties: {
          file: {
            type: "string",
            description:
              "Filename or path to the draft flow file. Plain names resolve to workspace/flows/<name>.json.",
          },
        },
      },

      async execute(
        _id: string,
        params: { file: string },
      ) {
        const fs = await import("fs");

        const abs = resolveFlowFile(params.file);
        if (!fs.existsSync(abs)) {
          return {
            content: [{ type: "text", text: `Draft not found: ${abs}` }],
          };
        }

        let flowDef: FlowDefinition;
        try {
          flowDef = JSON.parse(fs.readFileSync(abs, "utf-8")) as FlowDefinition;
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to parse ${abs}: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }

        const validation = validateFlow(flowDef);
        if (!validation.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Validation failed — cannot publish:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
              },
            ],
          };
        }

        const published = publishDraft(workspace, params.file);

        return {
          content: [
            {
              type: "text",
              text: `Published "${published.flow}" as v${published.version}. flow_run will now use this version by default.\nFile: ${published.file}`,
            },
          ],
          details: {
            flow: published.flow,
            version: published.version,
            file: published.file,
            totalVersions: published.totalVersions,
          },
        };
      },
    },
    { optional: true },
  );

  // ---- flow_edit ----------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_edit",
      description: `Edit nodes in a clawflow definition. Operates on a file or inline flow.

Actions:
  set     — set top-level flow fields (description, inputs, env, version)
  update  — update a node entirely or patch specific fields by node name
  add     — insert a new node at a position (default: end)
  remove  — remove a node by name
  move    — move a node to a new position (same level or into a parent)
  wrap    — wrap one or more nodes into a new container (loop, condition, branch, parallel)
  revert  — undo the last edit (restores the previous version from history)
  list    — list all nodes with index, name, type, and output key

All actions that target nodes (update, remove, move, add) search recursively
through nested structures (branch paths, condition then/else, loop, parallel).

The "parent" parameter targets a nested node list using slash-separated paths:
  "myBranch/true"       → branch "myBranch", path "true"
  "myCond/then"         → condition "myCond", then block
  "myLoop"              → loop "myLoop", child nodes
  "outer/true/inner"    → chained nesting

The edited flow is validated after every mutation. If validation fails, the
edit is rejected and errors are returned. For file-based flows, the file is
overwritten with the updated definition on success.

Examples:
  Set flow fields:    { action: "set", fields: { description: "New desc", inputs: { ticket_id: { type: "string", required: true } } } }
  Update one field:   { action: "update", node: "classify", fields: { prompt: "New prompt" } }
  Replace full node:  { action: "update", node: "classify", replace: { name: "classify", do: "ai", prompt: "..." } }
  Add at position:    { action: "add", position: 2, nodeDefinition: { name: "step3", do: "code", run: "..." } }
  Add inside branch:  { action: "add", parent: "shouldUpdate/true", nodeDefinition: { name: "step3", do: "code", run: "..." } }
  Remove:             { action: "remove", node: "old-step" }
  Move into loop:     { action: "move", node: "step3", parent: "myLoop", position: 0 }
  Move into else:     { action: "move", node: "step3", parent: "myCond/else", position: 0 }
  Wrap in loop:       { action: "wrap", nodes: ["step1", "step2"], wrapper: { name: "myLoop", do: "loop", over: "items", as: "item" } }
  Wrap in condition:  { action: "wrap", nodes: ["step1", "step2"], wrapper: { name: "guard", do: "condition", if: "{{ items.length > 0 }}" } }
  List:               { action: "list" }

To RESTRUCTURE an existing flow — make a group of nodes conditional, nest them in a
loop, or reparent them — use "wrap" (many nodes at once) or "move" (one node into a
"parent" path like "guard/else"). Do NOT remove-and-re-add each node, and do NOT
re-send the whole flow: a single large edit is slow and can stall mid-generation.`,

      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          file: {
            type: "string",
            description: "Path to a .json flow file. Mutually exclusive with 'flow'.",
          },
          flow: {
            type: "object",
            description: "Inline flow definition. Mutually exclusive with 'file'.",
            properties: {
              flow: { type: "string" },
              nodes: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            required: ["flow", "nodes"],
            additionalProperties: true,
          },
          action: {
            type: "string",
            enum: ["set", "update", "add", "remove", "move", "wrap", "revert", "list"],
          },
          node: {
            type: "string",
            description: "Node name to target (required for update, remove, move). Searched recursively through nested structures.",
          },
          fields: {
            type: "object",
            additionalProperties: true,
            description: "For action=set: top-level flow fields to set (description, inputs, env, version). For action=update: partial field updates to merge into the node.",
          },
          replace: {
            type: "object",
            additionalProperties: true,
            description: "For action=update: full node replacement (must include name and do)",
          },
          nodeDefinition: {
            type: "object",
            additionalProperties: true,
            description: "For action=add: the new node definition",
          },
          position: {
            type: "number",
            description: "For action=add/move: index to insert/move to (0-based). Default: end.",
          },
          parent: {
            type: "string",
            description: 'For action=add/move: target a nested node list. Slash-separated path e.g. "myBranch/true", "myCond/then", "myLoop". For move: destination parent (node is removed from current location and inserted here).',
          },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "For action=wrap: array of node names to wrap into a container.",
          },
          wrapper: {
            type: "object",
            additionalProperties: true,
            description: "For action=wrap: the container node definition (must include name, do). Wrapped nodes become its children (e.g. loop.nodes, condition.then, branch.paths.true, parallel.nodes).",
          },
        },
      },

      async execute(
        _id: string,
        params: {
          file?: string;
          flow?: FlowDefinition;
          action: "set" | "update" | "add" | "remove" | "move" | "wrap" | "revert" | "list";
          node?: string;
          fields?: Record<string, unknown>;
          replace?: FlowNode;
          nodeDefinition?: FlowNode;
          position?: number;
          parent?: string;
          nodes?: string[];
          wrapper?: FlowNode;
        },
      ) {
        // ---- Load flow definition ---
        let flowDef: FlowDefinition;
        let filePath: string | undefined;

        if (params.file) {
          const fs = await import("fs");
          const pathMod = await import("path");
          const base = workspace;
          let abs: string;
          if (params.file.startsWith("/")) {
            abs = params.file;
          } else if (params.file.includes("/")) {
            abs = pathMod.join(base, params.file);
          } else {
            const name = params.file.replace(/\.json$/, "");
            abs = pathMod.join(base, "flows", `${name}.json`);
          }
          if (!fs.existsSync(abs))
            return {
              content: [{ type: "text", text: `File not found: ${abs}` }],
            };
          filePath = abs;
          flowDef = JSON.parse(fs.readFileSync(abs, "utf8")) as FlowDefinition;
        } else if (params.flow) {
          flowDef = params.flow;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Provide either `file` (path) or `flow` (inline definition).",
              },
            ],
          };
        }

        const ok = (msg: string, flow: FlowDefinition) => ({
          content: [{ type: "text", text: msg }],
          details: flow,
        });
        const fail = (msg: string) => ({
          content: [{ type: "text", text: msg }],
        });

        // Resolve a node list from a parent path. Supports:
        //   undefined        → flowDef.nodes (top-level)
        //   "myBranch/true"  → branch node "myBranch", paths["true"]
        //   "myBranch/default" → branch node "myBranch", default
        //   "myCond/then"    → condition node "myCond", then
        //   "myCond/else"    → condition node "myCond", else
        //   "myLoop"         → loop node "myLoop", nodes
        //   "myParallel"     → parallel node "myParallel", nodes
        // Paths can be chained: "outerBranch/true/innerLoop"
        const resolveNodeList = (
          parentPath?: string,
        ): { nodes: FlowNode[]; error?: string } => {
          if (!parentPath) return { nodes: flowDef.nodes };

          const parts = parentPath.split("/");
          let current: FlowNode[] = flowDef.nodes;

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const node = current.find((n) => n.name === part);
            if (!node)
              return {
                nodes: [],
                error: `Parent node "${part}" not found at level ${i}.`,
              };

            if (node.do === "branch") {
              const b = node as BranchNode;
              const key = parts[++i]; // consume next part as path key
              if (!key)
                return {
                  nodes: [],
                  error: `Branch "${part}" requires a path key (e.g., "${part}/true").`,
                };
              if (key === "default") {
                if (!b.default) b.default = [];
                current = b.default;
              } else {
                if (!b.paths[key]) b.paths[key] = [];
                current = b.paths[key];
              }
            } else if (node.do === "condition") {
              const c = node as ConditionNode;
              const key = parts[++i]; // consume next part as then/else
              if (!key)
                return {
                  nodes: [],
                  error: `Condition "${part}" requires "then" or "else" (e.g., "${part}/then").`,
                };
              if (key === "then") {
                current = c.then;
              } else if (key === "else") {
                if (!c.else) c.else = [];
                current = c.else;
              } else {
                return {
                  nodes: [],
                  error: `Condition "${part}" only accepts "then" or "else", got "${key}".`,
                };
              }
            } else if (node.do === "loop") {
              current = (node as LoopNode).nodes;
            } else if (node.do === "parallel") {
              current = (node as ParallelNode).nodes;
            } else {
              return {
                nodes: [],
                error: `Node "${part}" (do: "${node.do}") has no child nodes.`,
              };
            }
          }
          return { nodes: current };
        };

        // Find a node by name, optionally scoped to a parent path
        const findIndex = (name: string, parentPath?: string) => {
          const { nodes, error } = resolveNodeList(parentPath);
          if (error) return -1;
          return nodes.findIndex((n) => n.name === name);
        };

        // Deep-find: search all node lists recursively, return the containing array + index
        const deepFind = (
          name: string,
          nodes: FlowNode[] = flowDef.nodes,
        ): { list: FlowNode[]; index: number } | null => {
          const idx = nodes.findIndex((n) => n.name === name);
          if (idx !== -1) return { list: nodes, index: idx };
          for (const node of nodes) {
            const children = getChildLists(node);
            for (const child of children) {
              const found = deepFind(name, child);
              if (found) return found;
            }
          }
          return null;
        };

        // Get all child node arrays from a container node
        const getChildLists = (node: FlowNode): FlowNode[][] => {
          switch (node.do) {
            case "branch": {
              const b = node as BranchNode;
              const lists = Object.values(b.paths);
              if (b.default) lists.push(b.default);
              return lists;
            }
            case "condition": {
              const c = node as ConditionNode;
              const lists: FlowNode[][] = [c.then];
              if (c.else) lists.push(c.else);
              return lists;
            }
            case "loop":
              return [(node as LoopNode).nodes];
            case "parallel":
              return [(node as ParallelNode).nodes];
            default:
              return [];
          }
        };

        // Save a snapshot before mutating (file-based flows only).
        // Derive history dir from the flow file's parent (sibling to flows/).
        const saveSnapshot = async () => {
          if (!filePath) return;
          const fs = await import("fs");
          const pathMod = await import("path");
          const flowDir = pathMod.dirname(filePath);
          const root = pathMod.dirname(flowDir); // parent of flows/
          const flowName = pathMod.basename(filePath, ".json");
          const histDir = pathMod.join(root, ".clawflow", "history", flowName);
          try {
            fs.mkdirSync(histDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const snapPath = pathMod.join(histDir, `${ts}.json`);
            fs.writeFileSync(snapPath, fs.readFileSync(filePath, "utf8"));
          } catch {
            // History is best-effort — don't block the edit
          }
        };

        // ---- Revert (undo last edit) ---
        if (params.action === "revert") {
          if (!filePath)
            return fail("Revert only works on file-based flows.");
          const fs = await import("fs");
          const pathMod = await import("path");
          const flowDir = pathMod.dirname(filePath);
          const root = pathMod.dirname(flowDir);
          const flowName = pathMod.basename(filePath, ".json");
          const histDir = pathMod.join(root, ".clawflow", "history", flowName);
          if (!fs.existsSync(histDir))
            return fail("No edit history found for this flow.");
          const snaps = fs.readdirSync(histDir)
            .filter((f: string) => f.endsWith(".json"))
            .sort()
            .reverse();
          if (snaps.length === 0)
            return fail("No edit history found for this flow.");
          const latest = pathMod.join(histDir, snaps[0]);
          const restored = JSON.parse(fs.readFileSync(latest, "utf8")) as FlowDefinition;
          fs.writeFileSync(filePath, JSON.stringify(restored, null, 2) + "\n");
          fs.unlinkSync(latest);
          return ok(
            `Reverted to snapshot ${snaps[0]}. File written: ${filePath}`,
            restored,
          );
        }

        // ---- Set (top-level flow fields) ---
        if (params.action === "set") {
          if (!params.fields)
            return fail('action "set" requires "fields".');

          const allowed = ["description", "inputs", "env", "version"];
          const backup = { ...flowDef };

          for (const [key, value] of Object.entries(params.fields)) {
            if (!allowed.includes(key))
              return fail(
                `Cannot set "${key}". Allowed fields: ${allowed.join(", ")}. Use "update" to modify nodes.`,
              );
            if (value === null || value === undefined) {
              delete (flowDef as unknown as Record<string, unknown>)[key];
            } else {
              (flowDef as unknown as Record<string, unknown>)[key] = value;
            }
          }

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            // rollback
            Object.assign(flowDef, backup);
            return fail(
              `Validation failed after set:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            await saveSnapshot();
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Flow fields updated: ${Object.keys(params.fields).join(", ")}.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- List ---
        if (params.action === "list") {
          const list = flowDef.nodes.map((n, i) => ({
            index: i,
            name: n.name,
            do: n.do,
            output: n.output ?? null,
          }));
          return {
            content: [
              { type: "text", text: JSON.stringify(list, null, 2) },
            ],
            details: list,
          };
        }

        // ---- Update ---
        if (params.action === "update") {
          if (!params.node)
            return fail('action "update" requires "node" (node name).');
          const found = deepFind(params.node);
          if (!found)
            return fail(`Node "${params.node}" not found.`);

          if (params.replace) {
            found.list[found.index] = params.replace as FlowNode;
          } else if (params.fields) {
            found.list[found.index] = {
              ...found.list[found.index],
              ...params.fields,
            } as FlowNode;
          } else {
            return fail(
              'action "update" requires either "fields" (partial) or "replace" (full node).',
            );
          }

          const validation = validateFlow(flowDef);
          if (!validation.ok)
            return fail(
              `Validation failed after update:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );

          if (filePath) {
            await saveSnapshot();
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Node "${params.node}" updated.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- Add ---
        if (params.action === "add") {
          if (!params.nodeDefinition)
            return fail('action "add" requires "nodeDefinition".');
          const { nodes: targetList, error: parentErr } = resolveNodeList(params.parent);
          if (parentErr) return fail(parentErr);
          const pos = params.position ?? targetList.length;
          if (pos < 0 || pos > targetList.length)
            return fail(
              `Position ${pos} out of range (0-${targetList.length}).`,
            );
          targetList.splice(pos, 0, params.nodeDefinition as FlowNode);

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            targetList.splice(pos, 1); // rollback
            return fail(
              `Validation failed after add:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            await saveSnapshot();
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          const loc = params.parent ? ` in ${params.parent}` : "";
          return ok(
            `Node "${params.nodeDefinition.name}" added at position ${pos}${loc}.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- Remove ---
        if (params.action === "remove") {
          if (!params.node)
            return fail('action "remove" requires "node" (node name).');
          const found = deepFind(params.node);
          if (!found)
            return fail(`Node "${params.node}" not found.`);

          const removed = found.list.splice(found.index, 1)[0];

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            found.list.splice(found.index, 0, removed); // rollback
            return fail(
              `Validation failed after remove (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            await saveSnapshot();
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Node "${params.node}" removed.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- Move ---
        if (params.action === "move") {
          if (!params.node)
            return fail('action "move" requires "node" (node name).');
          if (params.position === undefined)
            return fail('action "move" requires "position".');

          // Find the node wherever it is
          const source = deepFind(params.node);
          if (!source)
            return fail(`Node "${params.node}" not found.`);

          // Resolve destination list
          const { nodes: destList, error: parentErr } = resolveNodeList(params.parent);
          if (parentErr) return fail(parentErr);

          // Remove from source
          const [moved] = source.list.splice(source.index, 1);
          const pos = Math.min(params.position, destList.length);
          destList.splice(pos, 0, moved);

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            // rollback: remove from dest, re-insert at source
            destList.splice(pos, 1);
            source.list.splice(source.index, 0, moved);
            return fail(
              `Validation failed after move (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            await saveSnapshot();
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          const loc = params.parent ? ` in ${params.parent}` : "";
          return ok(
            `Node "${params.node}" moved to position ${pos}${loc}.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- Wrap ---
        if (params.action === "wrap") {
          if (!params.nodes || params.nodes.length === 0)
            return fail('action "wrap" requires "nodes" (array of node names).');
          if (!params.wrapper)
            return fail('action "wrap" requires "wrapper" (container node definition with name and do).');
          if (!["loop", "condition", "branch", "parallel"].includes(params.wrapper.do))
            return fail(
              `Wrapper "do" must be loop, condition, branch, or parallel. Got "${params.wrapper.do}".`,
            );

          // All target nodes must be in the same parent list and contiguous
          const firstFound = deepFind(params.nodes[0]);
          if (!firstFound)
            return fail(`Node "${params.nodes[0]}" not found.`);

          const parentList = firstFound.list;
          const indices: number[] = [];
          for (const name of params.nodes) {
            const idx = parentList.findIndex((n) => n.name === name);
            if (idx === -1)
              return fail(
                `Node "${name}" not found in the same parent list as "${params.nodes[0]}".`,
              );
            indices.push(idx);
          }
          indices.sort((a, b) => a - b);

          // Check contiguous
          for (let i = 1; i < indices.length; i++) {
            if (indices[i] !== indices[i - 1] + 1)
              return fail(
                "Nodes to wrap must be contiguous (adjacent in the same list).",
              );
          }

          // Extract the nodes
          const extracted = parentList.splice(indices[0], indices.length);

          // Build the wrapper node with children
          const wrapperNode = { ...params.wrapper } as FlowNode;
          switch (wrapperNode.do) {
            case "loop":
              (wrapperNode as LoopNode).nodes = extracted;
              break;
            case "parallel":
              (wrapperNode as ParallelNode).nodes = extracted;
              break;
            case "condition":
              (wrapperNode as ConditionNode).then = extracted;
              if (!(wrapperNode as ConditionNode).else)
                (wrapperNode as ConditionNode).else = [];
              break;
            case "branch": {
              const b = wrapperNode as BranchNode;
              // Put extracted nodes into the first path, or "true" by default
              const firstPath = b.paths ? Object.keys(b.paths)[0] : "true";
              if (!b.paths) b.paths = {};
              b.paths[firstPath] = extracted;
              break;
            }
          }

          // Insert wrapper where the first extracted node was
          parentList.splice(indices[0], 0, wrapperNode);

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            // rollback: remove wrapper, re-insert extracted nodes
            parentList.splice(indices[0], 1);
            parentList.splice(indices[0], 0, ...extracted);
            return fail(
              `Validation failed after wrap (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            await saveSnapshot();
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Wrapped ${params.nodes.length} node(s) into "${params.wrapper.name}" (${params.wrapper.do}).${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        return fail(`Unknown action: "${params.action}"`);
      },
    },
    { optional: true },
  );

  // ---- flow_trigger -------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_trigger",
      description: `Schedule a flow to run on a recurring cron schedule on this box.

A trigger is a separate record, not a field on the flow — so one flow can have
several triggers with different cadences and different inputs, and pausing one
never touches the flow definition or mints a new version.

Actions:
  create   — arm a new schedule (flow + cron required)
  update   — edit an existing schedule (cron, tz, inputs, version, description)
  list     — list triggers, optionally filtered by flow
  pause    — stop firing, keep the record
  resume   — start firing again
  delete   — remove the record
  run_now  — fire immediately, ignoring the schedule

Schedules are standard 5-field cron ("0 9 * * *"). Minimum interval is 60s.
Runs missed while the host was down are NOT replayed.
By default a trigger runs the latest PUBLISHED version; pin one with "version".`,

      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "list", "pause", "resume", "delete", "run_now"],
          },
          id: {
            type: "string",
            description: "Trigger id. Required for update/pause/resume/delete/run_now.",
          },
          flow: {
            type: "string",
            description: "Flow name. Required for create; optional filter for list.",
          },
          cron: {
            type: "string",
            description:
              'Cron expression, e.g. "0 9 * * *". Required for create; optional for update.',
          },
          tz: {
            type: "string",
            description: 'IANA timezone, e.g. "Europe/Rome". Host local time when omitted.',
          },
          inputs: {
            type: "object",
            additionalProperties: true,
            description: "Payload passed as the flow's inputs on every fire.",
          },
          version: {
            type: "number",
            description: "Pin a published version. Omit to always run the latest published.",
          },
          description: { type: "string" },
        },
      },

      async execute(
        _id: string,
        params: {
          action: string;
          id?: string;
          flow?: string;
          cron?: string;
          tz?: string;
          inputs?: Record<string, unknown>;
          version?: number;
          description?: string;
        },
      ) {
        const text = (t: string) => ({ content: [{ type: "text", text: t }] });

        const requireId = (): string => {
          if (!params.id) throw new Error(`"id" is required for action "${params.action}"`);
          if (!triggerStore.get(params.id)) throw new Error(`Trigger not found: ${params.id}`);
          return params.id;
        };

        const describe = (r: {
          id: string;
          flowName: string;
          cron: string;
          tz?: string;
          version: number | "@published";
          enabled: boolean;
          nextRunAt?: string;
          lastRunAt?: string;
          lastStatus?: string;
        }) =>
          `${r.enabled ? "●" : "○"} ${r.id}\n` +
          `    flow: ${r.flowName} (${r.version === "@published" ? "latest published" : `v${r.version}`})\n` +
          `    cron: ${r.cron}${r.tz ? ` [${r.tz}]` : ""}\n` +
          `    next: ${r.enabled ? (r.nextRunAt ?? "—") : "paused"}` +
          (r.lastRunAt ? `\n    last: ${r.lastRunAt} (${r.lastStatus ?? "?"})` : "");

        try {
          switch (params.action) {
            case "create": {
              if (!params.flow) throw new Error('"flow" is required for action "create"');
              if (!params.cron) throw new Error('"cron" is required for action "create"');
              // Validate before storing: a bad schedule must fail here, not at
              // fire time on a box nobody is watching.
              assertValidSchedule(params.cron, params.tz);
              const record = triggerStore.create({
                flowName: params.flow,
                cron: params.cron,
                tz: params.tz,
                inputs: params.inputs,
                version: params.version,
                description: params.description,
              });
              scheduler.sync();
              const stored = triggerStore.get(record.id) ?? record;
              return text(`Scheduled.\n\n${describe(stored)}`);
            }

            case "update": {
              const id = requireId();
              const current = triggerStore.get(id)!;
              const cron = params.cron ?? current.cron;
              const tz = params.tz ?? current.tz;
              // Re-validate the resulting schedule, not just the field that
              // changed — a new tz can invalidate an expression that was fine.
              assertValidSchedule(cron, tz);
              triggerStore.update(id, {
                cron,
                ...(params.tz !== undefined ? { tz: params.tz } : {}),
                ...(params.inputs !== undefined ? { inputs: params.inputs } : {}),
                ...(params.version !== undefined ? { version: params.version } : {}),
                ...(params.description !== undefined
                  ? { description: params.description }
                  : {}),
              });
              scheduler.sync();
              return text(`Updated.\n\n${describe(triggerStore.get(id)!)}`);
            }

            case "list": {
              const records = triggerStore.list(
                params.flow ? { flowName: params.flow } : undefined,
              );
              if (records.length === 0) {
                return text(
                  params.flow
                    ? `No triggers for flow "${params.flow}".`
                    : "No triggers on this box.",
                );
              }
              return text(records.map(describe).join("\n\n"));
            }

            case "pause": {
              const id = requireId();
              triggerStore.update(id, { enabled: false, nextRunAt: undefined });
              scheduler.sync();
              return text(`Paused ${id}. The flow definition is unchanged.`);
            }

            case "resume": {
              const id = requireId();
              triggerStore.update(id, { enabled: true });
              scheduler.sync();
              return text(`Resumed.\n\n${describe(triggerStore.get(id)!)}`);
            }

            case "delete": {
              const id = requireId();
              triggerStore.remove(id);
              scheduler.sync();
              return text(`Deleted trigger ${id}.`);
            }

            case "run_now": {
              const id = requireId();
              const result = await scheduler.runNow(id);
              if (!result) {
                const stored = triggerStore.get(id);
                return text(
                  `Trigger ${id} did not run: ${stored?.lastError ?? "flow could not be resolved"}`,
                );
              }
              return text(
                `Ran ${id} → instance ${result.instanceId} (${result.status}).`,
              );
            }

            default:
              return text(`Unknown action: "${params.action}"`);
          }
        } catch (err) {
          return text(
            `flow_trigger ${params.action} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    },
    { optional: true },
  );
}

export default {
  id: "clawflow",
  register,
};
