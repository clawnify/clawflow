import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { listRuns, listSubRuns, sweepRuns, type ListRunsOptions, type ListSubRunsOptions } from "./runs.js";
import type { FlowState, FlowResult, TraceEntry, PendingApproval, RunningStep, RunOwner, OwnerBeat } from "./types.js";

// ---- Durable State Store --------------------------------------------------------
// Persists flow instance state to disk so flows survive gateway restarts.
// This is the lightweight equivalent of Cloudflare's Durable Objects memoization.
//
// Each flow instance gets a JSON file: stateDir/<instanceId>.json
// Completed node outputs are stored so they're never re-run on resume.

export interface InstanceRecord {
  instanceId: string;
  flowName: string;
  status:
    | "running"
    | "completed"
    | "paused"
    | "waiting"
    | "failed"
    | "cancelled";
  state: FlowState;
  completedNodes: Record<string, unknown>; // nodeName -> output (memoized)
  trace: TraceEntry[]; // persisted trace survives resume
  running?: RunningStep; // the step executing now; cleared when it ends
  /** The process executing this top-level run, set when it starts or resumes
   *  (ownership.ts). It means something only while `status` is "running". */
  owner?: RunOwner;
  /** New each time a process takes the run: when it starts and at every
   *  resume. Tells a run that was paused and taken again from the one a
   *  reconcile pass looked at. */
  claim?: string;
  pausedAtIndex?: number; // node index where flow paused (for resume)
  resumeToken?: string;
  waitingFor?: FlowResult["waitingFor"];
  error?: string; // persisted error message for failed flows
  createdAt: string;
  updatedAt: string;
}

// ---- Run index -----------------------------------------------------------------
// A small summary of each top-level run, kept at stateDir/_index/<file>.json so a
// run list reads a few hundred bytes per run instead of parsing every record (a
// record carries every node's output and can be megabytes). The index is derived
// data: a missing or stale entry only means the reader parses the record. Each
// entry names the version of the record it was built from (its mtime, to the
// millisecond, and its size) and is trusted only while the record still matches,
// so a record rewritten after its entry (by any process) is never listed stale.
// Readers that predate it skip it: the directory name starts with "_".

export const RUN_INDEX_DIR = "_index";

export interface RunIndexEntry {
  instanceId: string;
  flowName: string;
  status: InstanceRecord["status"];
  createdAt: string;
  updatedAt: string;
  error?: string;
  resumeToken?: string;
  waitingFor?: InstanceRecord["waitingFor"];
  /** While the run is running: the process executing it, and its claim. */
  owner?: RunOwner;
  claim?: string;
  traceCount: number;
  nodeCount: number;
}

export function runIndexEntry(r: InstanceRecord): RunIndexEntry {
  return {
    instanceId: r.instanceId,
    flowName: r.flowName,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.error ? { error: r.error } : {}),
    ...(r.resumeToken ? { resumeToken: r.resumeToken } : {}),
    ...(r.waitingFor ? { waitingFor: r.waitingFor } : {}),
    ...(r.status === "running" && r.owner ? { owner: r.owner, ...(r.claim ? { claim: r.claim } : {}) } : {}),
    traceCount: Array.isArray(r.trace) ? r.trace.length : 0,
    nodeCount: r.completedNodes ? Object.keys(r.completedNodes).length : 0,
  };
}

/** stateDir/_index/<fileBase>.json, where fileBase is the record's file name without .json. */
export function runIndexPath(stateDir: string, fileBase: string): string {
  return path.join(stateDir, RUN_INDEX_DIR, `${fileBase}.json`);
}

/** The record version an entry was built from. */
interface RecordVersion {
  mtime: number;
  size: number;
}

function recordVersion(stats: fs.Stats): RecordVersion {
  return { mtime: Math.floor(stats.mtimeMs), size: stats.size };
}

/** On disk: the entry plus the record version it describes. */
interface StoredIndexEntry {
  record: RecordVersion;
  run: RunIndexEntry;
}

/**
 * Write a run's index entry for the record as it is on disk now, or as it was
 * when `recordStats` was taken (a backfill stats before it parses, so a record
 * rewritten in between leaves the entry stale, never wrong). Never throws: the
 * index is an optimization and must not fail a record write.
 */
