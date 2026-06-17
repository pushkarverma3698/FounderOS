/**
 * FounderOS — Typed inter-department contracts (Phase 2)
 * ======================================================
 * Cross-department handoffs travel through `dept_signals` (durable, Postgres)
 * whose `payload` is documented as "schema defined by event_type convention".
 * This module makes that convention EXPLICIT and ENFORCED: one Zod contract per
 * event type + a deterministic validator that gates every payload at the
 * boundary. No LLM call — pure, testable, side-effect-free.
 *
 * Why this is the substrate (not a speculative state channel):
 *   - Phase 4 (`publish_signal` tool + scheduler consumer) validates payloads
 *     with `validateSignalPayload` before writing/acting on a signal.
 *   - Phase 5 (nested `revenue` supervisor) reuses the SAME contracts for the
 *     marketing↔sales handoff — the typed vocabulary, defined once.
 *
 * CLAUDE rule #21: inter-dept handoffs use typed contracts, never raw message
 * dumping. Least-context-by-default — only the contract's declared fields cross
 * a boundary.
 */

import { z } from "zod";

// ── Event-type registry ───────────────────────────────────────────────────────

/**
 * The closed set of cross-department signal events. Grounded in the
 * `dept_signals` schema comment ("proposal_approved", "lead_replied",
 * "demo_ready") and the Phase-4 exemplar flow (lead_discovered → revenue).
 * Add an event here AND its contract below — the registry test enforces parity.
 */
export const SIGNAL_EVENT_TYPES = [
  "lead_discovered",
  "proposal_approved",
  "demo_ready",
  "design_brief_ready",
  "site_deployed",
] as const;

export type SignalEventType = (typeof SIGNAL_EVENT_TYPES)[number];

/** Narrow an arbitrary string to a known signal event type. */
export function isSignalEventType(value: string): value is SignalEventType {
  return (SIGNAL_EVENT_TYPES as readonly string[]).includes(value);
}

// ── Per-event payload contracts ───────────────────────────────────────────────

/** research/sales discovered a qualified lead → revenue outreach. */
export const LeadDiscoveredPayload = z.object({
  company: z.string().min(1),
  contactName: z.string().min(1).optional(),
  contactEmail: z.string().email().optional(),
  /** ICP fit score, 0–100 (deterministic research scoring). */
  icpScore: z.number().int().min(0).max(100),
  /** Where the lead came from, e.g. "linkedin", "web", "referral". */
  source: z.string().min(1),
  notes: z.string().optional(),
});
export type LeadDiscoveredPayload = z.infer<typeof LeadDiscoveredPayload>;

/** sales got a proposal approved → engineering can start the build. */
export const ProposalApprovedPayload = z.object({
  company: z.string().min(1),
  proposalId: z.string().min(1),
  amountUsd: z.number().nonnegative(),
  notes: z.string().optional(),
});
export type ProposalApprovedPayload = z.infer<typeof ProposalApprovedPayload>;

/** engineering shipped a demo → sales can follow up. */
export const DemoReadyPayload = z.object({
  company: z.string().min(1),
  repoUrl: z.string().url(),
  notes: z.string().optional(),
});
export type DemoReadyPayload = z.infer<typeof DemoReadyPayload>;

/** marketing finished launch copy → engineering builds from brief. */
export const DesignBriefReadyPayload = z.object({
  client: z.string().min(1),
  preset: z.string().min(1),
  copyBlocks: z.record(z.string()),
  mood: z.string().optional(),
  notes: z.string().optional(),
});
export type DesignBriefReadyPayload = z.infer<typeof DesignBriefReadyPayload>;

/** engineering deployed a site → sales sends follow-up. */
export const SiteDeployedPayload = z.object({
  client: z.string().min(1),
  siteUrl: z.string().url(),
  repoUrl: z.string().url().optional(),
  presetUsed: z.string().optional(),
  notes: z.string().optional(),
});
export type SiteDeployedPayload = z.infer<typeof SiteDeployedPayload>;

/**
 * The single source of truth mapping each event type to its payload contract.
 * `satisfies` makes the compiler reject an event type without a contract (or a
 * contract without an event type); the registry test enforces it at runtime too.
 */
export const SIGNAL_CONTRACTS = {
  lead_discovered: LeadDiscoveredPayload,
  proposal_approved: ProposalApprovedPayload,
  demo_ready: DemoReadyPayload,
  design_brief_ready: DesignBriefReadyPayload,
  site_deployed: SiteDeployedPayload,
} satisfies Record<SignalEventType, z.ZodTypeAny>;

/** The validated payload type for a given event type. */
export type SignalPayloadFor<E extends SignalEventType> = z.infer<
  (typeof SIGNAL_CONTRACTS)[E]
>;

// ── Engineering handoff slice (P3 — sync COS → CTO boundary) ─────────────────

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

// ── Deterministic boundary validator ──────────────────────────────────────────

export type ContractValidation =
  | { ok: true; eventType: SignalEventType; payload: unknown }
  | { ok: false; error: string };

/**
 * Validate a cross-department signal payload against its contract. Pure and
 * total — never throws, even on hostile input (null/non-object). Returns a
 * discriminated result so callers handle both branches explicitly.
 */
export function validateSignalPayload(eventType: string, payload: unknown): ContractValidation {
  if (!isSignalEventType(eventType)) {
    return {
      ok: false,
      error: `Unknown event type "${eventType}". Known: ${SIGNAL_EVENT_TYPES.join(", ")}.`,
    };
  }
  const result = SIGNAL_CONTRACTS[eventType].safeParse(payload);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Invalid ${eventType} payload — ${detail}` };
  }
  return { ok: true, eventType, payload: result.data };
}
