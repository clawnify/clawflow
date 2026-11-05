import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import {
  FlowDefinition,
  FlowNode,
  FlowState,
  FlowResult,
  TraceEntry,
  RunningStep,
  PluginConfig,
  MODEL_MAP,
  OPENROUTER_MODEL_MAP,
  RetryPolicy,
  AiNode,
  AgentNode,
  BranchNode,
  ConditionNode,
  LoopNode,
  ParallelNode,
  HttpNode,
  MemoryNode,
  WaitNode,
  SleepNode,
  CodeNode,
  ExecNode,
  ContentPart,
  ProviderSpec,
  NODE_FIELD_MODES,
  parseDuration,
} from "./types.js";
import { StateStore } from "./store.js";
import { validateFlow } from "./validate.js";
import {
  defaultRegistry,
  type CustomStepContext,
  type CustomStepDefinition,
  type StepRegistry,
} from "./custom-steps.js";
import {
  liveRuns,
  childController,
  abortableDelay,
  abortReason,
  FlowCancelledError,
  type LiveRun,
} from "./active-runs.js";
import type { FlowStatus } from "./types.js";

// ---- Built-in AI providers ------------------------------------------------------
// Selectable by name from an `ai` node's `provider` field (or cfg.defaultProvider).
// Each reads its key from an env var; override any of them via cfg.providers.

const BUILTIN_PROVIDERS: Record<string, ProviderSpec> = {
  openrouter: { baseUrl: "https://openrouter.ai/api", api: "openai-completions", apiKeyEnv: "OPENROUTER_API_KEY" },
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { baseUrl: "https://api.openai.com", api: "openai-completions", apiKeyEnv: "OPENAI_API_KEY" },
};

/** A provider spec with its API key resolved, ready to call. */
interface ResolvedProvider {
  name: string;
  spec: ProviderSpec;
  apiKey: string;
}

// ---- Event Bus ------------------------------------------------------------------
// External systems call sendEvent(instanceId, type, payload) to unblock
// flows waiting with do: wait / for: event.

type EventWaiter = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};
const eventBus = new Map<string, Map<string, EventWaiter>>();

export function sendEvent(
  instanceId: string,
  eventType: string,
  payload: unknown,
): boolean {
  const waiters = eventBus.get(instanceId);
  if (!waiters) return false;
  const waiter = waiters.get(eventType);
  if (!waiter) return false;
  clearTimeout(waiter.timeoutHandle);
  waiters.delete(eventType);
  waiter.resolve(payload);
  return true;
}

// ---- Template filters -----------------------------------------------------------

function applyFilter(val: unknown, filter: string): unknown {
  switch (filter) {
    case "json":
    case "tojson":
      return typeof val === "string" ? val : JSON.stringify(val);
    case "upper":
      return String(val).toUpperCase();
    case "lower":
      return String(val).toLowerCase();
    case "trim":
      return String(val).trim();
    case "length":
      if (Array.isArray(val)) return val.length;
      if (typeof val === "string") return val.length;
      if (val !== null && typeof val === "object") return Object.keys(val).length;
      return 0;
    default:
      return typeof val === "object" ? JSON.stringify(val) : String(val);
  }
}

// ---- Runner ---------------------------------------------------------------------

export class FlowRunner {
  private cfg: PluginConfig;
  private store: StateStore;
  private registry: StepRegistry;

  constructor(cfg: PluginConfig) {
    this.cfg = cfg;
    this.store = new StateStore(cfg.stateDir);
    this.registry = cfg.customSteps ?? defaultRegistry;
  }

  // ---- Start a new run ----------------------------------------------------------

  /** The agent session that started a run and is waiting on it (flow_run).
   *  An agent step targeting that session could only start once the waiting
   *  turn ends, so the run would deadlock until the step times out. */
  private callers = new Map<string, CallerSession>();

  async run(
    flow: FlowDefinition,
    input: unknown,
    instanceId?: string,
    opts?: { caller?: CallerSession },
  ): Promise<FlowResult> {
    if (!opts?.caller?.sessionKey && !opts?.caller?.sessionId) return this.runFlow(flow, input, instanceId);
    const id = instanceId ?? crypto.randomUUID();
    this.callers.set(id, opts.caller);
    try {
      return await this.runFlow(flow, input, id);
    } finally {
      this.callers.delete(id);
    }
  }

  private async runFlow(
    flow: FlowDefinition,
    input: unknown,
    instanceId?: string,
  ): Promise<FlowResult> {
    // Static validation before execution
    const validation = validateFlow(flow, { registry: this.registry });
    for (const w of validation.warnings) {
      console.warn(`[clawflow] ${w.node ? `[${w.node}] ` : ""}${w.message}`);
    }
    if (!validation.ok) {
      const id = instanceId ?? crypto.randomUUID();
      const messages = validation.errors.map((e) =>
        e.node ? `[${e.node}] ${e.message}` : e.message,
      );
      return {
        ok: false,
        status: "failed",
        flowName: flow.flow ?? "unknown",
        instanceId: id,
        state: { inputs: input },
        trace: [],
        error: `Validation failed:\n${messages.join("\n")}`,
      };
    }

    const id = instanceId ?? crypto.randomUUID();
    const state: FlowState = { inputs: input };

    // Validate declared inputs against the actual payload before any node runs.
    if (flow.inputs && typeof flow.inputs === "object") {
      const payload = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const missing: string[] = [];
      for (const [k, spec] of Object.entries(flow.inputs)) {
        if (spec?.required && !(k in payload)) missing.push(k);
      }
      if (missing.length > 0) {
        const error = `Missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`;
        this.store.create(id, flow.flow, state);
        this.store.update(id, { status: "failed", error });
        return {
          ok: false, status: "failed", flowName: flow.flow ?? "unknown",
          instanceId: id, state, trace: [], error,
        };
      }
    }

    // Create state record first — ensures a state file exists even if env resolution fails
    this.store.create(id, flow.flow, state);

    // Seed state.env: flow defaults → shell-expand $(…) → process.env overrides
    if (flow.env) {
      const env: Record<string, string> = {};
      const shellPattern = /\$\((.+?)\)/;

      for (const [k, v] of Object.entries(flow.env)) {
        // process.env always wins
        if (process.env[k] !== undefined) {
          env[k] = process.env[k]!;
          continue;
        }
        if (v === null) continue; // required, checked below
        // Shell-expand $(…) in default values
        if (shellPattern.test(v)) {
          try {
            const { exec } = await import("child_process");
            const { promisify } = await import("util");
            const execAsync = promisify(exec);
            const { stdout } = await execAsync(v.replace(shellPattern, "$1"), { timeout: 10_000 });
            const resolved = stdout.trim();
            if (!resolved) {
              const error = `env var "${k}": command "${v}" returned empty`;
              this.store.update(id, { status: "failed", error });
              return {
                ok: false, status: "failed", flowName: flow.flow ?? "unknown",
                instanceId: id, state, trace: [], error,
              };
            }
            env[k] = resolved;
          } catch (err) {
            const error = `env var "${k}": failed to resolve "${v}": ${err instanceof Error ? err.message : String(err)}`;
            this.store.update(id, { status: "failed", error });
            return {
              ok: false, status: "failed", flowName: flow.flow ?? "unknown",
              instanceId: id, state, trace: [], error,
            };
          }
        } else {
          env[k] = v;
        }
      }

      // Check required env vars (null with no process.env override)
      const missing = Object.entries(flow.env)
        .filter(([k, v]) => v === null && !(k in env))
        .map(([k]) => k);
      if (missing.length > 0) {
        const error = `Missing required env vars: ${missing.join(", ")}`;
        this.store.update(id, { status: "failed", error });
        return {
          ok: false, status: "failed", flowName: flow.flow ?? "unknown",
          instanceId: id, state, trace: [], error,
        };
      }

      if (Object.keys(env).length > 0) state.env = env;
    }

    return this.executeRun(flow, state, id, 0, []);
  }

  // ---- Resume after approval ----------------------------------------------------

