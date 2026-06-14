# ADR-021 — Production multi-agent transition (Phase 1): context isolation, token measurement, Gemini caching & adapter defer

- **Date:** 2026-06-14
- **Status:** Accepted
- **Branch:** `feat/phase1-context-isolation`

## Context

An external advisor handed the founder a generic "prototype → production SaaS" plan
(ephemeral containers, BullMQ broker, hierarchical supervisors, judge agents, distributed
tracing). A file-grounded audit showed FounderOS already ships ~70–75% of it (Postgres
checkpoints, DB-backed nested HITL, budget guard, LangSmith, per-turn `trace_id` seam
logging, deterministic pre-router, namespaced `founder_context`, idempotency, path-guard).
The founder chose to pre-build the genuinely-absent scalable substrate as a phased program
(see `/Users/pushkarverma/.claude/plans/hazy-plotting-tide.md`). This ADR records Phase 1
(context isolation + token) and the cross-cutting caching/Redis/adapter decisions.

Key library finding: the pinned `@langchain/langgraph-supervisor@0.0.20` already supports
`stateSchema`, nested-supervisor-as-agent, `outputMode`, `preModelHook`, `postModelHook`,
`responseFormat` — so the whole program is buildable on the existing prebuilts, no
hand-rolled `StateGraph` rewrite.

## Decisions

**1. Context isolation is pinned, not rebuilt.** `outputMode: "last_message"` (the library
default) already prevents a department's internal tool steps from polluting the supervisor's
history. We pin it explicitly in `office.ts` so the guarantee cannot silently regress. No
custom state rewrite was needed for isolation.

**2. Measure what we control.** `BudgetTracker` now breaks out input vs output tokens and the
per-turn `turn.out` trace logs `inputTokens`/`outputTokens`/`usd` (greppable by `turnId`),
reusing the existing budget callback. Input tokens are the dominant, cacheable-prefix cost.

**3. Gemini implicit caching is the token lever — no Redis, no explicit caching.**
   - Gemini 2.5 Flash does **implicit prompt caching by default** (≤75% off shared prefixes,
     ≥1024-token floor; our supervisor prefix is ~2.8k tokens). It applies server-side
     automatically — a free cost win we structurally enable by keeping the system prefix stable.
   - **Explicit** Gemini context caching is **incompatible with tool-calling agents**
     (`cached_content` 400s with tools/system_instruction/structured-output). FounderOS is all
     tool-calling → not pursued.
   - **Redis: NO** (for caching). It adds nothing over free implicit caching; an app-level
     response cache has near-zero hit rate in interactive temp-0 use. Redis's real value
     (atomic cross-instance quota/rate-limit) is a Phase-E multi-instance concern. The dormant
     `src/infra/redis.ts` stub stays; re-add at Phase E.

**4. Adapter upgrade DEFERRED.** `@langchain/google-genai@0.1.12` (latest is 2.x) exposes only
`{promptTokens, completionTokens, totalTokens}` — **no `cachedContentTokenCount`** — so the
implicit-cache discount is real but **not measurable in-app**. A `0.1.12 → 2.x` major bump
under `FounderChatGoogle extends ChatGoogleGenerativeAI` risks cascading `@langchain/core` /
`langgraph` upgrades and high blast radius on the production agent runtime. We defer it as its
own de-risked task; evidence + re-measure tool live in `scripts/probe-implicit-cache.ts`.

**5. Two Phase-1 scope cuts (YAGNI / risk).**
   - Skipped `createTrimmedPrompt` → `preModelHook` migration — the existing `prompt` modifier
     already shapes LLM input without mutating persisted state; migrating is pure churn.
   - Skipped moving the daily `TODAY:` date out of the system prefix — it is daily-granular and
     implicit-cache TTL is minutes, so the prefix is already stable within any cache window; the
     trailing-`SystemMessage` mechanism is adapter-fragile (system messages get merged).

## Consequences

- Phase 1 is small and honest: instrumentation + an explicit isolation guarantee + this ADR,
  not a refactor. 990 tests green, tsc clean.
- The token-delta-vs-cache metric is unavailable until the adapter is upgraded; we track input
  tokens + $ per turn instead.
- Next: Phase 2 (typed inter-dept contracts + scoped state channels on the flat topology).
