/**
 * Deterministic outreach draft validator — NO LLM (rule #16).
 * Enforces 2026 LinkedIn connection-note safety limits before any queue write.
 */

import {
  OUTREACH_DAILY_LIMIT,
  OUTREACH_MAX_CHARS,
  type DailyLimitSnapshot,
  type LeadContext,
} from "./contracts.js";

const URL_PATTERN =
  /(?:https?:\/\/|www\.|\.com\/|\.io\/|\.ai\/|linkedin\.com|bit\.ly|t\.co)/i;

export interface ValidateDraftInput {
  draft: string;
  lead_context: LeadContext;
  account_id: string;
  checkDailyLimit: (accountId: string) => DailyLimitSnapshot;
}

export interface ValidateDraftResult {
  valid: boolean;
  errors: string[];
  daily_limit: DailyLimitSnapshot;
}

export function validateConnectionDraft(input: ValidateDraftInput): ValidateDraftResult {
  const errors: string[] = [];
  const text = input.draft.trim();

  if (!text) {
    errors.push("Draft is empty — write a personalized connection note.");
  }

  if (text.length > OUTREACH_MAX_CHARS) {
    errors.push(
      `Draft is ${text.length} characters; LinkedIn connection notes must be ≤${OUTREACH_MAX_CHARS}.`,
    );
  }

  if (URL_PATTERN.test(text)) {
    errors.push("Draft must not contain URLs or links (platform safety rule).");
  }

  if (input.lead_context.icp_match_score < 40) {
    errors.push(
      `ICP match score ${input.lead_context.icp_match_score} is below the outreach floor (40).`,
    );
  }

  const daily = input.checkDailyLimit(input.account_id);
  if (!daily.allowed) {
    errors.push(
      `Daily account limit reached (${daily.sent_today}/${daily.daily_limit} connection notes today).`,
    );
  }

  return { valid: errors.length === 0, errors, daily_limit: daily };
}

/** In-memory daily counter for dev/simulation; swap for Postgres in SaaS phase. */
export class InMemoryDailyLimitTracker {
  private readonly counts = new Map<string, number>();

  constructor(private readonly dailyLimit = OUTREACH_DAILY_LIMIT) {}

  check(accountId: string): DailyLimitSnapshot {
    const sent = this.counts.get(accountId) ?? 0;
    const remaining = Math.max(0, this.dailyLimit - sent);
    return {
      allowed: sent < this.dailyLimit,
      sent_today: sent,
      daily_limit: this.dailyLimit,
      remaining,
    };
  }

  recordSend(accountId: string): void {
    this.counts.set(accountId, (this.counts.get(accountId) ?? 0) + 1);
  }
}
