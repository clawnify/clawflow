---
name: clawflow
description: Design and run declarative agentic workflows using clawflow. Use when the user asks to create a workflow, automation, pipeline, or flow.
---

# ClawFlow — Workflow Authoring Guide

You have access to flow tools for the full lifecycle: create, edit, read, list, publish, and run.

- Use `flow_create` to scaffold a new flow file (draft)
- Use `flow_edit` to modify it
- Use `flow_read` to inspect it (shows expected inputs and available versions)
- Use `flow_list` to discover all flows in the workspace
- Use `flow_publish` to promote a draft to a numbered version
- Use `flow_run` to execute it (runs the latest published version by default)

## When to use this

- User asks to create a workflow, automation, or pipeline
- User wants to chain AI calls with approvals, HTTP calls, or logic
- User needs a repeatable process (e.g. "generate a LinkedIn post from an idea")
- User says "create a flow", "run a flow", "build a workflow"

## How to write a flow

A flow is JSON with a `flow` name, an optional `env` block, and a `nodes` array. Call `flow_run` with the flow inline or from a file.

### Node types (11 total)

| Node | Purpose | Key fields |
|------|---------|------------|
| `ai` | Single LLM call, structured or freeform | `prompt`, `schema`, `model`, `input`, `attachments` |
| `agent` | Delegate to a real OpenClaw agent (with tools, browser, etc.) | `task`, `agent`, `sessionKey`, `sessionId`, `channel`, `tools` |
| `exec` | Run a shell command deterministically (no AI) | `command`, `cwd` |
| `branch` | Multi-way routing with inline sub-flows per path | `on`, `paths`, `default` |
| `condition` | If/else with sub-node blocks that reconverge | `if`, `then`, `else` |
| `loop` | Iterate over an array | `over`, `as`, `nodes` |
| `parallel` | Run nodes concurrently | `nodes`, `mode: "all"\|"race"` |
| `http` | Call an external API | `url`, `method`, `body`, `headers` |
| `memory` | Persistent key/value store | `action: "read"\|"write"\|"delete"`, `key` |
| `wait` | Human approval gate or external event wait | `for: "approval"\|"event"`, `prompt`, `preview`, `timeout` |
| `sleep` | Pause for a duration | `duration: "5m"` |
| `code` | Sandboxed JS expression — pure data transforms only. No `require`, no `fs`, no network. Use `exec` for anything that touches the filesystem or external modules. | `run`, `input` |

### Rules

- Every node needs a unique `name`
- Use `output` to name a node's result — other nodes reference it via the **output key**, NOT the node name: `{{ outputKey.field }}`
- **CRITICAL: `output` is required to store a node's result in state.** Without it, the result is discarded. This applies to ALL nodes including `loop`, `branch`, `parallel`, `condition`. If a downstream node references a result, the producing node MUST have `output`.
- Always add `schema` to `ai` nodes when downstream nodes need typed fields
- Use `retry` on `http` and `ai` nodes: `{ "limit": 3, "delay": "2s", "backoff": "exponential" }`
- Use `do: exec` for deterministic operations (scripts, file processing, CLI tools) — never use `do: agent` for pure shell commands
- Use `do: agent` for tasks that need tools (browser, exec, memory, MCP, CLI) — delegates to a real OpenClaw agent
- Use `do: ai` for structured extraction and single-turn LLM calls
- Agent-node selector fields mirror the `openclaw agent` CLI flags 1:1: `agent`→`--agent`, `sessionKey`→`--session-key`, `sessionId`→`--session-id`, `channel`→`--channel` (the old names `agentId`/`session` are deprecated aliases for `agent`/`sessionKey` and still work)
- Set `agent: "clawflow"` on agent nodes to target a configured OpenClaw agent (a plain slug like `main`/`clawflow`, never a session key)
- Set `sessionKey: "agent:main:slack:channel:agent"` on agent nodes to run inside a specific existing session (e.g. a channel) — maps to `--session-key`. An `agent:`-prefixed key is self-scoping; a bare key (e.g. `incident-42`) is scoped by `agent`. May be combined with `agent`
- Set `sessionId: "sess-9"` to target one explicit session by id (maps to `--session-id`) — the most specific selector, scoped by `agent`. Use `sessionKey` for channel/self-scoping keys, `sessionId` to resume a known id
- Set `channel: "slack"` to deliver the agent's reply on a specific channel (maps to `--channel`); omit to use the session's own channel
- `agent`, `sessionKey`, `sessionId`, and `channel` all support templates, so a prior node can compute the target (e.g. `agent: "{{ route.slug }}"`)
- Use `do: wait` with `for: approval` before any side effects that need human review — it pauses the flow, provides a token, and shows preview data to the approver
- Use `do: wait` with `for: event` to wait for external events (webhooks, signals)
- `do: condition` for boolean if/else, `do: branch` for multi-way value matching — both run inline sub-flows and reconverge
- Model shorthands: `fast` (Gemini 3 Flash), `smart` (Claude Sonnet 4.6), `best` (Minimax M2.5)

