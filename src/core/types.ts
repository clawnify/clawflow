// ---- clawflow v0.2 --------------------------------------------------------------
// Declarative agentic workflow format.
// Designed to be written by LLMs, run anywhere.
//
// Runtime targets:
//   - OpenClaw plugin (this package)
//   - Cloudflare Workers (via transpiler -- see transpile.ts)
//   - Standalone Node.js server (future)

// ---- Flow Definition ------------------------------------------------------------

export interface FlowDefinition {
  flow: string; // unique name, e.g. "triage-support-ticket"
  version?: string; // semver, e.g. "1.0.0"
  description?: string;
  /**
   * Declared inputs the flow expects. Optional: when omitted, the flow accepts
   * any payload (anything-goes mode). When present, required inputs must be
   * supplied at runtime or the flow fails before any node executes. Extra
   * undeclared keys in the payload pass through and are reachable via
   * {{ inputs.* }} but are not statically checked.
   */
  inputs?: Record<string, InputSpec>;
  /** Environment variables the flow expects. Values are defaults; null means required (runtime must provide). */
  env?: Record<string, string | null>;
  nodes: FlowNode[];
}

export interface InputSpec {
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  description?: string;
  default?: unknown;
}

// ---- Retry Policy ---------------------------------------------------------------
// Applies to any node. Learned from Cloudflare WorkflowStepConfig.

export interface RetryPolicy {
  limit: number; // max attempts (default: 1 = no retry)
  delay: string | number; // e.g. "2s", "1m", or milliseconds
  backoff?: "linear" | "exponential" | "constant";
}

// ---- Node Union -----------------------------------------------------------------

export type FlowNode =
  | AiNode
  | AgentNode
  | BranchNode
  | ConditionNode
  | LoopNode
  | ParallelNode
  | HttpNode
  | MemoryNode
  | WaitNode
  | SleepNode
  | CodeNode
  | ExecNode;

export interface BaseNode {
  name: string;
  do: string;
  output?: string; // store result under this key in flow state
  retry?: RetryPolicy; // per-node retry policy
  timeout?: string | number; // e.g. "30s", or ms integer
}

// ---- Field resolution modes -----------------------------------------------------
// Single source of truth for how each node field is treated when a flow runs.
// Both the runner (template interpolation) and the validator (template-ref checks)
// read the per-node `*_FIELD_MODES` maps below, so "which fields are dynamic" is
// declared once — not re-decided in every exec handler and again in the validator.
export type FieldMode =
  // A string interpolated with {{ }} templates at exec time (resolveTemplate).
  | "template"
  // An array of template strings, or a map of string values. Each element is resolved.
  | "templateEach"
  // A string-or-object deep-resolved, type-preserving (resolveBodyObject). The owning
  // handler performs this resolution; the generic pass leaves the field untouched.
  | "templateDeep"
  // A raw dotted state path read via getPath (never {{ }}-interpolated).
  | "path"
  // A JS expression evaluated against state (condition `if`).
  | "expr"
  // A FlowNode[] sub-block, resolved lazily as it executes (loop/branch/condition/parallel).
  | "children"
  // Executable source, passed through untouched and run (code `run`).
  | "code"
  // Passed through untouched: enums, numbers, output shapes, tool lists.
  | "literal";

// A field-mode map must list EXACTLY the own keys of T (minus BaseNode). Adding a
// field to an interface without classifying it — or classifying one that doesn't
// exist — is a compile error. This is what stops a new value field from silently
// shipping without interpolation (the agentId/session class of bug).
type OwnKeys<T extends BaseNode> = Exclude<keyof T, keyof BaseNode>;
type FieldModeMap<T extends BaseNode> = Record<OwnKeys<T>, FieldMode>;

// ---- Node Types -----------------------------------------------------------------

