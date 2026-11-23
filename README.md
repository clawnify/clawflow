<p align="center" dir="auto">
  <a target="_blank" rel="noopener noreferrer" href="https://www.clawnify.com"><img src="https://github.com/user-attachments/assets/246bcdb2-a508-4c21-a8db-081b6baf4526" alt="ClawFlow" width="600" style="max-width: 100%;"></a>
</p>
<div class="markdown-heading" dir="auto"><h1 align="center" tabindex="-1" class="heading-element" dir="auto">ClawFlow</h1><a id="user-content-clawflow" class="anchor" aria-label="Permalink: ClawFlow" href="#clawflow"></a></div>

<p align="center">
  <a href="https://www.npmjs.com/package/@clawnify/clawflow"><img src="https://img.shields.io/npm/v/@clawnify/clawflow?color=blue" alt="npm"></a>
  <a href="https://github.com/clawnify/clawflow/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://www.reddit.com/r/clawflow/"><img src="https://img.shields.io/badge/reddit-r%2Fclawflow-orange?logo=reddit&logoColor=white" alt="Reddit"></a>
  <a href="https://www.clawnify.com"><img src="https://img.shields.io/badge/clawnify.com-website-blueviolet" alt="Website"></a>
</p>

> The n8n for agents. A declarative, AI-native workflow format that agents can read, write, and run — without infrastructure.

---

## Install

```bash
npm install @clawnify/clawflow
```

Or as an OpenClaw plugin:
```bash
openclaw plugins install @clawnify/clawflow
```

From source:
```bash
git clone https://github.com/clawnify/clawflow.git
cd clawflow && npm install && npm run build
```

---

## Why ClawFlow

Workflows today are written **for** agents, not **by** them. Visual canvas tools require humans to click nodes. Code-first orchestration frameworks have too much surface area for LLMs to generate reliably.

**ClawFlow is a workflow format designed from first principles for agents.** Three rules drove every design decision:

1. **An LLM must be able to write a valid workflow in a single turn.** If the format is too complex, agents hallucinate. If it's too simple, real workflows can't be expressed.

2. **The format is the asset, not the runtime.** Write once, run as an OpenClaw plugin today, run in a standalone server tomorrow.

3. **AI nodes are first-class citizens.** `do: ai` and `do: agent` are core primitives with structured output, model selection, and schema validation — not HTTP calls with extra steps.

---

## Features

### AI-Native
- **`do: ai`** — structured LLM calls with schema validation and model selection (`fast`, `smart`, `best`)
- **`do: agent`** — delegate to real agents with full tool access (browser, exec, memory, MCP, CLI)
- **Agent-writable** — any LLM can generate a valid flow from a natural language description

### Control Flow
- **`do: branch`** — multi-way routing with inline sub-flows per path
- **`do: condition`** — if/else with automatic reconvergence
- **`do: loop`** — iterate over arrays
- **`do: parallel`** — concurrent execution with `all` or `race` modes

### Durability
- **Memoized state** — completed nodes aren't re-run on resume
- **Approval gates** — `do: wait` pauses for human review, resumes with a token
- **External events** — `waitForEvent` blocks until an external system pushes data
- **Per-node retry** — exponential, linear, or constant backoff on any node
- **Scheduled triggers** — cron schedules as first-class records: many per flow, each with its own inputs, paused without touching the flow

### Portability
- **OpenClaw plugin** — run flows as agent tools today
- **Standalone runner** — self-hosted Node.js server (coming soon)
- **Static validation** — catch bad references and missing fields before execution
- **Draft/publish versioning** — edit safely, publish when ready, run any version

---

## Quick Example

A flow is JSON. No custom syntax, no new language — just structured data that any LLM can generate from a description.

```json
{
  "flow": "support-triage",
  "description": "Classify a ticket, draft a reply, get approval, send it",
  "inputs": {
    "body": { "type": "string", "required": true },
    "id":   { "type": "string", "required": true }
  },
  "nodes": [
    {
      "name": "classify",
      "do": "ai",
      "prompt": "Classify this ticket as billing, technical, or general",
      "input": "inputs.body",
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
            "task": "Draft a billing support reply for: {{ inputs.body }}",
            "output": "draft"
          }
        ],
        "technical": [
          {
            "name": "handle-technical",
            "do": "agent",
            "task": "Draft a technical support reply for: {{ inputs.body }}",
            "output": "draft"
          }
        ]
      },
      "default": [
        {
          "name": "handle-general",
          "do": "agent",
          "task": "Draft a general support reply for: {{ inputs.body }}",
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
      "body": { "message": "{{ draft }}", "ticketId": "{{ inputs.id }}" },
      "retry": { "limit": 3, "delay": "2s", "backoff": "exponential" }
    }
  ]
}
```