### Declaring inputs

Flows can declare the input fields they expect via the optional `inputs` block.
A flow is **trigger-agnostic** — the runtime payload is just JSON that the
caller (CLI, webhook server, parent flow, dashboard) supplies. Inside the flow,
that payload is reachable as `{{ inputs.* }}` and `state.inputs` (in code nodes).

```json
{
  "flow": "support-triage",
  "inputs": {
    "body": { "type": "string", "required": true, "description": "Ticket body text" },
    "id":   { "type": "string", "required": true },
    "vip":  { "type": "boolean" }
  },
  "nodes": [ ... ]
}
```

Rules:

- The `inputs` block is **optional**. When omitted, the flow accepts any
  payload (anything-goes mode). Templates `{{ inputs.X }}` resolve at runtime.
- When present, every entry marked `required: true` must be in the payload at
  flow start. Missing required inputs fail the flow before any node executes.
- Extra keys in the payload that aren't declared **pass through** and remain
  reachable via `{{ inputs.* }}` — webhook envelopes can evolve without forcing
  every flow to declare every new field.
- When you **do** declare inputs, the validator catches typos like
  `{{ inputs.email_too }}` (when only `email_to` is declared) at load time.

### Environment variables

Flows can declare required and optional env vars via the `env` field. Three value types:

- `null` — **required**, flow fails at start if missing from `process.env`
- `"string"` — **default**, `process.env` overrides if set
- `"$(command)"` — **shell-expanded** at flow start, fails early if empty or errors

```json
{
  "flow": "notion-sync",
  "env": {
    "NOTION_TOKEN": null,
    "DB_URL": "$(cat /run/secrets/db_url)",
    "PAGE_SIZE": "10"
  },
  "nodes": [
    {
      "name": "search",
      "do": "http",
      "url": "https://api.notion.com/v1/search",
      "headers": { "Authorization": "Bearer {{ env.NOTION_TOKEN }}" },
      "body": { "page_size": "{{ env.PAGE_SIZE }}" },
      "output": "results"
    }
  ]
}
```

Access via `{{ env.VAR_NAME }}` in any template field. `process.env` always takes priority — if already set, the `$(...)` command is skipped.

### Templates

Any string field supports `{{ path.to.value }}` interpolation. The top-level key is always the **`output` field value**, not the node name:

```
{{ inputs.body }}               — initial payload (inputs is always available)
{{ env.API_KEY }}               — environment variable (env is always available)
{{ classification.category }}   — node with output: "classification" → access .category
{{ inputs.user.email }}         — nested dotted path from the input payload
{{ inputs }}                    — the WHOLE payload, auto-serialized to JSON
{{ inputs | json }}             — same thing, explicit (preferred for clarity)
```

A bare reference to an object or array (`{{ inputs }}`, `{{ classification }}`) renders as **JSON**, not `[object Object]` — so to drop an entire payload into a prompt or task, just write `{{ inputs | json }}`. You never need a `code` node to serialize state for a template.

**Filters:** Use `{{ value | filter }}` to transform values inline:

| Filter | Effect |
|--------|--------|
| `json` | Serialize object/array to JSON string (alias: `tojson`) |
| `upper` | Uppercase |
| `lower` | Lowercase |
| `trim` | Strip whitespace |
| `length` | Array/string/object length |

**Ternary expressions:** Use `{{ expr ? val1 : val2 }}` for inline conditionals:

