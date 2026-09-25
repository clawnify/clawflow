import * as fs from "fs";
import * as path from "path";
import type { InstanceRecord } from "./store.js";
import type { FlowResult, TraceEntry } from "./types.js";

// ---- Run reads + retention -------------------------------------------------------
// How callers see stored runs: a paged list, a summary of one run, and one value
// of a run read by path, plus the retention sweep that deletes old finished runs.
//
// Used by the plugin's flow_status / flow_run / flow_resume tools in-process, and
// by out-of-process platform callers (e.g. the Clawnify hook server) that import
// these functions directly from dist, like manage.ts, so the run record format is
// read in exactly one place.
//
// Every run is one JSON file in the state directory, so the run list grows with
// every trigger that fires, and one record carries each node's output more than
// once (state, completedNodes, trace). Returned whole, either overflows what an
// agent can read in one tool result. So every read here is bounded: the list by
// a page, a record by a summary once it is too big, a value by a page of items or
// characters.

/**
 * Characters of one tool result an agent on the box reliably sees whole. Hosts
 * cut larger tool results, keeping the start, so the on-box tools return a
 * summary instead of letting the end of a record disappear.
 */
export const ON_BOX_RESULT_CHARS = 16_000;

const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
const SCALAR_MAX_CHARS = 120;
const OUTLINE_MAX_DEPTH = 3;
const OUTLINE_MAX_ENTRIES = 60;
const DAY_MS = 86_400_000;

/** Sub-flow instance files: `<parentId>_<kind>_<node>[_<n>].json`. */
const SUB_FLOW_FILE = /_(loop|condition|branch|parallel)_/;

// ---- List ------------------------------------------------------------------------

export interface RunRow {
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

export interface RunPage {
  runs: RunRow[];
  /** Runs matching the filters, across all pages. */
  total: number;
  /** Pass back as `cursor` for the next page; null on the last page. */
  next_cursor: string | null;
}

export interface ListRunsOptions {
  /** Runs per page, 1..100. Default 20. */
  limit?: number;
  /** `next_cursor` from the previous page. */
  cursor?: string;
  /** Only runs of this flow (the definition's `flow` name). */
  flow?: string;
  status?: string;
}

/**
 * Runs newest first, a page at a time. The cursor is keyed on
 * (createdAt, instanceId), not an offset, so runs that start while a caller
 * pages never shift a page under it, and runs created in the same millisecond
 * are neither skipped nor repeated.
 */
export function listRuns(stateDir: string, opts: ListRunsOptions = {}): RunPage {
  const limit = opts.limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new Error(`limit must be a whole number between 1 and ${MAX_PAGE}`);
  }
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !after) {
    throw new Error("cursor is not one this list returned; start again without it");
  }

  const rows: RunRow[] = [];
  for (const record of readTopLevelRecords(stateDir)) {
    if (opts.flow && record.flowName !== opts.flow) continue;
    if (opts.status && record.status !== opts.status) continue;
    rows.push(toRow(record));
  }
  rows.sort(newestFirst);
  const rest = after ? rows.filter((r) => newestFirst(r, after) > 0) : rows;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page,
    total: rows.length,
    next_cursor: rest.length > limit && last ? encodeCursor(last) : null,
  };
}

function toRow(r: InstanceRecord): RunRow {
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

type Keyed = { createdAt: string; instanceId: string };

/** (createdAt, instanceId) descending. Positive when `a` sorts after `b`. */
function newestFirst(a: Keyed, b: Keyed): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.instanceId !== b.instanceId) return a.instanceId < b.instanceId ? 1 : -1;
  return 0;
}

function encodeCursor(k: Keyed): string {
  return btoa(encodeURIComponent(JSON.stringify([k.createdAt, k.instanceId])));
}

function decodeCursor(cursor: string): Keyed | null {
  try {
    const v = JSON.parse(decodeURIComponent(atob(cursor))) as unknown;
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string"
      ? { createdAt: v[0], instanceId: v[1] }
      : null;
  } catch {
    return null;
  }
}

/** Top-level run records; sub-flow files are skipped by name, before parsing. */
function* readTopLevelRecords(stateDir: string): Generator<InstanceRecord> {
  if (!fs.existsSync(stateDir)) return;
  for (const name of fs.readdirSync(stateDir)) {
    if (!isTopLevelRunFile(name)) continue;
    let record: InstanceRecord;
    try {
      record = JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8")) as InstanceRecord;
    } catch {
      continue;
    }
    if (!record || typeof record.instanceId !== "string" || record.instanceId.includes(":")) continue;
    yield record;
  }
}

function isTopLevelRunFile(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith("_") && !SUB_FLOW_FILE.test(name);
}

// ---- Summary ---------------------------------------------------------------------

