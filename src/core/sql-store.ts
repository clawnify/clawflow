import * as path from "node:path";
import { createHash } from "node:crypto";
import { runIndexEntry, type InstanceRecord } from "./store.js";
import type { FlowState, PendingApproval } from "./types.js";
import type { ExecutionStore, StorageConfig } from "./storage.js";
import { encodeCursor, parseRunPage, type ListRunsOptions, type ListSubRunsOptions, type RunPage, type SweepResult } from "./runs.js";
import { PostgresDriver, SqliteDriver, canonicalStoragePath, type Query, type SqlDriver } from "./sql-driver.js";

export class SqlStateStore implements ExecutionStore {
  readonly identity: string;
  private readonly driver: SqlDriver;
  private readonly namespace: string;
  constructor(readonly dir: string, config: Exclude<StorageConfig, { backend: "json" }>) {
    if (config.backend === "sqlite") {
      const file = canonicalStoragePath(config.path ?? path.join(dir, "clawflow.sqlite"));
      this.driver = new SqliteDriver(file);
      this.namespace = "default";
      this.identity = `sqlite:${file}`;
    } else {
      const url = process.env[config.connectionStringEnv]!;
      this.driver = new PostgresDriver(url);
      this.namespace = config.namespace;
      // No connection strings in live-run keys or diagnostic output.
      this.identity = `postgres:${createHash("sha256").update(url).digest("hex")}:${this.namespace}`;
    }
  }

  private async read(query: Query, id: string, lock = false): Promise<InstanceRecord | null> {
    const rows = await query(`SELECT record FROM clawflow_runs WHERE namespace=$1 AND id=$2${lock ? this.driver.lock : ""}`, [this.namespace, id]);
    return rows[0] ? JSON.parse(rows[0].record as string) : null;
  }

  private async write(query: Query, record: InstanceRecord, insert = false): Promise<void> {
    const values = [this.namespace, record.instanceId, record.instanceId.split(":")[0], record.flowName,
      record.status, record.createdAt, record.updatedAt, JSON.stringify(record), JSON.stringify(runIndexEntry(record))];
    if (insert) {
      await query(`INSERT INTO clawflow_runs (namespace,id,root_id,flow_name,status,created_at,updated_at,record,summary)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, values);
    } else {
      await query(`UPDATE clawflow_runs SET root_id=$3,flow_name=$4,status=$5,created_at=$6,updated_at=$7,record=$8,summary=$9
        WHERE namespace=$1 AND id=$2`, values);
    }
  }

  create(instanceId: string, flowName: string, state: FlowState): Promise<InstanceRecord> {
    const now = new Date().toISOString();
    const record: InstanceRecord = { instanceId, flowName, status: "running", state, completedNodes: {}, trace: [], createdAt: now, updatedAt: now };
    return this.driver.transaction(async (q) => {
      // A parent retry revisits deterministic sub-flow IDs. Reuse their memos
      // so a successful child is not replayed after a sibling failed.
      if (instanceId.includes(":")) {
        const existing = await this.read(q, instanceId, true);
        if (existing) return existing;
      }
      await this.write(q, record, true);
      return record;
    });
  }

  get(id: string): Promise<InstanceRecord | null> {
    return this.driver.transaction((q) => this.read(q, id), false);
  }

  update(id: string, patch: Partial<InstanceRecord>): Promise<InstanceRecord> {
    return this.checkpoint(id, patch);
  }

  /** Record, derived summary, node memo and approval become durable together. */
  checkpoint(id: string, patch: Partial<InstanceRecord>, memo?: { node: string; output: unknown }, approval?: PendingApproval): Promise<InstanceRecord> {
    return this.driver.transaction(async (q) => {
      const existing = await this.read(q, id, true);
      if (!existing) throw new Error(`Instance not found: ${id}`);
      const updated = { ...existing, ...patch, instanceId: existing.instanceId, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
      // A concurrently finishing step must never resurrect a cancelled run.
      if (existing.status === "cancelled") {
        updated.status = "cancelled";
        updated.error = existing.error;
        updated.running = undefined;
      }
      if (memo) updated.completedNodes = { ...updated.completedNodes, [memo.node]: memo.output };
      await this.write(q, updated);
      if (approval && updated.status !== "cancelled") await this.insertApproval(q, approval);
      return updated;
    });
  }

  async memoize(id: string, node: string, output: unknown): Promise<void> {
    await this.checkpoint(id, {}, { node, output });
  }

  async getMemoized(id: string, node: string): Promise<{ found: boolean; output: unknown }> {
    const r = await this.get(id);
    return { found: !!r && Object.prototype.hasOwnProperty.call(r.completedNodes, node), output: r?.completedNodes[node] };
  }

  list(status?: string): Promise<InstanceRecord[]> {
    return this.driver.transaction(async (q) => {
      const rows = await q(`SELECT record FROM clawflow_runs WHERE namespace=$1${status ? " AND status=$2" : ""}`, status ? [this.namespace, status] : [this.namespace]);
      return rows.map((r) => JSON.parse(r.record as string));
    }, false);
  }

  private async insertApproval(q: Query, approval: PendingApproval): Promise<void> {
    await q("INSERT INTO clawflow_approvals (namespace,token,instance_id,record) VALUES ($1,$2,$3,$4)",
      [this.namespace, approval.token, approval.instanceId, JSON.stringify(approval)]);
  }

  addApproval(approval: PendingApproval): Promise<void> {
    return this.driver.transaction((q) => this.insertApproval(q, approval));
  }

  /** Claim a paused run and consume its approval in the same transaction. */
  resume(token: string, transform: (record: InstanceRecord) => InstanceRecord): Promise<InstanceRecord> {
    return this.driver.transaction(async (q) => {
      let record = await this.read(q, token, true);
      if (!record) {
        const approvals = await q("SELECT instance_id FROM clawflow_approvals WHERE namespace=$1 AND token=$2", [this.namespace, token]);
        if (approvals[0]) record = await this.read(q, approvals[0].instance_id as string, true);
      }
      if (!record) throw new Error(`Resume token not found: ${token}`);
      const updated = { ...transform(record), instanceId: record.instanceId, createdAt: record.createdAt, updatedAt: new Date().toISOString() };
      await this.write(q, updated);
      await q("DELETE FROM clawflow_approvals WHERE namespace=$1 AND instance_id=$2", [this.namespace, record.instanceId]);
      return updated;
    });
  }

  resolveApproval(token: string): Promise<PendingApproval | null> {
    return this.driver.transaction(async (q) => {
      const rows = await q("DELETE FROM clawflow_approvals WHERE namespace=$1 AND token=$2 RETURNING record", [this.namespace, token]);
      return rows[0] ? JSON.parse(rows[0].record as string) : null;
    });
  }

  listApprovals(): Promise<PendingApproval[]> {
    return this.driver.transaction(async (q) => (await q("SELECT record FROM clawflow_approvals WHERE namespace=$1 ORDER BY token", [this.namespace])).map((r) => JSON.parse(r.record as string)), false);
  }

  listRuns(opts: ListRunsOptions = {}): Promise<RunPage> {
    return this.pageRuns(opts);
  }

  listSubRuns(parentId: string, opts: ListSubRunsOptions = {}): Promise<RunPage> {
    return this.pageRuns(opts, parentId);
  }

  private pageRuns(opts: ListSubRunsOptions, parentId?: string): Promise<RunPage> {
    const { limit, after } = parseRunPage(opts);
    return this.driver.transaction(async (q) => {
      const params: unknown[] = [this.namespace];
      let where = "namespace=$1";
      if (parentId === undefined) where += " AND id=root_id";
      else {
        params.push(parentId.split(":")[0], `${parentId}:`);
        where += " AND root_id=$2 AND substr(id, 1, length($3))=$3";
        if (opts.node) {
          if (opts.node.includes(":")) where += " AND 1=0";
          else {
            const filters = ["loop", "branch", "condition", "parallel"].map((kind) => {
              params.push(`${parentId}:${kind}:${opts.node!}:`);
              return `substr(id, 1, length($${params.length}))=$${params.length}`;
            });
            where += ` AND (${filters.join(" OR ")})`;
          }
        }
      }
      if (opts.flow) { params.push(opts.flow); where += ` AND flow_name=$${params.length}`; }
      if (opts.status) { params.push(opts.status); where += ` AND status=$${params.length}`; }
      const count = await q(`SELECT COUNT(*) AS total FROM clawflow_runs WHERE ${where}`, params);
      const oldestRows = opts.includeOldest
        ? await q(`SELECT id,updated_at FROM clawflow_runs WHERE ${where} ORDER BY updated_at ASC,id ASC LIMIT 1`, params) : [];
      const oldest = oldestRows[0] ? { instanceId: oldestRows[0].id as string, updatedAt: oldestRows[0].updated_at as string } : null;
      if (after) {
        params.push(after.createdAt, after.instanceId);
        where += ` AND (created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
      }
      params.push(limit + 1);
      const rows = await q(`SELECT summary FROM clawflow_runs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`, params);
      const runs = rows.slice(0, limit).map((r) => JSON.parse(r.summary as string));
      return { ...(opts.includeOldest ? { oldest } : {}), runs, total: Number(count[0].total), next_cursor: rows.length > limit ? encodeCursor(runs[runs.length - 1]) : null };
    }, false);
  }