---

## Node Types

11 node types. This is intentional — the constraint is the feature. An LLM can reliably generate valid flows because there's nothing to hallucinate.

### `do: ai` — LLM call

The most important node. A single LLM call that returns structured or freeform output.

```json
{
  "name": "classify",
  "do": "ai",
  "prompt": "Classify this support ticket",
  "input": "inputs.body",
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
| `model` | `fast` (Gemini 3 Flash), `smart` (Claude Sonnet 4.6), `best` (Minimax M2.5), or any model string |
| `provider` | Named backend to run against — a key in `providers` config or a built-in (`openrouter`, `anthropic`, `openai`). Defaults to `defaultProvider`, then env auto-detect. |
| `temperature` | 0–1, default 0 for deterministic workflow steps |

**Why schema matters:** downstream nodes reference `classification.category` as a reliable string. Without schema, the output is freeform text and you're back to parsing.

**Choosing a provider.** By default an `ai` node auto-detects a backend from the environment (`OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`). To run flow AI through a specific backend — for per-caller credentials, quota, or attribution instead of a shared process-env key — configure named providers on the plugin and point nodes at them:

```json
{
  "defaultProvider": "clawnify",
  "providers": {
    "clawnify": {
      "baseUrl": "https://api.clawnify.com/v1",
      "api": "openai-completions",
      "apiKeyEnv": "OPENCLAW_GATEWAY_TOKEN",
      "models": { "fast": "clawnify-lite", "smart": "clawnify-pro", "best": "clawnify-max" }
    }
  }
}
```

With `defaultProvider` set, every `ai` node routes through that provider (a stray `OPENROUTER_API_KEY` in the environment can no longer win), and a node's `model` tier maps to the provider's own model IDs. Any per-node `provider` overrides the default.

---

### `do: agent` — delegate to a real agent

Runs a task through a real OpenClaw agent with full tool access (browser, exec, memory, MCP, CLI). The agent decides its own path to a result.

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

On OpenClaw, this delegates to `openclaw agent --agent <id> --timeout <seconds> --message "..."`. The agent gets full tool access — browser, shell, file system, memory, MCP. Falls back to a single AI call if the CLI is unavailable (standalone mode).

| Field | Description |
|---|---|
| `task` | The instruction to the agent. Supports `{{ templates }}`. |
| `agent` | OpenClaw agent ID (e.g. `"main"`, `"ops"`). Uses config `defaultAgent` or `"main"` if omitted. |
| `input` | Dotted path to context passed with the task |
| `tools` | Hint for non-OpenClaw runtimes (OpenClaw agents have their own tool policy) |
| `timeout` | How long the turn may run (default 120 s). The step's limit and the turn's limit in OpenClaw. See [Time Limits](#time-limits). |

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
      { "name": "lookup-invoice", "do": "http", "url": "https://api.example.com/invoice/{{ inputs.id }}", "output": "invoice" },
      { "name": "draft-reply", "do": "ai", "prompt": "Draft billing reply for: {{ invoice }}", "output": "draft" }
    ],
    "technical": [
      { "name": "draft-reply", "do": "agent", "task": "Research and draft technical reply for: {{ inputs.body }}", "output": "draft" }
    ]
  },
  "default": [
    { "name": "draft-reply", "do": "ai", "prompt": "Draft a general reply for: {{ inputs.body }}", "output": "draft" }
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
"inputs.amount > 1000 || inputs.vip == true"
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
  "url": "https://hooks.slack.com/services/{{ inputs.slackWebhook }}",
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
{ "name": "save-result",  "do": "memory", "action": "write",  "key": "ticket-{{ inputs.id }}", "value": "{{ classification.category }}" }
{ "name": "load-history", "do": "memory", "action": "read",   "key": "ticket-{{ inputs.id }}", "output": "previous_category" }
{ "name": "cleanup",      "do": "memory", "action": "delete", "key": "ticket-{{ inputs.id }}" }
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

### `do: code` — inline JavaScript

```json
{
  "name": "format-date",
  "do": "code",
  "input": "inputs.timestamp",
  "run": "new Date(input).toLocaleDateString('en-GB')",
  "output": "formatted_date"
}
```

Single expressions are returned automatically. Multi-statement bodies (containing `;` or newlines) require an explicit `return`:

```json
{
  "name": "calc",
  "do": "code",
  "input": "inputs",
  "run": "const total = input.price * input.qty;\nconst tax = total * 0.22;\nreturn { total, tax, grand: total + tax };",
  "output": "invoice"
}
```

No imports, no async, no filesystem access. `state` and `input` are frozen — return new values instead of mutating. For scripts or complex logic, use `do: exec` to run shell commands. For external APIs, use `do: http`.

---

## Templates

Any string field supports `{{ path.to.value }}` interpolation resolved against flow state:

```
{{ inputs.body }}               # initial input payload (always available)
{{ classification.category }}   # node with output: "classification" → access .category
{{ inputs.user.email }}         # nested dotted path
{{ research.web_results }}      # array or object (serialized to JSON string)
```

**Important:** templates reference the **`output` key**, not the node name. If a node has `"name": "get_data", "output": "api"`, reference it as `{{ api }}` — not `{{ get_data }}`.

Flow state starts as `{ inputs: <payload> }` and grows as nodes complete. The
caller (CLI, webhook server, scheduled trigger, parent flow, dashboard) is
responsible for producing that payload — the flow definition itself stays
trigger-agnostic. Schedules live in their own records, not in the flow (see
[Scheduling](#scheduling)).

---

## Scheduling

A flow runs when something invokes it: an agent, an HTTP call, or a **trigger**.

A trigger is a first-class record — not a field on the flow definition:

```bash
flow_trigger action: "create" flow: "daily-digest" cron: "0 9 * * *" tz: "Europe/Rome"
```

```
● daily-digest-ab12cd34
    flow: daily-digest (latest published)
    cron: 0 9 * * * [Europe/Rome]
    next: 2026-08-22T07:00:00.000Z
