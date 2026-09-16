# Issue #687 resolution plan

**Status:** implementation plans written and committed; GitHub issue creation and `agent:ready`
labeling NOT yet done — pending founder go-ahead (see "Pending action" below).

## What happened

Issue #687 (`fix: resolve 6 core system anomalies`) was created 2026-09-16T17:44:32Z from a real
`read_logs` pass — confirmed via the raw Telegram transcript
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md)
Part 2): the founder relayed the bot's own "Mission analysis complete" text and asked for it to
become a GitHub issue dispatched to Antigravity. It carries the `agent:failed` label — the
dispatcher could not verify a PR landed after Antigravity ran.

## Root cause of the failed dispatch (not previously known)

**4 of the 6 file paths named in issue #687's "Files or subsystem in scope" section don't exist in
this repo** — confirmed by direct `ls`/`grep`: `src/integrations/google`, `src/kernel/runner.ts`,
`src/models/provider.ts`, and `src/eval/judge.ts` are all absent. Only `src/tools/jobhunt/
tailor-cv.ts` (item 5) was correct as written; `src/telemetry/langsmith.ts` (item 6) is also absent
— LangSmith config, if it exists at all here, lives in `src/infra/telemetry.ts`. A brief built on
unverified paths is a plausible, concrete reason a single atomic dispatch covering 6 unrelated
subsystems failed — Antigravity had to spend its attempt discovering the real files instead of
fixing the bugs, across 6 different areas at once.

This is itself an instance of the pattern this whole audit is about (Theme 2/6): the brief-authoring
step skipped verification. Rule #36 in `CLAUDE.md` (added this session) exists to stop this from
recurring — a brief's "files in scope" should be confirmed to exist before the brief is written, not
only before the fix is claimed done.

## Resolution: split into 6 independently-dispatchable briefs

One brief per anomaly, each with real (verified) file paths, each scoped so a failure in one doesn't
block the other five, each carrying a real-path verification requirement in its own Verify section:

| Brief | Anomaly | Grounding |
|---|---|---|
| [AG-014](../antigravity/AG-014-oauth-invalid-grant-handling.md) | Gmail/GCal OAuth `invalid_grant` | Real files found; exact call site needs executor discovery |
| [AG-015](../antigravity/AG-015-kernel-timeout-checkpointing.md) | Kernel 300s timeout / abort / HITL row | **Best-grounded** — this is B5+B6+B7 from the morning audit, exact file:line citations already exist |
| [AG-016](../antigravity/AG-016-fallback-residual-check.md) | 503/fallback exhaustion | Likely **already fixed** by PR #683 same day — brief's first job is confirming that, not writing new code |
| [AG-017](../antigravity/AG-017-judge-nemotron-defensive-parsing.md) | Judge crash on Nemotron | Real file found; "dead again" phrasing flags a possible prior unfixed recurrence to check first |
| [AG-018](../antigravity/AG-018-tailor-cv-slop-check-fix.md) | `tailor_cv` silent plain-text fallback | Real file confirmed; this is also a Theme-1 fail-open instance |
| [AG-019](../antigravity/AG-019-langsmith-pii-scrubbing.md) | LangSmith PII scrubbing | File path was wrong; real integration point needs confirming, may just be env-var config, not a bespoke module |

## Pending action (not done — requires founder go-ahead)

1. Comment on issue #687 explaining the split (link this doc), then close it as superseded — closing
   a fabricated-scope issue rather than leaving it `agent:failed` forever, matching how #677/#678
   were closed rather than left open.
2. File AG-014 through AG-019 as 6 new GitHub issues, each satisfying
   `.github/ISSUE_TEMPLATE/agent-task.md`'s template (the brief content above maps directly onto it).
3. Apply `agent:ready` to each once filed, so the existing `agent-dispatch` cron (VPS, `*/15`) picks
   them up per the normal issue-driven loop
   ([docs/antigravity/ISSUE-DRIVEN-CONTRACT.md](../antigravity/ISSUE-DRIVEN-CONTRACT.md)).

This wasn't done automatically in this session because creating GitHub issues with a label that
triggers autonomous execution against the live repo is a consequential, hard-to-reverse action —
six briefs firing at once warrants one explicit confirmation rather than being bundled silently into
"write the implementation plans."

## Suggested priority if going one at a time instead of all six

AG-015 (Tier-0 in the morning audit, best-grounded) first; AG-016 second since it may turn out to be
a zero-code "close as already fixed" (cheap to confirm); the remaining four in any order — none
blocks another.
