/**
 * FounderOS — Retrieval Golden Set (data only)
 * =============================================
 * A fixed set of queries against `brain.turicks_brain`, each paired with the
 * document(s) a correct retriever MUST return. This file holds data and the one
 * type that describes it — no logic. Scoring lives in retrieval-scoring.ts.
 *
 * How this set was built (so it can be rebuilt honestly):
 *   - The corpus was measured on 2026-08-19 against production:
 *     478 chunks across 113 distinct documents.
 *   - Every `expectedDocs` entry below was copied from a `source_path` that
 *     actually exists in that corpus. None were invented, and the runner
 *     re-checks their presence at run time (see findMissingGoldenDocs) so a
 *     re-ingest that renames or drops a document is reported rather than
 *     silently scored as a retrieval miss.
 *   - Where no single document is unambiguously correct for a question, the
 *     case was OMITTED rather than guessed. A golden set built on guesses
 *     measures nothing.
 *
 * `expectedDocs` is a MINIMUM requirement, not an exhaustive relevance
 * judgement: it lists documents that must appear, and extra results are never
 * penalised. That keeps the set honest without claiming a complete relevance
 * labelling of 113 documents.
 *
 * The identifier is `metadata->>'source_path'` and NOT the row `id`. `id`
 * defaults to `gen_random_uuid()` and is regenerated on every `pnpm brain:sync`,
 * so a golden set keyed on `id` would break on the next re-ingest.
 */

/** One golden retrieval case: a query and the documents retrieval must surface. */
export interface RetrievalGoldenCase {
  /** Stable id, used in the report. */
  readonly id: string;
  /** The query sent to the retriever, phrased as the founder would ask it. */
  readonly query: string;
  /**
   * `metadata->>'source_path'` values a correct retriever MUST return within
   * top-k. Minimum requirement — additional retrieved documents are not penalised.
   */
  readonly expectedDocs: readonly string[];
  /** Why this document is the right answer — read by a human auditing the set. */
  readonly rationale: string;
}

/**
 * The golden set. 25 cases spanning every document family in the corpus
 * (ADRs, strategy, rules, study/post-mortems, product-recovery, plans, profile)
 * so a family-specific retrieval failure cannot hide behind an average.
 */