```

That separation is deliberate. A schedule is mutable operational state — paused
at 2am, retimed, pointed at a different version — while a published flow version
is an immutable artifact. Embedding one in the other would make "pause" mean
"publish a new version", and would let an unrelated publish silently re-arm a
schedule the draft happened to carry. Temporal made the same move from
cron-in-workflow to a separate Schedules object, for the same reason.

Because triggers are their own records, one flow can have many, each with its
own payload:

```bash
flow_trigger action: "create" flow: "digest" cron: "0 * * * *" inputs: '{"customer":"acme"}'
flow_trigger action: "create" flow: "digest" cron: "0 9 * * *" inputs: '{"customer":"globex"}'
```

| Behavior | Rule |
|---|---|
| Expression | Standard 5-field cron; minimum interval 60s |
| Timezone | IANA name (`Europe/Rome`); host local time when omitted |
| Version | Latest published by default; pin with `version: 2` |
| Missed runs | **Not replayed** — a host that was down at 09:00 waits for the next occurrence |
| Overlap | A tick or a run-now is skipped while that trigger's previous run is still going, and the trigger records it (`lastStatus: "skipped"`) |
| Flow deleted | Triggers are **paused**, not removed, so a restore keeps them |
| Approval | Arming/pausing/deleting a schedule is gated like flow authoring |

Records live in `.clawflow/triggers/<id>.json`, alongside `.clawflow/versions/`.
Out-of-process callers — the Clawnify hook server and dashboard — read and write
them by importing `TriggerStore` from `dist`, the same way they read published
versions. The running scheduler re-reads the directory every 30s, so a schedule
created or edited in the dashboard goes live without a restart.

### One run at a time

Two rules decide whether a run may start while another is going. "Going" means
executing: a run paused at an approval holds nothing back, and it resumes when
approved even if another run has started since.

**A trigger never overlaps itself.** A tick, `flow_trigger action: "run_now"`
and `POST /flows/triggers/:id/run` all refuse to start while that trigger's
previous run is going. The trigger's record says so (`lastStatus: "skipped"`,
and `lastError` names the run in flight), and the route answers 409
`trigger_running` with `runningInstanceId`. Two triggers on one flow are
independent, and so is a run started any other way.

**A flow can allow one run at a time, whoever starts it.** Put `"overlap": "skip"`
on the flow:

```json
{ "flow": "dispatch-orders", "overlap": "skip", "nodes": [ ... ] }
```

Then a run of it is not started while another run of it is executing, from any
entry point. A trigger records the skip. `POST /flows/:name/run` answers 409:

```json
{ "error": "Flow \"dispatch-orders\" is already running (run 3f2a...)", "code": "flow_running", "flow": "dispatch-orders", "runningInstanceId": "3f2a..." }
```

`flow_run` returns `status: "skipped"` with the same `runningInstanceId`. A
refused start writes no run record, and a webhook that asked for it is not
queued. Use it for a flow that reads state, works, then writes it back. Leave
it off (the default, `"allow"`) for a flow that is started once per work item
and is meant to run many at once.

The rule holds inside one engine process, which is where the scheduler, the
flow server and `flow_run` all run.

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

## Errors

A step that fails after its retries ends the run as `failed`, and nothing after
it runs. `"onError": "continue"` on a step changes that for this step:

```json
{ "name": "work", "do": "agent", "task": "Process order {{ inputs.order }}", "timeout": "1h", "onError": "continue", "output": "work" },
{ "name": "failed", "do": "condition", "if": "work.error", "then": [
  { "name": "record", "do": "memory", "action": "write", "key": "order-{{ inputs.order }}", "value": "failed: {{ work.error }}" }
] }
```

The step is recorded in the trace as `error`, its `output` key holds
`{ "error": "<message>" }`, and the next step runs. A step that succeeded has
no `error` there, so `"if": "work.error"` tells the two apart. It covers a step
that runs out of time, and any step type, containers included: on a step
inside a loop it lets the loop go on to the next item. A cancel still cancels
the run, and `"onError": "fail"` is the default.

An `http` step does not fail on a status code: it returns the body it got. Only
a request that could not be made or answered counts as a failure.

---

## Starting a Run from a Flow

A flow starts another flow with an `http` step on the flow server, and reads
how that run is doing with a second one:

```json
{ "name": "start", "do": "http", "method": "POST", "url": "http://127.0.0.1:18793/flows/process-order/run", "body": { "order": "{{ item.id }}" }, "output": "started" },
{ "name": "check", "do": "http", "url": "http://127.0.0.1:18793/flows/runs/{{ started.instanceId }}/status", "output": "run" }
```

`POST /flows/:name/run` answers 202 with `{ "ok": true, "instanceId": "..." }`
and the run goes on by itself. `GET /flows/runs/:instanceId/status` answers:

```json
{ "ok": true, "instanceId": "3f2a...", "flow": "process-order", "status": "failed", "finished": true, "error": "Node \"work\": ...", "createdAt": "...", "updatedAt": "..." }
```

`status` is `running`, `paused`, `waiting`, `completed`, `failed` or
`cancelled`. `finished` is true for the last three: the run will not change
again. `error` is there for a failed or cancelled run, cut at 2000 characters.
An unknown run answers 404 with `"code": "run_not_found"`.

So a flow that hands work to other runs keeps each run's `instanceId` with the
work item, and on its next pass frees the items whose run is `finished`,
instead of waiting out that run's whole time limit.

Like `/run` and `/cancel`, the status route needs only the run id, and it is
read from the run's summary: no state, no outputs, no approval token. The
routes that return those need the host's token (see "Reading and closing a
configured store").

A run whose process was killed before it could record its end does not stay
`running`: it becomes `failed`, with an `error` that starts with `Interrupted:`
(see "Interrupted runs" below). Nothing starts it again, so a flow that hands
out work treats it like any other failed run.

Flow memory has no atomic update. A `memory` read followed by a write can
overwrite what another run wrote in between, so give each work item its own
key (`order-{{ item.id }}`) and keep shared lists out of memory that several
runs write.

---

## Time Limits

`timeout` on a node is how long one attempt of it may run (`"30s"`, `"5m"`, `"2h"`). When it runs out, the attempt is stopped the way a cancel stops a step, and the next retry starts or the run fails with `Node "<name>" timed out after <ms>ms`.

| Node | Limit when `timeout` is not set |
|---|---|
| `agent` | 120 s |
| `condition`, `branch`, `loop`, `parallel` | None. Each step inside keeps its own limit. |
| `sleep` | None. It lasts its `duration`. |
| `wait` | None. An event wait expires after 24 h; an approval expires after 24 h. |
| Any other step | 30 s |

`maxNodeDurationMs` in the plugin config replaces the 30 s and 120 s defaults. A `timeout` set on a container caps everything inside it; on a loop, all its iterations together.

An agent step's limit is also its turn's limit in OpenClaw: the runner passes it to `openclaw agent` as `--timeout`, in seconds rounded up. Without it, OpenClaw would end the turn after `agents.defaults.timeoutSeconds`, or 600 s when that is unset, however long the step allows. A turn that can take 40 minutes needs `"timeout": "1h"` on its step and nothing in `openclaw.json`.

---

## Flow State and Durability

Every flow run gets a unique `instanceId`. The runner persists state after every completed node. JSON files in `stateDir` remain the default; native SQLite and PostgreSQL are explicit alternatives. All three store checkpoints, memoized outputs, traces, the running step and pending approvals.

**What this means in practice:**

- A paused flow can be explicitly resumed after a gateway restart, using its stored checkpoint.
- A node that took 30 seconds to run won't run again on resume — its memoized output is loaded from disk.
- An approval-gated flow can stay paused for days. The state survives indefinitely.

**Retention.** Finished runs (completed, failed, cancelled) are deleted 30 days after their last update, together with their loop and branch instance files, by a daily sweep in the gateway process. Set `runRetentionDays` in the plugin config to change it; `0` keeps every run. Running, paused and waiting runs are never deleted.

**Cancelling a run.** `flow_cancel { instanceId }`, or `POST /flows/runs/:instanceId/cancel` on the flow server (optional body `{ "reason": "..." }`), stops a run that has not finished. A run executing in the process stops on the step it is on: an agent step's `openclaw agent` process gets SIGTERM, on which the CLI aborts its turn in the gateway; an exec step's command is stopped with its whole process group; http and ai steps are aborted; a custom step gets `ctx.abortSignal` and is abandoned if it ignores it. The run ends with status `cancelled`, the interrupted step's trace entry too, and nothing after it runs. A run paused at an approval gate, or one whose process is gone and that has not been failed yet (see "Interrupted runs"), is marked cancelled and its approval dropped; a runner in another process that still holds a run stops before its next step. The route answers 404 (`run_not_found`) for an unknown run and 409 (`run_finished`) for a finished one. Each attempt of a step is stopped the same way when it times out, before any retry starts; an agent step with no `timeout` gets 120 s per attempt.

**Interrupted runs.** A run is executed by one process, and only that process can record how it ended. If it is killed, crashes or loses power first, the run would say `running` for good. So every run names the process executing it, a process tells the store it is alive every 20 seconds for as long as it has runs there, and every 30 seconds the gateway process looks for runs whose process is gone. Such a run ends as `failed`, with the error `Interrupted: the process running this flow stopped during step "<name>", before the run could finish.` The step it was on is marked `error` in the trace, the loop iteration or branch it was inside ends the same way, and nothing after it runs. The run is not started again: `http`, `exec` and `agent` steps have effects outside the flow, and repeating them is the caller's decision.

A process counts as gone when:

- **The store has not heard from it for two minutes.** This holds for every store, and it is the only test that survives a reboot (the old pid may by then belong to another process), a state directory restored onto another machine, and a PostgreSQL namespace shared by engines on several hosts. SQLite and PostgreSQL measure the two minutes on the database's clock, so hosts need not agree on the time.
- **Its pid no longer exists**, with JSON or SQLite storage, which only processes on the same machine can write. This only ever finds a dead process sooner: an engine that is restarted settles the runs its predecessor left within seconds, not minutes.

How long a run has been quiet is never the test. A `sleep` or an event wait writes nothing for days and is still alive.

A process that was stalled for more than two minutes, not dead, can find its run failed when it comes back. The run stays failed: the process stops before its next step, also in the middle of a loop, and writes nothing to the run's record. A finished run does not change again. A run cancelled from another process now stops the same way, at the next step of the loop it is in.

A run that pauses at an approval has no process until someone resumes it, so it is never failed for this reason, and whichever process resumes it becomes the one it names.

A run started by ClawFlow before 1.11.0 names no process. Nothing proves it dead, so it is left as it is. Cancel it, or call `POST /flows/runs/reconcile` with `{ "unowned": true }` once after upgrading, when no older engine is still running flows on that store. Other hosts call `runner.reconcile()`, which is the same pass. With JSON storage the processes are listed in `flow-state/_owners/`, one small file each, removed when the process has no runs left.

**Reading runs.** `flow_status` lists runs newest first, 20 per page (`limit`, then `cursor` from the previous page). One run comes back whole when it is small, and otherwise as a summary: status, error, each state key with its size, and the trace without outputs. Read any single value with `path`, e.g. `state.leads` or `trace.3.output`; arrays and long strings come back a page at a time (`offset`, `limit`). `flow_run` and `flow_resume` return the same summary when a run is too large to read in one tool result. The same functions (`listRuns`, `summarizeRun`, `readRunValue`, `sweepRuns`) are exported for other hosts. With JSON storage, a small summary of each run is kept in `flow-state/_index/`, so a list reads a few hundred bytes per run instead of parsing every record; an entry older than its record is ignored, and the daily sweep fills in missing ones.

### SQLite and PostgreSQL

Set `storage` in `plugins.entries.clawflow.config` (OpenClaw), or in the config
passed to `new FlowRunner(config)` (standalone). No configuration means JSON;
`{ "backend": "json" }` selects it explicitly.

```json
{
  "stateDir": "/path/to/flow-state",
  "storage": { "backend": "sqlite" }
}
```

SQLite uses Node's built-in `node:sqlite`, requiring **[Node 22.13+](https://nodejs.org/en/blog/release/v22.13.0)**. It creates
`stateDir/clawflow.sqlite`, or the file supplied as `storage.path`. Keep it on a
local filesystem. WAL, full synchronization and a 5-second busy timeout are
configured on each connection. New database files are mode `0600`. Back up the
SQLite database with a SQLite-aware backup tool, or stop every connection before
copying it; copying just the main file while WAL writers are active can lose
checkpoints.

```json
{
  "storage": {
    "backend": "postgres",
    "connectionStringEnv": "CLAWFLOW_DATABASE_URL",
    "namespace": "my-agent"
  }
}
```

Set that environment variable through your deployment's secret manager to a
PostgreSQL connection URL. The URL is never written into a checkpoint. TLS options
are those of [node-postgres](https://node-postgres.com/features/ssl); require
certificate verification for remote connections. PostgreSQL is loaded only when
selected and uses at most four pooled connections per store. Empty configuration,
connection failures and unsupported schema versions fail the operation; they
never silently fall back to local files.

Use a stable, distinct namespace for each independent installation sharing a
database. **A namespace separates keys, not permissions.** Use dedicated database
roles and databases or schema grants to isolate untrusted installations. The
configured role needs permission to create and use the `clawflow_*` tables and
indexes in its search path. Initial schema creation is transactional and versioned.

SQL backends commit each step's checkpoint, memo and summary together; a pause
also commits its pending approval. Resume claims the paused run and consumes its
approval in one transaction, so competing resumes cannot both claim it. Run lists
read indexed summaries and use the same cursor/filter contract; retention deletes
finished roots, their child records and approvals. A new run cannot overwrite an
existing SQL run ID. `:` is reserved for engine-generated child IDs.

Flow definitions, published versions, trigger schedules and `do: memory` files
remain in the workspace. This is execution storage, not a central history mirror
or a distributed scheduler. Event waiters and immediate cancellation remain
process-local (use `runner.sendEvent()` to select the store); another process's cancellation is observed at the next step.
Changing storage does not add automatic recovery of an interrupted running step
or exactly-once external side effects. Full checkpoint payloads are still rewritten
at each step; the SQL indexes bound list payloads, not individual checkpoint size.

### Reading and closing a configured store

The existing `StateStore`, `listRuns(stateDir)` and `sweepRuns(stateDir, days)`
exports keep their JSON-file behavior. Database-aware consumers must use the
configured store. Always await the methods on it, including those on `runner.getStore()` and
`runner.listApprovals()`; JSON implementations can return synchronously.

```ts
import { createStateStore, readRunValue } from "@clawnify/clawflow";