export interface AiNode extends BaseNode {
  do: "ai";
  prompt: string;
  input?: string; // dotted path into flow state
  schema?: Record<string, string>; // output shape; enables JSON mode
  model?: "fast" | "smart" | "best" | string;
  /**
   * Named backend to run this node against — a key in `PluginConfig.providers`
   * or a built-in (`"openrouter"`, `"anthropic"`, `"openai"`). Falls back to
   * `PluginConfig.defaultProvider`, then to legacy env-var auto-detection.
   */
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  /** File paths (images, PDFs) to include as multimodal content. Supports templates. */
  attachments?: string[];
}
const AI_FIELD_MODES: FieldModeMap<AiNode> = {
  prompt: "template",
  input: "path",
  schema: "literal",
  model: "literal",
  provider: "literal",
  temperature: "literal",
  maxTokens: "literal",
  attachments: "templateEach",
};

export interface AgentNode extends BaseNode {
  do: "agent";
  task: string;
  input?: string;
  tools?: string[];
  // Field names mirror `openclaw agent`'s flags 1:1 (agent→--agent, sessionKey→
  // --session-key, sessionId→--session-id, channel→--channel). `agentId`/`session`
  // are the pre-1.3.1 names, kept as deprecated aliases (the new name wins if both set).
  /**
   * OpenClaw agent slug to delegate to (e.g. "main", "clawflow"), mapped to
   * `openclaw agent --agent`. A plain slug, never a session key. Defaults to
   * "main" if no target (`agent`/`sessionKey`/`sessionId`) is set.
   */
  agent?: string;
  /** @deprecated Renamed to `agent` (aligns with `--agent`). Still accepted; `agent` wins if both are set. */
  agentId?: string;
  /**
   * OpenClaw session key to target, mapped to `openclaw agent --session-key`.
   * Use this to run inside a specific existing session — a channel, a named
   * agent session — rather than a fresh turn. "agent:"-prefixed keys (e.g.
   * "agent:main:slack:channel:agent") are self-scoping; a bare key (e.g.
   * "incident-42") is scoped by `agent` (or the default agent). May be
   * combined with `agent` — OpenClaw requires them to be consistent.
   */
  sessionKey?: string;
  /** @deprecated Renamed to `sessionKey` (aligns with `--session-key`). Still accepted; `sessionKey` wins if both are set. */
  session?: string;
  /**
   * Explicit OpenClaw session id, mapped to `openclaw agent --session-id`. The
   * most specific target: it names one session directly (scoped by `agent`).
   * Prefer `sessionKey` for channel/self-scoping keys; use this to resume a known id.
   */
  sessionId?: string;
  /**
   * Delivery channel for the agent's reply, mapped to `openclaw agent --channel`
   * (e.g. "slack", "telegram", "whatsapp"). Omit to use the session's own channel.
   */
  channel?: string;
}
const AGENT_FIELD_MODES: FieldModeMap<AgentNode> = {
  task: "template",
  input: "path",
  tools: "literal",
  // Selector fields map to CLI flags and are interpolated so a value computed by a
  // prior node (e.g. "{{ route.agent_slug }}") can target the delegate/reply channel.
  agent: "template",
  agentId: "template", // deprecated alias for `agent`
  sessionKey: "template",
  session: "template", // deprecated alias for `sessionKey`
  sessionId: "template",
  channel: "template",
};

export interface BranchNode extends BaseNode {
  do: "branch";
  on: string; // dotted path in flow state
  paths: Record<string, FlowNode[]>; // value -> sub-flow to execute
  default?: FlowNode[]; // sub-flow if no path matches
}
const BRANCH_FIELD_MODES: FieldModeMap<BranchNode> = {
  on: "path",
  paths: "children",
  default: "children",
};

export interface LoopNode extends BaseNode {
  do: "loop";
  over: string; // dotted path to array
  as: string; // variable name for current item
  nodes: FlowNode[];
}
const LOOP_FIELD_MODES: FieldModeMap<LoopNode> = {
  over: "path",
  as: "literal",
  nodes: "children",
};

export interface ParallelNode extends BaseNode {
  do: "parallel";
  nodes: FlowNode[];
  mode?: "all" | "race"; // "all" = wait for all, "race" = first wins
}
const PARALLEL_FIELD_MODES: FieldModeMap<ParallelNode> = {
  nodes: "children",
  mode: "literal",
};

export interface HttpNode extends BaseNode {
  do: "http";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
}
const HTTP_FIELD_MODES: FieldModeMap<HttpNode> = {
  url: "template",
  method: "literal",
  body: "templateDeep",
  headers: "templateEach",
};

