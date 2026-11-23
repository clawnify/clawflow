import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { liveRuns } from "./active-runs.js";
import type { ExecutionStore } from "./storage.js";
import type { InstanceRecord } from "./store.js";
import type { OwnerBeat, RunOwner } from "./types.js";

// ---- Run ownership ---------------------------------------------------------------
// A run is executed by one process, and only that process can record how it
// ended. If the process is killed first, the record says "running" for good.
// Nothing on the record can tell that apart from a run that is only slow: a
// sleep or an event wait writes nothing for days.
//
// So every top-level run names the process executing it (`owner`), and a
// process says "I am alive" in the store for as long as it has runs there (a
// heartbeat every HEARTBEAT_MS). A run is interrupted when its record says
// "running" and its owner is gone:
//
//   - the owner's heartbeat is older than OWNER_STALE_MS, or it has none. This
//     is the rule for every store. It needs no knowledge of the owner's
//     machine, so it also holds for a database several hosts share and for a
//     state directory restored onto another machine.
//   - the store is local to this machine and the owner's pid no longer exists.
//     A shortcut: it only ever says "gone" sooner. It never says "alive",
//     because after a reboot the same pid belongs to another process.
//   - the owner is this process and the run is not executing here.
//
// reconcileRuns() fails such runs. A run with no owner at all (started by an
// engine that did not record one) proves nothing either way and is left as it
// is unless the caller asks.
//
// What keeps a live run from being failed by mistake:
//
//   - A process writes its heartbeat before every run it takes, and waits for
//     the write, so a run never names a process the store has not just heard
//     from.
//   - A verdict is about one claim of a run (`claim` on the record, new each
//     time a process starts or resumes it). The write that fails the run
//     happens only if the record still shows that claim, so a run that was
//     paused and taken again in between is not touched.

/** How often a process with runs in a store says it is alive there. */
export const HEARTBEAT_MS = 20_000;

/** A process that has not been heard from for this long is gone. Six missed
 *  heartbeats: a busy event loop or a slow store write must never pass for it. */
export const OWNER_STALE_MS = 120_000;

interface Lease {
  /** The store handle heartbeats go through: the latest runner's. */
  store: ExecutionStore;
  /** Runs of this process holding the lease. */
  holds: number;
  timer?: ReturnType<typeof setInterval>;
  /** A run of this process ended without recording it since `holds` left 0. */
  dropped?: boolean;
  /** Heartbeat writes, one at a time and in order. */
  queue: Promise<void>;
  /** Writes queued or in flight. */
  pending: number;
}

interface Engine {
  owner: RunOwner;
  /** Storage identity -> this process's lease there. */
  leases: Map<string, Lease>;
  /** Stores whose running runs this process has looked through once. */
  scanned: Set<string>;
}

// On `globalThis` like the live runs (active-runs.ts): however many copies of
// this module a process loads, it is one engine process with one identity.
const ENGINE_KEY = Symbol.for("@clawnify/clawflow/engine-process");
type EngineHolder = { [ENGINE_KEY]?: Engine };
const holder = globalThis as unknown as EngineHolder;
const engine: Engine = holder[ENGINE_KEY] ?? (holder[ENGINE_KEY] = {
  owner: {
    id: randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  },
  leases: new Map(),
  scanned: new Set(),
});

/** This process, as stamped on the runs it executes. */
export const engineOwner: RunOwner = engine.owner;

function enqueue(lease: Lease, op: () => unknown): Promise<void> {
  const run = async () => { await op(); };
  // With nothing ahead of it the write starts now, not a tick later: a process
  // that exits right after its run (process.exit in a script) has then already
  // removed its file from a JSON store, whose writes are synchronous.
  const next = lease.pending ? lease.queue.catch(() => {}).then(run) : run();
  lease.pending++;
  lease.queue = next;
  next.catch(() => {}).finally(() => { lease.pending--; });
  return next;
}