```
{{ sheet.type == 'diametri' ? '_diametri' : '' }}
{{ count > 10 ? 'many' : 'few' }}
{{ flag ? 'yes' : 'no' }}
```

Supported operators: `==`, `!=`, `>`, `<`, `>=`, `<=`. Bare paths evaluate as truthy/falsy.

**Wildcard `[*]`:** Collect a field from all items in an array:

```
{{ results[*].pdfPath }}     → ["/a.pdf", "/b.pdf", "/c.pdf"]
{{ results[*] }}             → full array
```

**Common mistake:** If a node has `"name": "get_data", "output": "api"`, reference it as `{{ api }}` — NOT `{{ get_data }}`. The node name is just an identifier; the output key is what goes into state.

**Common mistake:** Don't add a `code` node just to `JSON.stringify` state for a template (e.g. `run: "JSON.stringify(state.inputs)"` → `{{ raw_body }}`). Templates already serialize objects automatically — use `{{ inputs | json }}` directly. A `code` node is only warranted when you need real transformation, not serialization.

### do: ai — attachments (images & PDFs)

AI nodes support an `attachments` field — an array of file paths or URLs sent as multimodal content alongside the prompt. Templates are supported.

```json
{
  "name": "analyze-receipt",
  "do": "ai",
  "prompt": "Extract the total and vendor name from this receipt",
  "attachments": ["{{ inputs.receiptPath }}"],
  "schema": { "total": "number", "vendor": "string" },
  "model": "smart",
  "output": "extracted"
}
```

- **Images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` — sent as `image_url` content blocks
- **PDFs**: `.pdf` — sent as `file` content blocks
- **URLs**: passed through directly (no file read): `"attachments": ["https://example.com/photo.jpg"]`
- **Local files**: base64-encoded automatically
- Combine with `schema` for structured extraction from images/documents
- Works with all providers: OpenRouter, OpenAI, Anthropic, gateway

### do: exec — deterministic shell execution

Runs a command with no AI involved. Returns `{ stdout, stderr, exitCode }`. Non-zero exit codes are captured, not thrown.

```json
{
  "name": "build-pdf",
  "do": "exec",
  "command": "python3 /path/script.py '{{ pdfPath }}' '{{ data | json }}'",
  "output": "buildResult"
}
```

- Use `| json` filter to pass objects as JSON strings to scripts
- Optional `cwd` field for working directory
- Both `command` and `cwd` support template resolution
- Use ternary for conditional script selection: `"command": "python3 script{{ type == 'special' ? '_special' : '' }}.py"`

### do: wait — approval gates and event waiting

**for: approval** — pauses the flow for human review. Returns a token for resume.

```json
{
  "name": "review-pdfs",
  "do": "wait",
  "for": "approval",
  "prompt": "Review generated PDFs for {{ parsed.client_name }}",
  "preview": "process_sheets[*].pdfPath",
  "timeout": "24h",
  "output": "approval"
}
```

- `prompt`: what the approver sees (supports templates)
- `preview`: dotted path or wildcard to data shown alongside the prompt (optional)
- `timeout`: how long to wait before expiring (default: `"24h"`)
- On approval, `output` receives `{ approved: true, approvedAt: "...", token: "cf-xxxx" }`
- On denial, the flow is cancelled
- All pending approvals are tracked in a registry file and can be listed via `flow_status`
- Pre-approval trace (logs) is preserved — resume continues from where it stopped, not from scratch

**Always place `wait for: approval` before irreversible side effects** (sending emails, calling external APIs, deleting data).

**for: event** — waits for an external event (webhook, signal).

```json
{
  "name": "wait-payment",
  "do": "wait",
  "for": "event",
  "event": "stripe-webhook",
  "timeout": "1h",
  "output": "payment"
}
```

### do: loop — iterating with output

**IMPORTANT:** Always add `output` on loop nodes when downstream nodes need the results.

```json
{
  "name": "process_sheets",
  "do": "loop",
  "over": "parsed.sheets",
  "as": "sheet",
  "output": "process_sheets",
  "nodes": [
    {
      "name": "build_path",
      "do": "code",
      "run": "`/output/foglio_${state.sheet.type}.pdf`",
      "output": "pdfPath"
    },
    {
      "name": "run_script",
      "do": "exec",
      "command": "python3 /path/fill.py '{{ pdfPath }}' '{{ sheet | json }}'",
      "output": "buildResult"
    }
  ]
}
```

Inside loop nodes, the loop variable (`sheet` from `as: "sheet"`) is accessible:
- In templates: `{{ sheet.type }}`, `{{ sheet | json }}`
- In ternaries: `{{ sheet.type == 'x' ? 'a' : 'b' }}`
- In code `run` expressions: `state.sheet.type`
- Via `input`: `"input": "sheet"` → use `input.type` in `run`

Loop output is an array of sub-states. Use wildcard to extract specific fields:
```
{{ process_sheets[*].pdfPath }}  → ["/output/a.pdf", "/output/b.pdf"]
```

### Condition and branch expressions

The `if` field in condition nodes supports JS expressions with dotted paths. Both bare paths and `{{ }}` template syntax work:

```
"extractOrder.transport_type == 'CLIENTE'"
"{{ check.has_new_version }}"
"validation.valid && items.length > 0"
```

The `on` field in branch nodes resolves a dotted path to match against `paths` keys. Both bare paths and `{{ }}` work:

```json
{ "do": "branch", "on": "check.status", "paths": { "ok": [...], "error": [...] } }
{ "do": "branch", "on": "{{ check.has_changes }}", "paths": { "true": [...], "false": [...] } }
```

### Design principle: AI at the edges, determinism at the center

Prefer deterministic nodes (`exec`, `code`, `http`) for operations that don't need intelligence. Use `agent`/`ai` only where judgment or language understanding is needed:

```
extract (agent) → parse (ai+schema) → loop:
  ├─ code: build output path
  ├─ exec: run script with {{ data | json }}
