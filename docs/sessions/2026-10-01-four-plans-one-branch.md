# 2026-10-01 — four plans, one branch: dispatch hardening, dated context, goals standup, jobhunt last mile

## What we did

The four `docs/plans/2026-09-29-*.md` plans existed only as documents on four branches
(`claude/fix-dispatch-loop-hardening`, `claude/fix-chat-context-truth`,
`claude/feat-goals-daily-standup`, `claude/feat-jobhunt-tashi-and-findings`). They were
implemented, reviewed and merged in that order into one branch, together with the one audit
line from `claude/jolly-babbage-wkueh5` that had missed #751.

Eight agents worked in separate git worktrees on disjoint file areas; a ninth finished the Mac
client. The integrator (this session) reviewed each diff, finished the branches two usage-limit
cut-offs left incomplete, wrote the cross-branch tests, and ran the full gate on the merged tree.

| Plan | What it does now |
|---|---|
| Dispatch loop | Every Antigravity failure is classified (quota / auth / transient / unknown) from the tail of the log and ends in one Telegram message with the fix. The Gemini key travels on stdin, never argv. A brief missing any of the nine template sections, or naming a file that does not exist, is rejected before the approval card (`/task`) and at claim time (human-filed issues). `pnpm repo:add`, `pnpm branch:new`, `deploy/onboard-repo.sh`. The VPS daemons deploy with the app and a mismatch fails the deploy. pr-brain can use a long-lived token instead of the interactive login. |
| Chat context | Every `founder_context` value carries the date it was last confirmed (`context_meta`); anything older than 30 days, or undated, is rendered with a warning and the planner is told to state its date or ask. June's seed defaults are retired. `/focus` and `/projects` set them with no model call, owner-only. |
| Goals | `/goal add … | metric=… target=… by=…`, a 09:00 standup measured from real data (applications, merged PRs, issues, action_log, manual) with zero LLM calls, exactly-once and crash-safe, with a boot catch-up. "Plan next step" runs the normal planner, owner-only. Migration `0042_goals.sql`. |
| Jobhunt | Dead boards (10 consecutive 404s) stop being polled, persisted, re-probed weekly. Her precision noise is cut. The Mac client opens the employer's form, reads Dutch labels, and records an application only from a success signal or her explicit confirmation. A daily 09:30 check turns jobhunt faults into at most one GitHub issue (zero LLM) and always sends a Telegram line. SuccessFactors spike written. |

## What we fixed

Plan defects found while building, each now corrected and tested:

- The `/task` formatter filed 7 of the 9 template sections, so the new intake gate would have rejected every `/task`. It now files all nine; the real formatter output is run through both the TypeScript lint and the daemon's check.
- The plan reused the `update_context` guard for `/focus`, which would have let a guest in an allow-listed group (the kernel does not know who is typing) overwrite the founder's focus. Only the owner-only commands can write those two keys.
- Migration `when` timestamps in the drizzle journal are not monotonic (0040 < 0039), the mechanism by which a migration is silently skipped on an already-migrated DB. 0042 is greater than every earlier entry and a test pins it.
- The standup claimed its row before sending, which loses a day if the process dies in between, and node-cron does not catch up a 09:00 swallowed by a deploy restart. Two-phase claim with a lease, and a boot catch-up.
- The failure classifier would have matched `401`/`500` anywhere in an Antigravity transcript. It reads only the tail and anchors to status contexts.
- A sourced helper (`deploy/lib`) must ship with the daemons or both refuse to start; the deploy step covers it and a test pins it.
- The Mac client defaulted to "applied" after 1.2 s of silence (against its own ADR-018 comment), lost a submit that navigated the page, and told her to press SKIP, which deletes the row. Fixed; a CI test parses `overlay.js` and fails if any other path records "applied".
- The plan's "85 of 126 employers are on SuccessFactors" was already corrected to 7 by the 2026-09-08 audit.

## Why

Every failure in the dispatch loop ended in a log line or a terminal label, the chat quoted June's
plan as current, there was no goal object anywhere, and Tashi had 62 actionable NL roles in 30 days
and 0 recorded applications. The design rule throughout: code decides what is measured, when it runs
and what is deduplicated; the model proposes only when asked.

## Metrics

- Tests: 5,146 on `main` (445 files) → see the PR for the final count on the merged branch (6,516 in 506 files at the last full run, plus the Mac client's 259 Python tests).
- Real Postgres, not mocks: migration 0042 on top of 0041 (43 rows, second run idempotent); 30 goals integration tests; the founder_context seed run twice (second run writes nothing); the standup run twice (second run sends nothing).
- In-process Telegram real path (real `registerHandlers`, real access control, real DB): context 13 checks, goals 16 checks, every guest command and button refused.
- Issue #762's verbatim body is rejected by both the daemon and the TS lint (missing Evidence and Constraints; three files that do not exist).
- `shellcheck` warnings unchanged (1 and 3); every new script 0.

## Outstanding

See the PR description ("Outstanding from your end"). In short: remove `ISSUE_REPOS` from the VPS crontab; rotate the Gemini key; send `/focus` and `/projects`; add the first goal; SmartRecruiters needs a fixture captured on a machine whose browser trusts its network; the guest-tool gap is documented, not closed; NOT VERIFIED against prod: everything that needs the VPS, live Telegram, GitHub Actions or her laptop.
