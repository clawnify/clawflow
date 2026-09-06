import * as fs from "fs";
import * as path from "path";
import type { FlowDefinition } from "./types.js";

// ---- Draft / Version Management -------------------------------------------------
// Engine-owned draft + published-version semantics: the draft file convention
// (workspace/flows/<name>.json), the versions directory layout
// (.clawflow/versions/<flowName>/<N>.json), next-version assignment, and the
// version stamp.
//
// Used by the plugin's flow_* tools in-process, and by out-of-process platform
// callers (e.g. the Clawnify hook server) that import these functions directly
// from dist — so the layout exists in exactly one place.
//
// NOTE: none of these functions validate. Validation needs the caller's step
// registry (custom steps registered by sibling plugins live in the gateway
// process), so each caller validates first with the registry it has: the
// plugin tools use the in-process defaultRegistry, the hook server uses the
// flow server's POST /flows/validate route.

/** Resolve a file param to an absolute path using workspace conventions. */
export function resolveFlowFile(workspace: string, file: string): string {
  if (file.startsWith("/")) return file;
  if (file.includes("/")) return path.join(workspace, file);
  const name = file.replace(/\.json$/, "");
  return path.join(workspace, "flows", `${name}.json`);
}

/** Get the versions directory for a flow name. */
export function versionsDir(workspace: string, flowName: string): string {
  return path.join(workspace, ".clawflow", "versions", flowName);
}

/** List all published version numbers for a flow, sorted ascending. */
export function listVersions(workspace: string, flowName: string): number[] {
  const dir = versionsDir(workspace, flowName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f: string) => /^\d+\.json$/.test(f))
    .map((f: string) => parseInt(f, 10))
    .sort((a: number, b: number) => a - b);
}

/** Read a specific published version. Returns null if not found. */
export function readVersion(
  workspace: string,
  flowName: string,
  version: number,
): FlowDefinition | null {
  const file = path.join(versionsDir(workspace, flowName), `${version}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as FlowDefinition;
}

/** Get the latest published version definition. Returns null if none published. */
export function readLatestVersion(
  workspace: string,
  flowName: string,
): { version: number; def: FlowDefinition } | null {
  const versions = listVersions(workspace, flowName);
  if (versions.length === 0) return null;
  const latest = versions[versions.length - 1];
  const def = readVersion(workspace, flowName, latest);
  if (!def) return null;
  return { version: latest, def };
}

export interface PublishResult {
  flow: string;
  version: number;
  file: string;
  totalVersions: number;
}

/**
 * Publish the current draft of a flow as a new numbered version.
 *
 * Reads the draft from `file` (workspace conventions, see resolveFlowFile),
 * assigns the next version number (auto-incrementing integer), stamps it into
 * the definition, and saves an immutable copy to
 * .clawflow/versions/<flowName>/<N>.json. After publishing, flow_run uses this
 * version by default.
 *
 * Throws Error("Draft not found: …") when the draft file is missing and
 * Error("Failed to parse …") when it isn't valid JSON. Does NOT validate the
 * definition — callers validate first (see module note).
 */
export function publishDraft(workspace: string, file: string): PublishResult {
  const abs = resolveFlowFile(workspace, file);
  if (!fs.existsSync(abs)) {
    throw new Error(`Draft not found: ${abs}`);
  }

  let flowDef: FlowDefinition;
  try {
    flowDef = JSON.parse(fs.readFileSync(abs, "utf-8")) as FlowDefinition;
  } catch (err) {
    throw new Error(
      `Failed to parse ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const flowName = path.basename(abs, ".json");
  const versions = listVersions(workspace, flowName);
  const nextVersion = versions.length > 0 ? versions[versions.length - 1] + 1 : 1;

  // Stamp the version number into the definition
  flowDef.version = String(nextVersion);

  const dir = versionsDir(workspace, flowName);
  fs.mkdirSync(dir, { recursive: true });
  const versionFile = path.join(dir, `${nextVersion}.json`);
  fs.writeFileSync(versionFile, JSON.stringify(flowDef, null, 2) + "\n");

  return {
    flow: flowDef.flow,
    version: nextVersion,
    file: versionFile,
    totalVersions: nextVersion,
  };
}

/**
 * Resolve what an incoming trigger should execute: a pinned version when one is
 * requested, else the latest PUBLISHED version, else the draft.
 *
 * This is the one place that answers "which definition does a trigger run".
 * The flow server, the scheduler, and any off-box caller share it so a webhook,
 * a cron trigger, and an agent run can never execute different definitions of
 * the same flow — the invariant 1.5.1 established.
 *
 * Returns null when the flow (or the pinned version) does not exist.
 */
export function resolveRunnableFlow(
  workspace: string,
  flowsDir: string,
  flowName: string,
  version?: number | "@published",
): { def: FlowDefinition; version: number | null; source: string } | null {
  const safe = flowName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return null;

  if (typeof version === "number") {
    const def = readVersion(workspace, safe, version);
    return def ? { def, version, source: `v${version}` } : null;
  }

  const latest = readLatestVersion(workspace, safe);
  if (latest) {
    return { def: latest.def, version: latest.version, source: `v${latest.version}` };
  }

  const file = path.join(flowsDir, `${safe}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return {
      def: JSON.parse(fs.readFileSync(file, "utf8")) as FlowDefinition,
      version: null,
      source: "draft (no published versions)",
    };
  } catch {
    return null;
  }
}