/**
 * Keep this process marked alive in `store` for the length of one run. Resolves
 * once the store has heard from it, so the caller may then stamp the run with
 * `engineOwner`; call the returned function when the run has recorded its end.
 * The heartbeat runs only while a run holds it: an idle process writes nothing.
 */
export async function holdLease(store: ExecutionStore): Promise<() => void> {
  let lease = engine.leases.get(store.identity);
  if (!lease) {
    lease = { store, holds: 0, queue: Promise.resolve(), pending: 0 };
    engine.leases.set(store.identity, lease);
  }
  const held = lease;
  held.store = store;
  // Every run, not only the first: a process that was stalled, or that a pass
  // elsewhere took for gone, is heard from again before it takes another run.
  const heard = enqueue(held, () => held.store.beat(engine.owner));
  if (held.holds++ === 0) {
    held.timer = setInterval(() => {
      // A missed beat is retried by the next one; OWNER_STALE_MS allows six.
      enqueue(held, () => held.store.beat(engine.owner)).catch(() => {});
    }, HEARTBEAT_MS);
    held.timer.unref?.();
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--held.holds > 0) return;
    clearInterval(held.timer);
    held.timer = undefined;
    // A dropped run still names this process. Leave the entry to go stale, so
    // a reconcile pass in any process finds that run; otherwise forget it now,
    // queued behind any beat in flight and ahead of the next run's first one.
    if (held.dropped) held.dropped = false;
    else enqueue(held, () => held.store.forgetOwner(engine.owner.id)).catch(() => {});
  };
  try {
    await heard;
  } catch (err) {
    release();
    throw err;
  }
  return release;
}

/** Settles when this process has no heartbeat write to `store` in flight. */
export async function leaseSettled(store: ExecutionStore): Promise<void> {
  await engine.leases.get(store.identity)?.queue.catch(() => {});
}

/** A run of this process stopped executing without recording its end (its last
 *  write failed), so its record still says "running" under this process. Have
 *  the next reconcile pass, here or in another process, find it. */
