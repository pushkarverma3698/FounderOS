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
 *
 * ── Why there are two styles ──────────────────────────────────────────────
 * The first 25 cases are `topical`: each query carries the distinctive tokens
 * of its target's own title ("Why did we choose LangGraph..." → 001-why-langgraph.md).
 * They score near-perfectly BY CONSTRUCTION — any retriever with a keyword
 * component finds them without embeddings contributing anything. They are a
 * smoke test worth keeping, not evidence that retrieval is good.
 *
 * The `disjoint` cases exist to answer the question the topical ones cannot.
 * Each is derived from the document's BODY and deliberately shares no
 * distinctive vocabulary with its target's title or filename — and avoids
 * quoting the body verbatim too, since the keyword index matches on `content`,
 * so a quoted sentence would be just as lexically findable as a quoted title.
 * They describe the SITUATION the way someone would who does not know what the
 * document is called. Metrics are reported broken out by style; averaging the
 * two together would hide exactly the effect this split exists to expose.
 *
 * No query in either group was reworded after seeing its score.
 */

/**
 * How a query was authored, which decides what its score is evidence OF.
 *   - `topical`  — query carries the target's own title vocabulary. Near-
 *                  guaranteed to hit; a smoke test for "retrieval is wired up".
 *   - `disjoint` — query derived from body content, sharing no distinctive
 *                  vocabulary with the target's title or filename, and not
 *                  quoting the body verbatim. This is the one that can fail.
 */
export type RetrievalStyle = "topical" | "disjoint";

/** Both styles, in report order. */
export const RETRIEVAL_STYLES: readonly RetrievalStyle[] = ["topical", "disjoint"];

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
  /** How the query was authored. Metrics are broken out by this. */
  readonly style: RetrievalStyle;
  /** Why this document is the right answer — read by a human auditing the set. */
  readonly rationale: string;
}

/**
 * The golden set: 25 `topical` cases spanning every document family in the
 * corpus (ADRs, strategy, rules, study/post-mortems, product-recovery), then 12
 * `disjoint` cases that re-ask a subset of the same documents in vocabulary the
 * document's title does not contain.
 */