  async resume(
    token: string,
    flow: FlowDefinition,
    approvedOrPayload: boolean | unknown = true,
  ): Promise<FlowResult> {
    // Token can be an instanceId (legacy wait nodes) or an approve token
    let record = this.store.get(token);
    let instanceId = token;

    // Check if it's an approve token
    if (!record) {
      const approval = this.store.resolveApproval(token);
      if (approval) {
        record = this.store.get(approval.instanceId);
        instanceId = approval.instanceId;
      }
    }

    if (!record) throw new Error(`Resume token not found: ${token}`);
    if (record.status !== "paused" && record.status !== "waiting") {
      throw new Error(
        `Instance "${instanceId}" is not paused (status: ${record.status})`,
      );
    }

    // Retrieve stored trace from before pause
    const storedTrace = record.trace ?? [];
    const pausedAtIndex = record.pausedAtIndex ?? 0;

    if (typeof approvedOrPayload === "boolean" && !approvedOrPayload) {
      // Update the paused trace entry to "skipped"
      const pausedEntry = storedTrace.find((t) => t.status === "paused");
      if (pausedEntry) pausedEntry.status = "skipped";
      this.store.update(instanceId, { status: "cancelled", trace: storedTrace });
      return {
        ok: true,
        status: "cancelled",
        flowName: record.flowName,
        instanceId,
        state: record.state,
        trace: storedTrace,
        error: "Flow cancelled at approval gate",
      };
    }

    // Memoize the paused node with the approval payload and set in state
    const pausedNode = flow.nodes[pausedAtIndex];
    if (pausedNode) {
      const isApproval = pausedNode.do === "wait"
        && (pausedNode as WaitNode).for === "approval";
      const approvalOutput = isApproval
        ? { approved: true, approvedAt: new Date().toISOString(), token }
        : approvedOrPayload;
      this.store.memoize(instanceId, pausedNode.name, approvalOutput);
      if (pausedNode.output) record.state[pausedNode.output] = approvalOutput;

      // Update the paused trace entry to "ok"
      const pausedEntry = storedTrace.find(
        (t) => t.node === pausedNode.name && t.status === "paused",
      );
      if (pausedEntry) {
        pausedEntry.status = "ok";
        pausedEntry.output = approvalOutput;
      }
    }

    this.store.update(instanceId, {
      status: "running",
      trace: storedTrace,
      resumeToken: undefined,
      waitingFor: undefined,
      pausedAtIndex: undefined,
    });

    // Continue from the node AFTER the paused one, with preserved trace
    return this.executeRun(flow, record.state, instanceId, pausedAtIndex + 1, storedTrace);
  }

  // ---- Cancel -------------------------------------------------------------------

