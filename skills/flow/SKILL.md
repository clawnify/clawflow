---
name: flow
description: Design and run declarative agentic workflows using openclaw-flow. Use when the user asks to create a workflow, automation, pipeline, or flow.
---

# openclaw-flow — Workflow Authoring Guide

You have access to the `flow_run` tool. Use it to design and execute declarative workflows from natural language descriptions.

## When to use this

- User asks to create a workflow, automation, or pipeline
- User wants to chain AI calls with approvals, HTTP calls, or logic
- User needs a repeatable process (e.g. "generate a LinkedIn post from an idea")
- User says "create a flow", "run a flow", "build a workflow"

## How to write a flow

A flow is JSON with a `flow` name and a `nodes` array. Call `flow_run` with the flow inline or from a file.

### Node types (10 total)

| Node | Purpose | Key fields |
|------|---------|------------|
| `ai` | Single LLM call, structured or freeform | `prompt`, `schema`, `model`, `input` |
| `agent` | Open-ended autonomous task | `task`, `tools`, `model` |
| `branch` | Jump to a named node based on a value | `on`, `paths`, `default` |
| `condition` | If/else with sub-node blocks that reconverge | `if`, `then`, `else` |
| `loop` | Iterate over an array | `over`, `as`, `nodes` |
| `parallel` | Run nodes concurrently | `nodes`, `mode: "all"\|"race"` |
| `http` | Call an external API | `url`, `method`, `body`, `headers` |
| `memory` | Persistent key/value store | `action: "read"\|"write"\|"delete"`, `key` |
| `wait` | Pause for approval or external event | `for: "approval"\|"event"`, `event`, `prompt` |
| `sleep` | Pause for a duration | `duration: "5m"` |
| `code` | Inline JS expression | `run`, `input` |

### Rules

- Every node needs a unique `name`
- Use `output` to name a node's result — other nodes reference it as `{{ nodeName.field }}`
- Always add `schema` to `ai` nodes when downstream nodes need typed fields
- Use `retry` on `http` and `ai` nodes: `{ "limit": 3, "delay": "2s", "backoff": "exponential" }`
- Use `do: agent` for open-ended research/tasks, `do: ai` for structured extraction
- `do: wait` with `for: approval` pauses for human review before side effects
- `do: condition` runs inline then/else blocks and merges back (unlike `branch` which jumps)
- Model shorthands: `fast` (Haiku), `smart` (Sonnet), `best` (Opus)

### Templates

Any string field supports `{{ path.to.value }}` interpolation:

```
{{ trigger.body }}           — initial input
{{ classify.category }}      — output from node named "classify"
{{ trigger.user.email }}     — nested dotted path
```

### Condition expressions

The `if` field in condition nodes supports JS expressions with dotted paths:

```
"extractOrder.transport_type == 'CLIENTE'"
"validation.valid && items.length > 0"
"trigger.priority == 'high' || trigger.urgent == true"
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

Call with:

```
flow_run with flow: <above JSON>, input: { "topic": "AI agents replacing SaaS" }
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

## Example: Conditional routing

```json
{
  "flow": "triage",
  "nodes": [
    {
      "name": "classify",
      "do": "ai",
      "prompt": "Classify this as urgent or normal: {{ trigger.message }}",
      "schema": { "priority": "urgent | normal", "reason": "string" },
      "model": "fast",
      "output": "classification"
    },
    {
      "name": "route",
      "do": "condition",
      "if": "classification.priority == 'urgent'",
      "then": [
        {
          "name": "alert",
          "do": "http",
          "url": "https://hooks.slack.com/services/xxx",
          "method": "POST",
          "body": { "text": "URGENT: {{ classification.reason }}" }
        }
      ],
      "else": [
        {
          "name": "queue",
          "do": "memory",
          "action": "write",
          "key": "queue-{{ trigger.id }}",
          "value": "{{ classification.reason }}"
        }
      ]
    }
  ]
}
```

## Other tools

| Tool | Use |
|------|-----|
| `flow_resume` | Resume a paused flow after approval (`instanceId`, `approved: true/false`, `flow`) |
| `flow_send_event` | Push an event into a waiting flow (`instanceId`, `eventType`, `payload`) |
| `flow_status` | Check status of a flow instance or list all instances |
| `flow_transpile` | Convert a flow to Cloudflare Workers TypeScript |
