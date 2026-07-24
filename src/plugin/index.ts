import { FlowRunner } from "../core/runner.js";
import { FlowOps } from "../core/ops.js";
import { FLOW_OP_SPECS } from "../core/op-specs.js";
import { startFlowServer } from "../core/serve.js";
import { startManagementServer } from "../core/manage.js";
import type { PluginConfig } from "../core/types.js";

// ---- OpenClaw Plugin: clawflow ---------------------------------------------------
// Thin OpenClaw adapter over the harness-neutral core. Registers one tool per
// FLOW_OP_SPECS entry (flow_create, flow_run, flow_edit, …) forwarding to
// FlowOps, plus the OpenClaw-specific approval gate, the webhook flow server,
// and the loopback management API.

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
  const ops = new FlowOps(workspace, runner);

  // ---- Flow server (optional) ---------------------------------------------------
  // Skip when spawned as a child agent (CLAWFLOW_NO_SERVE) to avoid port conflicts.
  if (pluginCfg.serve && !process.env.CLAWFLOW_NO_SERVE) {
    startFlowServer({
      runner,
      serve: pluginCfg.serve,
      logger: api.logger,
    });
  }

  // ---- Management API (optional) ------------------------------------------------
  // Loopback-only op surface for out-of-process shims. Never starts without a
  // token. Shares CLAWFLOW_NO_SERVE so child agents don't bind ports.
  const manageCfg = pluginCfg.manage ?? {};
  const manageToken = manageCfg.token ?? process.env.CLAWFLOW_ADMIN_TOKEN;
  if (manageCfg.enabled !== false && manageToken && !process.env.CLAWFLOW_NO_SERVE) {
    startManagementServer({
      ops,
      token: manageToken,
      port: manageCfg.port,
      logger: api.logger,
    });
  } else if (manageCfg.enabled && !manageToken) {
    api.logger?.warn(
      "clawflow: manage.enabled is set but no token configured (manage.token or CLAWFLOW_ADMIN_TOKEN) — management API not started",
    );
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
  // Intrinsic mutation gate: authoring/publishing/deleting a flow is a write
  // action that must never run without a human OK, so it is gated on every call
  // independently of `enabled` (which governs flow_run) and does NOT honor
  // skipSessionPatterns. Kill-switch: approval.gateMutations=false.
  const gateMutations = approvalCfg.gateMutations !== false;
  const MUTATION_VERBS: Record<string, string> = {
    flow_create: "Create",
    flow_edit: "Edit",
    flow_publish: "Publish",
    flow_delete: "Delete",
  };

  if (api.registerHook && (approvalEnabled || gateMutations)) {
    api.registerHook(
      "before_tool_call",
      (event) => {
        const toolName = event.toolName ?? event.tool;

        // Flow-authoring tools — always gate (no skipSessionPatterns). No
        // allow-always persist path, so every call re-prompts.
        const mutationVerb = toolName ? MUTATION_VERBS[toolName] : undefined;
        if (gateMutations && mutationVerb) {
          const mp = (event.params ?? {}) as { file?: string; flow?: string };
          const name = mp.flow ?? mp.file ?? "inline flow";
          return {
            requireApproval: {
              title: `${mutationVerb} clawflow "${name}"?`.slice(0, 80),
              description: "Creates, edits, publishes, or deletes a flow definition.",
              severity: "warning",
              timeoutMs: approvalTimeoutMs,
              timeoutBehavior: approvalTimeoutBehavior,
            },
          };
        }

        if (!approvalEnabled || toolName !== "flow_run") return;

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
        description: "Gate flow_run (skippable) and flow authoring/publishing/deletion (always) behind user approval.",
      },
    );
  } else if (!api.registerHook) {
    api.logger?.warn(
      "clawflow: registerHook unavailable — flow_run will run without approval gate. Update OpenClaw to enable.",
    );
  }

  // ---- Tools --------------------------------------------------------------------
  // One tool per op spec, forwarding to FlowOps and adapting the { text,
  // details? } result to OpenClaw's tool-result shape.

  for (const spec of FLOW_OP_SPECS) {
    api.registerTool(
      {
        name: spec.name,
        ...(spec.catalogMode && { catalogMode: spec.catalogMode }),
        description: spec.description,
        parameters: spec.parameters,
        async execute(_id: string, params: unknown) {
          const result = await ops.execute(spec.name, params);
          return {
            content: [{ type: "text", text: result.text }],
            ...(result.details !== undefined && { details: result.details }),
          };
        },
      },
      { optional: true },
    );
  }
}

export default {
  id: "clawflow",
  register,
};