→ email (agent with {{ results[*].field }})
```

### do: agent — exec approval setup

Agent nodes delegate to a real OpenClaw agent via `openclaw agent --agent <id> --message <task>` (or `--session-key <key>` when you set `sessionKey` instead of `agent`). By default, the spawned agent uses the "main" profile, which may prompt for exec approval on every shell command — blocking unattended flows.

To run agent nodes without interactive prompts, create a dedicated `clawflow` agent with full exec access:

**1. Create the agent:**

```bash
openclaw agents add clawflow
```

**2. In `openclaw.json`**, add the agent to `agents.list`. It shares the main workspace (scripts, flows, and skills live there) but gets its own exec policy via `tools.exec`:

```json5
{
  agents: {
    list: [
      { id: "main", default: true },
      {
        id: "clawflow",
        tools: {
          deny: ["gateway", "cron", "tts"],
          exec: { security: "full", ask: "off" }
        }
      }
    ]
  }
}
```

`tools.deny` controls which tools exist; `tools.exec.*` controls how exec runs. Both matter.

**3. Set exec approvals** for the `clawflow` agent (no interactive prompts):

```bash
openclaw approvals set --stdin <<'EOF'
{
  "version": 1,
  "agents": {
    "clawflow": {
      "security": "full",
      "ask": "off",
      "askFallback": "full"
    }
  }
}
EOF
```

**4. Set `agent` on agent nodes:**

```json
{
  "name": "research_topic",
  "do": "agent",
  "agent": "clawflow",
  "task": "Research the latest trends in {{ inputs.topic }}",
  "timeout": "240s",
  "output": "research"
}
```

- `agent` defaults to `"main"` if omitted (backward compatible)
- `security: "full"` + `ask: "off"` + `askFallback: "full"` = no prompts, all exec allowed
- The main interactive agent stays locked down with its own allowlist
- `exec-approvals.json` is per-agent — the `clawflow` entry only affects flow-spawned runs

## Example: LinkedIn post generator

```json
{
  "flow": "linkedin-post",
  "nodes": [
    {
      "name": "draft",
      "do": "ai",
      "prompt": "Write a LinkedIn thought leadership post about: {{ inputs.topic }}\n\nTone: professional but conversational. Include a hook, 3-5 key points, and a question to drive engagement. Add 3 relevant hashtags.",
      "schema": {
        "post": "string",
        "hook": "string",
        "hashtags": "string[]"
      },
      "model": "smart",
      "output": "result"
    }
  ]
}
```

## Example: Multi-step with approval

```json
{
  "flow": "content-pipeline",
  "nodes": [
    {
      "name": "research",
      "do": "ai",
      "prompt": "Research the topic '{{ inputs.topic }}' and list 5 key insights",
      "schema": { "insights": "string[]" },
      "model": "smart",
      "output": "research"
    },
    {
      "name": "draft",
      "do": "ai",
      "prompt": "Write a LinkedIn post using these insights:\n{{ research.insights }}",
      "schema": { "post": "string", "hashtags": "string[]" },
      "model": "smart",
      "output": "draft"
    },
    {
      "name": "review",
      "do": "wait",
      "for": "approval",
      "prompt": "Review this post before publishing:\n\n{{ draft.post }}\n\nHashtags: {{ draft.hashtags }}"
    },
    {
      "name": "publish",
      "do": "http",
      "url": "https://api.example.com/posts",
      "method": "POST",
      "body": { "content": "{{ draft.post }}" },
      "retry": { "limit": 3, "delay": "2s", "backoff": "exponential" }
    }
  ]
}
```

## Example: Loop + exec + wildcard

```json
{
  "flow": "process-and-email",
  "nodes": [
    {
      "name": "parse",
      "do": "ai",
      "prompt": "Extract items from: {{ inputs.text }}",
      "schema": { "items": [{ "type": "string", "name": "string" }] },
      "model": "smart",
      "output": "parsed"
    },
    {
      "name": "process_items",
      "do": "loop",
      "over": "parsed.items",
      "as": "item",
      "output": "process_items",
      "nodes": [
        {
          "name": "build_path",
          "do": "code",
          "run": "`/output/${state.item.type}_${state.item.name}.pdf`",
          "output": "outPath"
        },
        {
          "name": "generate",
          "do": "exec",
          "command": "python3 /scripts/generate{{ item.type == 'special' ? '_special' : '' }}.py '{{ outPath }}' '{{ item | json }}'",
          "output": "genResult"
        }
      ]
    },
    {
      "name": "notify",
      "do": "agent",
      "task": "Send email to {{ inputs.email }} with these attachments:\n{{ process_items[*].outPath }}"
    }
  ]
}
```

## Example: Image/PDF analysis with structured output

```json
{
  "flow": "invoice-processor",
  "nodes": [
    {
      "name": "extract",
      "do": "ai",
      "prompt": "Extract all line items, totals, and vendor info from this invoice",
      "attachments": ["{{ inputs.invoicePath }}"],
      "schema": {
        "vendor": "string",
        "date": "string",
        "items": [{ "description": "string", "amount": "number" }],
        "total": "number"
      },
      "model": "smart",
      "output": "invoice"
    },
    {
      "name": "review",
      "do": "wait",
      "for": "approval",
      "prompt": "Verify extracted invoice from {{ invoice.vendor }}: ${{ invoice.total }}"
    },
    {
      "name": "save",
      "do": "http",
      "url": "https://api.example.com/invoices",
      "method": "POST",
      "body": "{{ invoice | json }}",
      "output": "saved"
    }
  ]
}
```

## Saving flows for reuse

Use `flow_create` to save a flow to disk. Plain names are saved to `workspace/flows/<name>.json` automatically.

```
# Create and save
flow_create with file: "linkedin-post", flow: "linkedin-post", nodes: [...]