export const RETRIEVAL_GOLDEN_SET: readonly RetrievalGoldenCase[] = [
  // ── Architecture decision records ──────────────────────────────────────────
  {
    id: "adr-langgraph",
    query: "Why did we choose LangGraph instead of writing a custom state machine?",
    expectedDocs: ["docs/decisions/001-why-langgraph.md"],
    rationale: "ADR-001 is titled 'Why LangGraph Instead of a Custom State Machine'.",
  },
  {
    id: "adr-drizzle",
    query: "Why did we pick drizzle-orm over Prisma for the database layer?",
    expectedDocs: ["docs/decisions/002-why-drizzle.md"],
    rationale: "ADR-002 is titled 'Why drizzle-orm Instead of Prisma'.",
  },
  {
    id: "adr-telegram-hitl",
    query: "Why are human-in-the-loop approvals done over Telegram?",
    expectedDocs: ["docs/decisions/004-why-telegram-hitl.md"],
    rationale: "ADR-004 is titled 'Why Telegram for Human-in-the-Loop Approvals'.",
  },
  {
    id: "adr-redis-cache",
    query: "Why is Redis used for caching instead of PostgreSQL tables?",
    expectedDocs: ["docs/decisions/005-why-redis-for-caching.md"],
    rationale: "ADR-005 is titled 'Why Redis for Caching Instead of PostgreSQL Tables'.",
  },
  {
    id: "adr-linkedin-ban-risk",
    query: "What is the ban risk of automating LinkedIn outreach, and what did we decide?",
    expectedDocs: ["docs/decisions/009-linkedin-automation-ban-risk.md"],
    rationale: "ADR-009 defers LinkedIn automation until ban-risk research is complete.",
  },
  {
    id: "adr-bounded-history",
    query: "How is conversation history bounded so the agent stops looping?",
    expectedDocs: ["docs/decisions/017-bounded-conversation-history.md"],
    rationale: "ADR-017 is titled 'Bounded Conversation History (the permanent loop fix)'.",
  },
  {
    id: "adr-personal-rag-readonly",
    query: "Is personal-rag read-only from every agent tool?",
    expectedDocs: ["docs/decisions/015-personal-rag-read-only-boundary.md"],
    rationale: "ADR-015 states the personal-rag read-only boundary and its enforcement.",
  },
  {
    id: "adr-job-application-submit",
    query: "Does the machine submit job applications by itself or does the founder click submit?",
    expectedDocs: ["docs/decisions/018-job-application-confirmed-submit-only.md"],
    rationale: "ADR-018: 'Founder Clicks, Machine Confirms Before Recording'.",
  },
  {
    id: "adr-kill-switch",
    query: "How does the global kill switch flag file work?",
    expectedDocs: ["docs/decisions/020-kill-switch-and-prod-hardening-scope.md"],
    rationale: "ADR-020 is the flag-file kill switch and pre-production hardening scope.",
  },
  {
    id: "adr-claude-judge",
    query: "Which model judges outbound copy quality, and why is it not the generator?",
    expectedDocs: ["docs/decisions/023-claude-as-judge.md"],
    rationale: "ADR-023 is 'Claude-as-judge for outbound copy (Phase 3)'.",
  },
  {
    id: "adr-daily-budget",
    query: "How does the daily budget guard stop runaway LLM spend?",
    expectedDocs: ["docs/decisions/035-daily-budget-guard.md"],
    rationale: "ADR-035 is 'Daily Budget Guard (Universal Cost Control)'.",
  },
  {
    id: "adr-account-registry",
    query: "How are integration accounts and credentials resolved per company?",
    expectedDocs: ["docs/decisions/036-account-registry.md"],
    rationale: "ADR-036 is the Integration Account Registry, with per-company credential resolution.",
  },
  {
    id: "adr-apify-research",
    query: "Which engine gives the research department real scraped web data?",
    expectedDocs: ["docs/decisions/037-apify-research-engine.md"],
    rationale: "ADR-037 makes Apify the research department's real-data engine.",
  },
  {
    id: "adr-mcp-bridge",
    query: "How do our agents consume external MCP servers as a client?",
    expectedDocs: ["docs/decisions/041-mcp-client-bridge.md"],
    rationale: "ADR-041 is the External MCP Client Bridge.",
  },
  {
    id: "adr-checkpoint-ttl",
    query: "What is the checkpoint TTL sweep and the opt-in idempotency window?",
    expectedDocs: ["docs/decisions/043-checkpoint-ttl-and-idempotency-window.md"],
    rationale: "ADR-043 is titled exactly that.",
  },
  {
    id: "adr-retire-stable-tier",
    query: "Why was the stable release tier retired in favour of a two-stage promotion?",
    expectedDocs: ["docs/decisions/045-retire-stable-tier.md"],
    rationale: "ADR-045 retires the `stable` tier; beta promotes straight to main.",
  },
  {
    id: "adr-operating-model-freeze",
    query: "What is the frozen engineering operating model binding on every executor?",
    expectedDocs: ["docs/decisions/046-operating-model-freeze.md"],
    rationale: "ADR-046 freezes the operating model and is binding on Claude and Antigravity.",
  },

  // ── Strategy ───────────────────────────────────────────────────────────────
  {
    id: "strategy-pricing-floor",
    query: "What is our minimum project price and the offer ladder?",
    expectedDocs: ["docs/strategy/02-OFFER-AND-PRICING.md"],
    rationale: "The offer ladder and the $8K project pricing floor live only in this file.",
  },
  {
    id: "strategy-gtm-channels",
    query: "What is the ranked channel priority for client acquisition?",
    expectedDocs: ["docs/strategy/03-GTM-ACQUISITION-ENGINE.md"],
    rationale: "The ranked channel table is in the GTM acquisition engine doc.",
  },
  {
    id: "strategy-nl-target-companies",
    query: "Which Dutch companies from the IND recognised sponsor register are we targeting?",
    expectedDocs: ["docs/strategy/08-NL-TARGET-COMPANIES.md"],
    rationale: "The verified target list scraped from the IND public register is this document.",
  },

  // ── Engineering rules ──────────────────────────────────────────────────────
  {
    id: "rules-tool-standards",
    query: "What checks must a new tool pass before it counts as done?",
    expectedDocs: ["docs/rules/TOOL-STANDARDS.md"],
    rationale: "TOOL-STANDARDS.md defines the 8 checks every new tool must pass.",
  },
  {
    id: "rules-test-pyramid",
    query: "What are the four test tiers and which risk does each one own?",
    expectedDocs: ["docs/rules/TEST-PYRAMID.md"],
    rationale: "TEST-PYRAMID.md is the four-tier table; TESTING-RULES.md is bug-derived rules.",
  },

  // ── Study, post-mortems, product recovery ──────────────────────────────────
  {
    id: "postmortem-eval-outputmode",
    query: "Why did the eval harness report tool selection as 0 out of 7?",
    expectedDocs: ["docs/study/POSTMORTEM-eval-outputMode.md"],
    rationale: "The post-mortem of the 0/7 → 7/7 tool-select bug is this file.",
  },
  {
    id: "rca-prod-hardcore-qa",
    query: "What was the root cause of the prod hardcore QA failure on 1 July 2026?",
    expectedDocs: ["docs/study/RCA-2026-07-01-prod-hardcore-qa.md"],
    rationale: "The RCA for that dated run is this file.",
  },
  {
    id: "recovery-failure-ledger",
    query: "Where is the ledger of every defect found in the 2026-08-08 product audit?",
    expectedDocs: ["docs/product-recovery/12-FAILURE-LEDGER.md"],
    rationale: "12-FAILURE-LEDGER.md is the audit's defect ledger with severities.",
  },
];
