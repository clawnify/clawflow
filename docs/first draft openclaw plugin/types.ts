// ─── openclaw-flow v0.2 ────────────────────────────────────────────────────────
// Declarative agentic workflow format.
// Designed to be written by LLMs, run anywhere.
//
// Runtime targets:
//   - OpenClaw plugin (this package)
//   - Cloudflare Workers (via transpiler — see transpile.ts)
//   - Standalone Node.js server (future)

// ─── Flow Definition ──────────────────────────────────────────────────────────

export interface FlowDefinition {
  flow: string;                    // unique name, e.g. "triage-support-ticket"
  version?: string;                // semver, e.g. "1.0.0"
  description?: string;
  trigger?: FlowTrigger;
  nodes: FlowNode[];
}

export interface FlowTrigger {
  on: "webhook" | "cron" | "manual" | "event" | string;
  from?: string;                   // source label e.g. "helpdesk"
  schedule?: string;               // cron expression if on: cron
}

// ─── Retry Policy ─────────────────────────────────────────────────────────────
// Applies to any node. Learned from Cloudflare WorkflowStepConfig.

export interface RetryPolicy {
  limit: number;                   // max attempts (default: 1 = no retry)
  delay: string | number;          // e.g. "2s", "1m", or milliseconds
  backoff?: "linear" | "exponential" | "constant";
}

// ─── Node Union ───────────────────────────────────────────────────────────────

export type FlowNode =
  | AiNode
  | AgentNode
  | BranchNode
  | LoopNode
  | ParallelNode
  | HttpNode
  | MemoryNode
  | WaitNode
  | SleepNode
  | CodeNode;

export interface BaseNode {
  name: string;
  do: string;
  output?: string;                 // store result under this key in flow state
  retry?: RetryPolicy;             // per-node retry policy
  timeout?: string | number;       // e.g. "30s", or ms integer
}

// ─── Node Types ───────────────────────────────────────────────────────────────

/**
 * ai — single LLM call, structured or freeform output.
 *
 * Example:
 *   - name: classify
 *     do: ai
 *     prompt: "Classify this ticket as billing, technical, or general"
 *     input: trigger.body
 *     schema:
 *       category: "billing | technical | general"
 *       confidence: number
 *       summary: string
 *     model: fast
 *     output: classification
 */
export interface AiNode extends BaseNode {
  do: "ai";
  prompt: string;
  input?: string;                        // dotted path into flow state
  schema?: Record<string, string>;       // output shape; enables JSON mode
  model?: "fast" | "smart" | "best" | string;
  temperature?: number;
}

/**
 * agent — open-ended autonomous task. When running on OpenClaw, this
 * delegates to sessions_spawn. On other runtimes it falls back to a
 * high-capability ai node.
 *
 * Example:
 *   - name: investigate
 *     do: agent
 *     task: "Research {{ classification.category }} issues and suggest a fix"
 *     tools: [web_search, read_file]
 *     timeout: 5m
 *     output: investigation
 */
export interface AgentNode extends BaseNode {
  do: "agent";
  task: string;
  input?: string;
  tools?: string[];
  model?: string;
}

/**
 * branch — routes to a different node based on a value in flow state.
 *
 * Example:
 *   - name: route
 *     do: branch
 *     on: classification.category
 *     paths:
 *       billing: handle-billing
 *       technical: handle-technical
 *     default: handle-general
 */
export interface BranchNode extends BaseNode {
  do: "branch";
  on: string;                            // dotted path in flow state
  paths: Record<string, string>;         // value → node name to jump to
  default?: string;                      // node name if no path matches
}

/**
 * loop — runs sub-nodes for each item in a list.
 *
 * Example:
 *   - name: process-tickets
 *     do: loop
 *     over: inbox.tickets
 *     as: ticket
 *     nodes:
 *       - name: summarize
 *         do: ai
 *         prompt: "Summarize {{ ticket }}"
 *         output: summary
 */
export interface LoopNode extends BaseNode {
  do: "loop";
  over: string;                          // dotted path to array
  as: string;                            // variable name for current item
  nodes: FlowNode[];
}

/**
 * parallel — runs multiple sub-nodes concurrently, waits for all to complete.
 * Learned from Cloudflare Promise.race / Promise.all patterns.
 *
 * Example:
 *   - name: research
 *     do: parallel
 *     nodes:
 *       - name: web-research
 *         do: agent
 *         task: "Search the web for {{ topic }}"
 *         output: web_results
 *       - name: memory-search
 *         do: memory
 *         action: read
 *         key: "knowledge-{{ topic }}"
 *         output: memory_results
 *     output: research_combined
 */