export interface MemoryNode extends BaseNode {
  do: "memory";
  action: "read" | "write" | "delete";
  key: string;
  value?: string; // required for write
}
const MEMORY_FIELD_MODES: FieldModeMap<MemoryNode> = {
  action: "literal",
  key: "template",
  value: "template",
};

/**
 * wait — pause for human approval or external event.
 *
 * for: "approval" — human-in-the-loop gate with token-based resume.
 *   Registers a pending approval, provides a token for resume.
 *   On approval: output = { approved: true, approvedAt: string, token: string }
 *   On denial: flow is cancelled.
 *
 * for: "event" — wait for an external event (webhook, signal).
 *
 * Example:
 *   - name: review-pdfs
 *     do: wait
 *     for: approval
 *     prompt: "Review generated PDFs for {{ parsed.client_name }}"
 *     preview: "process_sheets[*].pdfPath"
 *     timeout: "24h"
 *     output: approval
 */
export interface WaitNode extends BaseNode {
  do: "wait";
  for: "approval" | "event";
  prompt?: string; // shown for approval gates (supports templates)
  preview?: string; // dotted path or wildcard to data shown alongside prompt (for: approval)
  event?: string; // event type to match (for: event)
  timeout?: string; // e.g. "24h", "5m" -- fail if exceeded
}
const WAIT_FIELD_MODES: FieldModeMap<WaitNode> = {
  for: "literal",
  prompt: "template",
  preview: "templateDeep",
  event: "literal",
};

export interface SleepNode extends BaseNode {
  do: "sleep";
  duration: string; // e.g. "30s", "5m", "2h", "1d"
}
const SLEEP_FIELD_MODES: FieldModeMap<SleepNode> = {
  duration: "literal",
};

export interface CodeNode extends BaseNode {
  do: "code";
  run: string;
  input?: string;
}
const CODE_FIELD_MODES: FieldModeMap<CodeNode> = {
  run: "code",
  input: "path",
};

/**
 * exec — run a shell command deterministically, no AI involved.
 * Templates in `command` are resolved before execution.
 * Output: { stdout: string, stderr: string, exitCode: number }
 *
 * Example:
 *   - name: build-pdf
 *     do: exec
 *     command: "python3 /path/fill_foglio.py '{{ pdfPath }}' '{{ sheet | json }}'"
 *     output: buildResult
 */
export interface ExecNode extends BaseNode {
  do: "exec";
  command: string;
  cwd?: string; // working directory (resolved via templates)
}
const EXEC_FIELD_MODES: FieldModeMap<ExecNode> = {
  command: "template",
  cwd: "template",
};

/**
 * condition — if/else with sub-node blocks that reconverge.
 * Like branch, condition runs inline sub-nodes and merges back into
 * the main flow. Use condition for boolean logic, branch for multi-way
 * value matching.
 *
 * The `if` field is a JS expression evaluated against flow state.
 * Dotted paths like "order.status" resolve from state.
 * Comparison operators: ==, !=, >, <, >=, <=
 * Logical operators: &&, ||, !
 *
 * Example:
 *   - name: check-transport
 *     do: condition
 *     if: "extractOrder.transport_type == 'CLIENTE'"
 *     then:
 *       - name: pickup-note
 *         do: code
 *         run: "'Client picks up'"
 *         output: note
 *     else:
 *       - name: delivery-note
 *         do: code
 *         run: "'We deliver'"
 *         output: note
 *     output: condition_result
 */
export interface ConditionNode extends BaseNode {
  do: "condition";
  if: string; // JS expression evaluated against flow state
  then: FlowNode[]; // nodes to run when condition is true
  else?: FlowNode[]; // nodes to run when condition is false
}
const CONDITION_FIELD_MODES: FieldModeMap<ConditionNode> = {
  if: "expr",
  then: "children",
  else: "children",
};

// ---- Field-mode registry (the single source of truth) ---------------------------
// Maps each built-in node type to its per-field resolution modes. The runner reads
// this to interpolate the right fields; the validator reads it to know which fields
// carry {{ }} templates. Add a node type here and both consumers pick it up.