export const RETRIEVAL_GOLDEN_SET: readonly RetrievalGoldenCase[] = [
  // ── Architecture decision records ──────────────────────────────────────────
  {
    id: "adr-langgraph",
    query: "Why did we choose LangGraph instead of writing a custom state machine?",
    expectedDocs: ["docs/decisions/001-why-langgraph.md"],
    style: "topical",
    rationale: "ADR-001 is titled 'Why LangGraph Instead of a Custom State Machine'.",
  },
  {
    id: "adr-drizzle",
    query: "Why did we pick drizzle-orm over Prisma for the database layer?",
    expectedDocs: ["docs/decisions/002-why-drizzle.md"],
    style: "topical",
    rationale: "ADR-002 is titled 'Why drizzle-orm Instead of Prisma'.",
  },
  {
    id: "adr-telegram-hitl",
    query: "Why are human-in-the-loop approvals done over Telegram?",
    expectedDocs: ["docs/decisions/004-why-telegram-hitl.md"],
    style: "topical",
    rationale: "ADR-004 is titled 'Why Telegram for Human-in-the-Loop Approvals'.",
  },
  {
    id: "adr-redis-cache",
    query: "Why is Redis used for caching instead of PostgreSQL tables?",
    expectedDocs: ["docs/decisions/005-why-redis-for-caching.md"],
    style: "topical",
    rationale: "ADR-005 is titled 'Why Redis for Caching Instead of PostgreSQL Tables'.",
  },
  {
    id: "adr-linkedin-ban-risk",
    query: "What is the ban risk of automating LinkedIn outreach, and what did we decide?",
    expectedDocs: ["docs/decisions/009-linkedin-automation-ban-risk.md"],
    style: "topical",
    rationale: "ADR-009 defers LinkedIn automation until ban-risk research is complete.",
  },
  {
    id: "adr-bounded-history",
    query: "How is conversation history bounded so the agent stops looping?",
    expectedDocs: ["docs/decisions/017-bounded-conversation-history.md"],
    style: "topical",
    rationale: "ADR-017 is titled 'Bounded Conversation History (the permanent loop fix)'.",
  },
  {
    id: "adr-personal-rag-readonly",
    query: "Is personal-rag read-only from every agent tool?",
    expectedDocs: ["docs/decisions/015-personal-rag-read-only-boundary.md"],
    style: "topical",
    rationale: "ADR-015 states the personal-rag read-only boundary and its enforcement.",
  },
  {
    id: "adr-job-application-submit",
    query: "Does the machine submit job applications by itself or does the founder click submit?",
    expectedDocs: ["docs/decisions/018-job-application-confirmed-submit-only.md"],
    style: "topical",
    rationale: "ADR-018: 'Founder Clicks, Machine Confirms Before Recording'.",
  },
  {
    id: "adr-kill-switch",
    query: "How does the global kill switch flag file work?",
    expectedDocs: ["docs/decisions/020-kill-switch-and-prod-hardening-scope.md"],
    style: "topical",
    rationale: "ADR-020 is the flag-file kill switch and pre-production hardening scope.",
  },
  {
    id: "adr-claude-judge",
    query: "Which model judges outbound copy quality, and why is it not the generator?",
    expectedDocs: ["docs/decisions/023-claude-as-judge.md"],
    style: "topical",
    rationale: "ADR-023 is 'Claude-as-judge for outbound copy (Phase 3)'.",
  },
  {
    id: "adr-daily-budget",
    query: "How does the daily budget guard stop runaway LLM spend?",
    expectedDocs: ["docs/decisions/035-daily-budget-guard.md"],
    style: "topical",
    rationale: "ADR-035 is 'Daily Budget Guard (Universal Cost Control)'.",
  },
  {
    id: "adr-account-registry",
    query: "How are integration accounts and credentials resolved per company?",
    expectedDocs: ["docs/decisions/036-account-registry.md"],
    style: "topical",
    rationale: "ADR-036 is the Integration Account Registry, with per-company credential resolution.",
  },
  {
    id: "adr-apify-research",
    query: "Which engine gives the research department real scraped web data?",
    expectedDocs: ["docs/decisions/037-apify-research-engine.md"],
    style: "topical",
    rationale: "ADR-037 makes Apify the research department's real-data engine.",
  },
  {
    id: "adr-mcp-bridge",
    query: "How do our agents consume external MCP servers as a client?",
    expectedDocs: ["docs/decisions/041-mcp-client-bridge.md"],
    style: "topical",
    rationale: "ADR-041 is the External MCP Client Bridge.",
  },
  {
    id: "adr-checkpoint-ttl",
    query: "What is the checkpoint TTL sweep and the opt-in idempotency window?",
    expectedDocs: ["docs/decisions/043-checkpoint-ttl-and-idempotency-window.md"],
    style: "topical",
    rationale: "ADR-043 is titled exactly that.",
  },
  {
    id: "adr-retire-stable-tier",
    query: "Why was the stable release tier retired in favour of a two-stage promotion?",
    expectedDocs: ["docs/decisions/045-retire-stable-tier.md"],
    style: "topical",
    rationale: "ADR-045 retires the `stable` tier; beta promotes straight to main.",
  },
  {
    id: "adr-operating-model-freeze",
    query: "What is the frozen engineering operating model binding on every executor?",
    expectedDocs: ["docs/decisions/046-operating-model-freeze.md"],
    style: "topical",
    rationale: "ADR-046 freezes the operating model and is binding on Claude and Antigravity.",
  },

  // ── Strategy ───────────────────────────────────────────────────────────────
  {
    id: "strategy-pricing-floor",
    query: "What is our minimum project price and the offer ladder?",
    expectedDocs: ["docs/strategy/02-OFFER-AND-PRICING.md"],
    style: "topical",
    rationale: "The offer ladder and the $8K project pricing floor live only in this file.",
  },
  {
    id: "strategy-gtm-channels",
    query: "What is the ranked channel priority for client acquisition?",
    expectedDocs: ["docs/strategy/03-GTM-ACQUISITION-ENGINE.md"],
    style: "topical",
    rationale: "The ranked channel table is in the GTM acquisition engine doc.",
  },
  {
    id: "strategy-nl-target-companies",
    query: "Which Dutch companies from the IND recognised sponsor register are we targeting?",
    expectedDocs: ["docs/strategy/08-NL-TARGET-COMPANIES.md"],
    style: "topical",
    rationale: "The verified target list scraped from the IND public register is this document.",
  },

  // ── Engineering rules ──────────────────────────────────────────────────────
  {
    id: "rules-tool-standards",
    query: "What checks must a new tool pass before it counts as done?",
    expectedDocs: ["docs/rules/TOOL-STANDARDS.md"],
    style: "topical",
    rationale: "TOOL-STANDARDS.md defines the 8 checks every new tool must pass.",
  },
  {
    id: "rules-test-pyramid",
    query: "What are the four test tiers and which risk does each one own?",
    expectedDocs: ["docs/rules/TEST-PYRAMID.md"],
    style: "topical",
    rationale: "TEST-PYRAMID.md is the four-tier table; TESTING-RULES.md is bug-derived rules.",
  },

  // ── Study, post-mortems, product recovery ──────────────────────────────────
  {
    id: "postmortem-eval-outputmode",
    query: "Why did the eval harness report tool selection as 0 out of 7?",
    expectedDocs: ["docs/study/POSTMORTEM-eval-outputMode.md"],
    style: "topical",
    rationale: "The post-mortem of the 0/7 → 7/7 tool-select bug is this file.",
  },
  {
    id: "rca-prod-hardcore-qa",
    query: "What was the root cause of the prod hardcore QA failure on 1 July 2026?",
    expectedDocs: ["docs/study/RCA-2026-07-01-prod-hardcore-qa.md"],
    style: "topical",
    rationale: "The RCA for that dated run is this file.",
  },
  {
    id: "recovery-failure-ledger",
    query: "Where is the ledger of every defect found in the 2026-08-08 product audit?",
    expectedDocs: ["docs/product-recovery/12-FAILURE-LEDGER.md"],
    style: "topical",
    rationale: "12-FAILURE-LEDGER.md is the audit's defect ledger with severities.",
  },

  // ── Vocabulary-disjoint: derived from body content, no title tokens ────────
  // Each query below was written from the document's BODY after reading it, and
  // deliberately avoids the distinctive words in its title and filename — and
  // avoids quoting the body verbatim, since the keyword index matches `content`.
  {
    id: "disjoint-durable-resume",
    query:
      "If the process dies halfway through a multi-step workflow, what makes it pick up from the last completed step instead of re-running everything?",
    expectedDocs: ["docs/decisions/001-why-langgraph.md"],
    style: "disjoint",
    rationale:
      "Body §'PostgreSQL Checkpointing': a crash after lead_intel resumes from bdr and lead_intel " +
      "is not re-run. Query uses none of 'why', 'LangGraph', 'custom', 'state', 'machine'.",
  },
  {
    id: "disjoint-repeating-replies",
    query:
      "The assistant kept repeating itself across messages and stopped completing anything. What was the cause?",
    expectedDocs: ["docs/decisions/017-bounded-conversation-history.md"],
    style: "disjoint",
    rationale:
      "Body §Context records the founder symptom (it loops, same reply every question) and names " +
      "state pollution as the cause. Query avoids 'bounded', 'conversation', 'history'.",
  },
  {
    id: "disjoint-double-send",
    query:
      "What stops the same email going out twice when an approval is picked up hours after the run started?",
    expectedDocs: ["docs/decisions/043-checkpoint-ttl-and-idempotency-window.md"],
    style: "disjoint",
    rationale:
      "Body argues the key must be byte-identical across the approval gap or the action " +
      "re-executes into a double-send. Query avoids 'checkpoint', 'TTL', 'idempotency', 'window'.",
  },
  {
    id: "disjoint-runaway-spend",
    query:
      "What stops runaway model spend from accumulating unbounded, and at what percentage does it warn?",
    expectedDocs: ["docs/decisions/035-daily-budget-guard.md"],
    style: "disjoint",
    rationale:
      "Body: the cap was documented but never enforced; alerts fire at 80% and 100%. Query avoids " +
      "'daily', 'budget', 'guard'.",
  },
  {
    id: "disjoint-phone-signoff",
    query:
      "Where does the founder sign off on an outgoing message from his phone, rather than opening a dashboard?",
    expectedDocs: ["docs/decisions/004-why-telegram-hitl.md"],
    style: "disjoint",
    rationale:
      "Body compares two taps on a phone against 30–120 minutes for a web dashboard. Query avoids " +
      "'Telegram', 'human-in-the-loop', 'HITL', 'approvals'.",
  },
  {
    id: "disjoint-different-model-family",
    query:
      "Why is the model that reviews marketing text for slop deliberately from a different family than the one that wrote it?",
    expectedDocs: ["docs/decisions/023-claude-as-judge.md"],
    style: "disjoint",
    rationale:
      "Body: 'different model families for generator vs critic — prevents sycophancy', and nothing " +
      "previously caught generic AI-slop. Query avoids 'Claude', 'judge', 'outbound', 'copy'.",
  },
  {
    id: "disjoint-instant-halt",
    query:
      "How do we make the bot refuse all new work immediately without a redeploy, in a way that still fails safe if the marker is corrupt?",
    expectedDocs: ["docs/decisions/020-kill-switch-and-prod-hardening-scope.md"],
    style: "disjoint",
    rationale:
      "Body: a present-but-corrupt flag is still treated as halted; the gate refuses new turns and " +
      "approval taps. Query avoids 'kill', 'switch', 'hardening', 'scope'.",
  },
  {
    id: "disjoint-snippets-to-full-pages",
    query:
      "We could only see result titles and short snippets, never the whole page. What changed that?",
    expectedDocs: ["docs/decisions/037-apify-research-engine.md"],
    style: "disjoint",
    rationale:
      "Body §Context: the department saw titles plus ~300-char snippets and never full page " +
      "content. Query avoids 'Apify', 'research', 'engine', 'memory'.",
  },
  {
    id: "disjoint-blind-harness",
    query:
      "Our measurement harness said the agents used no tools, but they demonstrably did. Why was it blind to them?",
    expectedDocs: ["docs/study/POSTMORTEM-eval-outputMode.md"],
    style: "disjoint",
    rationale:
      "Body: sub-agent tool calls stay internal to the sub-graph and never surface in the parent " +
      "message list. Query avoids 'post-mortem', 'eval', 'outputMode'.",
  },
  {
    id: "disjoint-phantom-sends",
    query:
      "Our logs claimed messages were delivered when nothing was actually sent. What discipline came out of that?",
    expectedDocs: ["docs/rules/TESTING-RULES.md"],
    style: "disjoint",
    rationale:
      "Body Rule 2: phantom 'email sent' events were recorded in the audit log while the send " +
      "never happened. Query avoids 'testing', 'rules'.",
  },
  {
    id: "disjoint-below-floor-prospect",
    query:
      "If a prospect can only spend $4K, what do we do, and why did we drop the cheap starter tier?",
    expectedDocs: ["docs/strategy/02-OFFER-AND-PRICING.md"],
    style: "disjoint",
    rationale:
      "Body: below $8K, politely decline or refer; the $500 starter was retired for attracting " +
      "commodity buyers. Query avoids 'offer', 'ladder', 'pricing'.",
  },
  {
    id: "disjoint-no-write-path",
    query:
      "Can any tool write into the founder's own career knowledge base, and is that enforced by a runtime check or by there being no write path at all?",
    expectedDocs: ["docs/decisions/015-personal-rag-read-only-boundary.md"],
    style: "disjoint",
    rationale:
      "Body §Decision: enforced by construction — the tools do not expose a write path — not by a " +
      "runtime policy check. Query avoids 'personal-rag', 'read-only', 'boundary'.",
  },
];