export interface ParallelNode extends BaseNode {
  do: "parallel";
  nodes: FlowNode[];                     // all run concurrently
  mode?: "all" | "race";                 // "all" = wait for all, "race" = first wins
}

/**
 * http — calls an external endpoint.
 *
 * Example:
 *   - name: notify
 *     do: http
 *     url: "https://api.example.com/reply/{{ trigger.id }}"
 *     method: POST
 *     body: "{{ draft.text }}"
 *     retry:
 *       limit: 3
 *       delay: "2s"
 *       backoff: exponential
 */
export interface HttpNode extends BaseNode {
  do: "http";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * memory — read or write persistent key/value store.
 *
 * Example:
 *   - name: remember
 *     do: memory
 *     action: write
 *     key: "ticket-{{ trigger.id }}"
 *     value: "{{ classification.category }}"
 */
export interface MemoryNode extends BaseNode {
  do: "memory";
  action: "read" | "write" | "delete";
  key: string;
  value?: string;                        // required for write
}

/**
 * wait — pause for human approval OR a named external event.
 * Learned from Cloudflare step.waitForEvent().
 *
 * Approval example:
 *   - name: approve-send
 *     do: wait
 *     for: approval
 *     prompt: "Send this reply?\n\n{{ draft.text }}"
 *
 * Event example (external system pushes resumption):
 *   - name: await-payment
 *     do: wait
 *     for: event
 *     event: stripe-webhook          # must match type in flow_send_event call
 *     timeout: 24h
 *     output: payment_event
 */
export interface WaitNode extends BaseNode {
  do: "wait";
  for: "approval" | "event";
  prompt?: string;                       // shown for approval gates
  event?: string;                        // event type to match (for: event)
  timeout?: string;                      // e.g. "24h", "5m" — fail if exceeded
}

/**
 * sleep — pause for a fixed duration before continuing.
 * Maps directly to Cloudflare step.sleep().
 *
 * Example:
 *   - name: cool-down
 *     do: sleep
 *     duration: 5m
 */
export interface SleepNode extends BaseNode {
  do: "sleep";
  duration: string;                      // e.g. "30s", "5m", "2h", "1d"
}

/**
 * code — evaluate an inline JS expression. Constrained: no async, no imports.
 *
 * Example:
 *   - name: format-date
 *     do: code
 *     input: trigger.timestamp
 *     run: "new Date(input).toLocaleDateString('en-GB')"
 *     output: formatted_date
 */
export interface CodeNode extends BaseNode {
  do: "code";
  run: string;
  input?: string;
}

// ─── Runtime Types ────────────────────────────────────────────────────────────

export interface FlowState {
  trigger?: unknown;
  [key: string]: unknown;
}

// Vocabulary aligned with Cloudflare InstanceStatus for future portability
export type NodeStatus = "queued" | "running" | "ok" | "retrying" | "error" | "skipped" | "waiting" | "paused";

export interface TraceEntry {
  node: string;
  do: string;
  status: NodeStatus;
  attempt?: number;                      // which retry attempt (1-based)
  output?: unknown;
  error?: string;
  durationMs: number;
}

export type FlowStatus = "running" | "completed" | "paused" | "waiting" | "failed" | "cancelled";

export interface FlowResult {
  ok: boolean;
  status: FlowStatus;
  flowName: string;
  instanceId: string;                    // stable ID for this run
  state: FlowState;
  trace: TraceEntry[];
  // Set when status = "paused" (approval) or "waiting" (event)
  pausedAt?: string;
  resumeToken?: string;
  waitingFor?: {
    type: "approval" | "event";
    event?: string;                      // event type name if waiting for event
    prompt?: string;
    timeout?: string;
  };
  error?: string;
}

// ─── Plugin Config ────────────────────────────────────────────────────────────

export interface PluginConfig {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  memoryDir?: string;
  maxNodeDurationMs?: number;
  stateDir?: string;                     // where to persist flow state across restarts
}

// ─── Model Shorthands ─────────────────────────────────────────────────────────

export const MODEL_MAP: Record<string, string> = {
  fast:  "claude-haiku-4-5-20251001",
  smart: "claude-sonnet-4-6",
  best:  "claude-opus-4-6",
};
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// ─── Duration Parser ──────────────────────────────────────────────────────────
// Parses "30s", "5m", "2h", "1d" → milliseconds

export function parseDuration(d: string | number): number {
  if (typeof d === "number") return d;
  const units: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000
  };
  const match = d.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: "${d}". Use e.g. "30s", "5m", "2h", "1d"`);
  return parseFloat(match[1]) * (units[match[2]] ?? 1000);
}
