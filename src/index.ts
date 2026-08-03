// clawflow — core exports + OpenClaw plugin entry
//
// The default export is the OpenClaw plugin definition (id, register). Named
// exports are the public library surface (FlowRunner, validateFlow, etc.) for
// standalone consumers (e.g. `@clawnify/clawflow` as a Cloudflare runtime).
export { default } from "./plugin/index.js";

export { FlowRunner, sendEvent } from "./core/runner.js";
export { StateStore } from "./core/store.js";
export { transpileToCloudflare } from "./core/transpile.js";
export { validateFlow } from "./core/validate.js";
export type {
  ValidationError,
  ValidationResult,
  ValidateFlowOptions,
} from "./core/validate.js";
export {
  registerStepType,
  defaultRegistry,
  StepRegistry,
} from "./core/custom-steps.js";
export type {
  CustomStepContext,
  CustomStepDefinition,
  CustomStepValidator,
  CustomStepValidatorResult,
  CustomStepValidationFailure,
} from "./core/custom-steps.js";
export type {
  FlowDefinition,
  FlowNode,
  FlowState,
  FlowResult,
  FlowStatus,
  InputSpec,
  TraceEntry,
  NodeStatus,
  RetryPolicy,
  PluginConfig,
  InferenceFn,
  InferenceRequest,
  InferenceResult,
  AiNode,
  AgentNode,
  PendingApproval,
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
} from "./core/types.js";
export { parseDuration, MODEL_MAP, DEFAULT_MODEL, NODE_KEYS } from "./core/types.js";
export { startFlowServer } from "./core/serve.js";
export type { FlowServerOpts } from "./core/serve.js";
export type { ServeConfig } from "./core/types.js";
export {
  publishDraft,
  resolveFlowFile,
  versionsDir,
  listVersions,
  readVersion,
  readLatestVersion,
} from "./core/manage.js";
export type { PublishResult } from "./core/manage.js";
