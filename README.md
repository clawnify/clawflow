<p align="center" dir="auto">
  <a target="_blank" rel="noopener noreferrer" href="https://www.clawnify.com"><img src="https://github.com/user-attachments/assets/ff7c98e6-ee70-4b4c-89ff-7c530369fdcb" alt="ClawFlow" width="600" style="max-width: 100%;"></a>
</p>
<div class="markdown-heading" dir="auto"><h1 align="center" tabindex="-1" class="heading-element" dir="auto">ClawFlow</h1><a id="user-content-clawflow" class="anchor" aria-label="Permalink: ClawFlow" href="#clawflow"></a></div>

> The n8n for agents. A declarative, AI-native workflow format that agents can read, write, and run — without infrastructure.

---

## The Problem

Workflows today are written **for** agents, not **by** them. Visual canvas tools require humans to click nodes. Code-first orchestration frameworks have too much surface area for LLMs to generate reliably.

**What if the agent itself could design, build, and modify the workflow?**

---

## The Vision

**`clawflow` is a workflow format designed from first principles for agents.**

Three rules drove every design decision:

1. **An LLM must be able to write a valid workflow from a natural language description in a single turn.** If the format is too complex, agents hallucinate structure. If it's too simple, real workflows can't be expressed.

2. **The format is the asset, not the runtime.** Write once, run as an OpenClaw plugin today, deploy to Cloudflare Workers tomorrow, run in a standalone server next month. The spec outlives any particular runtime.

3. **AI nodes are first-class citizens, not HTTP calls with extra steps.** Every other workflow tool treats AI as just another integration. Here, `do: ai` and `do: agent` are core primitives with their own semantics: structured output, model selection, schema validation.

---

## What We're Building

```
clawflow/
│
├── Format Spec         The .flow JSON/YAML definition language
├── OpenClaw Plugin     Run flows inside OpenClaw as agent tools (today)
├── Cloudflare Runtime  Transpile flows to Workers + Durable Objects (next)
├── Standalone Runner   Node.js server for self-hosted deployment
└── Flow Registry       Shareable, reusable community flow library
```

---

## The Format

A flow is a JSON (or YAML) document. No custom syntax, no new language — just structured data that any LLM can generate from a description.

```json
{
  "flow": "support-triage",
  "description": "Classify a ticket, draft a reply, get approval, send it",
  "trigger": { "on": "webhook", "from": "helpdesk" },
  "nodes": [
    {
      "name": "classify",
      "do": "ai",
      "prompt": "Classify this ticket as billing, technical, or general",
      "input": "trigger.body",
      "schema": {
        "category": "billing | technical | general",
        "urgency": "low | medium | high",
        "summary": "string"
      },
      "model": "fast",
      "output": "classification"
    },
    {
      "name": "route",
      "do": "branch",
      "on": "classification.category",
      "paths": {
        "billing": [
          {
            "name": "handle-billing",
            "do": "agent",
            "task": "Draft a billing support reply for: {{ trigger.body }}",
            "model": "smart",
            "output": "draft"
          }
        ],
        "technical": [
          {
            "name": "handle-technical",
            "do": "agent",
            "task": "Draft a technical support reply for: {{ trigger.body }}",
            "model": "smart",
            "output": "draft"
          }
        ]
      },
      "default": [
        {
          "name": "handle-general",
          "do": "agent",
          "task": "Draft a general support reply for: {{ trigger.body }}",
          "model": "smart",
          "output": "draft"
        }
      ]
    },
    {
      "name": "approve",
      "do": "wait",
      "for": "approval",
      "prompt": "Send this reply?\n\n{{ draft }}"
    },
    {
      "name": "send",
      "do": "http",
      "url": "https://helpdesk.example.com/api/reply",
      "method": "POST",
      "body": { "message": "{{ draft }}", "ticketId": "{{ trigger.id }}" },
      "retry": { "limit": 3, "delay": "2s", "backoff": "exponential" }
    }
  ]
}
```

---

## Node Types

10 node types. This is intentional — the constraint is the feature. An LLM can reliably generate valid flows because there's nothing to hallucinate.

### `do: ai` — LLM call

The most important node. A single LLM call that returns structured or freeform output.

