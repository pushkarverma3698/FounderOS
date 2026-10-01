# 2026-10-01 — four plans, one branch: dispatch hardening, dated context, goals standup, jobhunt last mile

## What we did

The four `docs/plans/2026-09-29-*.md` plans existed only as documents on four branches
(`claude/fix-dispatch-loop-hardening`, `claude/fix-chat-context-truth`,
`claude/feat-goals-daily-standup`, `claude/feat-jobhunt-tashi-and-findings`). They were
implemented, reviewed and merged in that order into one branch, together with the one audit
line from `claude/jolly-babbage-wkueh5` that had missed #751.

Eight agents worked in separate git worktrees on disjoint file areas; a ninth finished the Mac
client. The integrator (this session) reviewed each diff, finished the branches two usage-limit
cut-offs left incomplete, wrote the cross-branch tests, closed one seam in the Mac client (a page's
own scripts could name any handler through the new event binding), and ran the full gate on the
merged tree.

| Plan | What it does now |
|---|---|
| Dispatch loop | Every Antigravity failure is classified (quota / auth / transient / unknown) from the tail of the log and ends in one Telegram message with the fix. The Gemini key travels on stdin, never argv. A brief missing any of the nine template sections, or naming a file that does not exist, is rejected before the approval card (`/task`) and at claim time (human-filed issues). `pnpm repo:add`, `pnpm branch:new`, `deploy/onboard-repo.sh`. The VPS daemons deploy with the app and a mismatch fails the deploy. pr-brain can use a long-lived token instead of the interactive login. |
| Chat context | Every `founder_context` value carries the date it was last confirmed (`context_meta`); anything older than 30 days, or undated, is rendered with a warning and the planner is told to state its date or ask. June's seed defaults are retired. `/focus` and `/projects` set them with no model call, owner-only. |
| Goals | `/goal add … | metric=… target=… by=…`, a 09:00 standup measured from real data (applications, merged PRs, issues, action_log, manual) with zero LLM calls, exactly-once and crash-safe, with a boot catch-up. "Plan next step" runs the normal planner, owner-only. Migration `0042_goals.sql`. |
| Jobhunt | Dead boards (10 consecutive 404s) stop being polled, persisted, re-probed weekly. Her precision noise is cut. The Mac client opens the employer's form, reads Dutch labels, presses a Dutch send button on her tap, and records an application only from a success signal or her explicit confirmation: a form that navigates away on submit is asked about on the new page ("Did the application go through?"), never assumed. A read-only capture tool saves a real apply page's DOM so a SmartRecruiters field map can be written (never run on a real site). A daily 09:30 check turns jobhunt faults into at most one GitHub issue (zero LLM) and always sends a Telegram line. SuccessFactors spike written. |

## What we fixed

Plan defects found while building, each now corrected and tested:

- The `/task` formatter filed 7 of the 9 template sections, so the new intake gate would have rejected every `/task`. It now files all nine; the real formatter output is run through both the TypeScript lint and the daemon's check.
- The plan reused the `update_context` guard for `/focus`, which would have let a guest in an allow-listed group (the kernel does not know who is typing) overwrite the founder's focus. Only the owner-only commands can write those two keys.
- Migration `when` timestamps in the drizzle journal are not monotonic (0040 < 0039), the mechanism by which a migration is silently skipped on an already-migrated DB. 0042 is greater than every earlier entry and a test pins it.
- The standup claimed its row before sending, which loses a day if the process dies in between, and node-cron does not catch up a 09:00 swallowed by a deploy restart. Two-phase claim with a lease, and a boot catch-up.
- The failure classifier would have matched `401`/`500` anywhere in an Antigravity transcript. It reads only the tail and anchors to status contexts.
- A sourced helper (`deploy/lib`) must ship with the daemons or both refuse to start; the deploy step covers it and a test pins it.
- The Mac client defaulted to "applied" after 1.2 s of silence (against its own ADR-018 comment), lost a submit that navigated the page, and told her to press SKIP, which deletes the row. Fixed; a CI test parses `overlay.js` and fails if any other path records "applied".
- The new watcher's event binding (`window.founderosEvent`) is exposed to every script in the employer's page, and the name a caller passes picked a handler on the host, `decision` (the one that records an outcome) included. It was safe only because that handler takes a second argument the event path never supplies. Only the two names the overlay sends are routed now; the rule is pinned in the Python suite and, because that suite is not in CI, as text assertions in `overlay-never-submits.test.ts`.
- The plan's "85 of 126 employers are on SuccessFactors" was already corrected to 7 by the 2026-09-08 audit.

## Why

Every failure in the dispatch loop ended in a log line or a terminal label, the chat quoted June's
plan as current, there was no goal object anywhere, and Tashi had 62 actionable NL roles in 30 days
and 0 recorded applications. The design rule throughout: code decides what is measured, when it runs
and what is deduplicated; the model proposes only when asked.

## Metrics

- Tests: 5,146 on `main` (445 files). The final counts on the pushed head (TypeScript, and the Mac client's Python suite, which CI does not run) are in the PR description, measured after the last merge: a number written into a session note is stale the moment the head moves.
- Real Postgres, not mocks: migration 0042 on top of 0041 (43 rows, second run idempotent); 30 goals integration tests; the founder_context seed run twice (second run writes nothing); the standup run twice (second run sends nothing).
- In-process Telegram real path (real `registerHandlers`, real access control, real DB): context 13 checks, goals 16 checks, every guest command and button refused.
- Issue #762's verbatim body is rejected by both the daemon and the TS lint (missing Evidence and Constraints; three files that do not exist).
- `shellcheck` warnings unchanged (1 and 3); every new script 0.

## Outstanding

See the PR description ("Outstanding from your end"). In short: remove `ISSUE_REPOS` from the VPS crontab; rotate the Gemini key; send `/focus` and `/projects`; add the first goal; SmartRecruiters needs a real apply-form DOM, captured with `tools/capture_apply_form.py` on a machine whose browser trusts its network (the sandbox browser cannot verify the proxy certificate and the trust-store change was refused, so that stays the founder's call); the guest-tool gap is documented, not closed; NOT VERIFIED against prod: everything that needs the VPS, live Telegram, GitHub Actions or her laptop.

Two things the brief asked for that were not done as written:

- `feat/ind-sponsor-discovery` was **not deleted**. The brief called it junk files, but besides `names.csv`, `names.txt` and `ddg_test.html` it holds two commits (tip `59247bb`, never in a PR) with about 770 lines of unmerged B2B recruiter-discovery code and two new dependencies, and nothing equivalent is on `main`. Deleting is one command if that is still the wish: `git push origin --delete feat/ind-sponsor-discovery`.
- The non-dry `jobhunt-import-sponsor-boards.ts --employers` import was not run (the plan said dry-run only).

Known limits of the Mac client, stated so nobody finds them by surprise: a page change *before* she presses SUBMIT & NEXT (a link, a second step) still leaves no bar (stop with Ctrl-C and start again; recorded outcomes are on disk); `requirements.txt` pins Playwright 1.49.1 and everything here was tested on 1.56 (the calls used are long-standing, but 1.49.1 was not run); beforeunload dialogs, captchas and real navigation timing on a live form were not exercised; and the button SUBMIT & NEXT presses is the first matching control on the whole page, not one scoped to the form it filled (unchanged by this work, but the new Dutch send words are generic enough to label a share or newsletter form too; a form the browser itself would refuse to submit is still never pressed, and the press happens only on her tap).