const store = createStateStore(config.stateDir, config.storage);
try {
  const page = await store.listRuns({ limit: 20, status: "paused" });
  if (page.runs[0]) {
    const run = await store.get(page.runs[0].instanceId);
    if (run) console.log(readRunValue(run, "state.inputs"));
  }
} finally {
  await store.close();
}
```

`store.listSubRuns(parentId, { limit, cursor, node?, flow?, status? })` pages
all retained descendants, preserving their actual `:`-separated IDs. `node`
filters the immediate node beneath that parent, including its nested descendants.
It uses the same `(createdAt DESC, instanceId DESC)` order as `listRuns`.
SQL count and page share one read transaction; different pages and `get` calls
do not share a snapshot. JSON readers have no snapshot. Neither API provides an
update cursor, revision, complete inventory guarantee, or deletion tombstones.

When the HTTP listener is enabled, authenticated management routes use the
same configured runner:

- `GET /flows/runs?limit=20&cursor=...&flow=...&status=...`.
  Optional `include_oldest=1` adds `oldest: { instanceId, updatedAt } | null`
  across all matching runs, before cursor filtering. The store option is
  `includeOldest: true`. SQL count, oldest checkpoint and page share one
  transaction; this identifies old checkpoints without declaring runs dead.
- `GET /flows/runs/:instanceId` for the complete record; optional `path`, `offset`,
  `limit`, `max_chars` use `readRunValue`. URL-encode actual instance IDs.
- `GET /flows/runs/:instanceId/subruns?limit=20&node=...` for descendant summaries.
- `GET /flows/runs/:instanceId?include_subruns=1&node=...` adds the last 20
  iterations per node and counts of omitted iterations for detail views.
- `POST /flows/runs/:instanceId/resume` with `{ "approved": true }` or `false`.
  Approval resolves the definition through `resolveRunnableFlow` (published
  version preferred); decline atomically cancels and consumes its approval.
  A 202 is sent only after the durable resume claim, before later steps finish.
- `POST /flows/runs/reconcile`, optionally with `{ "unowned": true }`, fails the
  runs whose process is gone now, without waiting for the gateway's next pass,
  and answers `{ "failed": [{ "instanceId", "flowName", "error" }], "unowned": <count>, "errors": [...] }`.
  `unowned` counts the running runs that name no process and were left alone;
  with `"unowned": true` they are failed too. `errors` lists runs it could not
  end, each with the reason. See "Interrupted runs".

The configured listener prefix replaces `/flows`. These new routes require
`Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>` (or the host gateway's configured
token; standalone hosts may supply `controlToken` to `startFlowServer`). Without
a token they refuse access. Optional `X-ClawFlow-Backend: sqlite|postgres|json`
refuses a stale runner whose backend differs from the caller's configuration.
Storage errors return 503 without credentials or a JSON fallback. The existing
run/trigger/cancel routes retain their prior authentication contract.

Run records do not yet bind an executed definition version/hash or trusted
actor/session access scope. Keep the relevant definition unchanged while a run
is paused. Do not infer historical provenance or access grants from missing
fields. Management reads are operator access, not a per-user authorization layer.

For a standalone runner, call `await runner.close()` once its runs have settled.
This closes the SQLite handle or PostgreSQL pool. Close a reader when it is no
longer needed; avoid opening a new pool for each request in a long-lived host.

### Importing existing JSON state

There is no automatic conversion on startup. Before switching storage:

1. Stop **every** ClawFlow writer, including the gateway, flow HTTP service and
   scheduler. Keep the original state directory as the backup.
2. From a source checkout with dependencies installed, run one of:

   ```sh
   npm run migrate:storage -- --writers-stopped --source /path/to/flow-state --sqlite /path/to/flow-state/clawflow.sqlite
   npm run migrate:storage -- --writers-stopped --source /path/to/flow-state --postgres-env CLAWFLOW_DATABASE_URL --namespace my-agent
   ```

3. Verify the imported runs and approvals using `createStateStore`. Update every
   reader as well as the runner to use the same storage configuration, then restart.

The importer copies all run records, including child runs, and pending approvals;
it ignores the derived `_index` directory and the `_owners` directory. A run
that was still `running` in the source and names a process is failed by the
gateway's first pass after the switch: every writer was stopped, so that
process is gone. It never modifies or removes the JSON
source. Each run and its approvals commit atomically, bounded by one record at a
time. Identical records are accepted on retry; different destination records,
malformed JSON and orphaned approvals stop the import. Earlier committed runs
remain after an error, so repair the source while stopped and retry before
starting the destination. Do not import again after the destination has begun
executing: it will correctly refuse newer, conflicting records. Switching back
to old JSON files after SQL writes would lose those newer checkpoints; this
command does not export SQL back to JSON.

The same importer is exported as `importJsonState(sourceDir, storageConfig)` for
hosts managing a stopped runtime. It copies execution state only; retain the
workspace's definitions, versions, schedules and memory files too.

### Storage tests

Run `npm test` on Node 22.13+ for JSON and native SQLite. Set
`CLAWFLOW_TEST_POSTGRES_URL` to an **isolated test database** to include the real
PostgreSQL suite. Tests create tables and records there. CI provisions PostgreSQL
16 and runs all three backends; production credentials are never needed.

---

## Runtime Targets

The format is the spec. The runtime is swappable.

### 1. OpenClaw Plugin (current)

Thirteen tools registered in OpenClaw:

| Tool | Does |
|---|---|
| `flow_create` | Create a new flow definition and save to file |
| `flow_delete` | Move a flow and its published versions to `.clawflow/bin/`; pause schedules, keep run history |
| `flow_restore_from_bin` | List bin contents or restore a deleted flow |
| `flow_run` | Execute a flow (uses latest published version by default) |
| `flow_resume` | Resume after an approval gate |
| `flow_send_event` | Push an event into a waiting flow |
| `flow_cancel` | Cancel a run that has not finished: the step it is on is stopped (an agent step's turn too) |
| `flow_status` | List instances a page at a time, or inspect one (a summary when large, one value by `path`) |
| `flow_list` | List all flows with metadata, expected inputs, and version info |
| `flow_read` | Read a flow definition (draft or specific version), inspect single nodes |
| `flow_publish` | Publish current draft as a new numbered version |
| `flow_edit` | Edit nodes in a flow definition (set, update, add, remove, move, wrap, revert, list) |
| `flow_trigger` | Schedule a flow on cron (create, update, list, pause, resume, delete, run_now) |

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
      "tools": { "alsoAllow": ["flow_create", "flow_delete", "flow_restore_from_bin", "flow_run", "flow_resume", "flow_cancel", "flow_send_event", "flow_status", "flow_list", "flow_read", "flow_publish", "flow_edit", "flow_trigger"] }
    }]
  }
}
```

