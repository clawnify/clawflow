import * as fs from "fs";
import * as path from "path";
import type { FlowState, FlowResult } from "./types.js";

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
  resumeToken?: string;
  waitingFor?: FlowResult["waitingFor"];
  createdAt: string;
  updatedAt: string;
}

export class StateStore {
  private dir: string;

  constructor(stateDir?: string) {
    this.dir =
      stateDir ??
      path.join(process.env.HOME ?? ".", ".openclaw", "flow-state");
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

  private filePath(instanceId: string): string {
    const safe = instanceId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  private write(record: InstanceRecord): void {
    fs.writeFileSync(
      this.filePath(record.instanceId),
      JSON.stringify(record, null, 2),
    );
  }
}
