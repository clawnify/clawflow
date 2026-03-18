import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import {
  FlowDefinition, FlowNode, FlowState, FlowResult, TraceEntry,
  PluginConfig, MODEL_MAP, DEFAULT_MODEL, RetryPolicy,
  AiNode, AgentNode, BranchNode, LoopNode, ParallelNode,
  HttpNode, MemoryNode, WaitNode, SleepNode, CodeNode,
  parseDuration,
} from "./types.js";
import { StateStore } from "./store.js";

// ─── Event Bus ────────────────────────────────────────────────────────────────
// External systems call sendEvent(instanceId, type, payload) to unblock
// flows waiting with do: wait / for: event.
// Maps instanceId → pending resolve functions keyed by event type.

type EventWaiter = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};
const eventBus = new Map<string, Map<string, EventWaiter>>();

export function sendEvent(instanceId: string, eventType: string, payload: unknown): boolean {
  const waiters = eventBus.get(instanceId);
  if (!waiters) return false;
  const waiter = waiters.get(eventType);
  if (!waiter) return false;
  clearTimeout(waiter.timeoutHandle);
  waiters.delete(eventType);
  waiter.resolve(payload);
  return true;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export class FlowRunner {
  private cfg: PluginConfig;
  private store: StateStore;

  constructor(cfg: PluginConfig) {
    this.cfg = cfg;
    this.store = new StateStore(cfg.stateDir);
  }

  // ── Start a new run ─────────────────────────────────────────────────────────

  async run(
    flow: FlowDefinition,
    input: unknown,
    instanceId?: string,
  ): Promise<FlowResult> {
    const id = instanceId ?? crypto.randomUUID();
    const state: FlowState = { trigger: input };
    this.store.create(id, flow.flow, state);
    return this.execute(flow, state, id, 0, []);
  }

  // ── Resume after approval or event ──────────────────────────────────────────

  async resume(
    token: string,
    approvedOrPayload: boolean | unknown,
  ): Promise<FlowResult> {
    // token is instanceId for approval; for events use sendEvent() directly
    const record = this.store.get(token);
    if (!record) throw new Error(`Resume token not found: ${token}`);
    if (record.status !== "paused" && record.status !== "waiting") {
      throw new Error(`Instance "${token}" is not paused (status: ${record.status})`);
    }

    if (typeof approvedOrPayload === "boolean" && !approvedOrPayload) {
      this.store.update(token, { status: "cancelled" });
      return {
        ok: true, status: "cancelled", flowName: record.flowName,
        instanceId: token, state: record.state, trace: [],
        error: "Flow cancelled at approval gate",
      };
    }

    this.store.update(token, { status: "running", resumeToken: undefined, waitingFor: undefined });

    // Find the flow definition — it should have been provided at run time.
    // For now callers must pass it back in; future: store flow definition in record.
    throw new Error("resume() requires the flow definition. Use resumeFlow() instead.");
  }

  async resumeFlow(
    token: string,
    flow: FlowDefinition,
    approvedOrPayload: boolean | unknown = true,
  ): Promise<FlowResult> {
    const record = this.store.get(token);
    if (!record) throw new Error(`Resume token not found: ${token}`);

    if (typeof approvedOrPayload === "boolean" && !approvedOrPayload) {
      this.store.update(token, { status: "cancelled" });
      return {
        ok: true, status: "cancelled", flowName: record.flowName,
        instanceId: token, state: record.state, trace: [],
        error: "Flow cancelled",
      };
    }

    this.store.update(token, { status: "running", resumeToken: undefined, waitingFor: undefined });

    // Re-run from the beginning — memoized nodes skip automatically
    return this.execute(flow, record.state, token, 0, []);
  }

  // ── Core execution loop ─────────────────────────────────────────────────────

  private async execute(
    flow: FlowDefinition,
    state: FlowState,
    instanceId: string,
    startIndex: number,
    priorTrace: TraceEntry[],
  ): Promise<FlowResult> {
    const trace: TraceEntry[] = [...priorTrace];
    const nodes = flow.nodes;
    let i = startIndex;

    while (i < nodes.length) {
      const node = nodes[i];
      const t0 = Date.now();

      // ── Durable memoization: skip already-completed nodes ────────────────────
      const memo = this.store.getMemoized(instanceId, node.name);
      if (memo.found) {
        if (node.output) state[node.output] = memo.output;
        trace.push({
          node: node.name, do: node.do, status: "ok",
          output: memo.output, durationMs: 0,
        });
        i++;
        continue;
      }

      try {
        const result = await this.runWithRetry(node, state, flow, instanceId);

        // ── Paused for approval ──────────────────────────────────────────────
        if (result.pause) {
          const waitNode = node as WaitNode;
          this.store.update(instanceId, {
            status: waitNode.for === "event" ? "waiting" : "paused",
            state,
            resumeToken: instanceId,  // instanceId IS the resume token
            waitingFor: {
              type: waitNode.for,
              event: waitNode.event,
              prompt: waitNode.prompt
                ? this.resolveTemplate(waitNode.prompt, state)
                : `Approve node "${node.name}"?`,
              timeout: waitNode.timeout,
            },
          });
          trace.push({ node: node.name, do: node.do, status: "paused", durationMs: Date.now() - t0 });
          return {
            ok: true,
            status: waitNode.for === "event" ? "waiting" : "paused",
            flowName: flow.flow, instanceId, state, trace,
            pausedAt: node.name,
            resumeToken: instanceId,
            waitingFor: this.store.get(instanceId)?.waitingFor,
          };
        }

        // ── Branch jump ─────────────────────────────────────────────────────
        if (result.jump) {
          const targetIndex = nodes.findIndex((n) => n.name === result.jump);
          if (targetIndex === -1) throw new Error(`Branch target "${result.jump}" not found`);
          if (node.output) state[node.output] = result.output;
          this.store.memoize(instanceId, node.name, result.output);
          this.store.update(instanceId, { state });
          trace.push({ node: node.name, do: node.do, status: "ok", output: result.output, durationMs: Date.now() - t0 });
          i = targetIndex;
          continue;
        }

        // ── Normal completion ────────────────────────────────────────────────
        if (node.output) state[node.output] = result.output;
        this.store.memoize(instanceId, node.name, result.output);
        this.store.update(instanceId, { state });
        trace.push({
          node: node.name, do: node.do, status: "ok",
          output: result.output, attempt: result.attempts,
          durationMs: Date.now() - t0,
        });
        i++;

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.store.update(instanceId, { status: "failed", state });
        trace.push({ node: node.name, do: node.do, status: "error", error: message, durationMs: Date.now() - t0 });
        return { ok: false, status: "failed", flowName: flow.flow, instanceId, state, trace, error: `Node "${node.name}": ${message}` };
      }
    }

    this.store.update(instanceId, { status: "completed", state });
    return { ok: true, status: "completed", flowName: flow.flow, instanceId, state, trace };
  }

  // ── Retry wrapper ────────────────────────────────────────────────────────────
  // Learned directly from Cloudflare WorkflowStepConfig retry semantics.

  private async runWithRetry(
    node: FlowNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
  ): Promise<{ output?: unknown; jump?: string; pause?: boolean; attempts?: number }> {
    const policy: RetryPolicy = node.retry ?? { limit: 1, delay: 0 };
    const nodeTimeoutMs = node.timeout
      ? parseDuration(node.timeout)
      : (this.cfg.maxNodeDurationMs ?? 30_000);

    let lastError: Error = new Error("Unknown error");

    for (let attempt = 1; attempt <= policy.limit; attempt++) {
      try {
        const work = this.execNode(node, state, flow, instanceId);
        const result = await Promise.race([
          work,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Node "${node.name}" timed out after ${nodeTimeoutMs}ms`)), nodeTimeoutMs),
          ),
        ]);
        return { ...result, attempts: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < policy.limit) {
          const delayMs = this.calcDelay(policy, attempt);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastError;
  }

  private calcDelay(policy: RetryPolicy, attempt: number): number {
    const base = parseDuration(policy.delay);
    if (policy.backoff === "exponential") return base * Math.pow(2, attempt - 1);
    if (policy.backoff === "linear") return base * attempt;
    return base; // constant (default)
  }

  // ── Node dispatcher ──────────────────────────────────────────────────────────

  private async execNode(
    node: FlowNode,
    state: FlowState,
    flow: FlowDefinition,
    instanceId: string,
  ): Promise<{ output?: unknown; jump?: string; pause?: boolean }> {
    switch (node.do) {
      case "ai":       return this.execAi(node as AiNode, state);
      case "agent":    return this.execAgent(node as AgentNode, state);
      case "branch":   return this.execBranch(node as BranchNode, state);
      case "loop":     return this.execLoop(node as LoopNode, state, flow);
      case "parallel": return this.execParallel(node as ParallelNode, state, flow, instanceId);
      case "http":     return this.execHttp(node as HttpNode, state);
      case "memory":   return this.execMemory(node as MemoryNode, state);
      case "wait":     return this.execWait(node as WaitNode, state, instanceId);
      case "sleep":    return this.execSleep(node as SleepNode);
      case "code":     return this.execCode(node as CodeNode, state);
      default:         throw new Error(`Unknown node type: "${(node as FlowNode).do}"`);
    }
  }

  // ── do: ai ──────────────────────────────────────────────────────────────────

  private async execAi(node: AiNode, state: FlowState): Promise<{ output: unknown }> {
    const apiKey = this.cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("No API key. Set apiKey in plugin config or ANTHROPIC_API_KEY env.");

    const baseUrl = this.cfg.baseUrl ?? "https://api.anthropic.com";
    const model = MODEL_MAP[node.model ?? "smart"] ?? node.model ?? this.cfg.defaultModel ?? DEFAULT_MODEL;

    const input = node.input ? this.getPath(state, node.input) : undefined;
    const prompt = this.resolveTemplate(node.prompt, state);

    const jsonInstructions = node.schema
      ? `\n\nReturn ONLY valid JSON matching exactly this schema (no markdown, no commentary):\n${JSON.stringify(node.schema, null, 2)}`
      : "";

    const userContent = input != null
      ? `${prompt}\n\nInput:\n${typeof input === "object" ? JSON.stringify(input, null, 2) : String(input)}`
      : prompt;

    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: node.temperature ?? 0,
        system: `You are a workflow step. Follow the prompt exactly.${jsonInstructions}`,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!resp.ok) throw new Error(`AI API ${resp.status}: ${await resp.text()}`);

    const data = await resp.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content.find((b) => b.type === "text")?.text ?? "";

    if (node.schema) {
      const clean = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      try { return { output: JSON.parse(clean) }; }
      catch { throw new Error(`ai node "${node.name}" returned invalid JSON: ${text.slice(0, 200)}`); }
    }

    return { output: text.trim() };
  }

  // ── do: agent ────────────────────────────────────────────────────────────────
  // Falls back to a high-capability ai node. Future: delegate to sessions_spawn.

  private async execAgent(node: AgentNode, state: FlowState): Promise<{ output: unknown }> {
    const task = this.resolveTemplate(node.task, state);
    const input = node.input ? this.getPath(state, node.input) : undefined;
    const fullPrompt = input != null
      ? `${task}\n\nContext:\n${typeof input === "object" ? JSON.stringify(input, null, 2) : String(input)}`
      : task;

    return this.execAi({
      ...node, do: "ai",
      prompt: fullPrompt,
      input: undefined,
      model: node.model ?? "best",
      schema: undefined,
    }, state);
  }

  // ── do: branch ───────────────────────────────────────────────────────────────

  private execBranch(node: BranchNode, state: FlowState): { output: unknown; jump: string } {
    const value = String(this.getPath(state, node.on) ?? "");
    const target = node.paths[value] ?? node.default;
    if (!target) throw new Error(`branch "${node.name}": no path for "${value}" and no default`);
    return { output: value, jump: target };
  }

  // ── do: loop ─────────────────────────────────────────────────────────────────

  private async execLoop(node: LoopNode, state: FlowState, flow: FlowDefinition): Promise<{ output: unknown[] }> {
    const items = this.getPath(state, node.over);
    if (!Array.isArray(items)) throw new Error(`loop "${node.name}": "${node.over}" is not an array`);

    const results: unknown[] = [];
    for (const item of items) {
      const loopState: FlowState = { ...state, [node.as]: item };
      const subRunner = new FlowRunner(this.cfg);
      const subFlow: FlowDefinition = { flow: `${flow.flow}:loop:${node.name}`, nodes: node.nodes };
      const result = await subRunner.run(subFlow, loopState.trigger);
      if (!result.ok) throw new Error(`loop iteration failed: ${result.error}`);
      results.push(result.state);
    }
    return { output: results };
  }

  // ── do: parallel ─────────────────────────────────────────────────────────────
  // Learned from Cloudflare Promise.race / Promise.all patterns.

  private async execParallel(
    node: ParallelNode, state: FlowState, flow: FlowDefinition, instanceId: string,
  ): Promise<{ output: unknown }> {
    const subRunner = new FlowRunner(this.cfg);

    const promises = node.nodes.map(async (subNode) => {
      const subFlow: FlowDefinition = { flow: `${flow.flow}:parallel:${node.name}:${subNode.name}`, nodes: [subNode] };
      const result = await subRunner.run(subFlow, state.trigger);
      if (!result.ok) throw new Error(`parallel branch "${subNode.name}" failed: ${result.error}`);
      // Copy sub-results back into parent state
      if (subNode.output) state[subNode.output] = result.state[subNode.output];
      return { name: subNode.name, output: subNode.output ? result.state[subNode.output] : result.state };
    });

    if (node.mode === "race") {
      const winner = await Promise.race(promises);
      return { output: winner };
    }

    const results = await Promise.all(promises);
    return { output: Object.fromEntries(results.map((r) => [r.name, r.output])) };
  }

  // ── do: http ─────────────────────────────────────────────────────────────────

  private async execHttp(node: HttpNode, state: FlowState): Promise<{ output: unknown }> {
    const url = this.resolveTemplate(node.url, state);
    const method = node.method ?? "GET";
    let body: string | undefined;
    if (node.body) {
      body = typeof node.body === "string"
        ? this.resolveTemplate(node.body, state)
        : this.resolveTemplate(JSON.stringify(node.body), state);
    }
    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(node.headers ?? {}) },
      body,
    });
    const text = await resp.text();
    try { return { output: JSON.parse(text) }; } catch { return { output: text }; }
  }

  // ── do: memory ───────────────────────────────────────────────────────────────

  private execMemory(node: MemoryNode, state: FlowState): { output: unknown } {
    const dir = this.cfg.memoryDir ?? path.join(process.env.HOME ?? ".", ".openclaw", "flow-memory");
    fs.mkdirSync(dir, { recursive: true });
    const key = this.resolveTemplate(node.key, state).replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = path.join(dir, `${key}.json`);

    if (node.action === "write") {
      const value = node.value ? this.resolveTemplate(node.value, state) : undefined;
      fs.writeFileSync(file, JSON.stringify({ key, value, ts: Date.now() }, null, 2));
      return { output: value };
    }
    if (node.action === "delete") {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { output: null };
    }
    // read
    if (!fs.existsSync(file)) return { output: null };
    return { output: (JSON.parse(fs.readFileSync(file, "utf8")) as { value: unknown }).value };
  }

  // ── do: wait ─────────────────────────────────────────────────────────────────
  // Two modes:
  //   for: approval → pause and return resume token (human approves)
  //   for: event    → register on eventBus and await sendEvent() call

  private async execWait(
    node: WaitNode, state: FlowState, instanceId: string,
  ): Promise<{ output?: unknown; pause?: boolean }> {
    if (node.for === "approval") {
      return { output: { waitType: "approval", prompt: node.prompt }, pause: true };
    }

    // for: event — wait for external sendEvent() call
    if (node.for === "event") {
      const eventType = node.event ?? "event";
      const timeoutMs = node.timeout ? parseDuration(node.timeout) : 24 * 3_600_000; // 24h default

      const payload = await new Promise<unknown>((resolve, reject) => {
        const timeoutHandle = setTimeout(
          () => reject(new Error(`wait "${node.name}" timed out waiting for event "${eventType}"`)),
          timeoutMs,
        );
        if (!eventBus.has(instanceId)) eventBus.set(instanceId, new Map());
        eventBus.get(instanceId)!.set(eventType, { resolve, reject, timeoutHandle });
      });

      eventBus.get(instanceId)?.delete(eventType);
      return { output: payload };
    }

    return { output: null };
  }

  // ── do: sleep ────────────────────────────────────────────────────────────────
  // Maps directly to Cloudflare step.sleep().

  private async execSleep(node: SleepNode): Promise<{ output: null }> {
    const ms = parseDuration(node.duration);
    await new Promise((r) => setTimeout(r, ms));
    return { output: null };
  }

  // ── do: code ─────────────────────────────────────────────────────────────────

  private execCode(node: CodeNode, state: FlowState): { output: unknown } {
    const input = node.input ? this.getPath(state, node.input) : undefined;
    // eslint-disable-next-line no-new-func
    const fn = new Function("input", "state", `"use strict"; return (${node.run});`);
    return { output: fn(input, state) };
  }

  // ── Template helpers ──────────────────────────────────────────────────────────

  resolveTemplate(template: string, state: FlowState): string {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, p) => {
      const val = this.getPath(state, p);
      return val === undefined ? `{{${p}}}` : typeof val === "object" ? JSON.stringify(val) : String(val);
    });
  }

  getPath(obj: unknown, dotPath: string): unknown {
    return dotPath.split(".").reduce((cur, key) => {
      if (cur == null || typeof cur !== "object") return undefined;
      return (cur as Record<string, unknown>)[key];
    }, obj);
  }

  // ── Instance management ───────────────────────────────────────────────────────

  getStore(): StateStore { return this.store; }
}