# Run later
flow_run with file: "linkedin-post", input: { "topic": "..." }
```

## Versioning

Flows support draft/publish versioning. The file in `flows/` is the **draft** (working copy). Published versions are immutable snapshots stored in `.clawflow/versions/<flowName>/`.

```
flows/
  my-flow.json                  ← draft (flow_edit modifies this)
.clawflow/
  history/my-flow/              ← undo stack (auto-snapshot on every edit)
  versions/my-flow/             ← published versions (immutable)
    1.json
    2.json
```

**Workflow:**

1. `flow_create` or `flow_edit` — work on the draft
2. `flow_read file: "my-flow"` — inspect the draft, see expected inputs and available versions
3. `flow_run file: "my-flow" draft: true` — test the draft
4. `flow_publish file: "my-flow"` — promote draft to next version (validates first)
5. `flow_run file: "my-flow"` — runs latest published version

**Rules:**
- `flow_run` uses the latest published version by default. Falls back to draft if no versions exist.
- Incoming triggers (`POST /flows/:name/run` on the flow server — webhooks, HTTP
  triggers, dashboard runs) resolve the same way: latest published version, draft
  only when nothing is published. So a draft edit does not change what a live
  trigger executes once the flow has been published at least once.
- `flow_run file: "my-flow" draft: true` — explicitly run the working copy
- `flow_run file: "my-flow" version: 2` — run a specific version
- `flow_read file: "my-flow" version: 1` — inspect a specific published version
- Version numbers are auto-incrementing integers (1, 2, 3...) — no semver
- Edits to the draft never affect published versions
- **Do NOT create separate files for versions** (e.g. `my-flow-v2.json`). Use `flow_publish` instead.

## Reading and discovering flows

- `flow_list` — lists all flows with their description, declared `inputs:` block, and published version info
- `flow_read file: "my-flow"` — full definition; response includes the declared `inputs:` block plus a best-effort `_expectedInputs` list extracted from `{{ inputs.* }}` templates, and available versions
- `flow_read file: "my-flow" node: "classify"` — inspect a single node (searches nested structures)

**Always use `flow_read` before running an unfamiliar flow** to understand what inputs it expects.

## Editing existing flows

`flow_edit` makes **surgical, in-place edits** to the draft — one operation at a time. Prefer it to rewriting the file. Actions:

- `add` — insert a node at a position (or inside a branch via `parent`)
- `remove` — remove a node by name
- `move` — reparent or reorder a single node (`node` + `parent` + `position`)
- `wrap` — wrap one or more existing nodes into a new container (`loop`, `condition`, `branch`, `parallel`)
- `update` — change fields on a node, or replace it whole
- `revert` — undo the last edit (restores the previous auto-snapshot)

All node-targeting actions search recursively through nested structures, and `parent` takes a slash-separated path into them: `"myCond/then"`, `"myCond/else"`, `"myLoop"`, `"outer/true/inner"`.

**To restructure — nest existing nodes under a condition or loop, reorder them, or make a group conditional — use `wrap` or `move`. Do NOT remove-and-re-add every node, and do NOT re-emit the entire flow definition as one giant edit.** Whole-flow rewrites are slow, easy to get wrong, and — because a large single response can stall mid-generation — may fail partway and leave you re-typing everything.

Example — make the whole pipeline run only when a guard passes, in one call (instead of rewriting the flow):

```
flow_edit file: "notify-event-created" action: "wrap"
  nodes: ["extract_venue", "lookup_venue", "match_or_create_venue", "is_new_venue"]
  wrapper: { name: "if_not_duplicate", do: "condition", if: "{{ existing_events.body.events.length === 0 }}" }
