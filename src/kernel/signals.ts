/**
 * FounderOS v3 kernel — cross-department signal contracts.
 * =========================================================
 * Relocated verbatim from src/agents/contracts.ts (Phase 1 of the v3 rebuild)
 * so the kernel owns every inter-agent schema; agents/contracts.ts re-exports
 * from here for backwards compatibility. One Zod contract per `dept_signals`
 * event type + a deterministic, total validator (never throws).
 */

import { z } from "zod";

// ── Event-type registry ───────────────────────────────────────────────────────

export const SIGNAL_EVENT_TYPES = [
  "lead_discovered",
  "proposal_approved",
  "demo_ready",
  "design_brief_ready",
  "site_deployed",
  "proof_drop_ready",
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

/** marketing drafted a proof-drop artifact concept → sales sends the drop. */
export const ProofDropReadyPayload = z.object({
  company: z.string().min(1),
  artifactType: z.string().min(1),
  artifactSummary: z.string().min(1),
  outreachHook: z.string().min(1),
  contactEmail: z.string().email().optional(),
  notes: z.string().optional(),
});
export type ProofDropReadyPayload = z.infer<typeof ProofDropReadyPayload>;

/** Single source of truth: event type → payload contract (compiler-enforced parity). */
export const SIGNAL_CONTRACTS = {
  lead_discovered: LeadDiscoveredPayload,
  proposal_approved: ProposalApprovedPayload,
  demo_ready: DemoReadyPayload,
  design_brief_ready: DesignBriefReadyPayload,
  site_deployed: SiteDeployedPayload,
  proof_drop_ready: ProofDropReadyPayload,
} satisfies Record<SignalEventType, z.ZodTypeAny>;

/** The validated payload type for a given event type. */
export type SignalPayloadFor<E extends SignalEventType> = z.infer<(typeof SIGNAL_CONTRACTS)[E]>;

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