export const NODE_FIELD_MODES: Record<string, Record<string, FieldMode>> = {
  ai:        AI_FIELD_MODES,
  agent:     AGENT_FIELD_MODES,
  branch:    BRANCH_FIELD_MODES,
  condition: CONDITION_FIELD_MODES,
  loop:      LOOP_FIELD_MODES,
  parallel:  PARALLEL_FIELD_MODES,
  http:      HTTP_FIELD_MODES,
  memory:    MEMORY_FIELD_MODES,
  wait:      WAIT_FIELD_MODES,
  sleep:     SLEEP_FIELD_MODES,
  code:      CODE_FIELD_MODES,
  exec:      EXEC_FIELD_MODES,
};

// ---- Allowed Node Keys (derived from the field-mode registry) -------------------
// Used by the validator to reject unknown fields. Own keys come straight from each
// node's field-mode map, so the allow-list can never drift from the classification.

const BASE_KEYS: readonly string[] = ["name", "do", "output", "retry", "timeout"];

export const NODE_KEYS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(NODE_FIELD_MODES).map(([type, modes]) => [
    type,
    new Set([...BASE_KEYS, ...Object.keys(modes)]),
  ]),
);

// ---- Runtime Types --------------------------------------------------------------

export interface FlowState {
  inputs?: unknown;
  [key: string]: unknown;
}

// Vocabulary aligned with Cloudflare InstanceStatus for future portability
export type NodeStatus =
  | "queued"
  | "running"
  | "ok"
  | "retrying"
  | "error"
  | "skipped"
  | "waiting"
  | "paused";

export interface TraceEntry {
  node: string;
  do: string;
  status: NodeStatus;
  attempt?: number; // which retry attempt (1-based)
  output?: unknown;
  error?: string;
  durationMs: number;
}

export type FlowStatus =
  | "running"
  | "completed"
  | "paused"
  | "waiting"
  | "failed"
  | "cancelled";

export interface FlowResult {
  ok: boolean;
  status: FlowStatus;
  flowName: string;
  instanceId: string; // stable ID for this run
  state: FlowState;
  trace: TraceEntry[];
  // Set when status = "paused" (approval/approve) or "waiting" (event)
  pausedAt?: string;
  resumeToken?: string;
  waitingFor?: {
    type: "approval" | "event";
    event?: string; // event type name if waiting for event
    prompt?: string;
    preview?: unknown; // resolved preview data for approve nodes
    timeout?: string;
  };
  error?: string;
}

// ---- Pending Approval -----------------------------------------------------------

export interface PendingApproval {
  token: string; // short random token for resume
  instanceId: string;
  flowName: string;
  node: string; // approve node name
  prompt: string; // resolved prompt text
  preview?: unknown; // resolved preview data
  createdAt: string;
  expiresAt: string;
}

// ---- Inference Function ---------------------------------------------------------
// Pluggable AI completion function. When running inside OpenClaw, the plugin
// injects a function that calls the gateway's OpenAI-compatible endpoint,
// reusing whatever providers/keys are already configured.

/** A single content part in a multimodal message (OpenAI/OpenRouter-compatible format). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface InferenceRequest {
  model: string;
  system: string;
  prompt: string;
  /** When set, the prompt is multimodal — providers should use this instead of `prompt`. */
  content?: ContentPart[];
  temperature?: number;
  maxTokens?: number;
}

export interface InferenceResult {
  text: string;
}

export type InferenceFn = (req: InferenceRequest) => Promise<InferenceResult>;

// ---- Providers ------------------------------------------------------------------
// A named AI backend an `ai` node can target. When the host resolves per-caller
// credentials (e.g. an org's BYOK key behind a gateway), point a provider at that
// endpoint so flow AI spend follows the same credential/routing path as the rest
// of the platform instead of a shared process-env key.

