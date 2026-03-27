import type {
  FlowDefinition,
  FlowNode,
  AiNode,
  AgentNode,
  BranchNode,
  ConditionNode,
  LoopNode,
  ParallelNode,
  HttpNode,
  MemoryNode,
  WaitNode,
  SleepNode,
  CodeNode,
  ExecNode,
} from "./types.js";

// ---- Flow Validator -------------------------------------------------------------
// Static checks run before execution to catch common authoring mistakes.

export interface ValidationError {
  node?: string; // node name, if applicable
  field?: string; // field name, if applicable
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export function validateFlow(flow: FlowDefinition): ValidationResult {
  const errors: ValidationError[] = [];

  if (!flow.flow || typeof flow.flow !== "string") {
    errors.push({ message: 'Missing or invalid "flow" name' });
  }

  if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) {
    errors.push({ message: "Flow must have at least one node" });
    return { ok: false, errors };
  }

  // Collect all output keys and node names across the entire flow tree
  const allNames = new Set<string>();
  const nameErrors: ValidationError[] = [];
  collectNames(flow.nodes, allNames, nameErrors);
  errors.push(...nameErrors);

  // Walk all nodes and validate
  validateNodes(flow.nodes, new Set<string>(), errors);

  return { ok: errors.length === 0, errors };
}

// ---- Helpers --------------------------------------------------------------------

/** Recursively collect all node names and check for duplicates */
function collectNames(
  nodes: FlowNode[],
  seen: Set<string>,
  errors: ValidationError[],
): void {
  for (const node of nodes) {
    if (!node.name || typeof node.name !== "string") {
      errors.push({ message: "Node is missing a name" });
      continue;
    }
    if (seen.has(node.name)) {
      errors.push({
        node: node.name,
        message: `Duplicate node name "${node.name}"`,
      });
    }
    seen.add(node.name);

    // Recurse into sub-flows
    for (const child of getChildNodes(node)) {
      collectNames(child, seen, errors);
    }
  }
}

/** Get all child node arrays from a node (branch paths, condition then/else, loop, parallel) */
function getChildNodes(node: FlowNode): FlowNode[][] {
  switch (node.do) {
    case "branch": {
      const n = node as BranchNode;
      const children = Object.values(n.paths);
      if (n.default) children.push(n.default);
      return children;
    }
    case "condition": {
      const n = node as ConditionNode;
      const children: FlowNode[][] = [n.then];
      if (n.else) children.push(n.else);
      return children;
    }
    case "loop":
      return [(node as LoopNode).nodes];
    case "parallel":
      return [(node as ParallelNode).nodes];
    default:
      return [];
  }
}

/**
 * Validate nodes sequentially, tracking which output keys are available
 * at each point in the flow. `available` starts with outputs from prior
 * nodes in the parent scope.
 */
function validateNodes(
  nodes: FlowNode[],
  parentAvailable: Set<string>,
  errors: ValidationError[],
): void {
  // Available keys: trigger is always available + anything from parent scope
  const available = new Set(parentAvailable);
  available.add("trigger");

  for (const node of nodes) {
    // Validate required fields per node type
    validateNodeFields(node, errors);

    // Check template references in string fields
    checkTemplateRefs(node, available, errors);

    // Check state references in branch `on` and condition `if`
    checkStateRefs(node, available, errors);

    // Recurse into sub-flows with current available set
    validateSubFlows(node, available, errors);

    // After this node, its output key becomes available
    if (node.output) {
      available.add(node.output);
    }
  }
}

