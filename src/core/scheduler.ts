import { randomUUID } from "crypto";
import { Cron } from "croner";

import { resolveRunnableFlow } from "./manage.js";
import type { TriggerStore, TriggerRecord } from "./triggers.js";
import type { FlowDefinition, FlowResult } from "./types.js";

// ---- Trigger Scheduler ----------------------------------------------------------
// Arms one croner timer per enabled trigger record and fires the flow directly
// through the runner — the same path the HTTP flow server takes, so a cron fire,
// a webhook and an agent run all resolve the same definition.
//
// Missed runs are NOT replayed. If the host was down at 09:00 the trigger does
// not fire at boot; it waits for the next occurrence. Replaying side-effecting
// flows after downtime is the worse failure, and croner gives us this for free
// by always scheduling forward from now.

/** Triggers may not fire more often than once a minute. */
const MIN_INTERVAL_MS = 60_000;

export interface SchedulerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface FlowRunnerLike {
  run(
    def: FlowDefinition,
    inputs: unknown,
    instanceId: string,
  ): Promise<FlowResult>;
}

export interface TriggerSchedulerOpts {
  runner: FlowRunnerLike;
  store: TriggerStore;
  workspace: string;
  flowsDir: string;
  logger?: SchedulerLogger;
  /**
   * How often to re-read the trigger records from disk, in ms.
   * Records are also written by out-of-process callers — the Clawnify hook
   * server and dashboard import TriggerStore from dist the same way they read
   * published versions — so the scheduler cannot rely on its own tools being
   * the only writer. Set 0 to disable (tests).
   */
  resyncMs?: number;
}

/**
 * Validate a schedule before it is stored.
 *
 * Triggers are agent-writable, so this is a trust boundary: croner accepts
 * 6-field patterns, and `* * * * * *` on a flow with AI nodes is a runaway cost
 * incident rather than a schedule. Rejects anything firing more than once a
 * minute, and anything croner cannot parse.
 */