export interface ProviderSpec {
  /** Base URL of the provider, e.g. "https://api.clawnify.com/v1". */
  baseUrl: string;
  /** Wire format. Default "openai-completions". */
  api?: "openai-completions" | "anthropic-messages";
  /** Literal API key. Prefer `apiKeyEnv` so secrets stay out of the config file. */
  apiKey?: string;
  /** Name of an env var holding the API key, resolved at call time. */
  apiKeyEnv?: string;
  /**
   * Maps flow model tiers ("fast" | "smart" | "best") to this provider's model
   * IDs. An `ai` node's `model` that isn't a tier and isn't one of these IDs is
   * normalized to the "smart" tier.
   */
  models?: Record<string, string>;
}

// ---- Plugin Config --------------------------------------------------------------

export interface ServeConfig {
  port: number;
  path?: string; // base path prefix, default "/flows"
  flowsDir?: string; // directory containing .json flow files, default workspace/flows
}

export interface PluginConfig {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  /**
   * Named AI backends selectable per `ai` node via its `provider` field. The
   * keys `"openrouter"`, `"anthropic"`, and `"openai"` are built in (env-keyed)
   * and can be overridden here.
   */
  providers?: Record<string, ProviderSpec>;
  /**
   * Provider used by `ai` nodes that don't set their own `provider`. When set,
   * it takes precedence over legacy env-var auto-detection, so a stray
   * `OPENROUTER_API_KEY` in the environment can't silently win.
   */
  defaultProvider?: string;
  memoryDir?: string;
  maxNodeDurationMs?: number;
  stateDir?: string; // where to persist flow state across restarts
  /** Override for AI inference — used by tests and embedders */
  inferenceFn?: InferenceFn;
  /** OpenClaw agent ID for do:agent nodes (e.g. "ops"). Falls back to --local if unset. */
  defaultAgent?: string;
  /** Optional HTTP server config — exposes a generic run endpoint per flow. */
  serve?: ServeConfig;
  /**
   * Optional custom step registry. Defaults to the module-level singleton
   * populated by `registerStepType()`. Provide a private registry for
   * test isolation or to run multiple FlowRunners with different step sets.
   */
  customSteps?: import("./custom-steps.js").StepRegistry;
  /**
   * Approval gate for the `flow_run` tool. Flows can call HTTP, exec, and
   * agent tools, so by default the plugin prompts the user before each run.
   * Hosts that need unattended automation can disable the gate entirely or
   * skip it for specific session contexts.
   */
  approval?: ApprovalConfig;
}

export interface ApprovalConfig {
  /** Disable the approval gate entirely. Default: `true` (gate enabled). */
  enabled?: boolean;
  /**
   * Substrings matched against the current session key. If any substring
   * appears in the session key, the approval gate is skipped for that run.
   * Useful for hook-driven sessions where no interactive channel is bound
   * (e.g. inbound email automation, where the session key looks like
   * `agent:main:main:email:<message-id>`). Default: `[]`.
   */
  skipSessionPatterns?: string[];
  /** Override the prompt timeout (ms). Default: `300000` (5 min). */
  timeoutMs?: number;
  /** Action on prompt timeout: `"allow"` or `"deny"`. Default: `"deny"`. */
  timeoutBehavior?: "allow" | "deny";
}

// ---- Model Shorthands -----------------------------------------------------------

export const MODEL_MAP: Record<string, string> = {
  fast: "google/gemini-3-flash-preview",
  smart: "anthropic/claude-sonnet-4.6",
  best: "minimax/minimax-m2.5",
};
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

// OpenRouter uses provider-prefixed IDs with dots.
// Maps both shorthand aliases and resolved model IDs.
export const OPENROUTER_MODEL_MAP: Record<string, string> = {
  fast: "google/gemini-3-flash-preview",
  smart: "anthropic/claude-sonnet-4.6",
  best: "minimax/minimax-m2.5",
  "google/gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "anthropic/claude-sonnet-4.6": "anthropic/claude-sonnet-4.6",
  "minimax/minimax-m2.5": "minimax/minimax-m2.5",
};

// ---- Duration Parser ------------------------------------------------------------
// Parses "30s", "5m", "2h", "1d" -> milliseconds

export function parseDuration(d: string | number): number {
  if (typeof d === "number") return d;
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const match = d.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match)
    throw new Error(
      `Invalid duration: "${d}". Use e.g. "30s", "5m", "2h", "1d"`,
    );
  return parseFloat(match[1]) * (units[match[2]] ?? 1000);
}
