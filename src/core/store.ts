import * as fs from "fs";
import * as path from "path";
import type { FlowState, FlowResult, TraceEntry, PendingApproval } from "./types.js";

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

export class StateStore {
  /** The state directory: one `<instanceId>.json` per run (see runs.ts for reads). */
  readonly dir: string;

  constructor(stateDir?: string) {
    this.dir =
      stateDir ??
      path.join(
        process.env.OPENCLAW_WORKSPACE ?? process.env.HOME ?? ".",
        "flow-state",
      );
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create(
    instanceId: string,
    flowName: string,
    initialState: FlowState,
  ): InstanceRecord {
    const record: InstanceRecord = {
      instanceId,
      flowName,
      status: "running",
      state: initialState,
      completedNodes: {},
      trace: [],
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

  update(
    instanceId: string,
    patch: Partial<InstanceRecord>,
  ): InstanceRecord {
    const existing = this.get(instanceId);
    if (!existing) throw new Error(`Instance not found: ${instanceId}`);
    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    return updated;
  }

  memoize(instanceId: string, nodeName: string, output: unknown): void {
    const record = this.get(instanceId);
    if (!record) return;
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
