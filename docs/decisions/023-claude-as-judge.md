# ADR-023 — Claude-as-judge for outbound copy (Phase 3)

- **Date:** 2026-06-14
- **Status:** Accepted
- **Branch:** `feat/phase3-judge`
- **Follows:** [ADR-022](022-typed-interdept-contracts.md)
- **Makes real:** CLAUDE rule #6 (different model families for generator vs critic)

## Context

Rule #6 ("Generator: Gemini · Critic: Claude — prevents sycophancy") existed only
as a written rule — in code, the same Gemini model both drafted and self-checked
outbound copy. The only outbound quality gate was the deterministic
`brand-validator` (banned phrases + word-count). Nothing caught generic AI-slop,
factual overreach, or wrong tone that isn't a banned phrase.

## Decision

**1. Add a Claude judge as gate 2, in the outbound tool — not `postModelHook`.**
The plan named `postModelHook`, but the draft that needs judging is the
email/LinkedIn body, which already exists as a typed tool argument inside
`send_email` / `linkedin_post`, exactly where `brand-validator` (gate 1) sits.
`postModelHook` on a ReAct agent fires after *every* model step (including
intermediate tool-planning), so it would judge non-final messages and re-judge on
every loop. The tool seam is outbound-only by construction, has the draft as
structured text, and already owns the retry-cap machinery. Chosen for precision
and reuse (rule #17).

**2. `src/infra/judge.ts` — generator≠critic, fail-open, memoized.**
   - Critic model: Claude (`claude-haiku-4-5`, `JUDGE_MODEL`-overridable, temp 0).
     Generator stays Gemini. Different family → no self-rubber-stamping.
   - **Fail-open (rule #4 is the backstop):** no API key, model error, unparseable
     output, or a `revise` with no actionable critique → `pass`. HITL is the final
     human gate; the judge may only *add* a critique to the approval card, never
     silently block the founder's workflow on its own confusion.
   - **Deterministic parse (rule #16):** the verdict is read by a pure, unit-tested
     `parseJudgeVerdict`, not trusted as free-form prose.
   - **Memoized (TTL):** the HITL `interrupt()` re-executes the tool body; the
     verdict is cached per `(channel, text)` so resume is a cache hit, not a 2nd
     Claude call.

**3. Bounded by the SAME retry counter as brand.** `outboundQualityGate` =
gate 1 (brand) → gate 2 (judge). A judge `revise` calls `recordBrandFailure`, so
generator+critic together cannot loop past `BRAND_MAX_RETRIES`; past the cap the
critique is surfaced on the HITL card and the founder decides. This reuses the
exact convergence cap that fixed the 146↔113 brand oscillation.

## Activation requirement (honest status)

Gate 2 is **active only when `ANTHROPIC_API_KEY` is configured.** The dev `.env`
currently has no Anthropic key, so in dev the judge is a no-op pass (`isJudgeEnabled()`
→ false) and outbound behaviour is unchanged. To turn the critic on in production,
set `ANTHROPIC_API_KEY` (and optionally `JUDGE_MODEL`) in the deploy env.

## Verification

- 14 unit tests (`judge.test.ts` 10 + `outbound-quality-gate.test.ts` 2 +
  updated `comms-brand-bound.test.ts`): pass/revise parse, fail-open on
  throw/unparseable/critique-missing, TTL memoization, channel non-collision,
  gate-1-still-governs. 1004 tests green · tsc clean.
- **NOT YET VERIFIED live end-to-end** (Gemini draft → Claude *revise* → re-draft)
  on the real Telegram path: dev `.env` has no `ANTHROPIC_API_KEY`, and the
  outbound send path (Composio) is currently down on an invalid key (see MEMORY).
  Deferred to the same gate as Composio recovery; the judge logic is fully
  unit-covered and fail-open in the meantime.

## Consequences

- Rule #6 is now real in code, on the highest-stakes path (external sends).
- Zero new failure mode for the founder: judge can only add a critique or no-op.
- Next: Phase 4 (`dept_signals` durable async over Postgres, typed via ADR-022).
