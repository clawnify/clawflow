import * as fs from "node:fs";
import * as path from "node:path";

import { FlowRunner, sendEvent } from "./runner.js";
import { validateFlow } from "./validate.js";
import type {
  FlowDefinition,
  FlowNode,
  BranchNode,
  ConditionNode,
  LoopNode,
  ParallelNode,
} from "./types.js";

// ---- Flow operations ------------------------------------------------------------
// The harness-neutral implementation of the flow_* tool surface. Each operation
// returns a plain { text, details? } result; harness wrappers (the OpenClaw
// plugin, the management API, future harness shims) adapt that to their own
// tool-result format. FLOW_OP_SPECS carries the tool metadata (name,
// description, JSON-schema parameters) as data so every harness registers the
// same surface without duplicating it.

export interface OpResult {
  text: string;
  details?: unknown;
}

export interface FlowOpSpec {
  /** Tool name, e.g. "flow_create". Also the op name for FlowOps.execute(). */
  name: string;
  description: string;
  /** JSON-schema for the tool parameters. */
  parameters: object;
  /** OpenClaw catalog hint — passed through by the OpenClaw plugin only. */
  catalogMode?: string;
}

// ---- Shared helpers -------------------------------------------------------------

/**
 * Recursively extract unique inputs.* paths from any string values in an
 * object tree. This tells agents what input fields a flow references — used
 * when the flow has no declared inputs block to give a best-effort hint.
 */
