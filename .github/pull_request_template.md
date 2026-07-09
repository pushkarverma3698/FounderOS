<!--
FounderOS PR template. Keep it honest — tick a box only with evidence.
Full checklist: docs/rules/CODE-REVIEW-CHECKLIST.md
-->

## What & why

<!-- One or two lines: what this changes and the problem it solves. -->

## Failing test first (v3 invariant #2)

<!-- For bug fixes: name the test that reproduced the bug BEFORE the fix (file + test name),
     or state why a repro test is impossible. A fix with no prior red test does not merge. -->

## Checklist

- [ ] `pnpm gate` green (tsc + tests)
- [ ] `pnpm verify:arch` green (no new architectural debt; baseline may only shrink)
- [ ] Behaviour change checked against `pnpm eval` (routing/tool/HITL not regressed) — or N/A
- [ ] No hardcoded secrets; no `console.log` in `src/` (boot `console.error` excepted)
- [ ] Errors fail loud (surfaced to founder), no swallowed errors or fake "Done."
- [ ] HITL gate covers any new external side effect (email/LinkedIn/GitHub/file) — or N/A
- [ ] Idempotency guard precedes any new external send; audit row only on real success — or N/A
- [ ] New run-loop branches emit a seam (`trace.event`); new seam added to the `Seam` union — or N/A
- [ ] Pure logic (routing/slicing/guards/parsing) is a unit-tested function, not a prompt instruction
- [ ] Every fixed bug has a regression test on the real gateway path
- [ ] "Why" comments on non-obvious functions
- [ ] **Docs synced** (CLAUDE.md rule #18): New ADRs, phase docs, or decisions → run `pnpm brain:sync` — or N/A

## Observability impact

<!-- New seams, traces, metrics, or none. -->

## Verification (real path, not just unit tests — CLAUDE.md #19)

<!-- How you exercised the live path. Paste the bot reply + matching/absent action_log row. -->

## Rollback plan

<!-- How to revert if this misbehaves in production. -->