```json
{
  "name": "classify",
  "do": "ai",
  "prompt": "Classify this support ticket",
  "input": "trigger.body",
  "schema": {
    "category": "billing | technical | general",
    "confidence": "number",
    "summary": "string"
  },
  "model": "fast",
  "output": "classification"
}
```

| Field | Description |
|---|---|
| `prompt` | The instruction to the model. Supports `{{ templates }}`. |
| `input` | Dotted path to a value in flow state passed as context |
| `schema` | Output shape. When set, enforces JSON mode. Keys are type hints. |
| `model` | `fast` (Haiku), `smart` (Sonnet), `best` (Opus), or any model string |
| `temperature` | 0–1, default 0 for deterministic workflow steps |

**Why schema matters:** downstream nodes reference `classification.category` as a reliable string. Without schema, the output is freeform text and you're back to parsing.

---

### `do: agent` — delegate to a real agent

Runs a task through a real OpenClaw agent with full tool access (browser, exec, memory, etc.). The agent decides its own path to a result.

```json
{
  "name": "scrape",
  "do": "agent",
  "task": "Navigate to https://example.com and extract the pricing table as JSON",
  "agent": "main",
  "timeout": "120s",
  "output": "data"
}
```

On OpenClaw, this delegates to `openclaw agent --agent <id> --message "..."`. The agent gets full tool access — browser, shell, file system, memory. Falls back to a single AI call if the CLI is unavailable (standalone mode).

| Field | Description |
|---|---|
| `task` | The instruction to the agent. Supports `{{ templates }}`. |
| `agent` | OpenClaw agent ID (e.g. `"main"`, `"ops"`). Uses config `defaultAgent` or `"main"` if omitted. |
| `input` | Dotted path to context passed with the task |
| `tools` | Hint for non-OpenClaw runtimes (OpenClaw agents have their own tool policy) |
| `model` | Model for fallback AI call (standalone mode only) |

The distinction between `ai` and `agent` is intentional:
- `do: ai` = deterministic, one-shot, structured output — use for classification, drafting, extraction
- `do: agent` = open-ended, multi-step, uses tools — use for scraping, research, file operations

---

### `do: branch` — multi-way routing

Routes the flow to a sub-flow based on a value in state. Each path is an array of nodes that executes as a self-contained block, then reconverges back into the main flow.

```json
{
  "name": "route",
  "do": "branch",
  "on": "classification.category",
  "paths": {
    "billing": [
      { "name": "lookup-invoice", "do": "http", "url": "https://api.example.com/invoice/{{ trigger.id }}", "output": "invoice" },
      { "name": "draft-reply", "do": "ai", "prompt": "Draft billing reply for: {{ invoice }}", "output": "draft" }
    ],
    "technical": [
      { "name": "draft-reply", "do": "agent", "task": "Research and draft technical reply for: {{ trigger.body }}", "output": "draft" }
    ]
  },
  "default": [
    { "name": "draft-reply", "do": "ai", "prompt": "Draft a general reply for: {{ trigger.body }}", "output": "draft" }
  ]
}
```

Each path runs its full node sequence and merges state back. The `default` path handles any value not explicitly listed. No `default` + no matching path = runtime error (intentional — fail loudly).

Use `branch` for multi-way value matching, `condition` for boolean if/else logic. Both support full sub-flows and reconverge automatically.

---

### `do: condition` — if/else with reconvergence

Runs inline sub-node blocks based on a boolean condition, then merges back into the main flow. Use `condition` for true/false logic, `branch` for multi-way value matching.

```json
{
  "name": "check-transport",
  "do": "condition",
  "if": "extractOrder.transport_type == 'CLIENTE'",
  "then": [
    { "name": "pickup-note", "do": "code", "run": "'Client picks up'", "output": "note" }
  ],
  "else": [
    { "name": "delivery-note", "do": "code", "run": "'We deliver'", "output": "note" }
  ]
}
```

| Field | Description |
|---|---|
| `if` | JS expression evaluated against flow state. Dotted paths are resolved. |
| `then` | Nodes to run when condition is true |
| `else` | Nodes to run when condition is false (optional — skipped if absent) |

Supports comparison and logical operators:
```
"classification.priority == 'urgent'"
"validation.valid && items.length > 0"
"trigger.amount > 1000 || trigger.vip == true"
```

---

### `do: loop` — iterate over a list

Runs a set of sub-nodes for each item in an array.

