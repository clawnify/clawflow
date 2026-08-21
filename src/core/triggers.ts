import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

// ---- Trigger Records ------------------------------------------------------------
// A trigger is a schedule that fires a flow. It is a first-class record, NOT a
// field on the flow definition: a schedule is mutable operational state (pause it
// at 2am, retime it, point it at a different version) while a published flow
// version is an immutable artifact. Embedding one in the other would make "pause"
// mean "publish a new version", and would let an unrelated publish silently
// re-arm a schedule the draft happened to carry.
//
// Layout mirrors versions: .clawflow/triggers/<triggerId>.json — one file per
// record, so N triggers can target one flow with different cadences and inputs.

export interface TriggerRecord {
  id: string;
  flowName: string;
  /** Which definition to run: a pinned version, or "@published" (latest). */
  version: number | "@published";
  /** Standard 5-field cron expression. */
  cron: string;
  /** IANA timezone (e.g. "Europe/Rome"). Host local time when unset. */
  tz?: string;
  /** Payload passed as the flow's inputs on every fire. */
  inputs?: Record<string, unknown>;
  enabled: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastInstanceId?: string;
  /** Informational: when the scheduler expects to fire next. */
  nextRunAt?: string;
}

export interface CreateTriggerInput {
  flowName: string;
  cron: string;
  version?: number | "@published";
  tz?: string;
  inputs?: Record<string, unknown>;
  enabled?: boolean;
  description?: string;
  /** Explicit id (used when restoring); generated when omitted. */
  id?: string;
}

export class TriggerStore {
  private dir: string;

  constructor(workspace?: string, triggersDir?: string) {
    const root =
      workspace ??
      process.env.OPENCLAW_WORKSPACE ??
      process.env.HOME ??
      ".";
    this.dir = triggersDir ?? path.join(root, ".clawflow", "triggers");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create(input: CreateTriggerInput): TriggerRecord {
    const now = new Date().toISOString();
    const id = input.id ?? generateId(input.flowName);
    if (this.get(id)) throw new Error(`Trigger already exists: ${id}`);
    const record: TriggerRecord = {
      id,
      flowName: input.flowName,
      version: input.version ?? "@published",
      cron: input.cron,
      ...(input.tz ? { tz: input.tz } : {}),
      ...(input.inputs ? { inputs: input.inputs } : {}),
      enabled: input.enabled !== false,
      ...(input.description ? { description: input.description } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.write(record);
    return record;
  }

  get(id: string): TriggerRecord | null {
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as TriggerRecord;
    } catch {
      return null;
    }
  }

  update(id: string, patch: Partial<TriggerRecord>): TriggerRecord {
    const existing = this.get(id);
    if (!existing) throw new Error(`Trigger not found: ${id}`);
    const updated: TriggerRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    return updated;
  }

  remove(id: string): boolean {
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  list(opts?: { flowName?: string; enabledOnly?: boolean }): TriggerRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    const records = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(this.dir, f), "utf8"),
          ) as TriggerRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is TriggerRecord => r !== null);

    return records
      .filter((r) => (opts?.flowName ? r.flowName === opts.flowName : true))
      .filter((r) => (opts?.enabledOnly ? r.enabled : true))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Pause every trigger targeting a flow, returning the ids paused.
   *
   * Called when a flow is soft-deleted. Paused rather than removed so a restore
   * keeps its schedules — and so restoring never silently re-arms unattended
   * runs; that takes an explicit resume.
   */
  pauseForFlow(flowName: string): string[] {
    const affected = this.list({ flowName }).filter((r) => r.enabled);
    for (const record of affected) {
      this.update(record.id, { enabled: false, nextRunAt: undefined });
    }
    return affected.map((r) => r.id);
  }

  // ---- Internals ---------------------------------------------------------------

  private filePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  private write(record: TriggerRecord): void {
    fs.writeFileSync(
      this.filePath(record.id),
      JSON.stringify(record, null, 2),
    );
  }
}

function generateId(flowName: string): string {
  const safe = flowName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
  return `${safe}-${randomUUID().slice(0, 8)}`;
}