  async sweep(retentionDays: number, now = Date.now()): Promise<SweepResult> {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new Error("retentionDays must be non-negative");
    if (!retentionDays) return { indexed: 0, runs: 0, files: 0 };
    const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
    const result = { indexed: 0, runs: 0, files: 0 };
    // Bound each transaction, including its locks. Always re-check under lock.
    while (true) {
      const batch = await this.driver.transaction(async (q) => {
        const roots = await q(`SELECT id FROM clawflow_runs WHERE namespace=$1 AND id=root_id
          AND status IN ('completed','failed','cancelled') AND updated_at < $2 LIMIT 100${this.driver.lock}`, [this.namespace, cutoff]);
        let files = 0;
        for (const root of roots) {
          const rows = await q("DELETE FROM clawflow_runs WHERE namespace=$1 AND root_id=$2 RETURNING id", [this.namespace, root.id]);
          files += rows.length;
        }
        return { runs: roots.length, files };
      });
      result.runs += batch.runs;
      result.files += batch.files;
      if (batch.runs < 100) return result;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Offline migration only: append missing records; refuse conflicts atomically. */
  importRecords(records: InstanceRecord[], approvals: PendingApproval[]): Promise<void> {
    return this.driver.transaction(async (q) => {
      for (const record of records) {
        const existing = await this.read(q, record.instanceId, true);
        if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error(`Migration conflict: ${record.instanceId}`);
        if (!existing) await this.write(q, record, true);
      }
      for (const approval of approvals) {
        const existing = await q("SELECT record FROM clawflow_approvals WHERE namespace=$1 AND token=$2", [this.namespace, approval.token]);
        if (existing.length && existing[0].record !== JSON.stringify(approval)) throw new Error(`Migration approval conflict: ${approval.token}`);
        if (!existing.length) await this.insertApproval(q, approval);
      }
    });
  }

  close(): Promise<void> { return this.driver.close(); }
}
