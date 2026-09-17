# Mechanism fix — real-path verification as a required field, not a convention

**Theme:** 8 — verification stops at a tool-call/SSH shortcut, never proves the real path, 9
independent instances, the best-evidenced pattern in the corpus
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md))
**Status:** implementation plan, not yet built

## Problem

`scripts/telegram-probe.ts` (built 2026-09-16) makes one-shot real-path verification cheap, and it
already caught a live bug (the fallback-chain starvation) on its first real use. But nothing
requires anyone to run it. Issue #687, dispatched the same day the tool shipped, specified
`pnpm test && pnpm typecheck` as its only acceptance criteria — no real-path check at all. The tool
existing doesn't change behavior; only a requirement does.

## Approach

1. **PR template.** Add a required section to the repo's PR template (or `STANDARDS.md`'s review
   checklist) — "Real-path verification: <command + output>" or explicit
   **NOT VERIFIED — reason**. `pr-brain`'s gate (per `CLAUDE_REVIEWER_INSTRUCTIONS.md`) checks for
   this field's presence and treats a silently-missing one as at minimum a NON-BLOCKER finding
   (founder's call whether it should be a hard BLOCKER).
2. **Antigravity brief template.** `.github/ISSUE_TEMPLATE/agent-task.md`'s "Acceptance criteria"
   section gets a required sub-field for the verification command — this closes the exact gap
   issue #687 fell into, and every AG-NNN brief written from now on (including the six issue #687
   splits filed alongside this plan) should model this explicitly rather than rely on convention.
3. **Cheap default probe.** For anything touching the Telegram-facing path, `telegram-probe.ts` (or
   a similarly-scoped lighter probe for non-Telegram work) becomes the default suggested command in
   the template, not something the author has to know to reach for.

## Files likely in scope

- `.github/pull_request_template.md` (or wherever this repo's PR template lives — confirm path)
- `.github/ISSUE_TEMPLATE/agent-task.md`
- `docs/antigravity/CLAUDE_REVIEWER_INSTRUCTIONS.md` — extend `pr-brain`'s check
- `docs/antigravity/README.md` § "Before you dispatch" — already referenced as the checklist to
  extend, per this repo's existing convention

## Out of scope

- Not making real-path verification mandatory for every PR regardless of scope (a pure docs change,
  for instance, has nothing to real-path-verify) — the requirement is: state one, or say why none
  applies. Silence is what's disallowed, not "NOT VERIFIED."

## Verify

Manually inspect the next 3 PRs opened after this ships — each should have a real-path verification
field, either filled or explicitly marked NOT VERIFIED with a reason. No automated test for a
template/process change; this is a process mechanism, verified by observing it hold over the next
few PRs (matching how the ActiveEnterTimestamp convention was verified in Theme 3 — it held on every
check since introduction).

## Next step

Turn into an AG-NNN dispatch brief once prioritized. Low code risk (template/doc changes plus a
`pr-brain` prompt extension) — good candidate to do early, since it makes every other mechanism
fix's own PR more trustworthy once it exists.