export function writeRunIndex(
  stateDir: string,
  fileBase: string,
  record: InstanceRecord,
  recordStats?: fs.Stats,
): void {
  try {
    const stats = recordStats ?? fs.statSync(path.join(stateDir, `${fileBase}.json`));
    const file = runIndexPath(stateDir, fileBase);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const stored: StoredIndexEntry = { record: recordVersion(stats), run: runIndexEntry(record) };
    fs.writeFileSync(tmp, JSON.stringify(stored));
    fs.renameSync(tmp, file);
  } catch {
    // Derived data: a reader falls back to parsing the record.
  }
}

/** The run's index entry if it describes the record as it is on disk now, else null. */
export function readFreshRunIndex(stateDir: string, fileBase: string): RunIndexEntry | null {
  try {
    const stored = JSON.parse(fs.readFileSync(runIndexPath(stateDir, fileBase), "utf8")) as StoredIndexEntry;
    const now = recordVersion(fs.statSync(path.join(stateDir, `${fileBase}.json`)));
    return stored?.record?.mtime === now.mtime && stored.record.size === now.size ? stored.run : null;
  } catch {
    return null;
  }
}

/** stateDir/_owners/<owner id>.json: one file per engine process with runs
 *  here, holding its RunOwner. Its mtime is the process's last heartbeat. */
export const OWNERS_DIR = "_owners";

/**
 * A top-level run that failed is not written again. Its own execution writes
 * "failed" as its last act, so a later write can only come from a process that
 * a reconcile pass took for gone and that was in fact stalled (ownership.ts):
 * its step finishing late must not turn a failed run back into a running,
 * paused or completed one, nor change what the record says happened. A
 * sub-flow instance is different: a retry of its parent runs it once more.
 */
export function isSettledFailure(record: Pick<InstanceRecord, "instanceId" | "status">): boolean {
  return record.status === "failed" && !record.instanceId.includes(":");
}

export class StateStore {
  /** The state directory: one `<instanceId>.json` per run (see runs.ts for reads). */
  readonly dir: string;
  /** A directory on this machine's disk. */
  readonly local = true;
  /** The directory's real path: two spellings of one directory (a symlink)
   *  are one store, with one set of live runs. */
  readonly identity: string;

  listRuns(opts?: ListRunsOptions) { return listRuns(this.dir, opts); }
  listSubRuns(parentId: string, opts?: ListSubRunsOptions) { return listSubRuns(this.dir, parentId, opts); }
  sweep(days: number, now?: number) { return sweepRuns(this.dir, days, now); }
  close(): void {}

  checkpoint(id: string, patch: Partial<InstanceRecord>, memo?: { node: string; output: unknown }, approval?: PendingApproval): InstanceRecord {
    if (memo) this.memoize(id, memo.node, memo.output);
    const record = this.update(id, patch);
    // Neither write above touched a run that had failed; nor does this one.
    if (approval && !isSettledFailure(record)) this.addApproval(approval);
    return record;
  }

  constructor(stateDir?: string) {
    this.dir =
      stateDir ??
      path.join(
        process.env.OPENCLAW_WORKSPACE ?? process.env.HOME ?? ".",
        "flow-state",
      );
    fs.mkdirSync(this.dir, { recursive: true });
    this.identity = `json:${fs.realpathSync(this.dir)}`;
  }

  create(
    instanceId: string,
    flowName: string,
    initialState: FlowState,
    owner?: RunOwner,
  ): InstanceRecord {
    const record: InstanceRecord = {
      instanceId,
      flowName,
      status: "running",
      state: initialState,
      completedNodes: {},
      trace: [],
      ...(owner ? { owner, claim: randomUUID() } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(record);
    return record;
  }

  get(instanceId: string): InstanceRecord | null {
    const file = this.filePath(instanceId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as InstanceRecord;
  }

  summary(instanceId: string): RunIndexEntry | null {
    // The index entry when it still describes the record on disk, else the
    // record itself (a sub-flow, or a record written before the index existed).
    const indexed = readFreshRunIndex(this.dir, this.fileBase(instanceId));
    if (indexed) return indexed.instanceId === instanceId ? indexed : null;
    const record = this.get(instanceId);
    return record && record.instanceId === instanceId ? runIndexEntry(record) : null;
  }

  update(
    instanceId: string,
    patch: Partial<InstanceRecord>,
  ): InstanceRecord {
    const existing = this.get(instanceId);
    if (!existing) throw new Error(`Instance not found: ${instanceId}`);
    if (isSettledFailure(existing)) return existing;
    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    return updated;
  }

  amend(
    instanceId: string,
    change: (record: InstanceRecord) => Partial<InstanceRecord> | null,
  ): InstanceRecord | null {
    const existing = this.get(instanceId);
    const patch = existing ? change(existing) : null;
    if (!existing || !patch) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.write(updated);
    return updated;
  }

  memoize(instanceId: string, nodeName: string, output: unknown): void {
    const record = this.get(instanceId);
    if (!record || isSettledFailure(record)) return;
    record.completedNodes[nodeName] = output;
    record.updatedAt = new Date().toISOString();
    this.write(record);
  }

  getMemoized(
    instanceId: string,
    nodeName: string,
  ): { found: boolean; output: unknown } {
    const record = this.get(instanceId);
    if (!record) return { found: false, output: undefined };
    const has = Object.prototype.hasOwnProperty.call(
      record.completedNodes,
      nodeName,
    );
    return { found: has, output: record.completedNodes[nodeName] };
  }

  list(status?: string): InstanceRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const records = files
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(this.dir, f), "utf8"),
          ) as InstanceRecord;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as InstanceRecord[];
    return status ? records.filter((r) => r.status === status) : records;
  }

