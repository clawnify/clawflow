// ---- Agent invoker --------------------------------------------------------------
// The `agent` node delegates a task to a real agent runtime. Which runtime — and
// how it is reached — is a harness concern, not a flow concern, so the runner
// talks to this interface and the harness supplies the implementation. The
// default is the OpenClaw CLI; other harnesses (e.g. Hermes) provide their own
// via PluginConfig.agentInvoker.

/** Selector for which agent/session receives the message. Field names follow
 * the OpenClaw CLI selectors (the format's reference harness); other invokers
 * map them to their runtime's nearest equivalent. */
export interface AgentTarget {
  /** Configured agent slug (e.g. "main"). */
  agent?: string;
  /** Exact session key (e.g. "agent:main:slack:channel:agent"). */
  sessionKey?: string;
  /** Explicit session id — the most specific selector. */
  sessionId?: string;
  /** Delivery channel for the agent's reply. */
  channel?: string;
}

export interface AgentInvokeOptions {
  /** Hard timeout for the invocation, in milliseconds. */
  timeoutMs: number;
  /** Flow-level env vars (state.env) to expose to the invocation. */
  env?: Record<string, string>;
}

export interface AgentInvoker {
  /** Run one agent turn and return the agent's reply as text. */
  invoke(
    message: string,
    target: AgentTarget,
    opts: AgentInvokeOptions,
  ): Promise<string>;
}

// ---- Default implementation: OpenClaw CLI ---------------------------------------

export class OpenClawCliInvoker implements AgentInvoker {
  constructor(private opts: { defaultAgent?: string } = {}) {}

  // Build the `openclaw agent` selector args from the target. Mirrors
  // OpenClaw's own selectors, which compose:
  //   --agent <id>         scopes to a configured agent
  //   --session-key <key>  an exact session key (agent:<id>:<key>, or scoped to --agent)
  //   --session-id <id>    the most specific: one explicit session (scoped by --agent)
  //   --channel <channel>  delivery channel for the reply
  // We pass through whichever are set and let OpenClaw resolve/enforce consistency
  // rather than re-asserting it here. When no target selector is set at all, fall
  // back to a configured agent (defaultAgent > "main") so the call is routable.
  private buildArgs(target: AgentTarget): string[] {
    const { agent, sessionKey, sessionId, channel } = target;
    const args: string[] = [];
    if (agent) args.push("--agent", agent);
    if (sessionKey) args.push("--session-key", sessionKey);
    if (sessionId) args.push("--session-id", sessionId);
    if (channel) args.push("--channel", channel);
    if (!agent && !sessionKey && !sessionId) {
      args.push("--agent", this.opts.defaultAgent ?? "main");
    }
    return args;
  }

  async invoke(
    message: string,
    target: AgentTarget,
    opts: AgentInvokeOptions,
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

    const args = ["agent", ...this.buildArgs(target), "--message", message];

    // Merge flow-level env vars into the child process environment.
    // Set CLAWFLOW_NO_SERVE to prevent the child from binding the webhook port.
    const env = {
      ...process.env,
      ...(opts.env ?? {}),
      CLAWFLOW_NO_SERVE: "1",
    };

    try {
      const { stdout } = await execFileAsync("openclaw", args, {
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env,
      });
      return stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`openclaw agent failed: ${msg}`);
    }
  }
}
