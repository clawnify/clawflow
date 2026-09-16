// ---- Custom Step Registry ------------------------------------------------------
// Public extension API: hosts register additional `do:` step types at startup.
// Built-in step types (ai, code, http, …) are dispatched first; custom types
// participate in the same do: resolution and the same validation/error shapes.

import type { FlowState } from "./types.js";

/** Names that cannot be overridden by custom steps. Mirrors NODE_KEYS in types.ts. */
const BUILT_IN_STEP_NAMES = new Set([
  "ai",
  "agent",
  "branch",
  "condition",
  "loop",
  "parallel",
  "http",
  "memory",
  "wait",
  "sleep",
  "code",
  "exec",
]);

/** Validator return shape — matches validate.ts ValidationError so errors are indistinguishable from native. */
export interface CustomStepValidationFailure {
  field?: string;
  message: string;
}

export type CustomStepValidatorResult =
  | { ok: true }
  | { ok: false; errors: CustomStepValidationFailure[] };

export type CustomStepValidator = (input: unknown) => CustomStepValidatorResult;

/** Runtime context handed to a custom step's run() function. */
export interface CustomStepContext {
  /** Frozen deep copy of the flow's current state. Reads only. */
  readonly state: Readonly<FlowState>;
  /** Resolved env (merged from flow.env + process.env). Empty object if none. */
  readonly env: Readonly<Record<string, string>>;
  /** Logger that prefixes the node name. */
  readonly logger: {
    debug: (msg: string, ...rest: unknown[]) => void;
    info: (msg: string, ...rest: unknown[]) => void;
    warn: (msg: string, ...rest: unknown[]) => void;
    error: (msg: string, ...rest: unknown[]) => void;
  };
  /** Aborts when the flow is cancelled. Custom steps should pass this to fetch()/etc. */
  readonly abortSignal: AbortSignal;
  /** The node's `name` field — useful for log prefixing or error messages. */
  readonly nodeName: string;
  /**
   * Resolve a `{{ template }}` string against the live flow state.
   * Useful when a custom step accepts non-string input shapes that contain templates.
   */
  resolveTemplate: (template: string) => string;
}

/**
 * Definition passed to `registerStepType`.
 *
 * The runner pre-resolves `{{ template }}` strings in top-level string fields
 * and (one level deep) in object fields named `body` or `headers`, mirroring
 * how `do: http` handles them. Other fields are passed through unchanged.
 * If you need finer control, declare the field as raw and call
 * `ctx.resolveTemplate()` yourself.
 */
export interface CustomStepDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  /** Step name as it will appear in flow JSON (`do: "<name>"`). */
  name: string;
  /**
   * Top-level node fields (excluding base keys like `name`, `do`, `output`,
   * `retry`, `timeout`) that this step accepts. Used by the validator to
   * reject typos. If empty, the step takes no input fields.
   */
  allowedKeys: readonly string[];
  /**
   * Optional field-level validation. Called with the post-template-resolution
   * input object. Errors are surfaced through `validateFlow` with the same
   * `{ node, field, message }` shape as native validation failures.
   */
  validate?: CustomStepValidator;
  /**
   * Step body. Whatever this returns lands in `state[node.output]`, identical
   * to built-ins. Throw to mark the node failed; the error message is traced.
   */
  run: (input: TInput, ctx: CustomStepContext) => Promise<TOutput> | TOutput;
}

/**
 * Registry of custom step definitions. A FlowRunner can use a private registry
 * (passed via `cfg.customSteps`) for test isolation, or share the module-level
 * default via `registerStepType()`.
 */
export class StepRegistry {
  private readonly steps = new Map<string, CustomStepDefinition>();

  register(def: CustomStepDefinition): void {
    if (!def || typeof def !== "object") {
      throw new Error("registerStepType: definition must be an object");
    }
    if (typeof def.name !== "string" || !def.name) {
      throw new Error("registerStepType: definition.name is required");
    }
    if (typeof def.run !== "function") {
      throw new Error(`registerStepType("${def.name}"): definition.run must be a function`);
    }
    if (!Array.isArray(def.allowedKeys)) {
      throw new Error(`registerStepType("${def.name}"): definition.allowedKeys must be an array`);
    }
    if (BUILT_IN_STEP_NAMES.has(def.name)) {
      throw new Error(
        `registerStepType("${def.name}"): name collides with built-in step type. Pick a different name.`,
      );
    }
    if (this.steps.has(def.name)) {
      throw new Error(
        `registerStepType("${def.name}"): already registered. Re-registration is not supported.`,
      );
    }
    this.steps.set(def.name, def);
  }

  get(name: string): CustomStepDefinition | undefined {
    return this.steps.get(name);
  }

  has(name: string): boolean {
    return this.steps.has(name);
  }

  /** All registered step names — for diagnostics/error messages. */
  names(): string[] {
    return [...this.steps.keys()];
  }

  /** Test/embedder helper: clear all registered steps. Not part of the public stability contract. */
  clear(): void {
    this.steps.clear();
  }
}

/**
 * Process-wide default registry shared by host applications.
 *
 * Held on `globalThis` under a registered symbol, not as a plain module
 * singleton. Node caches ES modules by resolved path, so a plugin importing
 * ClawFlow from `src/index.ts` and a gateway running `dist/index.js` used to
 * get two registries: the plugin's steps landed in one the engine never
 * read, and flows failed validation with "Unknown node type". House plugins
 * flipped between the two paths more than once (agent-tools fixed in
 * July, openclaw-email still wrong in September). With one registry per
 * process the import path no longer matters, and neither does a second
 * copy of the package on disk.
 */
const REGISTRY_KEY = Symbol.for("@clawnify/clawflow/step-registry");
type RegistryHolder = { [REGISTRY_KEY]?: StepRegistry };
const holder = globalThis as unknown as RegistryHolder;
export const defaultRegistry: StepRegistry = holder[REGISTRY_KEY] ?? (holder[REGISTRY_KEY] = new StepRegistry());

/**
 * Register a custom step type on the default registry. Call once at startup.
 *
 * @example
 *   import { registerStepType } from "@clawnify/clawflow";
 *
 *   registerStepType({
 *     name: "clawnify_app",
 *     allowedKeys: ["app_id", "method", "path", "body"],
 *     validate: (input) => {
 *       const i = input as Record<string, unknown>;
 *       if (typeof i.app_id !== "string") {
 *         return { ok: false, errors: [{ field: "app_id", message: "app_id must be a string" }] };
 *       }
 *       return { ok: true };
 *     },
 *     async run(input, ctx) {
 *       const res = await fetch(buildUrl(input), { signal: ctx.abortSignal });
 *       return { status: res.status, ok: res.ok, body: await res.json() };
 *     },
 *   });
 */
export function registerStepType(def: CustomStepDefinition): void {
  defaultRegistry.register(def);
}

/** Internal — exposed for the validator and runner. */
export function isBuiltInStepName(name: string): boolean {
  return BUILT_IN_STEP_NAMES.has(name);
}
