/**
 * LinkedIn outreach self-correcting reflection loop (SaaS foundation).
 *
 * @module outreach
 */

export {
  LeadContextSchema,
  OutreachReflectionStateSchema,
  OutreachQueuePayloadSchema,
  OUTREACH_MAX_RETRIES,
  OUTREACH_MAX_CHARS,
  OUTREACH_DAILY_LIMIT,
  type LeadContext,
  type DailyLimitSnapshot,
  type OutreachQueuePayload,
} from "./contracts.js";

export { OutreachReflectionGraphState, type OutreachGraphState } from "./state.js";
export { validateConnectionDraft, InMemoryDailyLimitTracker } from "./validator.js";
export { buildGeneratorModel, buildReflectorModel, type OutreachModelConfig } from "./models.js";
export { createInMemoryOutreachQueue, type OutreachQueue, type OutreachQueueEntry } from "./queue.js";
export { routeAfterValidator, terminalFailureReason, isTerminalFailure } from "./routing.js";
export {
  buildOutreachReflectionGraph,
  runOutreachReflection,
  type BuildOutreachReflectionGraphOpts,
  type CompiledOutreachReflectionGraph,
  type OutreachRunResult,
} from "./graph.js";