```

To move already-existing nodes into an existing condition's `else` branch instead, `move` each one with `parent: "if_not_duplicate/else"`.

Every edit is validated after it applies; if validation fails the edit is rejected and the draft is unchanged. Each edit also snapshots to the undo stack, so `revert` walks you back.

## Other tools

| Tool | Use |
|------|-----|
| `flow_create` | Create a new flow definition and save it to a JSON file |
| `flow_delete` | Soft-delete a flow (moves to `.clawflow/bin/` with timestamp) |
| `flow_restore_from_bin` | List bin contents or restore a deleted flow from `.clawflow/bin/` |
| `flow_list` | List all flows with metadata, expected inputs, and version info |
| `flow_read` | Read a flow definition (draft or specific version), inspect single nodes |
| `flow_publish` | Publish current draft as a new numbered version |
| `flow_edit` | Edit a flow: set top-level fields, modify nodes (update, add, remove, move, wrap, revert, list). Use `parent` for nested targets (e.g. `"myBranch/true"`, `"myLoop"`). Use `wrap` to wrap nodes into containers. |
| `flow_resume` | Resume a paused flow after approval (`instanceId`, `approved: true/false`, `flow`) |
| `flow_send_event` | Push an event into a waiting flow (`instanceId`, `eventType`, `payload`) |
| `flow_status` | Check status of a flow instance or list all instances |