```json
{
  "name": "process-tickets",
  "do": "loop",
  "over": "inbox.tickets",
  "as": "ticket",
  "nodes": [
    {
      "name": "summarize",
      "do": "ai",
      "prompt": "Summarize this ticket: {{ ticket }}",
      "output": "summary"
    }
  ],
  "output": "processed"
}
```

Iterations run sequentially. For concurrent execution, use `do: parallel`.

---

### `do: parallel` — concurrent execution

Runs multiple nodes at the same time. Waits for all to complete (`mode: "all"`) or the first to finish (`mode: "race"`).

```json
{
  "name": "research",
  "do": "parallel",
  "mode": "all",
  "nodes": [
    {
      "name": "web-search",
      "do": "agent",
      "task": "Search the web for recent cases of {{ topic }}",
      "output": "web_results"
    },
    {
      "name": "memory-lookup",
      "do": "memory",
      "action": "read",
      "key": "knowledge-{{ topic }}",
      "output": "memory_results"
    }
  ],
  "output": "research"
}
```

`mode: "race"` mirrors Cloudflare's `Promise.race()` pattern — the first branch to complete wins and the others are discarded. Useful for: try-cache-before-fetch, multi-model racing, fallback strategies.

---

### `do: http` — external API call

```json
{
  "name": "notify-slack",
  "do": "http",
  "url": "https://hooks.slack.com/services/{{ trigger.slackWebhook }}",
  "method": "POST",
  "body": { "text": "Ticket resolved: {{ classification.summary }}" },
  "retry": { "limit": 3, "delay": "1s", "backoff": "exponential" },
  "output": "slack_response"
}
```

All fields support `{{ templates }}`. Retry is strongly recommended for any outbound call.

---

### `do: memory` — persistent key/value store

Read, write, or delete values that persist across flow runs.

```json
{ "name": "save-result",  "do": "memory", "action": "write",  "key": "ticket-{{ trigger.id }}", "value": "{{ classification.category }}" }
{ "name": "load-history", "do": "memory", "action": "read",   "key": "ticket-{{ trigger.id }}", "output": "previous_category" }
{ "name": "cleanup",      "do": "memory", "action": "delete", "key": "ticket-{{ trigger.id }}" }
```

In the OpenClaw plugin, memory persists to `~/.openclaw/flow-memory/`. In Cloudflare, it maps to KV or D1. Keys support templates.

---

### `do: wait` — pause for human or external event

Two modes:

**Approval gate** — pauses the flow and returns a `resumeToken`. A human reviews and approves or denies via `flow_resume`.

```json
{
  "name": "approve-send",
  "do": "wait",
  "for": "approval",
  "prompt": "Send this reply to the customer?\n\n{{ draft }}"
}
```

**External event** — blocks until an external system pushes the matching event via `flow_send_event`. Learned from Cloudflare's `step.waitForEvent()`.

```json
{
  "name": "await-payment",
  "do": "wait",
  "for": "event",
  "event": "stripe-payment-confirmed",
  "timeout": "24h",
  "output": "payment"
}
```

When a Stripe webhook arrives, the calling code does:
```json
{ "tool": "flow_send_event", "instanceId": "...", "eventType": "stripe-payment-confirmed", "payload": { "amount": 4900 } }
```

The flow resumes with `payment.amount = 4900` in state.

---

### `do: sleep` — time-based pause

```json
{ "name": "cool-down", "do": "sleep", "duration": "5m" }
```

Duration syntax: `30s`, `5m`, `2h`, `1d`. Maps directly to Cloudflare's `step.sleep()`. Does not count towards step limits.

---

### `do: code` — inline expression

```json
{
  "name": "format-date",
  "do": "code",
  "input": "trigger.timestamp",
  "run": "new Date(input).toLocaleDateString('en-GB')",
  "output": "formatted_date"
}
```

Constrained: synchronous expressions only, no imports, no async. For anything more complex, use `do: http` to call a function or `do: agent` with a code-writing tool.

---

## Templates

Any string field supports `{{ path.to.value }}` interpolation resolved against flow state:

```
{{ trigger.body }}              # initial input
{{ classify.category }}         # output from node named "classify"
{{ trigger.user.email }}        # nested dotted path
{{ research.web_results }}      # array or object (serialized to JSON string)
```

Flow state starts as `{ trigger: <input> }` and grows as nodes complete.

---

## Retry Policy