export interface ValueOutline {
  path: string;
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  /** Serialized size, for containers and long strings. */
  chars?: number;
  /** Item count for arrays, key count for objects. */
  length?: number;
  /** Short scalars are shown whole. */
  value?: string | number | boolean | null;
}

export type TraceSummary = Omit<TraceEntry, "output"> & { outputChars?: number };

export interface RunSummary {
  summary: true;
  instanceId: string;
  flowName: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
  pausedAt?: string;
  resumeToken?: string;
  waitingFor?: unknown;
  /** One entry per state key (node outputs, inputs, env), with its size. */
  state: ValueOutline[];
  /** Every trace entry, with the output's size in place of the output. */
  trace: TraceSummary[];
  /** Characters of the full record this summarizes. */
  fullChars: number;
  read_more: string;
}

/**
 * A run too big to return whole: status, error, where it paused, each state
 * key with its size, and the trace without outputs. Accepts a stored record or
 * the FlowResult flow_run returns.
 */
export function summarizeRun(run: InstanceRecord | FlowResult, fullChars?: number): RunSummary {
  const r = run as Partial<InstanceRecord> & Partial<FlowResult>;
  const state = (r.state ?? {}) as Record<string, unknown>;
  return {
    summary: true,
    instanceId: r.instanceId ?? "",
    flowName: r.flowName ?? "",
    status: r.status ?? "",
    ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.pausedAt ? { pausedAt: r.pausedAt } : {}),
    ...(r.resumeToken ? { resumeToken: r.resumeToken } : {}),
    ...(r.waitingFor ? { waitingFor: r.waitingFor } : {}),
    state: Object.entries(state).map(([key, value]) => describe(`state.${key}`, value)),
    trace: (r.trace ?? []).map((entry) => {
      const { output, ...rest } = entry;
      return output === undefined ? rest : { ...rest, outputChars: serializedLength(output) };
    }),
    fullChars: fullChars ?? serializedLength(run),
    read_more:
      "Read one value with flow_status { instanceId, path }, e.g. path \"state.<key>\" or " +
      "\"trace.<i>.output\"; arrays and long strings come back a page at a time (offset, limit).",
  };
}

/**
 * The run whole when it fits in `maxChars` serialized, else its summary. What
 * every tool that returns a run hands back.
 */
export function runView(run: InstanceRecord | FlowResult, maxChars = ON_BOX_RESULT_CHARS): unknown {
  const chars = serializedLength(run);
  return chars <= maxChars ? run : summarizeRun(run, chars);
}

// ---- One value by path -----------------------------------------------------------

export interface ReadValueOptions {
  /** Where a page starts: an item index for arrays, a character index for strings. */
  offset?: number;
  /** Items (arrays, default 20, max 100) or characters (strings) per page. */
  limit?: number;
  /** The largest serialized result to return; bigger objects come back as an outline. */
  maxChars?: number;
}

/**
 * One value of a run by dot path (`state.leads`, `trace.3.output`,
 * `completedNodes.fetch`). Arrays come back a page of items at a time, strings a
 * page of characters, and an object too big to return is replaced by its
 * outline, with paths the caller can pass back. Keys containing a dot are not
 * addressable.
 */
export function readRunValue(
  run: InstanceRecord | FlowResult,
  valuePath: string,
  opts: ReadValueOptions = {},
): Record<string, unknown> {
  const maxChars = opts.maxChars ?? ON_BOX_RESULT_CHARS;
  const segments = valuePath.split(".").filter((s) => s !== "");
  if (!segments.length) throw new Error("path is empty");

  let node: unknown = run;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const at = segments.slice(0, i).join(".") || "the run";
    if (Array.isArray(node)) {
      const index = Number(seg);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        throw new Error(`"${seg}" is not an index of ${at}, an array of ${node.length}`);
      }
      node = node[index];
    } else if (isRecord(node)) {
      if (!(seg in node)) {
        const keys = Object.keys(node);
        throw new Error(
          `"${seg}" is not a field of ${at}. Fields: ${keys.slice(0, 40).join(", ")}` +
            (keys.length > 40 ? `, … (${keys.length} total)` : ""),
        );
      }
      node = node[seg];
    } else {
      throw new Error(`${at} is ${node === null ? "null" : `a ${typeof node}`}, not an object or array`);
    }
  }

  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a whole number, 0 or more");

  if (Array.isArray(node)) {
    const limit = opts.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new Error(`limit for an array must be between 1 and ${MAX_PAGE} items`);
    }
    // Fewer items when a page would not fit, down to one.
    let end = Math.min(offset + limit, node.length);
    while (end - offset > 1 && serializedLength(node.slice(offset, end)) > maxChars) {
      end = offset + Math.ceil((end - offset) / 2);
    }
    if (end - offset === 1 && isRecord(node[offset]) && serializedLength(node[offset]) > maxChars) {
      return withheldObject(`${valuePath}.${offset}`, node[offset] as Record<string, unknown>, maxChars);
    }
    return {
      path: valuePath,
      type: "array",
      total: node.length,
      offset,
      items: node.slice(offset, end),
      next_offset: end < node.length ? end : null,
    };
  }
  if (typeof node === "string") {
    const pageChars = Math.floor(maxChars * 0.75);
    const limit = opts.limit ?? pageChars;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxChars) {
      throw new Error(`limit for a string must be between 1 and ${maxChars} characters`);
    }
    const end = Math.min(offset + limit, node.length);
    return {
      path: valuePath,
      type: "string",
      total_chars: node.length,
      offset,
      text: node.slice(offset, end),
      next_offset: end < node.length ? end : null,
    };
  }
  if (isRecord(node) && serializedLength(node) > maxChars) {
    return withheldObject(valuePath, node, maxChars);
  }
  return { path: valuePath, type: node === null ? "null" : typeof node, value: node };
}

