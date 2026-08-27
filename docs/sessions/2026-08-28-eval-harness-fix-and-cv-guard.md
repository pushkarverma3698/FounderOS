# 2026-08-28 — Eval harness fix, CV fabrication guard, beta→main release

## What we did

Dispatched two parallel subagents (isolated worktrees) against the findings from
[EVAL-AUDIT-2026-08-28.md](../EVAL-AUDIT-2026-08-28.md) and the market study's P0 finding:

- **Eval harness fix** — all 6 harness defects (dropped HITL receipts, single-step routing,
  missing recursion-limit config, stale draft-vs-send expectations, over-broad infra-error
  exclusion, wrong golden-task count) fixed and proven with new tests against the real
  `buildKernel` graph, not asserted. [PR #585](https://github.com/pushkarverma3698/FounderOS/pull/585).
- **CV fabrication guard** — `verifyCvClaims()`, a pure function checking technologies,
  employers, titles, dates, and degrees against the base CV before `tailorCv()` can return a
  result. [PR #584](https://github.com/pushkarverma3698/FounderOS/pull/584).
- **Live re-eval** — ran `pnpm eval` for real on `/opt/review/founderos` against the healthy
  Gemini models, published the earned result. [PR #586](https://github.com/pushkarverma3698/FounderOS/pull/586).
- **Retroactive CV audit** — ran the new guard against every real tailored CV in production
  (read-only, via `/opt/review/founderos`, never `/opt/founderos`).
- **Released beta → main** ([PR #587](https://github.com/pushkarverma3698/FounderOS/pull/587)),
  watched the deploy, verified prod actually restarted on the new commit.
- Ran `pnpm brain:sync` after each doc-changing round.

## What we fixed

- **The eval harness was measuring itself.** `src/eval/kernel-invoker.ts` discarded tool
  receipts from any step that paused at a HITL gate and silently ran at LangGraph's bare
  default recursion limit (25) instead of production's configured 60. Fixed; the subagent found
  the audit's own proposed fix ("read `state.step_receipts`") was only half the mechanism — a
  gated tool that's a step's *only* call produces zero receipts even mid-interrupt, because
  every HITL tool calls `interrupt()` before doing any work. The complete fix also reads the
  pending interrupt's own payload, proven with a new offline test driving the real graph through
  both shapes.
- **`tailorCv()` could fabricate credentials with no code-level check.** Only a prompt
  instruction guarded against it — a direct violation of this repo's own principle that guards
  must be pure functions. `verifyCvClaims()` fixes it; wired in before any tailored CV can leave
  the pipeline.
- **My own audit doc had an error, caught by the eval-harness subagent, not by me.** B6
  originally named two adversarial tasks as "penalizing correct refusals." Only one
  (`adversarial-prompt-injection`) was; `stress-dangerous-shell`'s published row showed
  `hitl:✅` + `tools:❌ none` — the interrupt genuinely fired and was caught exactly as asserted,
  it was a receipt-loss casualty (D1), not a refusal. Corrected in `docs/LIMITATIONS.md` B6.
- **My own "22 tailored CVs" figure, published the day before, was also wrong.** It counted
  `tailor_status IS NOT NULL`, which includes 16 attempts that failed before ever rendering a
  CV. Only 6 tailored-CV PDFs have ever existed in production. Caught during the retroactive
  audit and corrected in `docs/study/PORTFOLIO-GAPS-AND-ACTIONS.md` and memory, same day.
- **My first retroactive-audit run itself produced a false result.** Decoding the stored PDF as
  raw UTF-8 (instead of extracting text) produced garbage "fabricated dates." Caught before
  reporting; fixed by extracting real text with `pdf-parse` (a throwaway devDependency of the
  read-only review checkout only, removed after the run).

## Why

The prior session's audit found the 42% golden-set score was mostly an artifact of a broken
measuring instrument, and the market study found `tailorCv()`'s only fabrication defense was a
wish, not a mechanism — the single highest-severity, highest-market-relevance gap the portfolio
work had surfaced. Both were named as P0/P1 in [PORTFOLIO-GAPS-AND-ACTIONS.md](../study/PORTFOLIO-GAPS-AND-ACTIONS.md).
The founder asked directly to fix the eval failures, fix the limitations the market data flagged
as real, and finish the outstanding work — using subagents. Both fixes were file-disjoint, so
they ran in parallel; each PR was reviewed by reading the actual diff, not by trusting the
agent's own summary, per this repo's rule that review is not delegable.

## Metrics

**Eval, before → after (2026-08-27 broken harness → 2026-08-28 live re-run):**

| Dimension | Before | After |
|---|---|---|
| Routing | 74% | **90%** |
| Tool selection | 50% | **96%** |
| HITL coverage | 82% | **95%** |
| **Overall** | **42%** | **85%** |

Zero tasks excluded as infra errors in the re-run (was 3). All three recursion-limit failures
resolved at the correct limit (60) — B5 closed on evidence, not assumption. 6 genuine failures
remain, all newly visible because the harness stopped hiding them, none of them harness
artifacts.

**CV fabrication guard, retroactive audit:** 6 real tailored-CV PDFs have ever existed in
production (not 22 — that figure conflated with 16 failed-before-rendering attempts). **6 of 6
flagged** by the new guard — same fabricated terms as the original 2026-08-25 measurement
(Kubernetes, C#, Domain-Driven Design) plus new ones. **Zero of the 6 had been applied to** —
the fabrication risk was real but contained; nothing fabricated reached a real employer through
this path.

**Deploy:** `main` merge commit `7466cfb`; `founderos.service` `ActiveEnterTimestamp` moved to
`2026-08-27T21:08:30Z`, confirming a real restart (not a stale process with a matching git
tree — the exact false-positive this repo has been burned by before). Clean boot log: kernel
compiled with 8 workers, checkpointer ready, Telegram bot started, `FounderOS v3 running 🚀`.

`pnpm gate`: green throughout — 331 files / 3,645 tests after the final merge.

## Outstanding

1. **Founder decision on the 6 flagged CVs**: do not approve sending any as-is; re-run
   `tailorCv()` for each so the new guard clears them or names the violation.
2. **Send the (still) unapplied qualified NL roles** — the portfolio and eval work is done;
   sending applications is a founder action per this session's own scope limits (real,
   consequential actions to real employers).
3. **6 genuine eval gaps documented, none urgent**: a tool-selection miss on `eng-build-feature`,
   the `admin`-over-pull pattern on business questions (corroborates an existing market-study
   finding), two comms/sales routing ambiguities, one open question about direct-reply
   legitimacy on `multi-step-chain`, one environment-fixture gap.
4. Two independently-started background sessions from the prior turn (recursion-limit fix,
   adversarial-task fix) were superseded by this session's work but could not be withdrawn
   (already running under the founder's own control) — watch for possibly-redundant PRs from
   them and reconcile against what's already merged here if they land.
