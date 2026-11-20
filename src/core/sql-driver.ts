import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";

type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;
export interface SqlDriver {
  readonly lock: string;
  transaction<T>(fn: (query: Query) => Promise<T>, write?: boolean): Promise<T>;
  close(): Promise<void>;
}

/** Resolve symlinked parents too when the database file does not exist yet. */
export function canonicalStoragePath(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync(absolute); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return path.join(canonicalStoragePath(path.dirname(absolute)), path.basename(absolute));
  }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS clawflow_storage (version INTEGER NOT NULL PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS clawflow_runs (
    namespace TEXT NOT NULL, id TEXT NOT NULL, root_id TEXT NOT NULL,
    flow_name TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    record TEXT NOT NULL, summary TEXT NOT NULL,
    PRIMARY KEY (namespace, id))`,
  `CREATE INDEX IF NOT EXISTS clawflow_runs_page ON clawflow_runs (namespace, created_at DESC, id DESC) WHERE id = root_id`,
  `CREATE INDEX IF NOT EXISTS clawflow_runs_flow_page ON clawflow_runs (namespace, flow_name, created_at DESC, id DESC) WHERE id = root_id`,
  `CREATE INDEX IF NOT EXISTS clawflow_runs_status_page ON clawflow_runs (namespace, status, created_at DESC, id DESC) WHERE id = root_id`,
  `CREATE INDEX IF NOT EXISTS clawflow_runs_retention ON clawflow_runs (namespace, status, updated_at) WHERE id = root_id`,
  `CREATE INDEX IF NOT EXISTS clawflow_runs_root ON clawflow_runs (namespace, root_id)`,
  `CREATE TABLE IF NOT EXISTS clawflow_approvals (
    namespace TEXT NOT NULL, token TEXT NOT NULL, instance_id TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY (namespace, token),
    FOREIGN KEY (namespace, instance_id) REFERENCES clawflow_runs (namespace, id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS clawflow_approvals_run ON clawflow_approvals (namespace, instance_id)`,
];

async function initialize(query: Query): Promise<void> {
  // All DDL and version checks are in one transaction. Future schema versions
  // must migrate explicitly, never be opened by an older engine.
  await query(schema[0]);
  const versions = await query("SELECT version FROM clawflow_storage");
  if (versions.length && (versions.length !== 1 || versions[0].version !== 1)) {
    throw new Error("Unsupported ClawFlow storage schema version");
  }
  for (const sql of schema.slice(1)) await query(sql);
  await query("INSERT INTO clawflow_storage (version) VALUES (1) ON CONFLICT DO NOTHING");
}

// DatabaseSync transactions must not interleave while their callbacks await.
// Share the queue across imports AND handles of the same file: otherwise a
// second handle's busy_timeout blocks the event loop holding the first lock.
const queueKey = Symbol.for("@clawnify/clawflow/sqlite-queues");
const globalQueues = globalThis as unknown as { [queueKey]?: Map<string, Promise<unknown>> };
const queues = globalQueues[queueKey] ??= new Map();

export class SqliteDriver implements SqlDriver {
  readonly lock = "";
  private db?: DatabaseSync;
  private initialized = false;
  private closed = false;
  private readonly file: string;
  constructor(file: string) {
    if (!file || file === ":memory:") throw new Error("SQLite storage requires a durable file path");
    this.file = canonicalStoragePath(file);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(this.file, next);
    void next.finally(() => { if (queues.get(this.file) === next) queues.delete(this.file); }).catch(() => {});
    return next;
  }

  transaction<T>(fn: (query: Query) => Promise<T>, write = true): Promise<T> {
    return this.serial(async () => {
      if (this.closed) throw new Error("ClawFlow storage is closed");
      if (!this.db) {
        // Lazy: JSON and PostgreSQL consumers can still run on Node 18/20.
        const require = createRequire(import.meta.url);
        let sqlite: typeof import("node:sqlite");
        try { sqlite = require("node:sqlite"); }
        catch { throw new Error("SQLite storage requires Node.js 22.13 or newer"); }
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        // Do not change permissions of an existing operator-owned file.
        try { fs.closeSync(fs.openSync(this.file, "wx", 0o600)); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
        const db = new sqlite.DatabaseSync(this.file);
        try { db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;"); }
        catch (err) { db.close(); throw err; }
        this.db = db;
      }
      const query: Query = async (sql, params = []) => {
        const values: unknown[] = [];
        const translated = sql.replace(/\$(\d+)/g, (_, n) => { values.push(params[Number(n) - 1]); return "?"; });
        return this.db!.prepare(translated).all(...values as import("node:sqlite").SQLInputValue[]) as Row[];
      };
      this.db.exec(write || !this.initialized ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        if (!this.initialized) await initialize(query);
        const result = await fn(query);
        this.db.exec("COMMIT");
        this.initialized = true;
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (!this.closed) this.db?.close();
      this.closed = true;
    });
  }
}

export class PostgresDriver implements SqlDriver {
  readonly lock = " FOR UPDATE";
  private pool?: Pool;
  private ready?: Promise<void>;
  private closed = false;
  constructor(private readonly connectionString: string) {}

  private async getPool(): Promise<Pool> {
    if (this.closed) throw new Error("ClawFlow storage is closed");
    if (!this.ready) {
      this.ready = (async () => {
        const { Pool } = await import("pg");
        if (this.closed) throw new Error("ClawFlow storage is closed");
        this.pool = new Pool({ connectionString: this.connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, allowExitOnIdle: true });
        // pg removes failed idle clients itself. Do not log credentials or let
        // EventEmitter's unhandled 'error' terminate unrelated active runs.
        this.pool.on("error", () => console.warn("[clawflow] Idle PostgreSQL connection closed; the next operation will reconnect"));
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          // Serializes first-open DDL across processes, including pg_catalog.
          await client.query("SELECT pg_advisory_xact_lock(18793, 1)");
          await initialize(async (sql, params) => (await client.query(sql, params)).rows);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally { client.release(); }
      })().catch(async (err) => {
        await this.pool?.end();
        this.pool = undefined;
        this.ready = undefined;
        throw err;
      });
    }
    await this.ready;
    return this.pool!;
  }

  async transaction<T>(fn: (query: Query) => Promise<T>, write = true): Promise<T> {
    const pool = await this.getPool();
    const client = await pool.connect();
    let failed = false;
    try {
      await client.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { failed = true; }
      throw err;
    } finally { client.release(failed); }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.ready?.catch(() => {});
    await this.pool?.end();
    this.pool = undefined;
  }
}
