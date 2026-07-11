/**
 * FounderOS — LinkedIn posting identity policy
 * ==============================================
 * Deterministic flow → account + tagging rules (rule #16 — not prompt-instructed).
 *
 * Strategy (docs/guides/LINKEDIN-ACCOUNT-AND-GROWTH-STRATEGY.md):
 *   - scheduled_feed (B): Pushkar personal profile + @Turicks tag — growth / build-in-public
 *   - immediate_feed (A), engagement: Turicks company page
 *   - outreach_note (C): personal only (connection notes are always personal on LinkedIn)
 */

import type { AccountKey } from "./accounts.js";
import { appendCompanyPageMention } from "../infra/social-mention.js";

/** Which automation path is publishing or drafting LinkedIn content. */
export const LINKEDIN_POSTING_FLOWS = [
  "immediate_feed",
  "scheduled_feed",
  "engagement",
  "outreach_note",
] as const;

export type LinkedInPostingFlow = (typeof LINKEDIN_POSTING_FLOWS)[number];

export interface LinkedInPostingPolicy {
  flow: LinkedInPostingFlow;
  /** Account registry key — resolves author URN via credential refs. */
  account_key: AccountKey;
  /** Append @Turicks company mention to feed post body (scheduled growth posts). */
  tag_company_page: boolean;
  /** Human-readable reason for logs and HITL cards. */
  rationale: string;
}

const POLICY: Record<LinkedInPostingFlow, Omit<LinkedInPostingPolicy, "flow">> = {
  immediate_feed: {
    account_key: "turicks",
    tag_company_page: false,
    rationale: "Official Turicks company page — brand announcements and engagement context",
  },
  scheduled_feed: {
    account_key: "personal",
    tag_company_page: true,
    rationale:
      "Founder personal profile + @Turicks — build-in-public for reach and followers (GTM #1)",
  },
  engagement: {
    account_key: "turicks",
    tag_company_page: false,
    rationale: "Comment/reply context on Turicks company page posts",
  },
  outreach_note: {
    account_key: "personal",
    tag_company_page: false,
    rationale: "Connection notes are always sent from the founder personal profile (ADR-009)",
  },
};

export function resolveLinkedInPostingPolicy(flow: LinkedInPostingFlow): LinkedInPostingPolicy {
  const row = POLICY[flow];
  return { flow, ...row };
}

/** Apply account policy to feed post body (e.g. @Turicks tag on scheduled personal posts). */
export function prepareLinkedInFeedPost(
  text: string,
  flow: LinkedInPostingFlow,
): { text: string; account_key: AccountKey; policy: LinkedInPostingPolicy } {
  const policy = resolveLinkedInPostingPolicy(flow);
  const body = policy.tag_company_page ? appendCompanyPageMention(text) : text.trim();
  return { text: body, account_key: policy.account_key, policy };
}
