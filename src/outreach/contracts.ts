/**
 * LinkedIn outreach reflection loop — Zod contracts (Layer 1).
 * Strict state boundary for the self-correcting connection-note subgraph.
 * Deterministic validation lives in validator.ts; LLM nodes only draft/rewrite.
 */

import { z } from "zod";

/** Profile + ICP context fed into the generator. */
export const LeadContextSchema = z.object({
  profile_id: z.string().min(1),
  full_name: z.string().min(1),
  headline: z.string().optional(),
  company: z.string().optional(),
  role: z.string().optional(),
  location: z.string().optional(),
  /** 0–100 ICP fit from research/sales scoring. */
  icp_match_score: z.number().min(0).max(100),
  /** Free-form hooks: recent post, mutual connection, gap-scan insight, etc. */
  personalization_hooks: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export type LeadContext = z.infer<typeof LeadContextSchema>;

export const OUTREACH_MAX_RETRIES = 3;
export const OUTREACH_MAX_CHARS = 300;
export const OUTREACH_DAILY_LIMIT = 20;

export const OutreachReflectionStateSchema = z.object({
  messages: z.array(z.unknown()),
  lead_context: LeadContextSchema,
  current_draft: z.string().default(""),
  validation_errors: z.array(z.string()).default([]),
  retry_count: z.number().int().min(0).default(0),
  status: z.enum(["running", "queued", "failed"]).default("running"),
  queue_id: z.string().optional(),
  failure_reason: z.string().optional(),
});

export type OutreachReflectionState = z.infer<typeof OutreachReflectionStateSchema>;

/** Payload handed to the delayed execution queue after validation passes. */
export const OutreachQueuePayloadSchema = z.object({
  queue_id: z.string(),
  profile_id: z.string(),
  message: z.string().max(OUTREACH_MAX_CHARS),
  scheduled_at: z.string().datetime(),
  pacing_jitter_ms: z.number().int().nonnegative(),
  account_id: z.string(),
});

export type OutreachQueuePayload = z.infer<typeof OutreachQueuePayloadSchema>;

export interface DailyLimitSnapshot {
  allowed: boolean;
  sent_today: number;
  daily_limit: number;
  remaining: number;
}
