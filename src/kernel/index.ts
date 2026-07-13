/**
 * FounderOS v3 kernel — public API.
 * The kernel is a library: contracts + a graph factory with injected models,
 * tools, and checkpointing. Composition (real models, real tools, HITL DB)
 * happens at the gateway boot, never in here.
 */

export * from "./contracts.js";
export { KernelState, RESET, type KernelStateType, type KernelUpdate, type ListUpdate } from "./state.js";
export {
  buildKernel,
  getPendingKernelApproval,
  kernelReply,
  type KernelConfig,
  type CompiledKernel,
} from "./graph.js";
export {
  makePlanNode,
  buildPlannerPrompt,
  parseRouteOverride,
  overrideDecision,
  summarizePreviousTurn,
  historyMessages,
  ROUTE_OVERRIDE_RE,
  type KernelChatModel,
  type WorkerCatalogEntry,
} from "./planner.js";
export {
  dispatch,
  routeAfterDispatch,
  routeAfterPlan,
  resolveInputs,
  envelopeMessage,
  formatFailureReply,
  retryMessage,
  MAX_ATTEMPTS_PER_STEP,
} from "./supervisor.js";
export { isKernelTerminalError, describeInterceptedError } from "./errors.js";
export {
  makeAgentNode,
  makeToolsNode,
  routeAfterAgent,
  collect,
  currentStep,
  isFailureResult,
  REJECTION_MARKER,
  TOOL_FAILURE_MARKER,
  type KernelTool,
  type KernelBindableModel,
  type WorkerSpec,
} from "./worker.js";
export { makeSynthesizeNode, receiptsBlock, fallbackSynthesisReply } from "./synthesizer.js";
export {
  normalizeFailureSignature,
  lessonMessage,
  makeLessonDispatch,
  SIGNATURE_MAX_CHARS,
  type FailureLesson,
  type LessonStore,
  type LessonCandidate,
} from "./lessons.js";