function extractInputRefs(obj: unknown): string[] {
  const paths = new Set<string>();
  const re = /\{\{\s*inputs\.(\w+(?:\.\w+)*)/g;

  function walk(val: unknown): void {
    if (typeof val === "string") {
      let m: RegExpExecArray | null;
      while ((m = re.exec(val)) !== null) paths.add(m[1]);
    } else if (Array.isArray(val)) {
      for (const item of val) walk(item);
    } else if (val && typeof val === "object") {
      for (const v of Object.values(val)) walk(v);
    }
  }
  walk(obj);
  return [...paths].sort();
}

/** Find a node by name, searching nested structures (branch paths, loop, parallel, condition). */
function findNode(nodes: FlowNode[], name: string): FlowNode | undefined {
  for (const n of nodes) {
    if (n.name === name) return n;
    if ("paths" in n && n.paths) {
      for (const branch of Object.values(
        n.paths as Record<string, FlowNode[]>,
      )) {
        const found = findNode(branch, name);
        if (found) return found;
      }
    }
    if ("default" in n && Array.isArray(n.default)) {
      const found = findNode(n.default as FlowNode[], name);
      if (found) return found;
    }
    if ("nodes" in n && Array.isArray(n.nodes)) {
      const found = findNode(n.nodes as FlowNode[], name);
      if (found) return found;
    }
    if ("then" in n && Array.isArray(n.then)) {
      const found = findNode(n.then as FlowNode[], name);
      if (found) return found;
    }
    if ("else" in n && Array.isArray((n as ConditionNode).else)) {
      const found = findNode((n as ConditionNode).else!, name);
      if (found) return found;
    }
  }
  return undefined;
}

// ---- FlowOps --------------------------------------------------------------------

export class FlowOps {
  constructor(
    private workspace: string,
    private runner: FlowRunner,
  ) {}

  private get store() {
    return this.runner.getStore();
  }

  /** Resolve a file param to an absolute path using workspace conventions. */
  private resolveFlowFile(file: string): string {
    const base = this.workspace;
    if (file.startsWith("/")) return file;
    if (file.includes("/")) return path.join(base, file);
    const name = file.replace(/\.json$/, "");
    return path.join(base, "flows", `${name}.json`);
  }

  /** Get the versions directory for a flow name. */
  private versionsDir(flowName: string): string {
    return path.join(this.workspace, ".clawflow", "versions", flowName);
  }

  /** List all published version numbers for a flow, sorted ascending. */
  private listVersions(flowName: string): number[] {
    const dir = this.versionsDir(flowName);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f: string) => /^\d+\.json$/.test(f))
      .map((f: string) => parseInt(f, 10))
      .sort((a: number, b: number) => a - b);
  }

  /** Read a specific published version. Returns null if not found. */
  private readVersion(flowName: string, version: number): FlowDefinition | null {
    const file = path.join(this.versionsDir(flowName), `${version}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as FlowDefinition;
  }

  /** Get the latest published version definition. Returns null if none published. */
  private readLatestVersion(flowName: string): { version: number; def: FlowDefinition } | null {
    const versions = this.listVersions(flowName);
    if (versions.length === 0) return null;
    const latest = versions[versions.length - 1];
    const def = this.readVersion(flowName, latest);
    if (!def) return null;
    return { version: latest, def };
  }

  /** Dispatch an op by its tool name (e.g. "flow_run"). Throws on unknown name. */
  async execute(name: string, params: unknown): Promise<OpResult> {
    const p = (params ?? {}) as never;
    switch (name) {
      case "flow_create": return this.create(p);
      case "flow_delete": return this.deleteFlow(p);
      case "flow_restore_from_bin": return this.restoreFromBin(p);
      case "flow_run": return this.run(p);
      case "flow_resume": return this.resume(p);
      case "flow_send_event": return this.sendEvent(p);
      case "flow_status": return this.status(p);
      case "flow_list": return this.list(p);
      case "flow_read": return this.read(p);
      case "flow_publish": return this.publish(p);
      case "flow_edit": return this.edit(p);
      default:
        throw new Error(`Unknown flow op: "${name}"`);
    }
  }

  // ---- flow_create --------------------------------------------------------------

  async create(params: {
    file: string;
    flow: string;
    description?: string;
    nodes: FlowNode[];
    inputs?: FlowDefinition["inputs"];
    env?: Record<string, string | null>;
    version?: string;
  }): Promise<OpResult> {
    const abs = this.resolveFlowFile(params.file);

    if (fs.existsSync(abs))
      return { text: `File already exists: ${abs}. Use flow_edit to modify it.` };

    const flowDef: FlowDefinition = {
      flow: params.flow,
      ...(params.version && { version: params.version }),
      ...(params.description && { description: params.description }),
      ...(params.inputs && { inputs: params.inputs }),
      ...(params.env && { env: params.env }),
      nodes: params.nodes,
    };

    const validation = validateFlow(flowDef);
    if (!validation.ok)
      return {
        text: `Validation failed:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
      };

    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: `Cannot create directory for ${abs}: ${msg}. Is OPENCLAW_WORKSPACE set? Current workspace root: ${this.workspace}`,
      };
    }
    fs.writeFileSync(abs, JSON.stringify(flowDef, null, 2) + "\n");

    return {
      text: `Flow "${params.flow}" created at ${abs}`,
      details: flowDef,
    };
  }

  // ---- flow_delete --------------------------------------------------------------

  async deleteFlow(params: { file: string }): Promise<OpResult> {
    const abs = this.resolveFlowFile(params.file);

    if (!fs.existsSync(abs))
      return { text: `File not found: ${abs}` };

    const binDir = path.join(this.workspace, ".clawflow", "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const basename = path.basename(abs, ".json");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const binPath = path.join(binDir, `${basename}.${ts}.json`);

    fs.renameSync(abs, binPath);

    return { text: `Flow moved to bin: ${binPath}` };
  }

  // ---- flow_restore_from_bin ------------------------------------------------------

  async restoreFromBin(params: { name?: string }): Promise<OpResult> {
    const binDir = path.join(this.workspace, ".clawflow", "bin");

    if (!fs.existsSync(binDir))
      return { text: "Bin is empty." };

    const files = fs.readdirSync(binDir)
      .filter((f: string) => f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0)
      return { text: "Bin is empty." };

    // ---- List mode ---
    if (!params.name) {
      const entries = files.map((f: string) => {
        const match = f.match(/^(.+?)\.(\d{4}-.+)\.json$/);
        return {
          name: match?.[1] ?? f,
          deletedAt: match?.[2] ?? "unknown",
          file: f,
        };
      });
      return {
        text: JSON.stringify(entries, null, 2),
        details: entries,
      };
    }

    // ---- Restore mode ---
    const prefix = params.name.replace(/\.json$/, "");
    const match = files.find((f: string) => f.startsWith(`${prefix}.`));

    if (!match)
      return { text: `No bin entry found for "${prefix}".` };

    const dest = path.join(this.workspace, "flows", `${prefix}.json`);
    if (fs.existsSync(dest))
      return {
        text: `Cannot restore: ${dest} already exists. Delete or rename it first.`,
      };

    fs.renameSync(path.join(binDir, match), dest);

    return { text: `Restored "${prefix}" from bin to ${dest}` };
  }

  // ---- flow_run -----------------------------------------------------------------

  async run(params: {
    flow?: FlowDefinition;
    file?: string;
    input?: unknown;
    draft?: boolean;
    version?: number;
  }): Promise<OpResult> {
    let flowDef: FlowDefinition;
    let source = "";

    if (params.file) {
      const abs = this.resolveFlowFile(params.file);

      // Determine flow name for version lookup
      const flowName = path.basename(abs, ".json");

      if (params.version != null) {
        // Specific version requested
        const vDef = this.readVersion(flowName, params.version);
        if (!vDef)
          return {
            text: `Version ${params.version} not found for flow "${flowName}". Available: ${this.listVersions(flowName).join(", ") || "none (not yet published)"}`,
          };
        flowDef = vDef;
        source = `v${params.version}`;
      } else if (!params.draft) {
        // Default: use latest published version if available
        const latest = this.readLatestVersion(flowName);
        if (latest) {
          flowDef = latest.def;
          source = `v${latest.version}`;
        } else {
          // No published versions — fall back to draft
          if (!fs.existsSync(abs))
            return { text: `File not found: ${abs}` };
          flowDef = JSON.parse(fs.readFileSync(abs, "utf8")) as FlowDefinition;
          source = "draft (no published versions)";
        }
      } else {
        // Explicit draft mode
        if (!fs.existsSync(abs))
          return { text: `File not found: ${abs}` };
        flowDef = JSON.parse(fs.readFileSync(abs, "utf8")) as FlowDefinition;
        source = "draft";
      }
    } else if (params.flow) {
      flowDef = params.flow as FlowDefinition;
      source = "inline";
    } else {
      return { text: "Provide either `flow` (inline definition) or `file` (path)." };
    }

    try {
      const result = await this.runner.run(flowDef, params.input ?? {});
      const out = { ...result, _source: source };
      return {
        text: JSON.stringify(out, null, 2),
        details: out,
      };
    } catch (err) {
      return {
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---- flow_resume --------------------------------------------------------------

  async resume(params: {
    instanceId: string;
    approved: boolean;
    flow: FlowDefinition;
  }): Promise<OpResult> {
    try {
      const result = await this.runner.resume(
        params.instanceId,
        params.flow,
        params.approved,
      );
      return {
        text: JSON.stringify(result, null, 2),
        details: result,
      };
    } catch (err) {
      return {
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---- flow_send_event ----------------------------------------------------------

  async sendEvent(params: {
    instanceId: string;
    eventType: string;
    payload?: unknown;
  }): Promise<OpResult> {
    const delivered = sendEvent(
      params.instanceId,
      params.eventType,
      params.payload ?? {},
    );
    if (!delivered) {
      return {
        text: `No active waiter found for instance "${params.instanceId}" event "${params.eventType}". The flow may not be waiting, or the event type doesn't match.`,
      };
    }
    return {
      text: `Event "${params.eventType}" delivered to instance "${params.instanceId}".`,
    };
  }

  // ---- flow_status --------------------------------------------------------------

  async status(params: { instanceId?: string; filter?: string }): Promise<OpResult> {
    if (params.instanceId) {
      const record = this.store.get(params.instanceId);
      if (!record)
        return { text: `Instance not found: ${params.instanceId}` };
      return {
        text: JSON.stringify(record, null, 2),
        details: record,
      };
    }
    const records = this.store.list(params.filter);
    const summary = records.map((r) => ({
      instanceId: r.instanceId,
      flow: r.flowName,
      status: r.status,
      updatedAt: r.updatedAt,
      waitingFor: r.waitingFor,
    }));
    return {
      text: JSON.stringify(summary, null, 2),
      details: summary,
    };
  }

  // ---- flow_list ----------------------------------------------------------------

  async list(params: { dir?: string }): Promise<OpResult> {
    const base = this.workspace;

    let dir: string;
    if (!params.dir) {
      dir = path.join(base, "flows");
    } else if (params.dir.startsWith("/")) {
      dir = params.dir;
    } else {
      dir = path.join(base, params.dir);
    }

    if (!fs.existsSync(dir)) {
      return { text: `Flows directory not found: ${dir}` };
    }

    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"));

    if (files.length === 0) {
      return { text: `No flow files found in ${dir}` };
    }

    const flows: Array<{
      file: string;
      flow: string;
      description?: string;
      inputs?: FlowDefinition["inputs"];
      expectedInputs?: string[];
      publishedVersion?: number;
      totalVersions?: number;
      nodes: number;
    }> = [];

    for (const file of files) {
      const abs = path.join(dir, file);
      try {
        const raw = fs.readFileSync(abs, "utf-8");
        const def = JSON.parse(raw) as FlowDefinition;
        if (!def.flow || !Array.isArray(def.nodes)) continue;
        const referenced = extractInputRefs(def.nodes);
        const flowName = file.replace(/\.json$/, "");
        const versions = this.listVersions(flowName);
        flows.push({
          file: abs,
          flow: def.flow,
          ...(def.description && { description: def.description }),
          ...(def.inputs && { inputs: def.inputs }),
          ...(referenced.length > 0 && { expectedInputs: referenced }),
          ...(versions.length > 0 && {
            publishedVersion: versions[versions.length - 1],
            totalVersions: versions.length,
          }),
          nodes: def.nodes.length,
        });
      } catch {
        // skip non-flow JSON files
      }
    }

    if (flows.length === 0) {
      return { text: `No valid flow definitions found in ${dir}` };
    }

    return {
      text: JSON.stringify(flows, null, 2),
      details: flows,
    };
  }

  // ---- flow_read ----------------------------------------------------------------

  async read(params: { file: string; node?: string; version?: number }): Promise<OpResult> {
    const abs = this.resolveFlowFile(params.file);
    const flowName = path.basename(abs, ".json");
    const versions = this.listVersions(flowName);

    let flowDef: FlowDefinition;
    let source: string;

    if (params.version != null) {
      const vDef = this.readVersion(flowName, params.version);
      if (!vDef) {
        return {
          text: `Version ${params.version} not found for "${flowName}". Available: ${versions.join(", ") || "none"}`,
        };
      }
      flowDef = vDef;
      source = `v${params.version}`;
    } else {
      if (!fs.existsSync(abs)) {
        return { text: `File not found: ${abs}` };
      }
      try {
        flowDef = JSON.parse(fs.readFileSync(abs, "utf-8")) as FlowDefinition;
      } catch (err) {
        return {
          text: `Failed to parse ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      source = "draft";
    }

    const referenced = extractInputRefs(flowDef.nodes);

    // Single node mode
    if (params.node) {
      const found = findNode(flowDef.nodes, params.node);
      if (!found) {
        return {
          text: `Node "${params.node}" not found in flow "${flowDef.flow}". Nodes: ${flowDef.nodes.map((n) => n.name).join(", ")}`,
        };
      }
      const nodeInputs = extractInputRefs(found);
      const result = {
        flow: flowDef.flow,
        _source: source,
        _file: abs,
        ...(versions.length > 0 && { _versions: versions }),
        ...(nodeInputs.length > 0 && { expectedInputs: nodeInputs }),
        node: found,
      };
      return {
        text: JSON.stringify(result, null, 2),
        details: result,
      };
    }

    // Full flow mode
    const result = {
      ...flowDef,
      _source: source,
      _file: abs,
      ...(versions.length > 0 && { _versions: versions }),
      ...(referenced.length > 0 && { _expectedInputs: referenced }),
    };
    return {
      text: JSON.stringify(result, null, 2),
      details: result,
    };
  }

  // ---- flow_publish --------------------------------------------------------------

  async publish(params: { file: string }): Promise<OpResult> {
    const abs = this.resolveFlowFile(params.file);
    if (!fs.existsSync(abs)) {
      return { text: `Draft not found: ${abs}` };
    }

    let flowDef: FlowDefinition;
    try {
      flowDef = JSON.parse(fs.readFileSync(abs, "utf-8")) as FlowDefinition;
    } catch (err) {
      return {
        text: `Failed to parse ${abs}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const validation = validateFlow(flowDef);
    if (!validation.ok) {
      return {
        text: `Validation failed — cannot publish:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
      };
    }

    const flowName = path.basename(abs, ".json");
    const versions = this.listVersions(flowName);
    const nextVersion = versions.length > 0 ? versions[versions.length - 1] + 1 : 1;

    // Stamp the version number into the definition
    flowDef.version = String(nextVersion);

    const dir = this.versionsDir(flowName);
    fs.mkdirSync(dir, { recursive: true });
    const versionFile = path.join(dir, `${nextVersion}.json`);
    fs.writeFileSync(versionFile, JSON.stringify(flowDef, null, 2) + "\n");

    return {
      text: `Published "${flowDef.flow}" as v${nextVersion}. flow_run will now use this version by default.\nFile: ${versionFile}`,
      details: {
        flow: flowDef.flow,
        version: nextVersion,
        file: versionFile,
        totalVersions: nextVersion,
      },
    };
  }

  // ---- flow_edit ----------------------------------------------------------------

  async edit(params: {
    file?: string;
    flow?: FlowDefinition;
    action: "set" | "update" | "add" | "remove" | "move" | "wrap" | "revert" | "list";
    node?: string;
    fields?: Record<string, unknown>;
    replace?: FlowNode;
    nodeDefinition?: FlowNode;
    position?: number;
    parent?: string;
    nodes?: string[];
    wrapper?: FlowNode;
  }): Promise<OpResult> {
    // ---- Load flow definition ---
    let flowDef: FlowDefinition;
    let filePath: string | undefined;

    if (params.file) {
      const abs = this.resolveFlowFile(params.file);
      if (!fs.existsSync(abs))
        return { text: `File not found: ${abs}` };
      filePath = abs;
      flowDef = JSON.parse(fs.readFileSync(abs, "utf8")) as FlowDefinition;
    } else if (params.flow) {
      flowDef = params.flow;
    } else {
      return { text: "Provide either `file` (path) or `flow` (inline definition)." };
    }

    const ok = (msg: string, flow: FlowDefinition): OpResult => ({
      text: msg,
      details: flow,
    });
    const fail = (msg: string): OpResult => ({ text: msg });

    // Resolve a node list from a parent path. Supports:
    //   undefined        → flowDef.nodes (top-level)
    //   "myBranch/true"  → branch node "myBranch", paths["true"]
    //   "myBranch/default" → branch node "myBranch", default
    //   "myCond/then"    → condition node "myCond", then
    //   "myCond/else"    → condition node "myCond", else
    //   "myLoop"         → loop node "myLoop", nodes
    //   "myParallel"     → parallel node "myParallel", nodes
    // Paths can be chained: "outerBranch/true/innerLoop"
    const resolveNodeList = (
      parentPath?: string,
    ): { nodes: FlowNode[]; error?: string } => {
      if (!parentPath) return { nodes: flowDef.nodes };

      const parts = parentPath.split("/");
      let current: FlowNode[] = flowDef.nodes;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const node = current.find((n) => n.name === part);
        if (!node)
          return {
            nodes: [],
            error: `Parent node "${part}" not found at level ${i}.`,
          };

        if (node.do === "branch") {
          const b = node as BranchNode;
          const key = parts[++i]; // consume next part as path key
          if (!key)
            return {
              nodes: [],
              error: `Branch "${part}" requires a path key (e.g., "${part}/true").`,
            };
          if (key === "default") {
            if (!b.default) b.default = [];
            current = b.default;
          } else {
            if (!b.paths[key]) b.paths[key] = [];
            current = b.paths[key];
          }
        } else if (node.do === "condition") {
          const c = node as ConditionNode;
          const key = parts[++i]; // consume next part as then/else
          if (!key)
            return {
              nodes: [],
              error: `Condition "${part}" requires "then" or "else" (e.g., "${part}/then").`,
            };
          if (key === "then") {
            current = c.then;
          } else if (key === "else") {
            if (!c.else) c.else = [];
            current = c.else;
          } else {
            return {
              nodes: [],
              error: `Condition "${part}" only accepts "then" or "else", got "${key}".`,
            };
          }
        } else if (node.do === "loop") {
          current = (node as LoopNode).nodes;
        } else if (node.do === "parallel") {
          current = (node as ParallelNode).nodes;
        } else {
          return {
            nodes: [],
            error: `Node "${part}" (do: "${node.do}") has no child nodes.`,
          };
        }
      }
      return { nodes: current };
    };

    // Deep-find: search all node lists recursively, return the containing array + index
    const deepFind = (
      name: string,
      nodes: FlowNode[] = flowDef.nodes,
    ): { list: FlowNode[]; index: number } | null => {
      const idx = nodes.findIndex((n) => n.name === name);
      if (idx !== -1) return { list: nodes, index: idx };
      for (const node of nodes) {
        const children = getChildLists(node);
        for (const child of children) {
          const found = deepFind(name, child);
          if (found) return found;
        }
      }
      return null;
    };

    // Get all child node arrays from a container node
    const getChildLists = (node: FlowNode): FlowNode[][] => {
      switch (node.do) {
        case "branch": {
          const b = node as BranchNode;
          const lists = Object.values(b.paths);
          if (b.default) lists.push(b.default);
          return lists;
        }
        case "condition": {
          const c = node as ConditionNode;
          const lists: FlowNode[][] = [c.then];
          if (c.else) lists.push(c.else);
          return lists;
        }
        case "loop":
          return [(node as LoopNode).nodes];
        case "parallel":
          return [(node as ParallelNode).nodes];
        default:
          return [];
      }
    };

    // Save a snapshot before mutating (file-based flows only).
    // Derive history dir from the flow file's parent (sibling to flows/).
    const saveSnapshot = () => {
      if (!filePath) return;
      const flowDir = path.dirname(filePath);
      const root = path.dirname(flowDir); // parent of flows/
      const flowName = path.basename(filePath, ".json");
      const histDir = path.join(root, ".clawflow", "history", flowName);
      try {
        fs.mkdirSync(histDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const snapPath = path.join(histDir, `${ts}.json`);
        fs.writeFileSync(snapPath, fs.readFileSync(filePath, "utf8"));
      } catch {
        // History is best-effort — don't block the edit
      }
    };

    // ---- Revert (undo last edit) ---
    if (params.action === "revert") {
      if (!filePath)
        return fail("Revert only works on file-based flows.");
      const flowDir = path.dirname(filePath);
      const root = path.dirname(flowDir);
      const flowName = path.basename(filePath, ".json");
      const histDir = path.join(root, ".clawflow", "history", flowName);
      if (!fs.existsSync(histDir))
        return fail("No edit history found for this flow.");
      const snaps = fs.readdirSync(histDir)
        .filter((f: string) => f.endsWith(".json"))
        .sort()
        .reverse();
      if (snaps.length === 0)
        return fail("No edit history found for this flow.");
      const latest = path.join(histDir, snaps[0]);
      const restored = JSON.parse(fs.readFileSync(latest, "utf8")) as FlowDefinition;
      fs.writeFileSync(filePath, JSON.stringify(restored, null, 2) + "\n");
      fs.unlinkSync(latest);
      return ok(
        `Reverted to snapshot ${snaps[0]}. File written: ${filePath}`,
        restored,
      );
    }

    // ---- Set (top-level flow fields) ---
    if (params.action === "set") {
      if (!params.fields)
        return fail('action "set" requires "fields".');

      const allowed = ["description", "inputs", "env", "version"];
      const backup = { ...flowDef };

      for (const [key, value] of Object.entries(params.fields)) {
        if (!allowed.includes(key))
          return fail(
            `Cannot set "${key}". Allowed fields: ${allowed.join(", ")}. Use "update" to modify nodes.`,
          );
        if (value === null || value === undefined) {
          delete (flowDef as unknown as Record<string, unknown>)[key];
        } else {
          (flowDef as unknown as Record<string, unknown>)[key] = value;
        }
      }

      const validation = validateFlow(flowDef);
      if (!validation.ok) {
        // rollback
        Object.assign(flowDef, backup);
        return fail(
          `Validation failed after set:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
        );
      }

      if (filePath) {
        saveSnapshot();
        fs.writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
      }
      return ok(
        `Flow fields updated: ${Object.keys(params.fields).join(", ")}.${filePath ? ` File written: ${filePath}` : ""}`,
        flowDef,
      );
    }

    // ---- List ---
    if (params.action === "list") {
      const list = flowDef.nodes.map((n, i) => ({
        index: i,
        name: n.name,
        do: n.do,
        output: n.output ?? null,
      }));
      return {
        text: JSON.stringify(list, null, 2),
        details: list,
      };
    }

    // ---- Update ---
    if (params.action === "update") {
      if (!params.node)
        return fail('action "update" requires "node" (node name).');
      const found = deepFind(params.node);
      if (!found)
        return fail(`Node "${params.node}" not found.`);

      if (params.replace) {
        found.list[found.index] = params.replace as FlowNode;
      } else if (params.fields) {
        found.list[found.index] = {
          ...found.list[found.index],
          ...params.fields,
        } as FlowNode;
      } else {
        return fail(
          'action "update" requires either "fields" (partial) or "replace" (full node).',
        );
      }

      const validation = validateFlow(flowDef);
      if (!validation.ok)
        return fail(
          `Validation failed after update:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
        );

      if (filePath) {
        saveSnapshot();
        fs.writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
      }
      return ok(
        `Node "${params.node}" updated.${filePath ? ` File written: ${filePath}` : ""}`,
        flowDef,
      );
    }

    // ---- Add ---
    if (params.action === "add") {
      if (!params.nodeDefinition)
        return fail('action "add" requires "nodeDefinition".');
      const { nodes: targetList, error: parentErr } = resolveNodeList(params.parent);
      if (parentErr) return fail(parentErr);
      const pos = params.position ?? targetList.length;
      if (pos < 0 || pos > targetList.length)
        return fail(
          `Position ${pos} out of range (0-${targetList.length}).`,
        );
      targetList.splice(pos, 0, params.nodeDefinition as FlowNode);

      const validation = validateFlow(flowDef);
      if (!validation.ok) {
        targetList.splice(pos, 1); // rollback
        return fail(
          `Validation failed after add:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
        );
      }

      if (filePath) {
        saveSnapshot();
        fs.writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
      }
      const loc = params.parent ? ` in ${params.parent}` : "";
      return ok(
        `Node "${params.nodeDefinition.name}" added at position ${pos}${loc}.${filePath ? ` File written: ${filePath}` : ""}`,
        flowDef,
      );
    }

    // ---- Remove ---
    if (params.action === "remove") {
      if (!params.node)
        return fail('action "remove" requires "node" (node name).');
      const found = deepFind(params.node);
      if (!found)
        return fail(`Node "${params.node}" not found.`);

      const removed = found.list.splice(found.index, 1)[0];

      const validation = validateFlow(flowDef);
      if (!validation.ok) {
        found.list.splice(found.index, 0, removed); // rollback
        return fail(
          `Validation failed after remove (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
        );
      }

      if (filePath) {
        saveSnapshot();
        fs.writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
      }
      return ok(
        `Node "${params.node}" removed.${filePath ? ` File written: ${filePath}` : ""}`,
        flowDef,
      );
    }

    // ---- Move ---
    if (params.action === "move") {
      if (!params.node)
        return fail('action "move" requires "node" (node name).');
      if (params.position === undefined)
        return fail('action "move" requires "position".');

      // Find the node wherever it is
      const source = deepFind(params.node);
      if (!source)
        return fail(`Node "${params.node}" not found.`);

      // Resolve destination list
      const { nodes: destList, error: parentErr } = resolveNodeList(params.parent);
      if (parentErr) return fail(parentErr);

      // Remove from source
      const [moved] = source.list.splice(source.index, 1);
      const pos = Math.min(params.position, destList.length);
      destList.splice(pos, 0, moved);

      const validation = validateFlow(flowDef);
      if (!validation.ok) {
        // rollback: remove from dest, re-insert at source
        destList.splice(pos, 1);
        source.list.splice(source.index, 0, moved);
        return fail(
          `Validation failed after move (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
        );
      }

      if (filePath) {
        saveSnapshot();
        fs.writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
      }
      const loc = params.parent ? ` in ${params.parent}` : "";
      return ok(
        `Node "${params.node}" moved to position ${pos}${loc}.${filePath ? ` File written: ${filePath}` : ""}`,
        flowDef,
      );
    }

    // ---- Wrap ---
    if (params.action === "wrap") {
      if (!params.nodes || params.nodes.length === 0)
        return fail('action "wrap" requires "nodes" (array of node names).');
      if (!params.wrapper)
        return fail('action "wrap" requires "wrapper" (container node definition with name and do).');
      if (!["loop", "condition", "branch", "parallel"].includes(params.wrapper.do))
        return fail(
          `Wrapper "do" must be loop, condition, branch, or parallel. Got "${params.wrapper.do}".`,
        );

      // All target nodes must be in the same parent list and contiguous
      const firstFound = deepFind(params.nodes[0]);
      if (!firstFound)
        return fail(`Node "${params.nodes[0]}" not found.`);

      const parentList = firstFound.list;
      const indices: number[] = [];
      for (const name of params.nodes) {
        const idx = parentList.findIndex((n) => n.name === name);
        if (idx === -1)
          return fail(
            `Node "${name}" not found in the same parent list as "${params.nodes[0]}".`,
          );
        indices.push(idx);
      }
      indices.sort((a, b) => a - b);

      // Check contiguous
      for (let i = 1; i < indices.length; i++) {
        if (indices[i] !== indices[i - 1] + 1)
          return fail(
            "Nodes to wrap must be contiguous (adjacent in the same list).",
          );
      }

      // Extract the nodes
      const extracted = parentList.splice(indices[0], indices.length);

      // Build the wrapper node with children
      const wrapperNode = { ...params.wrapper } as FlowNode;
      switch (wrapperNode.do) {
        case "loop":
          (wrapperNode as LoopNode).nodes = extracted;
          break;
        case "parallel":
          (wrapperNode as ParallelNode).nodes = extracted;
          break;
        case "condition":
          (wrapperNode as ConditionNode).then = extracted;
          if (!(wrapperNode as ConditionNode).else)
            (wrapperNode as ConditionNode).else = [];
          break;
        case "branch": {
          const b = wrapperNode as BranchNode;
          // Put extracted nodes into the first path, or "true" by default
          const firstPath = b.paths ? Object.keys(b.paths)[0] : "true";
          if (!b.paths) b.paths = {};
          b.paths[firstPath] = extracted;
          break;
        }
      }

      // Insert wrapper where the first extracted node was
      parentList.splice(indices[0], 0, wrapperNode);

      const validation = validateFlow(flowDef);
      if (!validation.ok) {
        // rollback: remove wrapper, re-insert extracted nodes
        parentList.splice(indices[0], 1);
        parentList.splice(indices[0], 0, ...extracted);
        return fail(
          `Validation failed after wrap (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
        );
      }

      if (filePath) {
        saveSnapshot();
        fs.writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
      }
      return ok(
        `Wrapped ${params.nodes.length} node(s) into "${params.wrapper.name}" (${params.wrapper.do}).${filePath ? ` File written: ${filePath}` : ""}`,
        flowDef,
      );
    }

    return fail(`Unknown action: "${params.action}"`);
  }
}
