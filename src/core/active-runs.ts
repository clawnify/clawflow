// ---- Live runs -----------------------------------------------------------------
// The runs executing in this process, each with the controller that cancels it.
//
// Held on `globalThis` under a registered symbol, like the step registry
// (custom-steps.ts), not as a module or runner field. A host may call the
// plugin's register() more than once per process, and each call builds its own
// FlowRunner, while the flow server keeps the runner it was started with. So a
// run started by one runner (flow_run, a schedule) and a cancel arriving through
// another (the flow server, flow_cancel) must still find each other, whatever
// path ClawFlow was imported from.

export interface LiveRun {
  /** Aborted to cancel the run: every step in it receives this signal. */
  controller: AbortController;
  flowName: string;
  /** Settles when the run stops executing in this process. */
  done?: Promise<unknown>;
}

const LIVE_RUNS_KEY = Symbol.for("@clawnify/clawflow/live-runs");
type LiveRunsHolder = { [LIVE_RUNS_KEY]?: Map<string, LiveRun> };
const holder = globalThis as unknown as LiveRunsHolder;

/** Storage identity + instanceId -> live state, for runs in this process. */
export const liveRuns: Map<string, LiveRun> = holder[LIVE_RUNS_KEY] ?? (holder[LIVE_RUNS_KEY] = new Map());

/** The error a cancelled step and run end with. */
export class FlowCancelledError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "FlowCancelledError";
  }
}

/**
 * A controller that aborts when `parent` does, plus a function that detaches it.
 * Each attempt of a step gets one, so the step's own timeout can abort its work
 * without cancelling the run. (AbortSignal.any needs Node 20.3; this works on 18.)
 */
export function childController(parent: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, dispose: () => {} };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return { controller, dispose: () => parent.removeEventListener("abort", onAbort) };
}

/** Resolve after `ms`, or reject at once with the signal's reason when it aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The reason a signal aborted, as an Error. */
export function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new FlowCancelledError();
}