---

### 2. Standalone Node.js Runner (coming soon)

A small HTTP server wrapping the runner. Expose flows as endpoints, receive webhooks, manage instances via REST API. Self-hosted alternative to Cloudflare.

```
POST  /flows/:name/run       # start a flow instance
POST  /flows/resume          # resume paused flow
POST  /flows/event           # send event to waiting flow
GET   /flows/instances       # list all instances
GET   /flows/instances/:id   # get instance status
```

---

### 3. Flow Registry (coming soon)

A community library of reusable, shareable `.flow` definitions. Think npm for workflows — but agent-writable.

```
clawflow install support-triage
clawflow install github-pr-review
clawflow install invoice-processing
clawflow install lead-enrichment
```

Every flow in the registry is:
- Parameterized (inputs declared in the `inputs:` block)
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

Node types: ai, agent, branch, condition, loop, parallel, http, memory, wait, sleep, code

Rules:
- Every node needs a unique "name"
- Use "output" to name a node's result — other nodes reference it via the output key: {{ outputKey.field }}
- Always add "schema" to ai nodes when downstream nodes need typed fields
- Use "retry" on all http nodes: { "limit": 3, "delay": "2s", "backoff": "exponential" }
- Use "do: agent" for open-ended research/tasks, "do: ai" for structured extraction
- "do: wait" with "for: approval" pauses for human review before side effects
- "do: parallel" runs nodes concurrently; use when steps are independent
- Prefer "model": "fast" for classification, "smart" for drafting, "best" for complex reasoning
```

---

## Comparison

|  | Visual canvas tools | Code-first orchestration | ClawFlow |
|---|---|---|---|
| AI nodes first-class | ✗ | partial | ✓ |
| Agent delegation | ✗ | partial | ✓ |
| LLM can write it | ✗ | ✗ | ✓ |
| Human readable | ✓ | ✗ | ✓ |
| Durable execution | ✗ | ✓ | ✓ |
| Per-step retry | ✓ | ✓ | ✓ |
| waitForEvent | ✗ | ✓ | ✓ |
| Parallel branches | ✓ | ✓ | ✓ |
| Runtime portable | ✗ | ✗ | ✓ |
| Self-hostable | ✓ | ✗ | ✓ |

---

## What's Next

- Standalone HTTP runner (self-hosted, no OpenClaw dependency)
- Observability: structured traces, token tracking
- Flow registry: shareable, reusable community flows
- Cloudflare Workers transpiler
- Visual canvas

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        .flow definition                         │
│                   (JSON — the portable format spec)             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                ┌──────────────┼──────────────┐
                │                             │
         ┌──────▼──────┐             ┌────────▼───────┐
         │  OpenClaw   │             │   Standalone   │
         │   Plugin    │             │  Node Server   │
         │             │             │  (coming soon) │
         │ 11 tools    │             │                │
         │ versioning  │             │ REST API       │
         │ run server  │             │ /run endpoint  │
         └──────┬──────┘             └────────────────┘
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
         │  execCondition · execLoop           │
         │  execParallel · execHttp            │
         │  execMemory · execWait · execSleep  │
         │  execCode · execExec                │
         └─────────────────────────────────────┘
```

---

## Contributing

The most valuable contributions right now:

1. **Real-world flow definitions** — try to describe a workflow you actually run, generate the flow JSON, and report where the format breaks down
2. **Node type proposals** — what real workflow pattern can't be expressed with the current 11 node types?
3. **Runtime implementations** — a Python runner, a Go runner, a Rust runner — anything that proves portability
4. **Bug reports** — file issues at [github.com/clawnify/clawflow](https://github.com/clawnify/clawflow/issues)

---

## License

MIT

---

Built by [Clawnify](https://www.clawnify.com) — AI agent hosting and orchestration.
