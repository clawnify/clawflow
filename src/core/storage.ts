import * as path from "node:path";
import { StateStore, type InstanceRecord } from "./store.js";
import { SqlStateStore } from "./sql-store.js";
import type { FlowState, PendingApproval } from "./types.js";
import type { ListRunsOptions, ListSubRunsOptions, RunPage, SweepResult } from "./runs.js";

export type StorageConfig =
  | { backend: "json" }
  | { backend: "sqlite"; path?: string }
  | { backend: "postgres"; connectionStringEnv: string; namespace: string };

export type Awaitable<T> = T | Promise<T>;

/** Await these methods: the legacy JSON store remains synchronous. */
export interface ExecutionStore {
  /** Local workspace path, NOT a database read API. */
  readonly dir: string;
  /** Stable within a process; scopes cancellation to this database/namespace. */
  readonly identity: string;
  create(id: string, flow: string, state: FlowState): Awaitable<InstanceRecord>;
  get(id: string): Awaitable<InstanceRecord | null>;
  update(id: string, patch: Partial<InstanceRecord>): Awaitable<InstanceRecord>;
  checkpoint(id: string, patch: Partial<InstanceRecord>, memo?: { node: string; output: unknown }, approval?: PendingApproval): Awaitable<InstanceRecord>;
  memoize(id: string, node: string, output: unknown): Awaitable<void>;
  getMemoized(id: string, node: string): Awaitable<{ found: boolean; output: unknown }>;
  list(status?: string): Awaitable<InstanceRecord[]>;
  addApproval(approval: PendingApproval): Awaitable<void>;
  resume(token: string, transform: (record: InstanceRecord) => InstanceRecord): Awaitable<InstanceRecord>;
  resolveApproval(token: string): Awaitable<PendingApproval | null>;
  listApprovals(): Awaitable<PendingApproval[]>;
  listRuns(opts?: ListRunsOptions): Awaitable<RunPage>;
  listSubRuns(parentId: string, opts?: ListSubRunsOptions): Awaitable<RunPage>;
  sweep(retentionDays: number, now?: number): Promise<SweepResult>;
  close(): Awaitable<void>;
}

/** Explicit opt-in; never falls back to another store when a database fails. */
export function createStateStore(stateDir?: string, config?: StorageConfig): ExecutionStore {
  const dir = stateDir ?? path.join(process.env.OPENCLAW_WORKSPACE ?? process.env.HOME ?? ".", "flow-state");
  if (!config || config.backend === "json") return new StateStore(dir);
  if (config.backend === "sqlite") {
    return new SqlStateStore(dir, { ...config, path: config.path ?? path.join(dir, "clawflow.sqlite") });
  }
  if (config.backend === "postgres") {
    if (!config.namespace?.trim()) throw new Error("PostgreSQL storage requires a namespace");
    if (!config.connectionStringEnv || !process.env[config.connectionStringEnv]) {
      throw new Error("PostgreSQL storage requires a populated connectionStringEnv");
    }
    return new SqlStateStore(dir, config);
  }
  throw new Error("Unknown ClawFlow storage backend");
}
