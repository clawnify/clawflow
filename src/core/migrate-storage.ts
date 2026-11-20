import { opendir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { createStateStore, type StorageConfig } from "./storage.js";
import { SqlStateStore } from "./sql-store.js";
import type { InstanceRecord } from "./store.js";
import type { PendingApproval } from "./types.js";

/**
 * Offline, restartable copy. Stop every writer first. Source files are never
 * changed. Each run and its approvals commit together; an error stops the
 * import, and re-running accepts identical records but refuses changed ones.
 */
export async function importJsonState(sourceDir: string, storage: Exclude<StorageConfig, { backend: "json" }>): Promise<{ runs: number; approvals: number }> {
  const store = createStateStore(sourceDir, storage) as SqlStateStore;
  const result = { runs: 0, approvals: 0 };
  try {
    let approvals: PendingApproval[] = [];
    try {
      approvals = JSON.parse(await readFile(path.join(sourceDir, "_pending-approvals.json"), "utf8"));
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (!Array.isArray(approvals) || approvals.some((a) => !a || typeof a.token !== "string" || typeof a.instanceId !== "string" || typeof a.expiresAt !== "string")) {
      throw new Error("Invalid pending approvals file; source was not modified");
    }
    const pending = new Map<string, PendingApproval[]>();
    for (const a of approvals) pending.set(a.instanceId, [...(pending.get(a.instanceId) ?? []), a]);
    // opendir and per-record transactions keep the copy bounded by one run,
    // rather than loading the whole checkpoint directory into memory.
    for await (const file of await opendir(sourceDir)) {
      if (!file.isFile() || !file.name.endsWith(".json") || file.name === "_pending-approvals.json") continue;
      const record = JSON.parse(await readFile(path.join(sourceDir, file.name), "utf8")) as InstanceRecord;
      if (!record || typeof record.instanceId !== "string" || !record.instanceId || typeof record.flowName !== "string"
        || !["running", "completed", "paused", "waiting", "failed", "cancelled"].includes(record.status)
        || !record.state || typeof record.state !== "object" || Array.isArray(record.state)
        || !record.completedNodes || typeof record.completedNodes !== "object" || Array.isArray(record.completedNodes)
        || !Array.isArray(record.trace) || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
        throw new Error(`Invalid instance record: ${file.name}; source was not modified`);
      }
      const forRun = pending.get(record.instanceId) ?? [];
      await store.importRecords([record], forRun);
      pending.delete(record.instanceId);
      result.runs++;
      result.approvals += forRun.length;
    }
    if (pending.size) throw new Error("Pending approvals reference missing runs; source was not modified");
    return result;
  } finally { await store.close(); }
}