function withheldObject(at: string, node: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const { entries, omitted } = outline(node, at);
  return {
    path: at,
    type: "object",
    withheld: true,
    reason: `The object at "${at}" is over ${maxChars} characters; read one of its fields by a deeper path.`,
    outline: entries,
    ...(omitted ? { outline_omitted: omitted } : {}),
  };
}

/** Every field down to three levels, shallowest first, capped at 60 entries. */
function outline(value: Record<string, unknown>, prefix: string): { entries: ValueOutline[]; omitted: number } {
  const entries: ValueOutline[] = [];
  let omitted = 0;
  let level = Object.entries(value).map(([k, v]) => ({ path: `${prefix}.${k}`, node: v }));
  for (let depth = 1; depth <= OUTLINE_MAX_DEPTH && level.length; depth++) {
    const next: Array<{ path: string; node: unknown }> = [];
    for (const { path: p, node } of level) {
      if (entries.length >= OUTLINE_MAX_ENTRIES) {
        omitted++;
        continue;
      }
      entries.push(describe(p, node));
      if (isRecord(node)) next.push(...Object.entries(node).map(([k, v]) => ({ path: `${p}.${k}`, node: v })));
    }
    level = next;
  }
  omitted += level.length;
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, omitted };
}

function describe(p: string, node: unknown): ValueOutline {
  if (node === null || node === undefined) return { path: p, type: "null", value: null };
  if (Array.isArray(node)) return { path: p, type: "array", length: node.length, chars: serializedLength(node) };
  if (typeof node === "object") {
    return { path: p, type: "object", length: Object.keys(node).length, chars: serializedLength(node) };
  }
  if (typeof node === "string") {
    return node.length <= SCALAR_MAX_CHARS
      ? { path: p, type: "string", value: node }
      : { path: p, type: "string", chars: node.length };
  }
  if (typeof node === "number" || typeof node === "boolean") {
    return { path: p, type: typeof node as "number" | "boolean", value: node };
  }
  return { path: p, type: "null", value: null };
}

// ---- Retention -------------------------------------------------------------------

export const DEFAULT_RUN_RETENTION_DAYS = 30;

const FINISHED = new Set(["completed", "failed", "cancelled"]);

export interface PruneResult {
  /** Top-level runs deleted. */
  runs: number;
  /** Files deleted, including sub-flow instance files. */
  files: number;
}

/**
 * Delete finished runs (completed, failed, cancelled) last updated more than
 * `retentionDays` ago, with their sub-flow files. Runs that are running, paused
 * or waiting are never deleted: a paused or waiting run is resumed from its
 * record. `retentionDays` 0 deletes nothing.
 */
export function pruneRuns(stateDir: string, retentionDays: number, now = Date.now()): PruneResult {
  const result: PruneResult = { runs: 0, files: 0 };
  if (!(retentionDays > 0) || !fs.existsSync(stateDir)) return result;
  const cutoff = now - retentionDays * DAY_MS;
  const names = fs.readdirSync(stateDir);
  const expired = new Set<string>();

  for (const name of names) {
    if (!isTopLevelRunFile(name)) continue;
    let record: Partial<InstanceRecord>;
    try {
      record = JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8")) as Partial<InstanceRecord>;
    } catch {
      continue;
    }
    const last = Date.parse(record.updatedAt ?? record.createdAt ?? "");
    if (!FINISHED.has(String(record.status)) || !(last < cutoff)) continue;
    expired.add(name.slice(0, -".json".length));
  }

  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    const base = name.slice(0, -".json".length);
    const sub = SUB_FLOW_FILE.exec(base);
    const owner = sub ? base.slice(0, sub.index) : base;
    if (!expired.has(owner)) continue;
    try {
      fs.unlinkSync(path.join(stateDir, name));
      result.files++;
      if (!sub) result.runs++;
    } catch {
      // Already gone, or not ours to delete: the next sweep retries.
    }
  }
  return result;
}

// ---- Shared ----------------------------------------------------------------------

function serializedLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
