/**
 * FounderOS — Typed inter-department contracts (compatibility barrel)
 * ===================================================================
 * The signal schemas moved to the v3 kernel (src/kernel/signals.ts) in Phase 1
 * of the rebuild — the kernel owns every inter-agent contract. This barrel
 * preserves the historical import path for existing callers/tests.
 *
 * CLAUDE rule #21: inter-dept handoffs use typed contracts, never raw message
 * dumping. Least-context-by-default — only the contract's declared fields cross
 * a boundary.
 */

export {
  SIGNAL_EVENT_TYPES,
  SIGNAL_CONTRACTS,
  isSignalEventType,
  validateSignalPayload,
  LeadDiscoveredPayload,
  ProposalApprovedPayload,
  DemoReadyPayload,
  DesignBriefReadyPayload,
  SiteDeployedPayload,
  ProofDropReadyPayload,
  type SignalEventType,
  type SignalPayloadFor,
  type ContractValidation,
} from "../kernel/signals.js";

// ── Engineering handoff slice (P3 — sync COS → CTO boundary) ─────────────────
// Dies with the old orchestration layers in Phase 4 of the v3 rebuild.

export {
  EngineeringHandoffSchema,
  type EngineeringHandoff,
  type HandoffValidation,
  extractEngineeringHandoff,
  validateEngineeringHandoff,
  formatEngineeringHandoffEnvelope,
  parseEngineeringHandoffEnvelope,
  findEngineeringHandoff,
  isolateEngineeringMessages,
  engineeringHandoffTokenEstimate,
  ENGINEERING_HANDOFF_MARKER,
  ENGINEERING_HANDOFF_TOKEN_CEILING,
} from "./handoff-engineering.js";

export { ENGINEERING_HANDOFF_SCHEMA_VERSION } from "./state.js";