/** Validate required fields per node type */
function validateNodeFields(node: FlowNode, errors: ValidationError[]): void {
  const e = (field: string, msg: string) =>
    errors.push({ node: node.name, field, message: msg });

  const nodeType = node.do as string;
  if (!nodeType) {
    e("do", `Node "${node.name}" is missing "do" field`);
    return;
  }

  switch (nodeType) {
    case "ai": {
      const n = node as AiNode;
      if (!n.prompt) e("prompt", `ai node "${node.name}" requires "prompt"`);
      break;
    }
    case "agent": {
      const n = node as AgentNode;
      if (!n.task) e("task", `agent node "${node.name}" requires "task"`);
      break;
    }
    case "branch": {
      const n = node as BranchNode;
      if (!n.on) e("on", `branch node "${node.name}" requires "on"`);
      if (!n.paths || typeof n.paths !== "object" || Object.keys(n.paths).length === 0) {
        e("paths", `branch node "${node.name}" requires at least one path`);
      } else {
        for (const [key, val] of Object.entries(n.paths)) {
          if (!Array.isArray(val)) {
            e("paths", `branch node "${node.name}" path "${key}" must be an array of nodes`);
          }
        }
      }
      if (n.default !== undefined && !Array.isArray(n.default)) {
        e("default", `branch node "${node.name}" default must be an array of nodes`);
      }
      break;
    }
    case "condition": {
      const n = node as ConditionNode;
      if (!n.if) e("if", `condition node "${node.name}" requires "if"`);
      if (!Array.isArray(n.then) || n.then.length === 0) {
        e("then", `condition node "${node.name}" requires a non-empty "then" array`);
      }
      break;
    }
    case "loop": {
      const n = node as LoopNode;
      if (!n.over) e("over", `loop node "${node.name}" requires "over"`);
      if (!n.as) e("as", `loop node "${node.name}" requires "as"`);
      if (!Array.isArray(n.nodes) || n.nodes.length === 0) {
        e("nodes", `loop node "${node.name}" requires a non-empty "nodes" array`);
      }
      break;
    }
    case "parallel": {
      const n = node as ParallelNode;
      if (!Array.isArray(n.nodes) || n.nodes.length === 0) {
        e("nodes", `parallel node "${node.name}" requires a non-empty "nodes" array`);
      }
      break;
    }
    case "http": {
      const n = node as HttpNode;
      if (!n.url) e("url", `http node "${node.name}" requires "url"`);
      break;
    }
    case "memory": {
      const n = node as MemoryNode;
      if (!n.action) e("action", `memory node "${node.name}" requires "action"`);
      if (!n.key) e("key", `memory node "${node.name}" requires "key"`);
      if (n.action === "write" && !n.value) {
        e("value", `memory node "${node.name}" with action "write" requires "value"`);
      }
      break;
    }
    case "wait": {
      const n = node as WaitNode;
      if (!n.for) e("for", `wait node "${node.name}" requires "for"`);
      if (n.for === "event" && !n.event) {
        e("event", `wait node "${node.name}" with for "event" requires "event"`);
      }
      break;
    }
    case "sleep": {
      const n = node as SleepNode;
      if (!n.duration) e("duration", `sleep node "${node.name}" requires "duration"`);
      break;
    }
    case "code": {
      const n = node as CodeNode;
      if (!n.run) e("run", `code node "${node.name}" requires "run"`);
      break;
    }
    case "exec": {
      const n = node as ExecNode;
      if (!n.command) e("command", `exec node "${node.name}" requires "command"`);
      break;
    }
    default:
      errors.push({
        node: node.name,
        field: "do",
        message: `Unknown node type "${nodeType}"`,
      });
  }
}

/** Extract template references {{ key.path }} from all string fields of a node */
function checkTemplateRefs(
  node: FlowNode,
  available: Set<string>,
  errors: ValidationError[],
): void {
  const strings = collectStringFields(node);
  const templatePattern = /\{\{\s*([\w.]+)\s*(?:\|\s*\w+)?\s*\}\}/g;

  for (const { field, value } of strings) {
    let match;
    while ((match = templatePattern.exec(value)) !== null) {
      const ref = match[1];
      const rootKey = ref.split(".")[0];
      if (!available.has(rootKey)) {
        errors.push({
          node: node.name,
          field,
          message: `Template "{{ ${ref} }}" references "${rootKey}" which is not an available output key. Available: ${[...available].sort().join(", ")}`,
        });
      }
    }
  }
}