export function assertValidSchedule(cron: string, tz?: string): void {
  let first: Date | null;
  let second: Date | null;

  // croner constructs lazily: an invalid timezone surfaces from nextRun(), not
  // from the constructor, so both must be inside the guard.
  try {
    const job = new Cron(cron, { timezone: tz });
    first = job.nextRun();
    second = first ? job.nextRun(first) : null;
  } catch (err) {
    throw new Error(
      `Invalid schedule "${cron}"${tz ? ` (tz ${tz})` : ""}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!first) throw new Error(`Schedule "${cron}" never fires`);

  if (second && second.getTime() - first.getTime() < MIN_INTERVAL_MS) {
    throw new Error(
      `Schedule "${cron}" fires more than once a minute — the minimum interval is 60s`,
    );
  }
}

const DEFAULT_RESYNC_MS = 30_000;

export class TriggerScheduler {
  private jobs = new Map<string, Cron>();
  private armedSpecs = new Map<string, string>();
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: TriggerSchedulerOpts;
  private readonly log: SchedulerLogger;

  constructor(opts: TriggerSchedulerOpts) {
    this.opts = opts;
    this.log = opts.logger ?? {
      info: console.log,
      warn: console.warn,
      error: console.error,
    };
  }

  /** Arm every enabled trigger. Safe to call repeatedly. */
  sync(): void {
    const records = this.opts.store.list({ enabledOnly: true });
    const live = new Set(records.map((r) => r.id));

    for (const [id, job] of this.jobs) {
      if (!live.has(id)) {
        job.stop();
        this.jobs.delete(id);
      }
    }

    for (const record of records) {
      // Re-arm only when the schedule itself changed. Rebuilding an unchanged
      // timer on every resync would reset its countdown and could starve a
      // trigger that fires less often than the resync interval.
      const armed = this.armedSpecs.get(record.id);
      const spec = `${record.cron}|${record.tz ?? ""}`;
      if (armed === spec && this.jobs.has(record.id)) continue;

      this.jobs.get(record.id)?.stop();
      this.jobs.delete(record.id);
      this.arm(record);
      this.armedSpecs.set(record.id, spec);
    }

    for (const id of [...this.armedSpecs.keys()]) {
      if (!live.has(id)) this.armedSpecs.delete(id);
    }
  }

  start(): void {
    this.sync();
    this.log.info(`[clawflow] scheduler armed ${this.jobs.size} trigger(s)`);

    const every = this.opts.resyncMs ?? DEFAULT_RESYNC_MS;
    if (every > 0 && !this.resyncTimer) {
      this.resyncTimer = setInterval(() => {
        try {
          this.sync();
        } catch (err) {
          this.log.error(
            `[clawflow] scheduler resync failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }, every);
      this.resyncTimer.unref?.();
    }
  }

  stop(): void {
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    this.armedSpecs.clear();
  }

  /** Informational: when an armed trigger next fires. */
  nextRun(id: string): Date | null {
    return this.jobs.get(id)?.nextRun() ?? null;
  }

  /** Fire a trigger immediately, ignoring its schedule (but not its existence). */
  async runNow(id: string): Promise<FlowResult | null> {
    const record = this.opts.store.get(id);
    if (!record) throw new Error(`Trigger not found: ${id}`);
    return this.fire(record, { manual: true });
  }

  // ---- Internals ---------------------------------------------------------------

  private arm(record: TriggerRecord): void {
    let job: Cron;
    try {
      job = new Cron(
        record.cron,
        {
          timezone: record.tz,
          // Never start a run while the previous one is still going.
          protect: true,
          // Don't hold the process open on our account.
          unref: true,
          catch: true,
        },
        () => {
          void this.fire(record);
        },
      );
    } catch (err) {
      this.log.error(
        `[clawflow] trigger ${record.id} has an unusable schedule "${record.cron}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    let next: Date | null = null;
    try {
      next = job.nextRun();
    } catch (err) {
      job.stop();
      this.log.error(
        `[clawflow] trigger ${record.id} has an unusable schedule "${record.cron}"${
          record.tz ? ` (tz ${record.tz})` : ""
        }: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.jobs.set(record.id, job);
    if (next) {
      this.opts.store.update(record.id, { nextRunAt: next.toISOString() });
    }
  }

  private async fire(
    armed: TriggerRecord,
    opts?: { manual?: boolean },
  ): Promise<FlowResult | null> {
    // Re-read: the armed copy is a snapshot, and the record may have been
    // paused, retimed or repointed since it was armed.
    const record = this.opts.store.get(armed.id);
    if (!record) return null;
    if (!record.enabled && !opts?.manual) return null;

    const loaded = resolveRunnableFlow(
      this.opts.workspace,
      this.opts.flowsDir,
      record.flowName,
      record.version,
    );

    if (!loaded) {
      const error =
        typeof record.version === "number"
          ? `Flow "${record.flowName}" v${record.version} not found`
          : `Flow "${record.flowName}" not found`;
      this.log.error(`[clawflow] trigger ${record.id} skipped: ${error}`);
      this.opts.store.update(record.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "skipped",
        lastError: error,
      });
      return null;
    }

    const instanceId = randomUUID();
    this.log.info(
      `[clawflow] trigger ${record.id} → ${record.flowName} ${loaded.source} (${instanceId})`,
    );

    try {
      const result = await this.opts.runner.run(
        loaded.def,
        record.inputs ?? {},
        instanceId,
      );
      this.opts.store.update(record.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: result.ok ? "ok" : "error",
        lastInstanceId: instanceId,
        ...(result.ok ? { lastError: undefined } : { lastError: result.error }),
        ...(this.nextRunIso(record.id) ?? {}),
      });
      if (!result.ok) {
        this.log.error(
          `[clawflow] trigger ${record.id} run failed: ${result.error ?? "unknown error"}`,
        );
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`[clawflow] trigger ${record.id} crashed: ${message}`);
      this.opts.store.update(record.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "error",
        lastInstanceId: instanceId,
        lastError: message,
        ...(this.nextRunIso(record.id) ?? {}),
      });
      return null;
    }
  }

  private nextRunIso(id: string): { nextRunAt: string } | null {
    try {
      const next = this.jobs.get(id)?.nextRun();
      return next ? { nextRunAt: next.toISOString() } : null;
    } catch {
      return null;
    }
  }
}