  // ---- Pending Approvals --------------------------------------------------------

  private get approvalsFile(): string {
    return path.join(this.dir, "_pending-approvals.json");
  }

  addApproval(approval: PendingApproval): void {
    const approvals = this.listApprovals();
    approvals.push(approval);
    fs.writeFileSync(this.approvalsFile, JSON.stringify(approvals, null, 2));
  }

  resume(token: string, transform: (record: InstanceRecord) => InstanceRecord): InstanceRecord {
    const approval = this.listApprovals().find((a) => a.token === token);
    const record = this.get(token) ?? (approval ? this.get(approval.instanceId) : null);
    if (!record) throw new Error(`Resume token not found: ${token}`);
    const updated = this.update(record.instanceId, transform(record));
    if (record.resumeToken) this.resolveApproval(record.resumeToken);
    return updated;
  }

  resolveApproval(token: string): PendingApproval | null {
    const approvals = this.listApprovals();
    const idx = approvals.findIndex((a) => a.token === token);
    if (idx < 0) return null;
    const [approval] = approvals.splice(idx, 1);
    fs.writeFileSync(this.approvalsFile, JSON.stringify(approvals, null, 2));
    return approval;
  }

  listApprovals(): PendingApproval[] {
    if (!fs.existsSync(this.approvalsFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.approvalsFile, "utf8")) as PendingApproval[];
    } catch {
      return [];
    }
  }

  // ---- Engine processes (ownership.ts) -------------------------------------------

  private ownerFile(id: string): string {
    return path.join(this.dir, OWNERS_DIR, `${this.fileBase(id)}.json`);
  }

  beat(owner: RunOwner): void {
    const file = this.ownerFile(owner.id);
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // First beat, or a reconcile pass took this process for gone.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(owner));
      fs.renameSync(tmp, file);
    }
  }

  owners(): OwnerBeat[] {
    const dir = path.join(this.dir, OWNERS_DIR);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const now = Date.now();
    const beats: OwnerBeat[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const file = path.join(dir, name);
        const owner = JSON.parse(fs.readFileSync(file, "utf8")) as RunOwner;
        if (typeof owner?.id !== "string" || typeof owner.pid !== "number") continue;
        beats.push({ ...owner, ageMs: Math.max(0, now - fs.statSync(file).mtimeMs) });
      } catch {
        // Removed between the listing and the read: it is no longer an owner.
      }
    }
    return beats;
  }

  forgetOwner(id: string, quietForMs?: number): void {
    const file = this.ownerFile(id);
    try {
      if (quietForMs !== undefined && Date.now() - fs.statSync(file).mtimeMs <= quietForMs) return;
      fs.unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // ---- Internals ---------------------------------------------------------------

  private fileBase(instanceId: string): string {
    return instanceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private filePath(instanceId: string): string {
    return path.join(this.dir, `${this.fileBase(instanceId)}.json`);
  }

  private write(record: InstanceRecord): void {
    fs.writeFileSync(
      this.filePath(record.instanceId),
      JSON.stringify(record, null, 2),
    );
    // After the record, keyed to the version just written. Sub-flow instances
    // (loop iterations, branches) are never listed, so never indexed.
    if (!record.instanceId.includes(":")) {
      writeRunIndex(this.dir, this.fileBase(record.instanceId), record);
    }
  }
}