/** Check that branch `on` and condition `if` reference available state keys */
function checkStateRefs(
  node: FlowNode,
  available: Set<string>,
  errors: ValidationError[],
): void {
  if (node.do === "branch") {
    const n = node as BranchNode;
    const rootKey = n.on?.split(".")[0];
    if (rootKey && !available.has(rootKey)) {
      errors.push({
        node: node.name,
        field: "on",
        message: `Branch "on" references "${rootKey}" which is not an available output key. Available: ${[...available].sort().join(", ")}`,
      });
    }
  }

  if (node.do === "condition") {
    const n = node as ConditionNode;
    if (n.if) {
      // Extract identifiers from the expression (skip JS keywords and string literals)
      const reserved = new Set([
        "true", "false", "null", "undefined", "NaN", "Infinity",
        "typeof", "instanceof", "in", "new", "void", "delete",
      ]);
      // Remove string literals first to avoid matching identifiers inside them
      const cleaned = n.if.replace(/'[^']*'|"[^"]*"/g, "");
      const identPattern = /([a-zA-Z_][\w]*(?:\.[\w]+)*)/g;
      let match;
      while ((match = identPattern.exec(cleaned)) !== null) {
        const path = match[1];
        const rootKey = path.split(".")[0];
        if (!reserved.has(rootKey) && !available.has(rootKey)) {
          errors.push({
            node: node.name,
            field: "if",
            message: `Condition references "${rootKey}" which is not an available output key. Available: ${[...available].sort().join(", ")}`,
          });
        }
      }
    }
  }

  if (node.do === "loop") {
    const n = node as LoopNode;
    // Strip {{ }} template wrapper if present, then extract the root key
    const overPath = n.over?.replace(/^\{\{\s*([\w.]+)\s*\}\}$/, "$1");
    const rootKey = overPath?.split(".")[0];
    if (rootKey && !available.has(rootKey)) {
      errors.push({
        node: node.name,
        field: "over",
        message: `Loop "over" references "${rootKey}" which is not an available output key. Available: ${[...available].sort().join(", ")}`,
      });
    }
  }
}

/** Recurse into sub-flows for validation */
function validateSubFlows(
  node: FlowNode,
  available: Set<string>,
  errors: ValidationError[],
): void {
  switch (node.do) {
    case "branch": {
      const n = node as BranchNode;
      for (const nodes of Object.values(n.paths)) {
        validateNodes(nodes, available, errors);
      }
      if (n.default) {
        validateNodes(n.default, available, errors);
      }
      break;
    }
    case "condition": {
      const n = node as ConditionNode;
      validateNodes(n.then, available, errors);
      if (n.else) {
        validateNodes(n.else, available, errors);
      }
      break;
    }
    case "loop": {
      const n = node as LoopNode;
      const loopAvailable = new Set(available);
      loopAvailable.add(n.as); // loop variable is available inside
      validateNodes(n.nodes, loopAvailable, errors);
      break;
    }
    case "parallel": {
      const n = node as ParallelNode;
      // Each parallel branch has the same available set (they run concurrently)
      for (const child of n.nodes) {
        validateNodes([child], available, errors);
      }
      break;
    }
  }
}

/** Collect all string-valued fields from a node (for template checking) */
function collectStringFields(node: FlowNode): { field: string; value: string }[] {
  const result: { field: string; value: string }[] = [];
  // Fields that contain template-interpolated strings
  const templateFields = ["prompt", "task", "url", "key", "value", "run", "body", "if", "command", "cwd"];

  for (const field of templateFields) {
    const val = (node as unknown as Record<string, unknown>)[field];
    if (typeof val === "string") {
      result.push({ field, value: val });
    } else if (val !== null && typeof val === "object") {
      // body can be an object with string values
      collectObjectStrings(val as Record<string, unknown>, field, result);
    }
  }

  // Check headers
  const headers = (node as unknown as Record<string, unknown>).headers;
  if (headers && typeof headers === "object") {
    collectObjectStrings(headers as Record<string, unknown>, "headers", result);
  }

  // Check wait prompt
  if (node.do === "wait") {
    const n = node as WaitNode;
    if (n.prompt) result.push({ field: "prompt", value: n.prompt });
  }

  return result;
}

function collectObjectStrings(
  obj: Record<string, unknown>,
  prefix: string,
  result: { field: string; value: string }[],
): void {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      result.push({ field: `${prefix}.${k}`, value: v });
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      collectObjectStrings(v as Record<string, unknown>, `${prefix}.${k}`, result);
    }
  }
}
