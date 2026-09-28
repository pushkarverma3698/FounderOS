/**
 * Tashi's classifier terms that came from MEASUREMENT, per track.
 * ================================================================
 * 2026-09-28: every NL-marked board in the registry (1,166) was polled with the
 * production adapters and her own filters were run over the 39,287 postings.
 * 21 Dutch roles survived a 30-day window. Among the postings dropped as
 * `off_track` at Dutch or unknown locations, hand-reading the finance-shaped
 * titles left 29 that fit a 2.4-year FP&A / KYC / audit candidate — BDO and
 * Deloitte junior tax and audit roles, ING financial-crime compliance, an
 * Assistant Controller, a Rabobank Finance Specialist. The phrases below are
 * what those titles needed; tests/unit/jobhunt/tashi-track-recall.test.ts pins
 * each one to its real title.
 *
 * WHOLE PHRASES ONLY, and that is measured too: bare "controller" matched a
 * chip-design role, bare "tax" matched software sales ("Account Manager Tax &
 * Trade"), "compliance specialist" matched export control, bare "assurance"
 * matched quality assurance — all in the same sweep, all pinned as negatives.
 *
 * English only. ~3/4 of Dutch finance postings are written in Dutch, and the
 * Language gate reads a stated requirement, not the language a posting is
 * written in — Dutch titles wait on how well she reads Dutch.
 *
 * Kept apart from wife-nl-finance.ts for the 400-line budget; merged into each
 * track's `classifyTerms` there.
 */

export const TASHI_MEASURED_TERMS = {
  fpa: [
    "assistant controller", "junior controller", "regio controller", "regional controller",
    "group controller", "plant controller", "project controller", "commercial controller",
    "finance controller", "financial control", "financial planning", "finance specialist",
    "finance officer", "finance strategy", "strategic finance", "consultant finance",
    "finance & data analyst", "finance data analyst",
  ],
  "finance-ops": [
    "accounts payable", "accounts receivable", "finance administrator", "tax specialist",
    "tax consultant", "consultant tax", "analyst tax", "tax associate", "tax filing",
    "indirect tax", "direct tax", "transfer pricing",
  ],
  "compliance-kyc": ["compliance officer", "financial crime", "transaction monitoring", "fraud analyst"],
  auditor: [
    "internal audit", "it audit", "audit & assurance", "audit and assurance", "audit trainee",
    "trainee audit", "assurance associate", "risk analyst", "analyst risk", "risk specialist",
    "risk officer",
  ],
  accountant: ["accounting analyst", "accounting officer"],
} as const satisfies Record<string, readonly string[]>;
