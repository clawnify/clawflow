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
  trigger?: FlowTrigger;
  nodes: FlowNode[];
}

export interface FlowTrigger {
  on: "webhook" | "cron" | "manual" | "event" | string;
  from?: string; // source label e.g. "helpdesk"
  schedule?: string; // cron expression if on: cron
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

// ---- Node Types -----------------------------------------------------------------

export interface AiNode extends BaseNode {
  do: "ai";
  prompt: string;
  input?: string; // dotted path into flow state
  schema?: Record<string, string>; // output shape; enables JSON mode
  model?: "fast" | "smart" | "best" | string;
  temperature?: number;
}

export interface AgentNode extends BaseNode {
  do: "agent";
  task: string;
  input?: string;
  tools?: string[];
  model?: string;
  /** OpenClaw agent ID to delegate to (e.g. "main", "ops"). Uses OpenClaw's default routing if omitted. */
  agent?: string;
}

export interface BranchNode extends BaseNode {
  do: "branch";
  on: string; // dotted path in flow state
  paths: Record<string, FlowNode[]>; // value -> sub-flow to execute
  default?: FlowNode[]; // sub-flow if no path matches
}

export interface LoopNode extends BaseNode {
  do: "loop";
  over: string; // dotted path to array
  as: string; // variable name for current item
  nodes: FlowNode[];
}

export interface ParallelNode extends BaseNode {
  do: "parallel";
  nodes: FlowNode[];
  mode?: "all" | "race"; // "all" = wait for all, "race" = first wins
}

export interface HttpNode extends BaseNode {
  do: "http";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface MemoryNode extends BaseNode {
  do: "memory";
  action: "read" | "write" | "delete";
  key: string;
  value?: string; // required for write
}

export interface WaitNode extends BaseNode {
  do: "wait";
  for: "approval" | "event";
  prompt?: string; // shown for approval gates
  event?: string; // event type to match (for: event)
  timeout?: string; // e.g. "24h", "5m" -- fail if exceeded
}

export interface SleepNode extends BaseNode {
  do: "sleep";
  duration: string; // e.g. "30s", "5m", "2h", "1d"
}

export interface CodeNode extends BaseNode {
  do: "code";
  run: string;
  input?: string;
}

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

// ---- Runtime Types --------------------------------------------------------------

export interface FlowState {
  trigger?: unknown;
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
  // Set when status = "paused" (approval) or "waiting" (event)
  pausedAt?: string;
  resumeToken?: string;
  waitingFor?: {
    type: "approval" | "event";
    event?: string; // event type name if waiting for event
    prompt?: string;
    timeout?: string;
  };
  error?: string;
}

// ---- Inference Function ---------------------------------------------------------
// Pluggable AI completion function. When running inside OpenClaw, the plugin
// injects a function that calls the gateway's OpenAI-compatible endpoint,
// reusing whatever providers/keys are already configured.

export interface InferenceRequest {
  model: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface InferenceResult {
  text: string;
}

export type InferenceFn = (req: InferenceRequest) => Promise<InferenceResult>;

// ---- Plugin Config --------------------------------------------------------------

export interface PluginConfig {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  memoryDir?: string;
  maxNodeDurationMs?: number;
  stateDir?: string; // where to persist flow state across restarts
  /** Injected by the OpenClaw plugin to route AI calls through the gateway */
  inferenceFn?: InferenceFn;
  /** OpenClaw agent ID for do:agent nodes (e.g. "ops"). Falls back to --local if unset. */
  defaultAgent?: string;
  /** Gateway URL for OpenAI-compatible endpoint (auto-detected when running in OpenClaw) */
  gatewayUrl?: string;
  /** Gateway auth token */
  gatewayToken?: string;
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
