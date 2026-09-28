# Audit: reply latency, Telegram UX, RAG/context, goals, OmniRouter (2026-09-28)

Evidence-only audit. No code changed. Every number below comes from a command run on 2026-09-28
against prod (`ssh founderos-vps`): the `founderos.service` journal (`"module":"trace"` lines,
30 days) and the prod Postgres (`founderos-postgres`). Fix plans that act on it:

- `docs/plans/2026-09-28-reply-latency-and-failure-ux.md` (branch `claude/fix-gemini-thinking-and-failure-ux`)
- `docs/plans/2026-09-28-rag-retrieval-cleanup.md` (branch `claude/fix-rag-retrieval-cleanup`)

## 1. Reply latency

91 completed turns with both `turn.in` and `turn.out`/`turn.error`, 2026-08-29 → 09-28:
**p50 18.6 s, p90 157 s, max 300 s** (the turn timeout). The 200–300 s turns cluster on 09-15/16,
the fallback-chain starvation bug fixed that week. Since 09-17 the worst turn was 157 s.

Per-stage split. `llm.call` is logged at call start, so each gap is that call's duration:

| Turn | Planner | Worker hops | Tools | Synthesizer | Total |
|---|---|---|---|---|---|
| "list my 3 most recent emails" (09-21) | 3.6 s | 2.0 + 2.0 s | 0.3 s | 3.4 s | 11.6 s |
| "Check production logs for founder Os" (09-22) | 7.3 s | 2.1 + 5.3 s | 0.4 s | 5.2 s | 20.8 s |
| "Give the latest role with url" (09-09) | 2.7 s | 1.9 + 2.3 + 1.8 s | <0.1 s | 1.7 s | 10.8 s |
| "Is Jev useful for us?" (09-26) | 7.1 s | ~9 s total | `search_web` 12.8 / 15.8 / 13.1 s | 4.6 s | 84.1 s |
| "What engineering capabilities you have?" (direct reply) | 7.0 s | none | none | none | 7.0 s |

Every tool turn is at least 3 serial LLM calls (plan → worker → synthesize) plus one worker call
per tool round. RAG retrieval is not a factor: `search_knowledge` 153 ms, `search_turicks_brain`
133 ms in the Jev turn.

### Root cause: Gemini thinks on every call, invisibly

`src/agents/model.ts` constructs `ChatGoogleGenerativeAI` without `thinkingConfig`, so Gemini 3.x
Flash runs its default dynamic thinking. `@langchain/google-genai` 2.1.31 sets
`usage_metadata.output_tokens = candidatesTokenCount` (`dist/utils/common.js:471`), which
excludes `thoughtsTokenCount`. So thought tokens are billed but never written to `ai_call_costs`.
The planner's recorded median output is 166 tokens, which alone cannot take 3.6–7.3 s.

Measured 2026-09-28 (founder-approved live test): the real planner system prompt (6,323 chars,
1,632 input tokens) plus "list my 3 most recent emails", direct REST to
`generativelanguage.googleapis.com`, temperature 0, 10 calls:

| Model | thinkingConfig | Latency | Thought tokens | Visible output | Valid planner JSON |
|---|---|---|---|---|---|
| gemini-3.6-flash | none (prod today) | 4,832 / 4,208 ms | 615 / 473 | 181 / 178 | yes |
| gemini-3.6-flash | `thinkingLevel: "low"` | 1,562 / 1,709 ms | 0 | 91 / 93 | yes |
| gemini-3.6-flash | `thinkingLevel: "minimal"` | 1,610 / 1,421 ms | 0 | 95 | yes |
| gemini-3.6-flash | `thinkingBudget: 0` | 1,378 / 1,359 ms | 0 | 95 | yes |
| gemini-3.1-flash-lite (fallback 1) | `thinkingLevel: "minimal"` | 1,058 ms | 0 | 88 | yes |
| gemini-3-flash-preview (fallback 2) | `thinkingLevel: "minimal"` | 1,497 ms | 0 | 90 | yes |

About 3 s saved per Gemini call. A typical tool turn makes 4–5 of them.

## 2. Telegram UX (ranked by founder friction)