Any node can define per-node retry behavior. Learned directly from Cloudflare's `WorkflowStepConfig`:

```json
{
  "retry": {
    "limit": 3,
    "delay": "2s",
    "backoff": "exponential"
  }
}
```

| Field | Values | Default |
|---|---|---|
| `limit` | integer | 1 (no retry) |
| `delay` | duration string or ms | `"0"` |
| `backoff` | `constant`, `linear`, `exponential` | `constant` |

Strongly recommended on `do: http` and `do: ai` nodes. Do not use on `do: wait` — retrying approval gates makes no sense.

---

## Flow State and Durability

Every flow run gets a unique `instanceId`. The runner persists state after every completed node to `~/.openclaw/flow-state/<instanceId>.json`.

**What this means in practice:**

- Gateway restarts mid-flow? Already-completed nodes are not re-run. The flow resumes from the last checkpoint.
- A node that took 30 seconds to run won't run again on resume — its memoized output is loaded from disk.
- An approval-gated flow can stay paused for days. The state survives indefinitely.

This is the lightweight equivalent of Cloudflare Durable Objects' memoization. Cloudflare does it at the infrastructure level with global durability. We do it at the file system level for local/self-hosted use.

---

## Runtime Targets

The format is the spec. The runtime is swappable.

### 1. OpenClaw Plugin (current)

Five tools registered in OpenClaw:

| Tool | Does |
|---|---|
| `flow_run` | Execute a flow inline or from a file |
| `flow_resume` | Resume after an approval gate |
| `flow_send_event` | Push an event into a waiting flow |
| `flow_status` | Inspect any running or completed instance |
| `flow_transpile` | Convert a flow to Cloudflare Workers TypeScript |

**Install:**
```bash
npm install @clawnify/clawflow
```

**Or as an OpenClaw plugin:**
```bash
openclaw plugins install @clawnify/clawflow
```

**Config:**
```json
{
  "plugins": {
    "entries": {
      "clawflow": {
        "enabled": true,
        "config": { "defaultModel": "smart" }
      }
    }
  },
  "agents": {
    "list": [{
      "id": "main",
      "tools": { "alsoAllow": ["flow_run", "flow_resume", "flow_send_event", "flow_status", "flow_transpile"] }
    }]
  }
}
```

---

### 2. Cloudflare Workers + Workflows (transpiler)

`flow_transpile` converts any `.flow` definition to a complete Cloudflare `WorkflowEntrypoint` TypeScript class.

Node mapping:

| clawflow | Cloudflare Workflows |
|---|---|
| `do: ai` | `step.do()` with AI provider call |
| `do: agent` | `step.do()` with extended AI call |
| `do: wait / for: event` | `step.waitForEvent({ type, timeout })` |
| `do: sleep` | `step.sleep(name, duration)` |
| `do: parallel / mode: race` | `Promise.race([step.do, ...])` |
| `do: parallel / mode: all` | `Promise.all([step.do, ...])` |
| `do: http` | `step.do()` wrapping `fetch()` |
| `do: memory` | `step.do()` wrapping KV/D1 |
| retry policy | `step.do(name, config, callback)` |

The transpiler gives you:
- **Durable execution** — Cloudflare guarantees steps complete exactly once, globally
- **Long-running flows** — minutes, hours, weeks — without timeouts
- **Global scale** — Cloudflare's network, not your server
- **Audit trail** — Cloudflare's Workflows dashboard shows every step

---

### 3. Standalone Node.js Runner (coming soon)

A small HTTP server wrapping the runner. Expose flows as endpoints, receive webhooks, manage instances via REST API. Self-hosted alternative to Cloudflare.

```
POST  /flows/:name/run       # start a flow instance
POST  /flows/resume          # resume paused flow
POST  /flows/event           # send event to waiting flow
GET   /flows/instances       # list all instances
GET   /flows/instances/:id   # get instance status
```

---

### 4. Flow Registry (coming soon)

A community library of reusable, shareable `.flow` definitions. Think npm for workflows — but agent-writable.

```
clawflow install support-triage
clawflow install github-pr-review
clawflow install invoice-processing
clawflow install lead-enrichment
```

Every flow in the registry is:
- Parameterized (inputs declared in `trigger`)
- Runtime-agnostic (runs on OpenClaw or Cloudflare)
- LLM-editable (agents can fork and modify them)

---

