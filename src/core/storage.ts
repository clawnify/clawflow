import * as path from "node:path";
import { StateStore, type InstanceRecord, type RunIndexEntry } from "./store.js";
import { SqlStateStore } from "./sql-store.js";
import type { FlowState, PendingApproval, RunOwner, OwnerBeat } from "./types.js";
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
  /** True when only processes on this machine can write the store: a
   *  directory or a file on its disk, not a database reached over a network. */
  readonly local: boolean;
  /** `owner`: the process executing a top-level run; sub-flow instances have none. */
  create(id: string, flow: string, state: FlowState, owner?: RunOwner): Awaitable<InstanceRecord>;
  get(id: string): Awaitable<InstanceRecord | null>;
  /** A top-level run's list row (what listRuns returns for it), read without
   *  parsing its record where the store can. Null for an unknown run. */
  summary(id: string): Awaitable<RunIndexEntry | null>;
  update(id: string, patch: Partial<InstanceRecord>): Awaitable<InstanceRecord>;
  checkpoint(id: string, patch: Partial<InstanceRecord>, memo?: { node: string; output: unknown }, approval?: PendingApproval): Awaitable<InstanceRecord>;
  /** Change a record only if it is still what the caller expects: `change`
   *  sees the record as it is now, under the store's lock, and returns the
   *  fields to set, or null to leave it. Resolves to the changed record, or
   *  null when it was left or does not exist. */
  amend(id: string, change: (record: InstanceRecord) => Partial<InstanceRecord> | null): Awaitable<InstanceRecord | null>;
  memoize(id: string, node: string, output: unknown): Awaitable<void>;
  getMemoized(id: string, node: string): Awaitable<{ found: boolean; output: unknown }>;
  list(status?: string): Awaitable<InstanceRecord[]>;
  addApproval(approval: PendingApproval): Awaitable<void>;
  resume(token: string, transform: (record: InstanceRecord) => InstanceRecord): Awaitable<InstanceRecord>;
  resolveApproval(token: string): Awaitable<PendingApproval | null>;
  listApprovals(): Awaitable<PendingApproval[]>;
  /** Engine processes (ownership.ts). `beat`: this process is alive now. */
  beat(owner: RunOwner): Awaitable<void>;
  /** Every process that has beaten here and not been forgotten. */
  owners(): Awaitable<OwnerBeat[]>;
  /** With `quietForMs`: only if it has not been heard from for longer than
   *  that, checked as it is removed. */
  forgetOwner(id: string, quietForMs?: number): Awaitable<void>;
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
