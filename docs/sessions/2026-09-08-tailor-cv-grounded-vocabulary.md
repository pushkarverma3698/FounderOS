# 2026-09-08 — tailor_cv grounded vocabulary

## What we did

Fixed the binding constraint on the jobhunt supply→apply pipeline: `tailorCv()`
fabricated technologies not on the base CV, and `verifyCvClaims` correctly
blocked every one of those PDFs. Prod measurement going in: 22 tailoring
attempts, 21 `tailor_status='failed'`, 2 applications ever sent.

Root cause was the prompt, not the guard. It handed the model every JD skill
term under "JD KEYWORDS TO HIGHLIGHT (ONLY IF TRUTHFUL TO BASE CV)" and left
the model to sort truthful from fabricated. Measured against the real KPN "AI
Engineer - Network" row (the one that produced two different live fabrications
on 2026-09-07 — "Vector Database", then "ETL"): 7 of 11 JD terms were absent
from the base CV and went in anyway. `/jobs` had already printed those same 7
as "Not on your CV" for that row — the system knew and asked the model to
guess right anyway.

## What we fixed

- `src/tools/jobhunt/tailor-cv.ts`: prompt now sends a **closed**
  `PERMITTED TECHNOLOGY VOCABULARY` (every term `extractSkillTerms` finds in
  the base CV, union of the profile's dictionary and the default tech one) and
  a `NOT ON THIS CV` list the model is told never to write. A fabrication that
  survives that gets **one repair round** naming the exact offending claims
  from the guard's own violation list, re-verified by the same
  `verifyCvClaims`. The guard's strictness is untouched — a fabrication that
  survives the repair round is still a terminal, named failure.
- `src/tools/jobhunt/cv-claim-summary.ts` (new): `describeClaimViolations()`,
  a compact, kind-grouped summary ("technology: ETL, Java (+2 more)") instead
  of joining five full log-style sentences. Split out of `cv-claim-guard.ts`
  to stay under the 400-line CI budget.
- `src/gateway/jobhunt-commands.ts` + `src/tools/jobhunt/telegram-format.ts`:
  `/draft`'s failure message truncated the guard's reason with a bare
  `.slice(0, 200)`, cutting a claim mid-word (prod: `... [technology] "TD)`)
  and hiding the rest of the fabricated list — the one actionable part of the
  message. New `truncateAtWord()` backs up to the last word boundary instead.

## Why

CLAUDE.md rule #26 (outcome, not instruction): a guard that blocks 21 of 22
attempts isn't a working pipeline, it's a wall with a sign on it. The fix had
to move the fabrication rate, not the guard's strictness — loosening
`verifyCvClaims` to pass more CVs would trade a blocked application for a
fabricated one sent to a real employer, which CLAUDE.md rule #26 and the task
brief both name explicitly as the worse failure.

## Metrics

- Real KPN row, real base CV, one live paid call (`founderos-vps`, isolated
  `/tmp` clone, never `/opt/founderos` or `/opt/review/founderos`): **success,
  zero forbidden terms leaked**, repair round observed firing once and fixing
  the one ungrounded claim the model still produced under the new prompt.
- `pnpm gate`: 347 test files, 3811 tests, exit 0.
- 5 new tests in `tests/unit/jobhunt/tailor-cv-grounding.test.ts` (RED before
  the fix — reproduces the KPN fabrication shape with a mocked worker), 3 new
  `truncateAtWord` tests, 3 new `describeClaimViolations` tests.

## Outstanding

- **NOT VERIFIED — real Telegram.** `TELEGRAM_TESTER_API_ID`/`_API_HASH`/
  `_SESSION` are still absent (confirmed again this session: no `.env` on the
  laptop worktree, no tester session on the VPS review checkout either). The
  live-call proof above is SSH/direct tool-level execution against the real
  prod row and CV — not proof the planner routes to `tailor_cv` correctly or
  that the founder's real Telegram reply renders as expected. Ask: run
  `scripts/telegram-tester.ts login` once, or have the founder run `/draft` on
  a live queued row himself to close this gap for good.
- `pnpm eval` was not run — N/A by inspection, not by skip: this diff touches
  only `src/tools/jobhunt/{tailor-cv,cv-claim-guard,cv-claim-summary,
  telegram-format}.ts` and one call site in `jobhunt-commands.ts`; no planner,
  supervisor, or `capabilities.ts` file changed, so routing/tool-selection
  cannot have regressed.
- PR: https://github.com/pushkarverma3698/FounderOS/pull/634 (branch
  `claude/fix-tailor-cv-grounded-vocabulary`) — CI green on push, awaiting the
  PR-triggered rerun and founder review/merge.
