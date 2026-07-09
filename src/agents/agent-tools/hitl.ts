/**
 * FounderOS — HITL core (compatibility barrel).
 * The approval primitive moved to src/infra/hitl.ts in v3 Phase 3 so the
 * kernel (which may not import src/agents) can gate tools with the same
 * DB-row-before-interrupt() flow. This barrel preserves the historical path.
 */

export {
  idemKey,
  timeBucket,
  recurringIdemKey,
  hitlGate,
  type BucketGranularity,
  type ApprovalRequest,
} from "../../infra/hitl.js";
