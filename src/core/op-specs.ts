import type { FlowOpSpec } from "./ops.js";

// ---- Flow op specs --------------------------------------------------------------
// The tool surface as data: one spec per flow_* operation, carrying the name,
// description, and JSON-schema parameters. Harness wrappers iterate this to
// register tools (the OpenClaw plugin in-process; out-of-process shims via the
// management API's GET /ops), so the surface is defined exactly once.

export const FLOW_OP_SPECS: FlowOpSpec[] = [
  {
    name: "flow_create",
    description: `Create a new clawflow definition and save it to a JSON file.

Builds a FlowDefinition from the provided parameters, validates it, and writes
it to disk. Use this to scaffold a new flow file; use flow_edit to modify it
afterwards and flow_run to execute it.

Node types:
  ai, agent, branch, condition, loop, parallel, http, memory, wait, sleep, code, exec

All nodes require "name" and "do". Templates: {{ outputKey.field }}.`,
    parameters: {
      type: "object",
      required: ["file", "flow", "nodes"],
      properties: {
        file: {
          type: "string",
          description:
            "Filename or path for the new flow file. Plain names like \"my-flow\" are saved to workspace/flows/my-flow.json. Paths with slashes are resolved relative to the workspace.",
        },
        flow: {
          type: "string",
          description: "Unique flow name",
        },
        description: {
          type: "string",
          description: "Human-readable description of what the flow does",
        },
        nodes: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Array of node definitions",
        },
        inputs: {
          type: "object",
          additionalProperties: true,
          description:
            'Declared inputs the flow expects. Map of name → { type?, required?, description?, default? }. Optional: when omitted, the flow accepts any payload. When present, required inputs are enforced before any node runs.',
        },
        env: {
          type: "object",
          additionalProperties: true,
          description: "Environment variable defaults",
        },
        version: {
          type: "string",
          description: 'Semver version string, e.g. "1.0.0"',
        },
      },
    },
  },

  {
    name: "flow_delete",
    description: `Delete a flow file by moving it to the bin.

The flow is not permanently removed — it is timestamped and moved to
workspace/.clawflow/bin/ so it can be restored later with flow_restore_from_bin.
Safe for agents to call without fear of data loss.`,
    parameters: {
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "string",
          description:
            "Filename or path of the flow to delete. Plain names like \"my-flow\" resolve to workspace/flows/my-flow.json.",
        },
      },
    },
  },

  {
    name: "flow_restore_from_bin",
    description: `Restore a flow from the bin or list bin contents.

Without "name", lists all flows in workspace/.clawflow/bin/ with their timestamps.
With "name", restores the most recent version of that flow back to the flows/
directory. If the flow file already exists, the restore is rejected.`,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Flow name to restore (without timestamp). Omit to list all bin contents.",
        },
      },
    },
  },

  {
    name: "flow_run",
    catalogMode: "direct-only",
    description: `Run an agentic workflow in the clawflow format.

State model:
  The "input" parameter becomes "inputs" in flow state (i.e. state.inputs).
  Flow state = { inputs, env?, ...nodeOutputs }.
  Each node with "output" adds its result to state (e.g. output: "result" → state.result).
  In code nodes: fn(input, state) — "input" is the resolved node.input field, "state" is the full flow state.
  IMPORTANT: inputs contains ALL initial data. If you need different parts of inputs in a code node,
  use object-style input: { "payload": "inputs.payload", "email": "inputs.email_to" }
  or access via state.inputs.field inside the code.

Node types:
  ai       — LLM call, structured or freeform. Use schema: for typed output.
  agent    — delegate to a real OpenClaw agent. Fields mirror the CLI flags: agent
             (a configured slug, e.g. "clawflow" → --agent), sessionKey (a session
             key, e.g. "agent:main:slack:channel:agent" → --session-key), sessionId
             (→ --session-id), channel (→ --channel). A bare session key is scoped by
             agent; an "agent:"-prefixed key is self-scoping. (agentId/session are
             deprecated aliases for agent/sessionKey.)
  branch   — route to different nodes based on a value: { on, paths, default }
  loop     — iterate over a list: { over, as, nodes[] }
  parallel — run nodes concurrently: { nodes[], mode: "all"|"race" }
  http     — call an external API: { url, method, body, headers }
  memory   — persist data: { action: read|write|delete, key, value }
  wait     — pause for approval or event: { for: "approval"|"event", event?, timeout? }
  sleep    — pause for duration: { duration: "5m" }
  code     — inline JS expression: { run: "...", input? }

All nodes support retry: { limit, delay, backoff } and timeout.
Templates: use {{ nodeName.field }} to reference any value in flow state.
Returns instanceId for status tracking and resume.

Versioning: when a flow has published versions, flow_run uses the latest
published version by default. Set draft: true to run the working copy instead.
Set version to run a specific published version.`,
    parameters: {
      type: "object",
      properties: {
        flow: {
          type: "object",
          properties: {
            flow: { type: "string" },
            description: { type: "string" },
            nodes: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
          required: ["flow", "nodes"],
          additionalProperties: true,
        },
        file: {
          type: "string",
          description: "Path to a .json flow file (or plain name like \"my-flow\")",
        },
        input: {
          type: "object",
          additionalProperties: true,
          description: "Input data, available as inputs.* in the flow (and at state.inputs in code nodes).",
        },
        draft: {
          type: "boolean",
          description:
            "Run the draft (working copy) instead of the latest published version. Default: false.",
        },
        version: {
          type: "number",
          description:
            "Run a specific published version number. Overrides draft flag.",
        },
      },
    },
  },

  {
    name: "flow_resume",
    description: `Resume a paused clawflow after an approval gate.
Use the instanceId (= resumeToken) from a flow_run result where status was "paused".
Set approved=true to continue, false to cancel.
You must pass the original flow definition back so the runner can continue.`,
    parameters: {
      type: "object",
      required: ["instanceId", "approved", "flow"],
      properties: {
        instanceId: {
          type: "string",
          description: "The instanceId from the paused flow_run result",
        },
        approved: { type: "boolean" },
        flow: {
          type: "object",
          required: ["flow", "nodes"],
          properties: {
            flow: { type: "string" },
            nodes: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
          additionalProperties: true,
        },
      },
    },
  },

  {
    name: "flow_send_event",
    description: `Send an event to a flow instance that is waiting with do: wait / for: event.
This is the equivalent of Cloudflare's instance.sendEvent().
The eventType must match the "event" field on the wait node.
payload is passed as the output of the wait node and into flow state.`,
    parameters: {
      type: "object",
      required: ["instanceId", "eventType"],
      properties: {
        instanceId: { type: "string" },
        eventType: {
          type: "string",
          description: "Must match the 'event' field of the wait node",
        },
        payload: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },

  {
    name: "flow_status",
    description: `Get the status and state of a flow instance, or list all instances.
Status values: running | completed | paused | waiting | failed | cancelled`,
    parameters: {
      type: "object",
      properties: {
        instanceId: {
          type: "string",
          description: "Specific instance to inspect. Omit to list all.",
        },
        filter: {
          type: "string",
          description:
            "Filter by status: running | completed | paused | waiting | failed | cancelled",
        },
      },
    },
  },

  {
    name: "flow_list",
    catalogMode: "direct-only",
    description: `List all saved flow definitions in the workspace.

Scans the flows directory for .json files and returns a summary of each flow
including its name, description, declared inputs, version, node count, and file path.
Use this to discover available flows before running or editing them.`,
    parameters: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description:
            "Directory to scan. Defaults to workspace/flows/. Absolute paths are used as-is; relative paths resolve from the workspace root.",
        },
      },
    },
  },

  {
    name: "flow_read",
    description: `Read a flow definition from file and return its contents.

Returns the full flow definition (or a single node if specified). The response
includes the declared "inputs" block when present, plus a best-effort list of
input fields referenced by templates (extracted from {{ inputs.* }} usages).
Use this to inspect a flow before running it or to understand what inputs it
needs.

Versioning: by default reads the draft (working copy). Set version to read
a specific published version. The response includes available version numbers.`,
    parameters: {
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "string",
          description:
            "Filename or path to the flow file. Plain names resolve to workspace/flows/<name>.json.",
        },
        node: {
          type: "string",
          description:
            "Name of a specific node to return. Searches nested structures (branches, loops, etc.).",
        },
        version: {
          type: "number",
          description:
            "Read a specific published version instead of the draft.",
        },
      },
    },
  },

  {
    name: "flow_publish",
    description: `Publish the current draft of a flow as a new numbered version.

Validates the draft, assigns the next version number (auto-incrementing integer),
and saves an immutable copy to .clawflow/versions/<flowName>/<N>.json.
After publishing, flow_run will use this version by default.

Use this when a flow is ready for production. Edits via flow_edit continue to
modify the draft without affecting published versions.`,
    parameters: {
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "string",
          description:
            "Filename or path to the draft flow file. Plain names resolve to workspace/flows/<name>.json.",
        },
      },
    },
  },

  {
    name: "flow_edit",
    description: `Edit nodes in a clawflow definition. Operates on a file or inline flow.

Actions:
  set     — set top-level flow fields (description, inputs, env, version)
  update  — update a node entirely or patch specific fields by node name
  add     — insert a new node at a position (default: end)
  remove  — remove a node by name
  move    — move a node to a new position (same level or into a parent)
  wrap    — wrap one or more nodes into a new container (loop, condition, branch, parallel)
  revert  — undo the last edit (restores the previous version from history)
  list    — list all nodes with index, name, type, and output key

All actions that target nodes (update, remove, move, add) search recursively
through nested structures (branch paths, condition then/else, loop, parallel).

The "parent" parameter targets a nested node list using slash-separated paths:
  "myBranch/true"       → branch "myBranch", path "true"
  "myCond/then"         → condition "myCond", then block
  "myLoop"              → loop "myLoop", child nodes
  "outer/true/inner"    → chained nesting

The edited flow is validated after every mutation. If validation fails, the
edit is rejected and errors are returned. For file-based flows, the file is
overwritten with the updated definition on success.

Examples:
  Set flow fields:    { action: "set", fields: { description: "New desc", inputs: { ticket_id: { type: "string", required: true } } } }
  Update one field:   { action: "update", node: "classify", fields: { prompt: "New prompt" } }
  Replace full node:  { action: "update", node: "classify", replace: { name: "classify", do: "ai", prompt: "..." } }
  Add at position:    { action: "add", position: 2, nodeDefinition: { name: "step3", do: "code", run: "..." } }
  Add inside branch:  { action: "add", parent: "shouldUpdate/true", nodeDefinition: { name: "step3", do: "code", run: "..." } }
  Remove:             { action: "remove", node: "old-step" }
  Move into loop:     { action: "move", node: "step3", parent: "myLoop", position: 0 }
  Move into else:     { action: "move", node: "step3", parent: "myCond/else", position: 0 }
  Wrap in loop:       { action: "wrap", nodes: ["step1", "step2"], wrapper: { name: "myLoop", do: "loop", over: "items", as: "item" } }
  Wrap in condition:  { action: "wrap", nodes: ["step1", "step2"], wrapper: { name: "guard", do: "condition", if: "{{ items.length > 0 }}" } }
  List:               { action: "list" }

To RESTRUCTURE an existing flow — make a group of nodes conditional, nest them in a
loop, or reparent them — use "wrap" (many nodes at once) or "move" (one node into a
"parent" path like "guard/else"). Do NOT remove-and-re-add each node, and do NOT
re-send the whole flow: a single large edit is slow and can stall mid-generation.`,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        file: {
          type: "string",
          description: "Path to a .json flow file. Mutually exclusive with 'flow'.",
        },
        flow: {
          type: "object",
          description: "Inline flow definition. Mutually exclusive with 'file'.",
          properties: {
            flow: { type: "string" },
            nodes: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
          required: ["flow", "nodes"],
          additionalProperties: true,
        },
        action: {
          type: "string",
          enum: ["set", "update", "add", "remove", "move", "wrap", "revert", "list"],
        },
        node: {
          type: "string",
          description: "Node name to target (required for update, remove, move). Searched recursively through nested structures.",
        },
        fields: {
          type: "object",
          additionalProperties: true,
          description: "For action=set: top-level flow fields to set (description, inputs, env, version). For action=update: partial field updates to merge into the node.",
        },
        replace: {
          type: "object",
          additionalProperties: true,
          description: "For action=update: full node replacement (must include name and do)",
        },
        nodeDefinition: {
          type: "object",
          additionalProperties: true,
          description: "For action=add: the new node definition",
        },
        position: {
          type: "number",
          description: "For action=add/move: index to insert/move to (0-based). Default: end.",
        },
        parent: {
          type: "string",
          description: 'For action=add/move: target a nested node list. Slash-separated path e.g. "myBranch/true", "myCond/then", "myLoop". For move: destination parent (node is removed from current location and inserted here).',
        },
        nodes: {
          type: "array",
          items: { type: "string" },
          description: "For action=wrap: array of node names to wrap into a container.",
        },
        wrapper: {
          type: "object",
          additionalProperties: true,
          description: "For action=wrap: the container node definition (must include name, do). Wrapped nodes become its children (e.g. loop.nodes, condition.then, branch.paths.true, parallel.nodes).",
        },
      },
    },
  },
];