export function runDropped(store: ExecutionStore): void {
  engine.scanned.delete(store.identity);
  const lease = engine.leases.get(store.identity);
  if (lease) lease.dropped = true;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists under another user. Only "no such process" means gone.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function ownerGone(store: ExecutionStore, beat: OwnerBeat): boolean {
  if (beat.ageMs > OWNER_STALE_MS) return true;
  return store.local && beat.host === engine.owner.host && !pidExists(beat.pid);
}

export interface ReconcileOptions {
  /**
   * Also fail running runs that name no owner: runs started by an engine that
   * did not record one. Nothing proves such a run dead, so this is the
   * caller's word that no such engine is still executing flows on this store.
   */
  unowned?: boolean;
  /** Look through every running run even when no process looks gone. */
  full?: boolean;
}

export interface ReconciledRun {
  instanceId: string;
  flowName: string;
  error: string;
}

export interface ReconcileResult {
  /** Runs marked failed because nothing is executing them any more. */
  failed: ReconciledRun[];
  /** Running runs with no owner on record, left as they are. */
  unowned: number;
  /** Runs the pass could not end, or not completely, and why. A run that is
   *  still running is tried again by the next pass. */
  errors: Array<{ instanceId: string; error: string }>;
}

/**
 * Fail the top-level runs of `store` that say "running" while nothing is
 * executing them (see the rules at the top of this file), with their running
 * loop, branch and parallel instances. Safe to call from any process, at any
 * time, any number of times: a run is changed only if its record still shows
 * the claim that was judged.
 *
 * Cheap when there is nothing to do: after this process's first pass over a
 * store, the running runs are read only when a process looks gone.
 */
export async function reconcileRuns(store: ExecutionStore, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { failed: [], unowned: 0, errors: [] };
  const me = engine.owner;
  const gone = (await store.owners()).filter((beat) => beat.id !== me.id && ownerGone(store, beat));
  if (!gone.length && !opts.full && !opts.unowned && engine.scanned.has(store.identity)) return result;

  let cursor: string | undefined;
  do {
    const page = await store.listRuns({ status: "running", limit: 100, cursor });
    // Read after the page, never before it: a process says it is alive before
    // it stamps a run, so every live owner of a run on this page is in here.
    const beats = new Map((await store.owners()).map((beat) => [beat.id, beat]));
    for (const row of page.runs) {
      const owner = row.owner;
      const beat = owner ? beats.get(owner.id) : undefined;
      let ownerStopped = false;
      if (!owner) {
        if (!opts.unowned) {
          result.unowned++;
          continue;
        }
      } else if (owner.id === me.id) {
        if (liveRuns.has(`${store.identity}\0${row.instanceId}`)) continue;
      } else {
        if (beat && !ownerGone(store, beat)) continue;
        ownerStopped = true;
      }
      const lastSeen = beat ? Date.now() - beat.ageMs : undefined;
      // One run that cannot be read or written must not stop the pass.
      try {
        const failed = await failInterrupted(store, row, ownerStopped, lastSeen, result.errors);
        if (failed) result.failed.push({ instanceId: failed.instanceId, flowName: failed.flowName, error: failed.error ?? "" });
      } catch (err) {
        result.errors.push({ instanceId: row.instanceId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  // With a run left over, the next pass looks again.
  if (result.errors.length) return result;
  engine.scanned.add(store.identity);

  // Their runs are settled. A process whose pid is gone will not be heard from
  // again. One that was only quiet is forgotten only if it is quiet still, so
  // a stalled process keeps the heartbeat it has just renewed.
  for (const beat of gone) {
    const quiet = beat.ageMs > OWNER_STALE_MS;
    await store.forgetOwner(beat.id, quiet ? OWNER_STALE_MS : undefined);
  }
  return result;
}

/** Fail one run if its record still shows the claim that was judged, then its
 *  running sub-flow instances. Null when the run had moved on. */
async function failInterrupted(
  store: ExecutionStore,
  row: { instanceId: string; owner?: RunOwner; claim?: string },
  ownerStopped: boolean,
  lastSeen: number | undefined,
  errors: ReconcileResult["errors"],
): Promise<InstanceRecord | null> {
  const instanceId = row.instanceId;
  const interrupt = (record: InstanceRecord): Partial<InstanceRecord> => {
    const step = record.running;
    const at = step ? ` during step "${step.node}"` : "";
    const error = ownerStopped
      ? `Interrupted: the process running this flow stopped${at}, before the run could finish.`
      : `Interrupted: the run was left marked running${at}, with no process running it.`;
    const trace = [...(record.trace ?? [])];
    if (step) {
      // It ran at least until its process was last heard from.
      const until = lastSeen ?? Date.parse(record.updatedAt);
      const durationMs = Math.max(0, until - Date.parse(step.startedAt)) || 0;
      trace.push({ node: step.node, do: step.do, status: "error", error, durationMs });
    }
    return { status: "failed", error, trace, running: undefined };
  };

  // Only the claim that was judged: a run that was paused and taken again
  // since the pass read it shows another one, and is left alone.
  const failed = await store.amend(instanceId, (record) =>
    record.status === "running" && record.owner?.id === row.owner?.id && record.claim === row.claim ? interrupt(record) : null);
  if (!failed) return null;

  // The loop iteration, branch or parallel instance it was inside says
  // "running" too, and nothing else would ever end it. The run itself is
  // failed already: a sub-flow that cannot be ended is reported, not fatal.
  try {
    let cursor: string | undefined;
    do {
      const page = await store.listSubRuns(instanceId, { status: "running", limit: 100, cursor });
      for (const sub of page.runs) {
        await store.amend(sub.instanceId, (record) => (record.status === "running" ? interrupt(record) : null));
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  } catch (err) {
    errors.push({ instanceId, error: `its loop and branch instances: ${err instanceof Error ? err.message : String(err)}` });
  }
  return failed;
}