## How Agents Build Workflows

This is the core loop that makes this different from every other workflow tool:

```
User:  "When a new GitHub PR is opened, have an AI review the diff,
        check if all tests pass, and if the review is positive
        post an approval — otherwise request changes with specific feedback"

Agent: [calls flow_run with an inline flow definition it just generated]

→ flow runs
→ AI reviews diff (do: ai)
→ checks CI status (do: http → GitHub API)
→ branches on review result (do: branch)
→ posts comment (do: http → GitHub API)
```

The agent doesn't need a visual canvas. It doesn't need to learn a DSL. It reads the node type descriptions from the tool definition and generates valid JSON in one turn.

### System prompt for flow authorship

Add this to a skill or system prompt to enable an agent to write flows:

```
You can design and run workflows using flow_run.
Flows are JSON with a "flow" name and "nodes" array.

Node types: ai, agent, branch, loop, parallel, http, memory, wait, sleep, code

Rules:
- Every node needs a unique "name"
- Use "output" to name a node's result — other nodes reference it as {{ nodeName.field }}
- Always add "schema" to ai nodes when downstream nodes need typed fields
- Use "retry" on all http nodes: { "limit": 3, "delay": "2s", "backoff": "exponential" }
- Use "do: agent" for open-ended research/tasks, "do: ai" for structured extraction
- "do: wait" with "for: approval" pauses for human review before side effects
- "do: parallel" runs nodes concurrently; use when steps are independent
- Prefer "model": "fast" for classification, "smart" for drafting, "best" for complex reasoning
```

---

## What's Shipped (v0.2)

- 11 node types: ai, agent, branch, condition, loop, parallel, http, memory, wait, sleep, code
- Static flow validation before execution
- `do: agent` delegates to real OpenClaw agents
- `do: branch` and `do: condition` with inline sub-flows and automatic reconvergence
- Per-node retry with exponential/linear/constant backoff
- `waitForEvent` — external systems push events into waiting flows
- Durable state: memoized node outputs persist across restarts
- Cloudflare transpiler — convert flows to `WorkflowEntrypoint` TypeScript
- Plugin ships a skill (SKILL.md) so agents know how to write flows

## What's Next

- Standalone HTTP runner (self-hosted, no OpenClaw dependency)
- Webhook and cron triggers
- Observability: structured traces, token tracking
- Flow registry: shareable, reusable community flows
- Visual canvas

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        .flow definition                         │
│              (JSON/YAML — the portable format spec)             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
    ┌──────▼──────┐    ┌───────▼──────┐   ┌────────▼───────┐
    │  OpenClaw   │    │  Cloudflare  │   │   Standalone   │
    │   Plugin    │    │   Workers    │   │  Node Server   │
    │             │    │   (via       │   │   (coming soon)    │
    │ flow_run    │    │  transpiler) │   │                │
    │ flow_resume │    │              │   │ REST API       │
    │ flow_status │    │ step.do()    │   │ Webhook recv   │
    │ flow_event  │    │ waitForEvent │   │ Cron trigger   │
    └──────┬──────┘    └──────────────┘   └────────────────┘
           │
    ┌──────▼──────────────────────────────┐
    │            FlowRunner               │
    │                                     │
    │  ┌─────────┐   ┌─────────────────┐  │
    │  │ State   │   │   Event Bus     │  │
    │  │ Store   │   │ (waitForEvent)  │  │
    │  │         │   │                 │  │
    │  │ memoize │   │ sendEvent()     │  │
    │  │ resume  │   │ per instanceId  │  │
    │  └─────────┘   └─────────────────┘  │
    │                                     │
    │  Node executors:                    │
    │  execAi · execAgent · execBranch    │
    │  execLoop · execParallel · execHttp │
    │  execMemory · execWait · execSleep  │
    │  execCode                           │
    └─────────────────────────────────────┘
```

---

## Contributing

The most valuable contributions right now:

1. **Real-world flow definitions** — try to describe a workflow you actually run, generate the `.flow` JSON, and report where the format breaks down
2. **Transpiler completeness** — test the Cloudflare transpiler output and file issues for nodes that don't map cleanly
3. **Node type proposals** — what's the 10th node type? What real workflow pattern can't be expressed with the current 9?
4. **Runtime implementations** — a Python runner, a Go runner, a Rust runner — anything that proves portability

---

## License

MIT