  /**
   * Cancel a run that has not finished.
   *
   * A run executing in this process is stopped where it is: the step it is on
   * receives the abort and the run ends as cancelled before this resolves. An
   * agent step's `openclaw agent` process gets SIGTERM, on which the CLI aborts
   * the turn it started in the gateway; exec, http and ai steps are killed or
   * aborted; a custom step gets `ctx.abortSignal` and is abandoned if it ignores
   * it. Any other unfinished run (paused at an approval, or left running by a
   * process that has since exited) is marked cancelled on its record. A runner
   * in another process that still holds such a run stops before its next step
   * and keeps that status.
   */
  async cancel(instanceId: string, reason = "Cancelled"): Promise<CancelResult> {
    const live = liveRuns.get(instanceId);
    const record = this.store.get(instanceId);
    if (!live && !record) return { ok: false, instanceId, error: "not_found" };
    if (!live && record && FINISHED_STATUSES.has(record.status)) {
      return { ok: false, instanceId, error: "finished", status: record.status };
    }

    if (live) {
      if (!live.controller.signal.aborted) live.controller.abort(new FlowCancelledError(reason));
      // The step's work is raced against the abort, so the run settles at once;
      // the bound only guards against a host that never yields.
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        live.done?.catch(() => undefined),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, 5_000);
        }),
      ]);
      clearTimeout(bound);
      const status = this.store.get(instanceId)?.status ?? "cancelled";
      return { ok: true, instanceId, status: status === "cancelled" ? "cancelled" : "cancelling" };
    }

    const current = record!;
    const trace = current.trace ?? [];
    const paused = trace.find((t) => t.status === "paused");
    if (paused) paused.status = "cancelled";
    if (current.resumeToken) this.store.resolveApproval(current.resumeToken);
    this.store.update(instanceId, {
      status: "cancelled",
      error: reason,
      trace,
      running: undefined,
      resumeToken: undefined,
      waitingFor: undefined,
      pausedAtIndex: undefined,
    });
    return { ok: true, instanceId, status: "cancelled" };
  }

  /** Execute a top-level run (new or resumed) as a live run of this process, so
   *  cancel() can reach the step it is on. */
  private async executeRun(
    flow: FlowDefinition,
    state: FlowState,
    instanceId: string,
    startIndex: number,
    priorTrace: TraceEntry[],
  ): Promise<FlowResult> {
    const live: LiveRun = { controller: new AbortController(), flowName: flow.flow };
    liveRuns.set(instanceId, live);
    try {
      const done = this.execute(flow, state, instanceId, startIndex, priorTrace, live.controller.signal);
      live.done = done;
      return await done;
    } finally {
      if (liveRuns.get(instanceId) === live) liveRuns.delete(instanceId);
    }
  }

  /** End a run (or sub-flow) as cancelled, recording why. */
  private endCancelled(
    flow: FlowDefinition,
    state: FlowState,
    instanceId: string,
    trace: TraceEntry[],
    reason?: string,
  ): FlowResult {
    const error = reason || "Cancelled";
    this.store.update(instanceId, { status: "cancelled", state, trace, error, running: undefined });
    return { ok: false, status: "cancelled", flowName: flow.flow, instanceId, state, trace, error };
  }

  /** A top-level run whose record was marked cancelled from outside this
   *  process while it ran. Sub-flow records are never marked that way. */
  private cancelledOnRecord(instanceId: string): string | undefined {
    if (instanceId.includes(":")) return undefined;
    const record = this.store.get(instanceId);
    return record?.status === "cancelled" ? (record.error || "Cancelled") : undefined;
  }

  // ---- Core execution loop ------------------------------------------------------

  private async execute(
    flow: FlowDefinition,
    state: FlowState,
    instanceId: string,
    startIndex: number,
    priorTrace: TraceEntry[],
    signal: AbortSignal,
  ): Promise<FlowResult> {
    const trace: TraceEntry[] = [...priorTrace];
    const nodes = flow.nodes;
    let i = startIndex;

    while (i < nodes.length) {
      const node = nodes[i];
      const t0 = Date.now();

      // One read per step: whether the run was cancelled, and the memo below.
      const record = this.store.get(instanceId);
      if (signal.aborted) return this.endCancelled(flow, state, instanceId, trace, abortReason(signal).message);
      if (record?.status === "cancelled" && !instanceId.includes(":")) {
        return this.endCancelled(flow, state, instanceId, trace, record.error);
      }

      // ---- Durable memoization: skip already-completed nodes --------------------
      const memo = record && Object.prototype.hasOwnProperty.call(record.completedNodes, node.name)
        ? { found: true, output: record.completedNodes[node.name] }
        : { found: false, output: undefined };
      if (memo.found) {
        if (node.output) state[node.output] = memo.output;
        // On resume, prior trace entries are already in priorTrace — don't re-add
        if (!priorTrace.some((t) => t.node === node.name)) {
          trace.push({
            node: node.name,
            do: node.do,
            status: "ok",
            output: memo.output,
            durationMs: 0,
          });
        }
        i++;
        continue;
      }

      try {
        // Say what this run is doing while the step runs; each exit below clears it.
        this.store.update(instanceId, { running: this.runningStep(node, state) });
        const result = await this.runWithRetry(node, state, flow, instanceId, signal);

        // ---- Paused for approval (do: wait, for: approval) ----------------------
        if (result.approve) {
          const entry: TraceEntry = {
            node: node.name,
            do: node.do,
            status: "paused",
            durationMs: Date.now() - t0,
          };
          trace.push(entry);
          this.store.update(instanceId, {
            status: "paused",
            state,
            trace,
            running: undefined,
            pausedAtIndex: i,
            resumeToken: result.approve.token,
            waitingFor: {
              type: "approval",
              prompt: result.approve.prompt,
              preview: result.approve.preview,
              timeout: result.approve.timeout,
            },
          });
          return {
            ok: true,
            status: "paused",
            flowName: flow.flow,
            instanceId,
            state,
            trace,
            pausedAt: node.name,
            resumeToken: result.approve.token,
            waitingFor: {
              type: "approval",
              prompt: result.approve.prompt,
              preview: result.approve.preview,
              timeout: result.approve.timeout,
            },
          };
        }

        // ---- Normal completion --------------------------------------------------
        if (node.output) state[node.output] = result.output;
        this.store.memoize(instanceId, node.name, result.output);
        const entry: TraceEntry = {
          node: node.name,
          do: node.do,
          status: "ok",
          output: result.output,
          attempt: result.attempts,
          durationMs: Date.now() - t0,
        };
        trace.push(entry);
        this.store.update(instanceId, { state, trace, running: undefined });
        i++;
      } catch (err) {
        if (signal.aborted) {
          const reason = abortReason(signal).message;
          trace.push({ node: node.name, do: node.do, status: "cancelled", error: reason, durationMs: Date.now() - t0 });
          return this.endCancelled(flow, state, instanceId, trace, reason);
        }
        const message = err instanceof Error ? err.message : String(err);
        const entry: TraceEntry = {
          node: node.name,
          do: node.do,
          status: "error",
          error: message,
          durationMs: Date.now() - t0,
        };
        trace.push(entry);
        const cancelled = this.cancelledOnRecord(instanceId);
        if (cancelled) return this.endCancelled(flow, state, instanceId, trace, cancelled);
        const error = `Node "${node.name}": ${message}`;
        this.store.update(instanceId, { status: "failed", state, trace, error, running: undefined });
        return {
          ok: false,
          status: "failed",
          flowName: flow.flow,
          instanceId,
          state,
          trace,
          error,
        };
      }
    }

    const cancelled = this.cancelledOnRecord(instanceId);
    if (cancelled) return this.endCancelled(flow, state, instanceId, trace, cancelled);
    this.store.update(instanceId, { status: "completed", state, trace });
    return {
      ok: true,
      status: "completed",
      flowName: flow.flow,
      instanceId,
      state,
      trace,
    };
  }

  // ---- Retry wrapper ------------------------------------------------------------
  // Each attempt gets its own signal, aborted when the run is cancelled (via
  // `signal`) or when the attempt times out, so a timed-out attempt's child
  // process or request is stopped before the next attempt starts instead of
  // running on in the background. The work is raced against that signal, so a
  // step that ignores it is abandoned, never waited on.

  private async runWithRetry(
    node: FlowNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{
    output?: unknown;
    approve?: { token: string; prompt: string; preview?: unknown; timeout?: string };
    attempts?: number;
  }> {
    const policy: RetryPolicy = node.retry ?? { limit: 1, delay: 0 };
    const nodeTimeoutMs = this.nodeTimeoutMs(node);

    let lastError: Error = new Error("Unknown error");

    for (let attempt = 1; attempt <= policy.limit; attempt++) {
      if (signal.aborted) throw abortReason(signal);
      const { controller, dispose } = childController(signal);
      const timer = setTimeout(
        () => controller.abort(new Error(`Node "${node.name}" timed out after ${nodeTimeoutMs}ms`)),
        nodeTimeoutMs,
      );
      try {
        const stopped = new Promise<never>((_, reject) => {
          const onAbort = () => reject(abortReason(controller.signal));
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await Promise.race([this.execNode(node, state, flow, instanceId, controller.signal), stopped]);
        return { ...result, attempts: attempt };
      } catch (err) {
        if (signal.aborted) throw abortReason(signal);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < policy.limit) {
          await abortableDelay(this.calcDelay(policy, attempt), signal);
        }
      } finally {
        clearTimeout(timer);
        dispose();
      }
    }
    throw lastError;
  }

  /** How long one attempt of a step may run before it fails and is stopped.
   *  An agent step defaults to the 120 s its `openclaw agent` process always
   *  had: with 30 s here the step failed while its turn ran on in the gateway. */
  private nodeTimeoutMs(node: FlowNode): number {
    if (node.timeout) return parseDuration(node.timeout);
    return this.cfg.maxNodeDurationMs ?? (node.do === "agent" ? 120_000 : 30_000);
  }

  private runningStep(node: FlowNode, state: FlowState): RunningStep {
    const step: RunningStep = {
      node: node.name,
      do: node.do,
      startedAt: new Date().toISOString(),
      timeoutMs: this.nodeTimeoutMs(node),
    };
    if (node.do === "agent") {
      // The same interpolation execNode applies, so this is the session the step runs in.
      const n = this.resolveNodeFields(node, state) as AgentNode;
      const target = { agent: n.agent ?? n.agentId, sessionKey: n.sessionKey ?? n.session, sessionId: n.sessionId };
      step.target = {
        agent: target.agent,
        sessionKey: agentStepSessionKey(target, this.cfg.defaultAgent, this.cfg.sessionMainKey),
        sessionId: target.sessionId,
      };
    }
    return step;
  }

  private calcDelay(policy: RetryPolicy, attempt: number): number {
    const base = parseDuration(policy.delay);
    if (policy.backoff === "exponential")
      return base * Math.pow(2, attempt - 1);
    if (policy.backoff === "linear") return base * attempt;
    return base; // constant (default)
  }

  // ---- Node dispatcher ----------------------------------------------------------

  private async execNode(
    node: FlowNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{
    output?: unknown;
    approve?: { token: string; prompt: string; preview?: unknown; timeout?: string };
  }> {
    // Interpolate every field classified as a template value in NODE_FIELD_MODES,
    // once, before dispatch — so handlers never re-decide "is this field dynamic?".
    // Structural fields (paths, expressions, child blocks, deep bodies) are left
    // untouched here and resolved by their handler where timing matters.
    node = this.resolveNodeFields(node, state);

    switch (node.do) {
      case "ai":
        return this.execAi(node as AiNode, state, signal);
      case "agent":
        return this.execAgent(node as AgentNode, state, instanceId, signal);
      case "branch":
        return this.execBranch(node as BranchNode, state, flow, instanceId, signal);
      case "condition":
        return this.execCondition(
          node as ConditionNode,
          state,
          flow,
          instanceId,
          signal,
        );
      case "loop":
        return this.execLoop(node as LoopNode, state, flow, instanceId, signal);
      case "parallel":
        return this.execParallel(
          node as ParallelNode,
          state,
          flow,
          instanceId,
          signal,
        );
      case "http":
        return this.execHttp(node as HttpNode, state, signal);
      case "memory":
        return this.execMemory(node as MemoryNode, state);
      case "wait":
        return this.execWait(node as WaitNode, state, flow, instanceId, signal);
      case "sleep":
        return this.execSleep(node as SleepNode, signal);
      case "code":
        return this.execCode(node as CodeNode, state);
      case "exec":
        return this.execExec(node as ExecNode, state, signal);
      default: {
        const stepName = (node as FlowNode & { do: string }).do;
        const def = this.registry.get(stepName);
        if (!def) {
          const known = this.registry.names();
          const hint = known.length
            ? ` Registered custom steps: ${known.join(", ")}.`
            : " No custom steps are registered — is the plugin loaded?";
          throw new Error(`Unknown step type: "${stepName}".${hint}`);
        }
        return this.execCustomStep(node, def, state, signal);
      }
    }
  }

  // ---- do: ai -------------------------------------------------------------------

  private async execAi(
    node: AiNode,
    state: FlowState,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    const provider = this.resolveProvider(node.provider);
    const model = this.resolveModel(node.model, provider);

    const input = node.input ? this.getPath(state, node.input) : undefined;
    const prompt = node.prompt; // template already interpolated by resolveNodeFields

    const jsonInstructions = node.schema
      ? `\n\nReturn ONLY valid JSON matching exactly this schema (no markdown, no commentary):\n${JSON.stringify(node.schema, null, 2)}`
      : "";

    const userText =
      input != null
        ? `${prompt}\n\nInput:\n${typeof input === "object" ? JSON.stringify(input, null, 2) : String(input)}`
        : prompt;

    const system = `You are a workflow step. Follow the prompt exactly.${jsonInstructions}`;

    // Build multimodal content parts when attachments are present
    let contentParts: ContentPart[] | undefined;
    if (node.attachments?.length) {
      contentParts = [{ type: "text", text: userText }];
      for (const resolved of node.attachments) {
        // paths already interpolated by resolveNodeFields (templateEach)
        contentParts.push(this.attachmentToContentPart(resolved));
      }
    }

    const text = await this.callInference(model, system, userText, node.temperature, node.maxTokens, contentParts, provider, signal);

    if (node.schema) {
      const clean = text
        .replace(/^```(?:json)?\n?/m, "")
        .replace(/\n?```$/m, "")
        .trim();
      try {
        return { output: JSON.parse(clean) };
      } catch {
        throw new Error(
          `ai node "${node.name}" returned invalid JSON: ${text.slice(0, 200)}`,
        );
      }
    }

    return { output: text.trim() };
  }

  // ---- File → content part -------------------------------------------------------

  private static MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };

  private static isUrl(s: string): boolean {
    return /^https?:\/\//i.test(s);
  }

  /**
   * Normalize a provider baseUrl before appending an endpoint. Accepts URLs both
   * with and without a trailing "/v1" (OpenClaw-style provider configs include it),
   * so we always hit ".../v1/<endpoint>" exactly once instead of "/v1/v1/...".
   */
  private static apiBase(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  private attachmentToContentPart(value: string): ContentPart {
    // URLs are passed through directly
    if (FlowRunner.isUrl(value)) {
      // Guess type from URL extension (default to image)
      const urlPath = new URL(value).pathname.toLowerCase();
      if (urlPath.endsWith(".pdf")) {
        return {
          type: "file",
          file: {
            filename: path.basename(urlPath),
            file_data: value,
          },
        };
      }
      return { type: "image_url", image_url: { url: value } };
    }

    // Local file — read and base64-encode
    const ext = path.extname(value).toLowerCase();
    const mime = FlowRunner.MIME_BY_EXT[ext];
    if (!mime) {
      throw new Error(
        `Unsupported attachment type "${ext}" for "${value}". Supported: ${Object.keys(FlowRunner.MIME_BY_EXT).join(", ")}`,
      );
    }
    const data = fs.readFileSync(value);
    const b64 = data.toString("base64");

    if (mime === "application/pdf") {
      return {
        type: "file",
        file: {
          filename: path.basename(value),
          file_data: `data:${mime};base64,${b64}`,
        },
      };
    }
    return {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${b64}` },
    };
  }

  /** Convert OpenAI/OpenRouter content parts to Anthropic message content format. */
  private toAnthropicContent(parts: ContentPart[]): unknown[] {
    return parts.map((p) => {
      if (p.type === "text") return { type: "text", text: p.text };
      if (p.type === "image_url") {
        const url = p.image_url.url;
        // data URL → extract media_type and base64 data
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (match) {
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        }
        // Remote URL
        return { type: "image", source: { type: "url", url } };
      }
      if (p.type === "file") {
        const fd = p.file.file_data;
        const match = fd.match(/^data:(application\/pdf);base64,(.+)$/s);
        if (match) {
          return {
            type: "document",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        }
        // Remote URL
        return { type: "document", source: { type: "url", url: fd } };
      }
      return p;
    });
  }


  // ---- Provider resolution ------------------------------------------------------
  // An `ai` node runs against a named provider when one is selected (node.provider
  // or cfg.defaultProvider), otherwise it falls back to legacy env auto-detection.
  // Selecting a provider is how a host routes flow AI spend through its own
  // per-caller credential path instead of a shared process-env key.

  private resolveProvider(name?: string): ResolvedProvider | null {
    const providerName = name ?? this.cfg.defaultProvider;
    if (!providerName) return null; // legacy env auto-detect

    const spec = this.cfg.providers?.[providerName] ?? BUILTIN_PROVIDERS[providerName];
    if (!spec) {
      throw new Error(
        `ai node references unknown provider "${providerName}". ` +
          `Configure it under plugins.clawflow.config.providers, or use a built-in: ` +
          `${Object.keys(BUILTIN_PROVIDERS).join(", ")}.`,
      );
    }

    const apiKey = spec.apiKey ?? (spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined);
    if (!apiKey) {
      throw new Error(
        `ai node provider "${providerName}" has no API key ` +
          `(looked in ${spec.apiKeyEnv ? `env ${spec.apiKeyEnv}` : "config apiKey"}).`,
      );
    }
    return { name: providerName, spec, apiKey };
  }

  /**
   * Resolve an `ai` node's `model` to a concrete model ID. With a provider that
   * declares a tier map, "fast"/"smart"/"best" map to its model IDs and any other
   * value is normalized to the "smart" tier (Option A). Without one, falls back to
   * the generic tier shorthand and otherwise passes the value through.
   */
  private resolveModel(rawModel: string | undefined, provider: ResolvedProvider | null): string {
    const tier = rawModel ?? this.cfg.defaultModel ?? "smart";
    const models = provider?.spec.models;
    if (models) {
      if (models[tier]) return models[tier];
      if (Object.values(models).includes(tier)) return tier; // already a provider model id
      const fallback = models["smart"] ?? Object.values(models)[0];
      if (fallback) {
        console.warn(
          `[clawflow] ai model "${tier}" is not valid for provider "${provider!.name}"; using "${fallback}"`,
        );
        return fallback;
      }
    }
    return MODEL_MAP[tier] ?? tier;
  }

  // ---- Inference dispatch -------------------------------------------------------

  private async callInference(
    model: string,
    system: string,
    prompt: string,
    temperature?: number,
    maxTokens?: number,
    content?: ContentPart[],
    provider?: ResolvedProvider | null,
    signal?: AbortSignal,
  ): Promise<string> {
    // Optional override (used by tests and embedders)
    if (this.cfg.inferenceFn) {
      const result = await this.cfg.inferenceFn({
        model,
        system,
        prompt,
        content,
        temperature: temperature ?? 0,
        maxTokens,
        signal,
      });
      return result.text;
    }
    return this.callDirectApi(model, system, prompt, temperature, maxTokens, content, provider, signal);
  }

  private async callDirectApi(
    model: string,
    system: string,
    prompt: string,
    temperature?: number,
    maxTokens?: number,
    content?: ContentPart[],
    provider?: ResolvedProvider | null,
    signal?: AbortSignal,
  ): Promise<string> {
    // A selected provider is the single credential/routing path — no env racing.
    if (provider) {
      if ((provider.spec.api ?? "openai-completions") === "anthropic-messages") {
        return this.callAnthropicMessages(
          provider.spec.baseUrl,
          provider.apiKey,
          model,
          system,
          prompt,
          temperature,
          maxTokens,
          content,
          signal,
        );
      }
      return this.callOpenAiCompatible(
        provider.spec.baseUrl,
        provider.apiKey,
        model,
        system,
        prompt,
        temperature,
        provider.name,
        maxTokens,
        content,
        signal,
      );
    }

    // Legacy env auto-detect: OpenRouter > Anthropic > OpenAI.
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const anthropicKey = this.cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (openrouterKey) {
      // OpenRouter uses provider-prefixed IDs with dots (anthropic/claude-sonnet-4.6)
      // Resolve from shorthand aliases first, then pass through if already prefixed
      const orModel = OPENROUTER_MODEL_MAP[model] ?? (model.includes("/") ? model : `anthropic/${model}`);
      return this.callOpenAiCompatible(
        "https://openrouter.ai/api",
        openrouterKey,
        orModel,
        system,
        prompt,
        temperature,
        "OpenRouter",
        maxTokens,
        content,
        signal,
      );
    }

    if (anthropicKey) {
      return this.callAnthropicMessages(
        this.cfg.baseUrl ?? "https://api.anthropic.com",
        anthropicKey,
        model,
        system,
        prompt,
        temperature,
        maxTokens,
        content,
        signal,
      );
    }

    if (openaiKey) {
      return this.callOpenAiCompatible(
        this.cfg.baseUrl ?? "https://api.openai.com",
        openaiKey,
        model,
        system,
        prompt,
        temperature,
        "OpenAI",
        maxTokens,
        content,
        signal,
      );
    }

    throw new Error(
      "No AI backend available. Set one of:\n" +
        "  - a provider via plugins.clawflow.config (defaultProvider/providers)\n" +
        "  - OPENROUTER_API_KEY env var\n" +
        "  - ANTHROPIC_API_KEY env var (or apiKey in plugin config)\n" +
        "  - OPENAI_API_KEY env var",
    );
  }

  private async callAnthropicMessages(
    baseUrl: string,
    apiKey: string,
    model: string,
    system: string,
    prompt: string,
    temperature?: number,
    maxTokens?: number,
    content?: ContentPart[],
    signal?: AbortSignal,
  ): Promise<string> {
    // Convert content parts to Anthropic format when multimodal
    const userContent = content ? this.toAnthropicContent(content) : prompt;

    const resp = await fetch(`${FlowRunner.apiBase(baseUrl)}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? 4096,
        temperature: temperature ?? 0,
        system,
        messages: [{ role: "user", content: userContent }],
      }),
      signal,
    });
    if (!resp.ok)
      throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content.find((b) => b.type === "text")?.text ?? "";
  }

  private async callOpenAiCompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    system: string,
    prompt: string,
    temperature: number | undefined,
    provider: string,
    maxTokens?: number,
    content?: ContentPart[],
    signal?: AbortSignal,
  ): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (provider.toLowerCase() === "openrouter") {
      headers["HTTP-Referer"] = "https://clawnify.com";
      headers["X-OpenRouter-Title"] = "Clawnify";
    }
    const resp = await fetch(`${FlowRunner.apiBase(baseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: temperature ?? 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: content ?? prompt },
        ],
      }),
      signal,
    });
    if (!resp.ok)
      throw new Error(`${provider} API ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  // ---- do: agent ----------------------------------------------------------------
  // Delegates to a real OpenClaw agent via CLI. The agent gets full tool access
  // (browser, exec, memory, MCP, CLI).

  private async execAgent(
    node: AgentNode,
    state: FlowState,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    const task = node.task; // template already interpolated by resolveNodeFields
    const input = node.input ? this.getPath(state, node.input) : undefined;
    const fullPrompt =
      input != null
        ? `${task}\n\nContext:\n${typeof input === "object" ? JSON.stringify(input, null, 2) : String(input)}`
        : task;

    const timeoutMs = node.timeout
      ? parseDuration(node.timeout)
      : undefined;

    const target = {
      // new names win; agentId/session are accepted as deprecated aliases
      agent: node.agent ?? node.agentId,
      sessionKey: node.sessionKey ?? node.session,
      sessionId: node.sessionId,
      channel: node.channel,
    };
    // Sub-flow ids extend the run's id ("<id>:loop:…"), and the caller is
    // recorded against the run.
    const caller = this.callers.get(instanceId.split(":")[0]);
    if (caller && targetsCallerSession(target, caller, this.cfg.defaultAgent, this.cfg.sessionMainKey)) {
      throw new Error(
        `This step runs in the same session as the agent that started this flow with flow_run. ` +
          `That session is busy until flow_run returns, so the step could never start and would wait until it timed out. ` +
          `Test the flow by triggering it for real while that session is idle, or point the step at another session.`,
      );
    }

    const cliResult = await this.tryOpenClawAgent(fullPrompt, target, state, timeoutMs, signal);
    return { output: this.autoParseJson(cliResult) };
  }

  // Build the `openclaw agent` selector args from a node's target fields. Mirrors
  // OpenClaw's own selectors, which compose:
  //   --agent <id>         scopes to a configured agent
  //   --session-key <key>  an exact session key (agent:<id>:<key>, or scoped to --agent)
  //   --session-id <id>    the most specific: one explicit session (scoped by --agent)
  //   --channel <channel>  delivery channel for the reply
  // We pass through whichever are set and let OpenClaw resolve/enforce consistency
  // rather than re-asserting it here. When no target selector is set at all, fall
  // back to a configured agent (defaultAgent > "main") so the call is routable.
  private buildAgentArgs(target: {
    agent?: string;
    sessionKey?: string;
    sessionId?: string;
    channel?: string;
  }): string[] {
    const { agent, sessionKey, sessionId, channel } = target;
    const args: string[] = [];
    if (agent) args.push("--agent", agent);
    if (sessionKey) args.push("--session-key", sessionKey);
    if (sessionId) args.push("--session-id", sessionId);
    if (channel) args.push("--channel", channel);
    if (!agent && !sessionKey && !sessionId) {
      args.push("--agent", this.cfg.defaultAgent ?? "main");
    }
    return args;
  }

  private async tryOpenClawAgent(
    message: string,
    target: { agent?: string; sessionKey?: string; sessionId?: string; channel?: string },
    state: FlowState,
    nodeTimeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    // Check if openclaw CLI is available
    try {
      await execFileAsync("which", ["openclaw"]);
    } catch {
      throw new Error("openclaw CLI not found — agent nodes require the openclaw CLI to be installed");
    }

    if (signal?.aborted) throw abortReason(signal);
    const args = ["agent", ...this.buildAgentArgs(target), "--message", message];

    // Merge flow-level env vars (state.env) into the child process environment.
    // Set CLAWFLOW_NO_SERVE to prevent the child from binding the webhook port.
    const env = {
      ...process.env,
      ...((state.env as Record<string, string>) ?? {}),
      CLAWFLOW_NO_SERVE: "1",
    };

    try {
      // On abort (the run is cancelled or the attempt timed out) the child gets
      // SIGTERM, Node's default kill signal. The openclaw CLI answers SIGTERM by
      // sending chat.abort for the turn it started, so the turn stops in the
      // gateway too instead of running on (or staying queued) without the flow.
      const { stdout } = await execFileAsync("openclaw", args, {
        timeout: nodeTimeoutMs ?? this.cfg.maxNodeDurationMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env,
        signal,
      });
      return stdout.trim();
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`openclaw agent failed: ${msg}`);
    }
  }

  private autoParseJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const text = (value as string).trim();

    // 1. Try the whole string as JSON
    try {
      return JSON.parse(text);
    } catch {
      // not pure JSON
    }

    // 2. Try stripping markdown code fences
    const fenced = text
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    if (fenced !== text) {
      try {
        return JSON.parse(fenced);
      } catch {
        // not valid
      }
    }

    // 3. Extract the largest valid JSON from mixed text.
    // CLI output has log lines with stray brackets before the real payload.
    // Strategy: find all candidate { or [ positions, try bracket-matching
    // each one, keep the longest valid parse.
    let bestParsed: unknown = null;
    let bestLength = 0;

    for (const bracket of ["{", "["] as const) {
      const closer = bracket === "{" ? "}" : "]";
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const start = text.indexOf(bracket, searchFrom);
        if (start < 0) break;
        let depth = 0;
        let end = -1;
        for (let i = start; i < text.length; i++) {
          if (text[i] === bracket) depth++;
          else if (text[i] === closer) depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
        if (end > start) {
          const candidate = text.slice(start, end + 1);
          if (candidate.length > bestLength) {
            try {
              const parsed = JSON.parse(candidate);
              bestParsed = parsed;
              bestLength = candidate.length;
            } catch {
              // not valid JSON at this position
            }
          }
        }
        searchFrom = start + 1;
      }
    }

    return bestParsed ?? value;
  }

  // ---- do: branch ---------------------------------------------------------------

  private async execBranch(
    node: BranchNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    // Strip {{ }} template wrapper if present so both "check.flag" and "{{ check.flag }}" work
    const onPath = node.on.replace(/^\{\{\s*([\w.\[\]0-9]+)\s*\}\}$/, "$1");
    const value = String(this.getPath(state, onPath) ?? "");
    const branch = node.paths[value] ?? node.default;
    if (!branch)
      throw new Error(
        `branch "${node.name}": no path for "${value}" and no default`,
      );

    if (branch.length === 0) {
      return { output: value };
    }

    // Execute the matched path as a sub-flow (same pattern as condition)
    const pathName = value in node.paths ? value : "default";
    const subFlow: FlowDefinition = {
      flow: `${flow.flow}:branch:${node.name}:${pathName}`,
      nodes: branch,
    };
    const subId = `${instanceId}:branch:${node.name}:${pathName}`;
    this.store.create(subId, subFlow.flow, state);
    const subResult = await this.execute(subFlow, state, subId, 0, [], signal);
    if (!subResult.ok) {
      throw new Error(
        `branch "${node.name}" path "${pathName}" failed: ${subResult.error}`,
      );
    }

    Object.assign(state, subResult.state);
    return { output: value };
  }

  // ---- do: condition ------------------------------------------------------------
  // If/else with inline sub-node blocks that reconverge into the main flow.

  private async execCondition(
    node: ConditionNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    // Strip {{ }} template wrapper if present so both "check.skip" and "{{ check.skip }}" work
    const condExpr = node.if.replace(/\{\{\s*(.*?)\s*\}\}/g, "$1");
    const conditionResult = this.evalCondition(condExpr, state);
    const branch = conditionResult ? node.then : (node.else ?? []);

    if (branch.length === 0) {
      return { output: conditionResult };
    }

    // Execute the chosen branch as a sub-flow
    const branchName = conditionResult ? "then" : "else";
    const subFlow: FlowDefinition = {
      flow: `${flow.flow}:condition:${node.name}:${branchName}`,
      nodes: branch,
    };
    const subId = `${instanceId}:condition:${node.name}:${branchName}`;
    this.store.create(subId, subFlow.flow, state);
    const subResult = await this.execute(subFlow, state, subId, 0, [], signal);
    if (!subResult.ok) {
      throw new Error(
        `condition "${node.name}" ${branchName} branch failed: ${subResult.error}`,
      );
    }

    // Merge sub-flow state back into parent
    Object.assign(state, subResult.state);
    return { output: conditionResult };
  }

  private evalCondition(expr: string, state: FlowState): boolean {
    // Keywords and literals that should not be resolved as state paths
    const reserved = new Set([
      "true", "false", "null", "undefined", "NaN", "Infinity",
      "typeof", "instanceof", "in", "new", "void", "delete",
    ]);

    // Replace identifiers and dotted paths with their resolved values
    const resolved = expr.replace(
      /([a-zA-Z_][\w]*(?:\.[\w]+)*)/g,
      (_match, path: string) => {
        if (reserved.has(path)) return path;
        // Only resolve if the identifier exists in state
        const val = this.getPath(state, path);
        if (val === undefined && !path.includes(".")) {
          // Bare identifier not in state — leave as-is (might be a JS keyword)
          return path;
        }
        return JSON.stringify(val);
      },
    );
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("state", `"use strict"; return !!(${resolved});`);
      return fn(state);
    } catch {
      throw new Error(
        `condition expression failed: "${expr}" (resolved: "${resolved}")`,
      );
    }
  }

  // ---- do: loop -----------------------------------------------------------------
  // FIX: pass full loop state (including the iteration variable) to sub-nodes

  private async execLoop(
    node: LoopNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{ output: unknown[] }> {
    // Support both plain dotted paths ("plan.sections") and template syntax ("{{ plan.sections }}")
    const resolved = this.resolveBodyObject(node.over, state);
    const items = typeof resolved === "string" ? this.getPath(state, resolved) : resolved;
    if (!Array.isArray(items))
      throw new Error(`loop "${node.name}": "${node.over}" is not an array`);

    const results: unknown[] = [];
    for (const item of items) {
      const loopState: FlowState = { ...state, [node.as]: item };
      const subFlow: FlowDefinition = {
        flow: `${flow.flow}:loop:${node.name}`,
        nodes: node.nodes,
      };
      const subId = `${instanceId}:loop:${node.name}:${results.length}`;
      this.store.create(subId, subFlow.flow, loopState);
      const subResult = await this.execute(
        subFlow,
        loopState,
        subId,
        0,
        [],
        signal,
      );
      if (!subResult.ok)
        throw new Error(`loop iteration failed: ${subResult.error}`);
      results.push(subResult.state);
    }
    return { output: results };
  }

  // ---- do: parallel -------------------------------------------------------------
  // FIX: each branch gets a snapshot of state to avoid concurrent mutation.
  // Results are merged back after all branches complete.

  private async execParallel(
    node: ParallelNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    const promises = node.nodes.map(async (subNode, idx) => {
      const branchState: FlowState = JSON.parse(JSON.stringify(state));
      const subFlow: FlowDefinition = {
        flow: `${flow.flow}:parallel:${node.name}:${subNode.name}`,
        nodes: [subNode],
      };
      const subId = `${instanceId}:parallel:${node.name}:${idx}`;
      this.store.create(subId, subFlow.flow, branchState);
      const subResult = await this.execute(
        subFlow,
        branchState,
        subId,
        0,
        [],
        signal,
      );
      if (!subResult.ok)
        throw new Error(
          `parallel branch "${subNode.name}" failed: ${subResult.error}`,
        );
      const output = subNode.output
        ? subResult.state[subNode.output]
        : subResult.state;
      return { name: subNode.name, output, outputKey: subNode.output };
    });

    if (node.mode === "race") {
      const winner = await Promise.race(promises);
      // Merge winner's output back into parent state
      if (winner.outputKey) state[winner.outputKey] = winner.output;
      return { output: winner };
    }

    const results = await Promise.all(promises);
    // Merge all branch outputs back into parent state
    for (const r of results) {
      if (r.outputKey) state[r.outputKey] = r.output;
    }
    return {
      output: Object.fromEntries(results.map((r) => [r.name, r.output])),
    };
  }

  // ---- do: http -----------------------------------------------------------------

  private async execHttp(
    node: HttpNode,
    state: FlowState,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    const url = node.url; // template already interpolated by resolveNodeFields
    const method = node.method ?? "GET";
    let body: string | undefined;
    if (node.body) {
      if (typeof node.body === "string") {
        body = this.resolveTemplate(node.body, state);
      } else {
        // Deep-resolve templates in the body object, preserving types.
        // This avoids double-encoding when a template resolves to an object/array.
        body = JSON.stringify(this.resolveBodyObject(node.body, state));
      }
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (node.headers) {
      // values already interpolated by resolveNodeFields (templateEach)
      Object.assign(headers, node.headers);
    }
    const resp = await fetch(url, { method, headers, body, signal });
    const text = await resp.text();
    try {
      return { output: JSON.parse(text) };
    } catch {
      return { output: text };
    }
  }

  // ---- do: <custom step> --------------------------------------------------------

  private async execCustomStep(
    node: FlowNode,
    def: CustomStepDefinition,
    state: FlowState,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    // Build the input view: every declared field, with templates pre-resolved
    // (mirrors do: http for url/body/headers). Non-string scalars pass through.
    const input: Record<string, unknown> = {};
    const raw = node as unknown as Record<string, unknown>;
    for (const field of def.allowedKeys) {
      const value = raw[field];
      if (value === undefined) continue;
      input[field] = this.resolveBodyObject(value, state);
    }

    const env = (state.env && typeof state.env === "object")
      ? (state.env as Record<string, string>)
      : {};
    const logPrefix = `[${node.name}:${def.name}]`;
    const ctx: CustomStepContext = {
      state: this.deepFreeze(JSON.parse(JSON.stringify(state))),
      env,
      logger: {
        debug: (msg, ...rest) => console.debug(logPrefix, msg, ...rest),
        info: (msg, ...rest) => console.info(logPrefix, msg, ...rest),
        warn: (msg, ...rest) => console.warn(logPrefix, msg, ...rest),
        error: (msg, ...rest) => console.error(logPrefix, msg, ...rest),
      },
      // Aborts when the run is cancelled or this attempt times out.
      abortSignal: signal,
      nodeName: node.name,
      resolveTemplate: (template: string) => this.resolveTemplate(template, state),
    };

    const output = await def.run(input, ctx);
    return { output };
  }

  // ---- do: memory ---------------------------------------------------------------

  private execMemory(
    node: MemoryNode,
    state: FlowState,
  ): { output: unknown } {
    const dir =
      this.cfg.memoryDir ??
      path.join(
        process.env.OPENCLAW_WORKSPACE ?? process.env.HOME ?? ".",
        "flow-memory",
      );
    fs.mkdirSync(dir, { recursive: true });
    // key/value templates already interpolated by resolveNodeFields
    const key = node.key.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = path.join(dir, `${key}.json`);

    if (node.action === "write") {
      const value = node.value ?? undefined;
      fs.writeFileSync(
        file,
        JSON.stringify({ key, value, ts: Date.now() }, null, 2),
      );
      return { output: value };
    }
    if (node.action === "delete") {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { output: null };
    }
    // read
    if (!fs.existsSync(file)) return { output: null };
    return {
      output: (JSON.parse(fs.readFileSync(file, "utf8")) as { value: unknown })
        .value,
    };
  }

  // ---- do: wait -----------------------------------------------------------------
  // Two modes:
  //   for: approval -> human-in-the-loop gate with token, preview, registry
  //   for: event    -> register on eventBus and await sendEvent() call

  private async execWait(
    node: WaitNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{
    output?: unknown;
    pause?: boolean;
    approve?: { token: string; prompt: string; preview?: unknown; timeout?: string };
  }> {
    if (node.for === "approval") {
      // prompt template already interpolated by resolveNodeFields
      const prompt = node.prompt ?? `Approve node "${node.name}"?`;
      const timeout = node.timeout ?? "24h";
      const expiresAt = new Date(
        Date.now() + parseDuration(timeout),
      ).toISOString();

      // Resolve preview data if specified
      let preview: unknown;
      if (node.preview) {
        const previewExpr = node.preview.includes("{{")
          ? node.preview
          : `{{ ${node.preview} }}`;
        preview = this.resolveBodyObject(previewExpr, state);
      }

      // Generate approval token and register
      const token = `cf-${crypto.randomUUID().slice(0, 8)}`;
      this.store.addApproval({
        token,
        instanceId,
        flowName: flow.flow,
        node: node.name,
        prompt,
        preview,
        createdAt: new Date().toISOString(),
        expiresAt,
      });

      return {
        approve: { token, prompt, preview, timeout },
      };
    }

    // for: event -- wait for external sendEvent() call
    if (node.for === "event") {
      const eventType = node.event ?? "event";
      const timeoutMs = node.timeout
        ? parseDuration(node.timeout)
        : 24 * 3_600_000; // 24h default

      const payload = await new Promise<unknown>((resolve, reject) => {
        // Cancelling the run (or this attempt timing out) drops the waiter.
        const onAbort = () => {
          clearTimeout(timeoutHandle);
          eventBus.get(instanceId)?.delete(eventType);
          reject(abortReason(signal));
        };
        const timeoutHandle = setTimeout(
          () => {
            signal.removeEventListener("abort", onAbort);
            reject(
              new Error(
                `wait "${node.name}" timed out waiting for event "${eventType}"`,
              ),
            );
          },
          timeoutMs,
        );
        if (!eventBus.has(instanceId))
          eventBus.set(instanceId, new Map());
        eventBus.get(instanceId)!.set(eventType, {
          resolve: (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject,
          timeoutHandle,
        });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });

      eventBus.get(instanceId)?.delete(eventType);
      return { output: payload };
    }

    return { output: null };
  }

  // ---- do: sleep ----------------------------------------------------------------

  private async execSleep(node: SleepNode, signal: AbortSignal): Promise<{ output: null }> {
    await abortableDelay(parseDuration(node.duration), signal);
    return { output: null };
  }

  // ---- do: code -----------------------------------------------------------------

  /** Detect multi-statement code (contains ; or newline outside of string literals). */
  private isMultiStatement(code: string): boolean {
    // An IIFE like (function(){ ...; return x; })() is a single expression
    // even though it contains semicolons internally — don't flag it.
    const trimmed = code.trim();
    if (/^\(function\s*\(/.test(trimmed) && /\}\s*\)\s*\(\s*\)$/.test(trimmed)) {
      return false;
    }
    const stripped = code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
    return stripped.includes(";") || stripped.includes("\n");
  }

  /** Recursively freeze an object tree so code nodes cannot mutate state. */
  private deepFreeze<T>(obj: T): T {
    if (obj !== null && typeof obj === "object" && !Object.isFrozen(obj)) {
      Object.freeze(obj);
      for (const v of Object.values(obj as Record<string, unknown>)) {
        this.deepFreeze(v);
      }
    }
    return obj;
  }

  private execCode(node: CodeNode, state: FlowState): { output: unknown } {
    // Support both plain dotted paths ("plan.field") and template syntax ("{{ plan.field }}")
    const rawInput = node.input ? this.resolveBodyObject(node.input, state) : undefined;
    const input = typeof rawInput === "string"
      ? this.getPath(state, rawInput)
      : rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? this.resolveCodeInputObject(rawInput as Record<string, unknown>, state)
        : rawInput;

    const multiStatement = this.isMultiStatement(node.run);
    const body = multiStatement
      ? `"use strict"; ${node.run}`
      : `"use strict"; return (${node.run});`;

    // eslint-disable-next-line no-new-func
    let fn: Function;
    try {
      fn = new Function("input", "state", body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let hint = "";
      if (!multiStatement && /require\s*\(/.test(node.run)) {
        hint = " Hint: require() is not available in code nodes.";
      } else if (!multiStatement && /(const|let|var)\s+\w+/.test(node.run)) {
        hint =
          " Hint: declarations like const/let/var need multi-statement mode — add a semicolon or newline and use an explicit return.";
      } else if (!multiStatement) {
        hint =
          ' Hint: if your code has multiple statements, separate them with semicolons and use an explicit "return".';
      }
      throw new Error(
        `code "${node.name}": syntax error — ${msg}.${hint}`,
      );
    }

    const frozenState = this.deepFreeze(JSON.parse(JSON.stringify(state)));
    const frozenInput =
      input !== undefined
        ? this.deepFreeze(JSON.parse(JSON.stringify(input)))
        : undefined;

    // Wrap input in a diagnostic Proxy that reports available keys on undefined access
    const diagnosticInput = frozenInput !== undefined && frozenInput !== null && typeof frozenInput === "object"
      ? this.wrapWithDiagnosticProxy(frozenInput as Record<string, unknown>, node.name, state)
      : frozenInput;

    try {
      return { output: fn(diagnosticInput, frozenState) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let hint = "";
      if (/is not a function/.test(msg) && /require/.test(node.run)) {
        hint = " Hint: require() is not available in code nodes.";
      } else if (/read only|Cannot assign|Cannot add/i.test(msg)) {
        hint =
          " Hint: state and input are frozen — return new values instead of mutating.";
      } else if (/Cannot read propert|undefined is not an object/i.test(msg)) {
        hint = this.buildStateHint(input, state);
      }
      throw new Error(
        `code "${node.name}": runtime error — ${msg}.${hint}`,
      );
    }
  }

  /**
   * Wrap an object-style input with a Proxy that throws a descriptive error
   * when the code accesses a property that doesn't exist, showing what keys
   * ARE available in input and in state.inputs.
   */
  private wrapWithDiagnosticProxy(
    obj: Record<string, unknown>,
    nodeName: string,
    state: FlowState,
  ): Record<string, unknown> {
    const inputKeys = Object.keys(obj);
    const flowInputKeys =
      state.inputs && typeof state.inputs === "object"
        ? Object.keys(state.inputs as Record<string, unknown>)
        : [];
    const stateKeys = Object.keys(state);

    return new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        const p = String(prop);
        // Skip internal JS access patterns
        if (p === "toJSON" || p === "valueOf" || p === "toString" || p === "constructor") {
          return Reflect.get(target, prop, receiver);
        }
        const parts: string[] = [];
        parts.push(`'${p}' is not a key in input. Input keys: [${inputKeys.join(", ")}].`);
        if (flowInputKeys.includes(p)) {
          parts.push(`Did you mean state.inputs.${p}? It exists in inputs.`);
        } else if (flowInputKeys.length > 0) {
          parts.push(`Flow input keys: [${flowInputKeys.join(", ")}].`);
        }
        if (stateKeys.length > 0) {
          parts.push(`State keys: [${stateKeys.join(", ")}].`);
        }
        throw new Error(parts.join(" "));
      },
    });
  }

  /**
   * Build a hint string showing available keys when a "Cannot read property" error occurs.
   */
  private buildStateHint(input: unknown, state: FlowState): string {
    const parts: string[] = [" Hint:"];
    if (input !== undefined && input !== null && typeof input === "object") {
      parts.push(`Input keys: [${Object.keys(input as Record<string, unknown>).join(", ")}].`);
    } else {
      parts.push("input is " + (input === undefined ? "undefined" : String(input)) + ".");
    }
    const flowInputKeys =
      state.inputs && typeof state.inputs === "object"
        ? Object.keys(state.inputs as Record<string, unknown>)
        : [];
    if (flowInputKeys.length > 0) {
      parts.push(`Flow input keys: [${flowInputKeys.join(", ")}].`);
    }
    parts.push(`State keys: [${Object.keys(state).join(", ")}].`);
    return parts.join(" ");
  }

  /**
   * Resolve an object-style `input` for code nodes.
   * Each string value is resolved as a state path (plain or wildcard).
   * Values already resolved by resolveBodyObject (non-strings) pass through.
   */
  private resolveCodeInputObject(
    obj: Record<string, unknown>,
    state: FlowState,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        // Check for wildcard: path[*] or path[*].field
        const wcMatch = v.match(/^([\w.]+)\[\*\](?:\.([\w.]+))?$/);
        if (wcMatch) {
          const arr = this.getPath(state, wcMatch[1]);
          if (Array.isArray(arr)) {
            result[k] = wcMatch[2]
              ? arr.map((item: unknown) => this.getPath(item, wcMatch[2]))
              : arr;
          } else {
            result[k] = v;
          }
        } else {
          // Plain dotted path
          const resolved = this.getPath(state, v);
          result[k] = resolved !== undefined ? resolved : v;
        }
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  // ---- do: exec ----------------------------------------------------------------
  // Runs a shell command deterministically. No AI involved.

  private async execExec(
    node: ExecNode,
    state: FlowState,
    signal: AbortSignal,
  ): Promise<{ output: unknown }> {
    const { spawn } = await import("child_process");

    // command/cwd templates already interpolated by resolveNodeFields
    const command = node.command;
    const cwd = node.cwd ?? undefined;
    const timeoutMs = node.timeout ? parseDuration(node.timeout) : (this.cfg.maxNodeDurationMs ?? 30_000);
    const maxBuffer = 10 * 1024 * 1024; // 10MB
    if (signal.aborted) throw abortReason(signal);

    // The shell gets a process group of its own, and a cancel, the step's
    // timeout or too much output stops the whole group. Signalling only the
    // shell left the command running: dash, /bin/sh on Debian and Ubuntu, forks
    // a command rather than replacing itself with it.
    const ownGroup = process.platform !== "win32";
    return new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, cwd, detached: ownGroup, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let settled = false;
      const stopGroup = () => {
        try {
          if (ownGroup && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // already gone
        }
      };
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        done();
      };
      const fail = (reason: Error) => {
        stopGroup();
        settle(() => reject(reason));
      };
      const onAbort = () => fail(abortReason(signal));
      const timer = setTimeout(
        () => fail(new Error(`exec "${node.name}" failed: timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      signal.addEventListener("abort", onAbort, { once: true });
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBuffer) fail(new Error(`exec "${node.name}" failed: output exceeded ${maxBuffer} bytes`));
        else into.push(chunk);
      };
      child.stdout!.on("data", collect(out));
      child.stderr!.on("data", collect(err));
      child.on("error", (e) => settle(() => reject(new Error(`exec "${node.name}" failed: ${e.message}`))));
      child.on("close", (code, sig) =>
        settle(() => {
          if (code === null) {
            reject(new Error(`exec "${node.name}" failed: the shell was killed by ${sig}`));
            return;
          }
          // Non-zero exit is not a runtime error: return the result with exitCode
          resolve({
            output: {
              stdout: Buffer.concat(out).toString("utf8").trimEnd(),
              stderr: Buffer.concat(err).toString("utf8").trimEnd(),
              exitCode: code,
            },
          });
        }),
      );
    });
  }

  // ---- Template helpers ---------------------------------------------------------

  // Interpolate a node's `template`/`templateEach` fields against state, returning a
  // shallow clone with those fields resolved (or the original node when nothing is
  // dynamic). Every other mode — path, expr, children, templateDeep, code, literal —
  // is passed through: its handler owns resolution, because timing (loop iteration
  // state), type preservation (deep bodies), or "never interpolate" (code) matter.
  // Custom steps have no entry here; execCustomStep resolves their fields itself.
  private resolveNodeFields(node: FlowNode, state: FlowState): FlowNode {
    const modes = NODE_FIELD_MODES[node.do];
    if (!modes) return node;
    const raw = node as unknown as Record<string, unknown>;
    let clone: Record<string, unknown> | undefined;
    const patch = (field: string, value: unknown) => {
      (clone ??= { ...raw })[field] = value;
    };
    for (const [field, mode] of Object.entries(modes)) {
      const val = raw[field];
      if (val === undefined) continue;
      if (mode === "template") {
        if (typeof val === "string") patch(field, this.resolveTemplate(val, state));
      } else if (mode === "templateEach") {
        if (Array.isArray(val)) {
          patch(field, val.map((v) => (typeof v === "string" ? this.resolveTemplate(v, state) : v)));
        } else if (val !== null && typeof val === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(val)) {
            out[k] = typeof v === "string" ? this.resolveTemplate(v, state) : v;
          }
          patch(field, out);
        }
      }
    }
    return (clone ?? raw) as unknown as FlowNode;
  }

  // Deep-resolve templates in an object, preserving types.
  // If a value is a pure template like "{{ foo.bar }}" and resolves to an
  // object/array, the resolved value replaces the string (no double-encoding).
  private resolveBodyObject(obj: unknown, state: FlowState): unknown {
    if (typeof obj === "string") {
      // Check if the entire string is a single template expression
      const singleMatch = obj.match(/^\{\{\s*([\w.\[\]0-9]+)\s*(?:\|\s*(\w+))?\s*\}\}$/);
      if (singleMatch) {
        const val = this.getPath(state, singleMatch[1]);
        if (val === undefined) return obj;
        return singleMatch[2] ? applyFilter(val, singleMatch[2]) : val;
      }
      // Check for wildcard: {{ path[*].field }}
      const wildcardMatch = obj.match(/^\{\{\s*([\w.]+)\[\*\](?:\.([\w.]+))?\s*\}\}$/);
      if (wildcardMatch) {
        const arr = this.getPath(state, wildcardMatch[1]);
        if (!Array.isArray(arr)) return obj;
        return wildcardMatch[2]
          ? arr.map((item: unknown) => this.getPath(item, wildcardMatch[2]))
          : arr;
      }
      // Whole-string OR-chain fallback: {{ a || b || 'default' }} — type-preserving
      // (mirrors the single-path branch above; e.g. {{ n || 0 }} stays a number).
      const orMatch = obj.match(/^\{\{\s*([^{}?]+?\|\|[^{}?]+?)\s*\}\}$/);
      if (orMatch) {
        return this.resolveOrChain(orMatch[1], state);
      }
      return this.resolveTemplate(obj, state);
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.resolveBodyObject(item, state));
    }
    if (obj !== null && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = this.resolveBodyObject(v, state);
      }
      return result;
    }
    return obj;
  }

  resolveTemplate(template: string, state: FlowState): string {
    // Pass 1: ternary expressions  {{ expr ? val1 : val2 }}
    // Supports: ==, !=, >, <, >=, <=  with string or number literals
    let result = template.replace(
      /\{\{\s*(.+?)\s*\?\s*(.+?)\s*:\s*(.+?)\s*\}\}/g,
      (_m, condExpr: string, thenExpr: string, elseExpr: string) => {
        const condResult = this.evalTemplateCondition(condExpr.trim(), state);
        const chosen = condResult ? thenExpr.trim() : elseExpr.trim();
        // Chosen value: strip surrounding quotes if it's a string literal
        const unquoted = chosen.replace(/^['"](.*)['"]$/, "$1");
        if (unquoted !== chosen) return unquoted;
        // Otherwise resolve as a path
        const val = this.getPath(state, chosen);
        return val !== undefined
          ? (typeof val === "object" ? JSON.stringify(val) : String(val))
          : chosen;
      },
    );

    // Pass 2: OR-chain fallback  {{ a || b || 'default' }}  (JS || semantics:
    // first truthy operand, else the last). Runs after ternary so `?` exprs are
    // already consumed; excludes `?`/braces so it never straddles a ternary.
    result = result.replace(
      /\{\{\s*([^{}?]+?\|\|[^{}?]+?)\s*\}\}/g,
      (_m, expr: string) => {
        const val = this.resolveOrChain(expr, state);
        if (val === undefined || val === null) return "";
        return typeof val === "object" ? JSON.stringify(val) : String(val);
      },
    );

    // Pass 3: wildcard  {{ path[*].field }}
    result = result.replace(
      /\{\{\s*([\w.]+)\[\*\](?:\.([\w.]+))?\s*\}\}/g,
      (_m, arrPath: string, field?: string) => {
        const arr = this.getPath(state, arrPath);
        if (!Array.isArray(arr)) return `{{${arrPath}[*]${field ? "." + field : ""}}}`;
        const mapped = field ? arr.map((item: unknown) => this.getPath(item, field)) : arr;
        return JSON.stringify(mapped);
      },
    );

    // Pass 4: simple path + optional filter  {{ path | filter }}
    result = result.replace(/\{\{\s*([\w.\[\]0-9]+)\s*(?:\|\s*(\w+))?\s*\}\}/g, (_m, p: string, filter?: string) => {
      const val = this.getPath(state, p);
      if (val === undefined) return `{{${p}}}`;
      if (filter) return String(applyFilter(val, filter));
      return typeof val === "object" ? JSON.stringify(val) : String(val);
    });

    return result;
  }

  /**
   * Resolve a `a || b || 'default'` chain, returning the first truthy operand's
   * value (JS `||` semantics; all-falsy → the last operand's value). Type is
   * preserved so `{{ n || 0 }}` yields the number 0, `{{ x || 'y' }}` a string.
   */
  private resolveOrChain(expr: string, state: FlowState): unknown {
    const operands = expr.split("||");
    let last: unknown;
    for (const operand of operands) {
      last = this.resolveOperand(operand, state);
      if (last) return last;
    }
    return last;
  }

  /**
   * Resolve a single template operand: a quoted string literal, a numeric /
   * boolean / null literal, or otherwise a state path.
   */
  private resolveOperand(operand: string, state: FlowState): unknown {
    const t = operand.trim();
    const str = t.match(/^'([^']*)'$/) ?? t.match(/^"([^"]*)"$/);
    if (str) return str[1];
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (t !== "" && !isNaN(Number(t))) return Number(t);
    return this.getPath(state, t);
  }

  /** Evaluate a simple condition expression for ternary templates */
  private evalTemplateCondition(expr: string, state: FlowState): boolean {
    // Match: path op value  (e.g. sheet.type == 'diametri')
    const m = expr.match(/^([\w.\[\]0-9]+)\s*(==|!=|>=?|<=?)\s*(.+)$/);
    if (!m) {
      // Bare truthy check: {{ flag ? 'yes' : 'no' }}
      const val = this.getPath(state, expr);
      return !!val;
    }
    const [, pathStr, op, rawRight] = m;
    const left = this.getPath(state, pathStr.trim());
    // Parse right side: string literal or number or path
    let right: unknown;
    const strMatch = rawRight.trim().match(/^['"](.*)['"]$/);
    if (strMatch) {
      right = strMatch[1];
    } else if (!isNaN(Number(rawRight.trim()))) {
      right = Number(rawRight.trim());
    } else {
      right = this.getPath(state, rawRight.trim());
    }
    switch (op) {
      case "==": return left == right;
      case "!=": return left != right;
      case ">": return (left as number) > (right as number);
      case "<": return (left as number) < (right as number);
      case ">=": return (left as number) >= (right as number);
      case "<=": return (left as number) <= (right as number);
      default: return false;
    }
  }

  getPath(obj: unknown, dotPath: string): unknown {
    // Split "business[0].name" into segments: ["business", "[0]", "name"]
    const segments = dotPath.split(/\./).flatMap((key) => {
      // Split "business[0]" into ["business", "0"]
      const parts: string[] = [];
      const m = key.match(/^([^\[]*)((?:\[\d+\])*)$/);
      if (m) {
        if (m[1]) parts.push(m[1]);
        // Extract each [N] index
        const indices = m[2].match(/\[(\d+)\]/g);
        if (indices) {
          for (const idx of indices) {
            parts.push(idx.slice(1, -1)); // strip [ and ]
          }
        }
      } else {
        parts.push(key);
      }
      return parts;
    });
    return segments.reduce((cur, key) => {
      if (cur == null || typeof cur !== "object") return undefined;
      if (Array.isArray(cur)) {
        const idx = Number(key);
        return Number.isInteger(idx) ? cur[idx] : undefined;
      }
      return (cur as Record<string, unknown>)[key];
    }, obj);
  }

  // ---- Instance management ------------------------------------------------------

  getStore(): StateStore {
    return this.store;
  }

  /** List all pending approvals across all flow instances */
  listApprovals() {
    return this.store.listApprovals();
  }
}

/** The OpenClaw session a run was started from (the flow_run tool's caller). */
export interface CallerSession {
  sessionKey?: string;
  sessionId?: string;
}

/** The session key an agent step's turn runs in, resolved the way OpenClaw
 *  routes `openclaw agent`. Keys are lower-cased, and a key without the
 *  `agent:` prefix is scoped by the step's agent (session-store-key.ts,
 *  canonicalizeSessionKeyForAgent). A step with neither a key nor a session id
 *  runs in its agent's main session, `agent:<agent>:<session.mainKey>`, the
 *  main key defaulting to "main" (agent-request-routing.ts →
 *  resolveExplicitAgentSessionKey). Undefined for a step that names only a
 *  session id, which is matched by id instead. */
export function agentStepSessionKey(
  target: { agent?: string; sessionKey?: string; sessionId?: string },
  defaultAgent?: string,
  mainKey?: string,
): string | undefined {
  const agent = (target.agent ?? defaultAgent ?? "main").toLowerCase();
  if (target.sessionKey) {
    const raw = target.sessionKey.toLowerCase();
    return raw.startsWith("agent:") ? raw : `agent:${agent}:${raw}`;
  }
  if (target.sessionId) return undefined;
  return `agent:${agent}:${(mainKey || "main").toLowerCase()}`;
}

/** Whether an agent step's resolved target is the caller's own session. */
export function targetsCallerSession(
  target: { agent?: string; sessionKey?: string; sessionId?: string },
  caller: CallerSession,
  defaultAgent?: string,
  mainKey?: string,
): boolean {
  if (target.sessionId && caller.sessionId && target.sessionId === caller.sessionId) return true;
  const key = agentStepSessionKey(target, defaultAgent, mainKey);
  return Boolean(key && caller.sessionKey) && key === caller.sessionKey!.toLowerCase();
}

/** What cancel() did. "cancelling" means the run was aborted but had not ended
 *  within the bound (a host that never yields); it ends as cancelled. */
export type CancelResult =
  | { ok: true; instanceId: string; status: "cancelled" | "cancelling" }
  | { ok: false; instanceId: string; error: "not_found" }
  | { ok: false; instanceId: string; error: "finished"; status: FlowStatus };

const FINISHED_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);
