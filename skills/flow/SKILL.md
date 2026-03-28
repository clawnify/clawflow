---
name: flow
description: Design and run declarative agentic workflows using clawflow. Use when the user asks to create a workflow, automation, pipeline, or flow.
---

# ClawFlow — Workflow Authoring Guide

You have access to the `flow_run` tool. Use it to design and execute declarative workflows from natural language descriptions.

## When to use this

- User asks to create a workflow, automation, or pipeline
- User wants to chain AI calls with approvals, HTTP calls, or logic
- User needs a repeatable process (e.g. "generate a LinkedIn post from an idea")
- User says "create a flow", "run a flow", "build a workflow"

## How to write a flow

A flow is JSON with a `flow` name and a `nodes` array. Call `flow_run` with the flow inline or from a file.

### Node types (11 total)

| Node | Purpose | Key fields |
|------|---------|------------|
| `ai` | Single LLM call, structured or freeform | `prompt`, `schema`, `model`, `input` |
| `agent` | Delegate to a real OpenClaw agent (with tools, browser, etc.) | `task`, `agent`, `tools`, `model` |
| `approve` | Human-in-the-loop gate — pauses for approval with token | `prompt`, `preview`, `timeout` |
| `exec` | Run a shell command deterministically (no AI) | `command`, `cwd` |
| `branch` | Multi-way routing with inline sub-flows per path | `on`, `paths`, `default` |
| `condition` | If/else with sub-node blocks that reconverge | `if`, `then`, `else` |
| `loop` | Iterate over an array | `over`, `as`, `nodes` |
| `parallel` | Run nodes concurrently | `nodes`, `mode: "all"\|"race"` |
| `http` | Call an external API | `url`, `method`, `body`, `headers` |
| `memory` | Persistent key/value store | `action: "read"\|"write"\|"delete"`, `key` |
| `wait` | Wait for an external event | `for: "event"`, `event`, `timeout` |
| `sleep` | Pause for a duration | `duration: "5m"` |
| `code` | Inline JS expression | `run`, `input` |

### Rules

- Every node needs a unique `name`
- Use `output` to name a node's result — other nodes reference it via the **output key**, NOT the node name: `{{ outputKey.field }}`
- **CRITICAL: `output` is required to store a node's result in state.** Without it, the result is discarded. This applies to ALL nodes including `loop`, `branch`, `parallel`, `condition`. If a downstream node references a result, the producing node MUST have `output`.
- Always add `schema` to `ai` nodes when downstream nodes need typed fields
- Use `retry` on `http` and `ai` nodes: `{ "limit": 3, "delay": "2s", "backoff": "exponential" }`
- Use `do: exec` for deterministic operations (scripts, file processing, CLI tools) — never use `do: agent` for pure shell commands
- Use `do: agent` for tasks that need tools (browser, exec, memory, MCP, CLI) — delegates to a real OpenClaw agent
- Use `do: ai` for structured extraction and single-turn LLM calls
- Set `agent: "ops"` on agent nodes to target a specific OpenClaw agent ID
- Use `do: approve` before any side effects that need human review — it pauses the flow and provides a token for resume
- `do: wait` with `for: event` waits for external events (webhooks, signals)
- `do: condition` for boolean if/else, `do: branch` for multi-way value matching — both run inline sub-flows and reconverge
- Model shorthands: `fast` (Gemini 3 Flash), `smart` (Claude Sonnet 4.6), `best` (Minimax M2.5)

### Templates

Any string field supports `{{ path.to.value }}` interpolation. The top-level key is always the **`output` field value**, not the node name:

```
{{ trigger.body }}              — initial input (trigger is always available)
{{ classification.category }}   — node with output: "classification" → access .category
{{ trigger.user.email }}        — nested dotted path from trigger
```

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

### do: approve — human-in-the-loop gate

Pauses the flow for human approval. Returns a token that can be used to resume or cancel.

```json
{
  "name": "review-pdfs",
  "do": "approve",
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

**Always place `approve` before irreversible side effects** (sending emails, calling external APIs, deleting data).

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

### Condition expressions

The `if` field in condition nodes supports JS expressions with dotted paths:

```
"extractOrder.transport_type == 'CLIENTE'"
"validation.valid && items.length > 0"
"trigger.priority == 'high' || trigger.urgent == true"
```

### Design principle: AI at the edges, determinism at the center

Prefer deterministic nodes (`exec`, `code`, `http`) for operations that don't need intelligence. Use `agent`/`ai` only where judgment or language understanding is needed:

```
extract (agent) → parse (ai+schema) → loop:
  ├─ code: build output path
  ├─ exec: run script with {{ data | json }}
→ email (agent with {{ results[*].field }})
```

## Example: LinkedIn post generator

```json
{
  "flow": "linkedin-post",
  "nodes": [
    {
      "name": "draft",
      "do": "ai",
      "prompt": "Write a LinkedIn thought leadership post about: {{ trigger.topic }}\n\nTone: professional but conversational. Include a hook, 3-5 key points, and a question to drive engagement. Add 3 relevant hashtags.",
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
      "prompt": "Research the topic '{{ trigger.topic }}' and list 5 key insights",
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
      "do": "approve",
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
      "prompt": "Extract items from: {{ trigger.text }}",
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
      "task": "Send email to {{ trigger.email }} with these attachments:\n{{ process_items[*].outPath }}"
    }
  ]
}
```

## Saving flows for reuse

When the user wants to save a flow for later use, write it to `flows/<flow-name>.json` in the workspace. File paths in `flow_run` resolve relative to `OPENCLAW_WORKSPACE`.

```
# Save
Write the flow JSON to flows/linkedin-post.json

# Run later
flow_run with file: "flows/linkedin-post.json", input: { "topic": "..." }
```

## Other tools

| Tool | Use |
|------|-----|
| `flow_resume` | Resume a paused flow after approval (`instanceId`, `approved: true/false`, `flow`) |
| `flow_send_event` | Push an event into a waiting flow (`instanceId`, `eventType`, `payload`) |
| `flow_status` | Check status of a flow instance or list all instances |
| `flow_transpile` | Convert a flow to Cloudflare Workers TypeScript |
