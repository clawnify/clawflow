import { FlowRunner, sendEvent } from "../core/runner.js";
import { transpileToCloudflare } from "../core/transpile.js";
import type { FlowDefinition, PluginConfig } from "../core/types.js";

// ---- OpenClaw Plugin: clawflow ---------------------------------------------------
// Registers five tools:
//
//   flow_run           — execute a flow (inline or from file)
//   flow_resume        — resume after approval gate
//   flow_send_event    — push an event into a waiting flow
//   flow_status        — inspect a running/completed flow instance
//   flow_transpile     — convert a .flow definition to Cloudflare Workers TS

interface PluginApi {
  registerTool: (def: object, opts?: { optional?: boolean }) => void;
  config?: {
    plugins?: { entries?: Record<string, { config?: PluginConfig }> };
    gateway?: { port?: number; host?: string };
    [key: string]: unknown;
  };
  runtime?: {
    config?: { loadConfig?: () => unknown };
    [key: string]: unknown;
  };
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

function register(api: PluginApi) {
  const rawCfg: PluginConfig =
    api.config?.plugins?.entries?.["clawflow"]?.config ?? {};

  // Auto-detect gateway URL when running inside OpenClaw
  const gatewayPort =
    rawCfg.gatewayUrl
      ? undefined // user explicitly configured, skip detection
      : api.config?.gateway?.port ??
        (process.env.OPENCLAW_GATEWAY_PORT
          ? parseInt(process.env.OPENCLAW_GATEWAY_PORT, 10)
          : 18789);

  const gatewayHost =
    api.config?.gateway?.host ?? process.env.OPENCLAW_GATEWAY_HOST ?? "127.0.0.1";

  const pluginCfg: PluginConfig = {
    ...rawCfg,
    // Auto-set gateway URL so do:ai nodes route through OpenClaw's providers
    gatewayUrl: rawCfg.gatewayUrl ?? `http://${gatewayHost}:${gatewayPort}`,
    gatewayToken:
      rawCfg.gatewayToken ??
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      process.env.OPENCLAW_GATEWAY_PASSWORD,
  };

  api.logger?.info?.(
    `[clawflow] AI backend: gateway at ${pluginCfg.gatewayUrl}`,
  );

  const runner = new FlowRunner(pluginCfg);
  const store = runner.getStore();

  // ---- flow_run -----------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_run",
      description: `Run an agentic workflow in the clawflow format.

Node types:
  ai       — LLM call, structured or freeform. Use schema: for typed output.
  agent    — open-ended autonomous task (falls back to high-capability AI)
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
Returns instanceId for status tracking and resume.`,

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
            description: "Path to a .json flow file",
          },
          input: {
            type: "object",
            additionalProperties: true,
            description: "Input data, available as trigger.* in the flow",
          },
        },
      },

      async execute(
        _id: string,
        params: { flow?: FlowDefinition; file?: string; input?: unknown },
      ) {
        let flowDef: FlowDefinition;

        if (params.file) {
          const { readFileSync, existsSync } = await import("fs");
          const abs = params.file.startsWith("/")
            ? params.file
            : `${process.cwd()}/${params.file}`;
          if (!existsSync(abs))
            return {
              content: [{ type: "text", text: `File not found: ${abs}` }],
            };
          flowDef = JSON.parse(
            readFileSync(abs, "utf8"),
          ) as FlowDefinition;
        } else if (params.flow) {
          flowDef = params.flow as FlowDefinition;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Provide either `flow` (inline definition) or `file` (path).",
              },
            ],
          };
        }

        try {
          const result = await runner.run(flowDef, params.input ?? {});
          return {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
            details: result,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );

  // ---- flow_resume --------------------------------------------------------------

  api.registerTool(
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

      async execute(
        _id: string,
        params: {
          instanceId: string;
          approved: boolean;
          flow: FlowDefinition;
        },
      ) {
        try {
          const result = await runner.resume(
            params.instanceId,
            params.flow,
            params.approved,
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
            details: result,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );

  // ---- flow_send_event ----------------------------------------------------------

  api.registerTool(
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

      async execute(
        _id: string,
        params: {
          instanceId: string;
          eventType: string;
          payload?: unknown;
        },
      ) {
        const delivered = sendEvent(
          params.instanceId,
          params.eventType,
          params.payload ?? {},
        );
        if (!delivered) {
          return {
            content: [
              {
                type: "text",
                text: `No active waiter found for instance "${params.instanceId}" event "${params.eventType}". The flow may not be waiting, or the event type doesn't match.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Event "${params.eventType}" delivered to instance "${params.instanceId}".`,
            },
          ],
        };
      },
    },
    { optional: true },
  );

  // ---- flow_status --------------------------------------------------------------

  api.registerTool(
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

      async execute(
        _id: string,
        params: { instanceId?: string; filter?: string },
      ) {
        if (params.instanceId) {
          const record = store.get(params.instanceId);
          if (!record)
            return {
              content: [
                {
                  type: "text",
                  text: `Instance not found: ${params.instanceId}`,
                },
              ],
            };
          return {
            content: [
              { type: "text", text: JSON.stringify(record, null, 2) },
            ],
            details: record,
          };
        }
        const records = store.list(params.filter);
        const summary = records.map((r) => ({
          instanceId: r.instanceId,
          flow: r.flowName,
          status: r.status,
          updatedAt: r.updatedAt,
          waitingFor: r.waitingFor,
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
          details: summary,
        };
      },
    },
    { optional: true },
  );

  // ---- flow_transpile -----------------------------------------------------------

  api.registerTool(
    {
      name: "flow_transpile",
      description: `Convert a clawflow definition into a Cloudflare Workers TypeScript class.
Output is a complete .ts file you can deploy with: wrangler deploy
Each node maps to a Cloudflare Workflows primitive:
  ai/agent   → step.do()
  wait/event → step.waitForEvent()
  sleep      → step.sleep()
  parallel   → Promise.all() / Promise.race()`,

      parameters: {
        type: "object",
        required: ["flow"],
        properties: {
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

      async execute(
        _id: string,
        params: { flow: FlowDefinition },
      ) {
        try {
          const ts = transpileToCloudflare(params.flow);
          return { content: [{ type: "text", text: ts }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Transpile error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );
}

export default {
  id: "clawflow",
  register,
};