1. **Waiting with nothing to read.** A placeholder ("🤔 Working on it…", then the step objective,
   then "✍️ Writing your reply…") is deleted and the whole reply lands at once. Direct replies to
   long questions took 7–13 s as a single planner call.
2. **Job answers from free text omit the posting date.** On 09-07 the founder asked
   "are these of today?" 4 times in 5 minutes. The command views (`brief-row.ts` `ageLine`) have
   printed "posted X · found Y" since 09-08. The free-text path does not: `queryJobState`'s curated
   select (`src/db/job-queries.ts`, non-`fullDetails` branch) returns `created_at` but not
   `posted_at`.
3. **Failure replies read like a stack trace and have no retry.** `formatFailureReply`
   (`src/kernel/supervisor.ts`) prints `Task stopped at step "s1" — validation failure in
   kernel/worker`. On 09-16 the founder typed "Try again" by hand twice.
4. **34 commands in the ☰ menu; 17 are `wife_*` twins.** Every job command already accepts a
   profile word (`/jobs tashi`, `jobhunt-profile-arg.ts`); the twins only exist in the menu.
5. **Status questions take the slow path.** "Check is it done?" / "Where are we?" took 20–29 s
   through the planner. `/tasks` answers the same thing deterministically.

## 3. RAG / context delegation

Right by design: a worker sees only its prompt plus a JSON envelope (`supervisor.envelopeMessage`),
never the chat; retrieval is just-in-time via tools; history is bounded (20 turns / 16k chars /
6 h session gap); tool output is clamped. Hybrid retrieval measured recall@5 83.8 %, p95 575 ms
(2026-08-25 session).

The mess is in the inventory (prod counts, 2026-09-28):

| Store | Rows | Last write | Read by |
|---|---|---|---|
| `brain.brain_memories` | 1,857 | 09-28 | `search_knowledge` **and** `search_turicks_brain` (same engine, same table) |
| `brain.turicks_brain` | 1,352 | 09-05 | nothing (frozen by ADR-038) |
| `brain.personal_rag` | **4** | **06-15** | `search_personal_rag` (personal worker) |
| `brain.research_cache` | 1,074 | 09-26 | `search_research_cache` |
| `agents.episodic_memory` | 128 | 09-26 | `search_memory` |

- The research worker has both brain tools. On 09-26 it called `search_knowledge("FounderOS Pushkar")`
  and `search_turicks_brain("FounderOS Pushkar")` in the same turn, although
  `prompts/research.ts` forbids exactly that. A prompt rule without a mechanism.
- `personal_rag`'s 4 chunks are a June wiki stub and a FounderOS brief. The wiki is a known
  fabrication source for CV facts (it once injected a non-existent skill into live CVs).
- Dead prompt text: `prompts/research.ts` still branches on "EXTERNAL LEAD DISCOVERY" /
  "INTERNAL KNOWLEDGE" routing directives that no code emits (grep: 0 emitters).
  `agents/agent-tools/rag.ts` still describes ChromaDB on :8765/:8766.

## 4. High-level goals

One message is one mission: ≤ 8 steps (`MAX_PLAN_STEPS`) × ≤ 6 tool calls
(`MAX_TOOL_CALLS_PER_STEP`) within 300 s (`OFFICE_TURN_TIMEOUT_MS`). The plan is fixed at planning
time; the supervisor retries a failed step but never re-plans. No goal object persists across
turns. `scheduled_tasks` has 21 rows, none since 07-21 (16 failed during the July provider
outage). The outcome-pursuing loops that do exist are `/task` → Antigravity → PR → review
(proven 09-22) and the jobhunt cron sweeps.

## 5. OmniRouter for prod

Not for prod. It is a laptop-local proxy (`127.0.0.1:20128`; the VPS got `http=000` on 09-05). It
would share the subscription usage windows the founder already exhausts interactively. Consumer
subscriptions carry terms-of-service risk for a 24/7 bot (not checked per provider). Prod recorded
$0.29 of LLM spend in 30 days, so there is nothing to save. The fallback chain classifies by
provider HTTP status, which a proxy may rewrite (NOT VERIFIED for OmniRouter). Fine for the
laptop dev loop.
