# AG-051 — Five daily journeys and one morning health line

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) §5, task AG-051.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-daily-journeys`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite. It becomes Full if you change the cron install path in `deploy/`.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

Every morning the founder gets one Telegram message that says whether FounderOS can do his 5 daily asks, and what is
about to break: credits, quotas, logins. This becomes the gate for every other task in the plan.

## Problem (measured)

- Each PR proves its own fix. Nothing runs the founder's real asks daily. The Google account mix-up fixed in #1031 was
  live from the day a second account was added until 10-08.
- 3 of the 4 blockers on 10-08 were outside services running out: the AI Studio 402, the OpenRouter key limit, and the
  Claude weekly limit. Each was found only when a reply failed.
- Journeys A, B and C already exist: `scripts/journey-where.ts`, `scripts/journey-jobs-group.ts`,
  `scripts/journey-coding.ts`, with helpers in `scripts/lib/journey-*.ts` and MTProto in `scripts/lib/mtproto.ts`
  (`connect`, `probePeer`, `sendAndCollect`).
- PR #1002 holds a `telegram-probe.ts` fix that never merged. Take it into this PR.

## Expected behavior

1. **`scripts/journey-daily.ts`** runs J1 to J5 from the plan's §5 table, plus the existing A to C, as the founder over
   MTProto. Each journey gets a pure scorer in `scripts/lib/journey-score.ts` that compares the reply with the real
   source:
   - J1, J2: run `gws` directly for the work account.
   - J3: GitHub REST.
   - J4: the `issues` and job rows in Postgres.
   - J5: the `reminders` table.
   No model call scores anything.
2. **J4 cleans up after itself.** It closes the issue it opened and cancels the job, and its title starts with
   `journey ` so the dispatch daemons can skip it if needed.
3. **Health line**, a pure function over these reads:
   - OpenRouter `/api/v1/credits` (balance only).
   - The AI Studio key (one-token call).
   - Claude CLI `claude -p ok --max-turns 1` as `claude-agent`: exit status, plus the reset time if limited.
   - One `gws` profile read per Google account in `src/core/accounts.ts`.
   - `systemctl --failed` count, and daemon status.
   - Yesterday's spend from the budget ledger, next to `BUDGET_DAILY_USD`.
4. **One message** at 08:00 IST via cron on the VPS: score `5/5 + A-C`, one line per red journey with the reason, then
   the health line. Split the message rather than drop a row (#26).
5. **Results stored** in `journey_runs` (check whether an existing table fits first), so a 7-day streak can be counted.

## Files in scope

`scripts/journey-daily.ts`, `scripts/lib/journey-score.ts`, `scripts/lib/health-line.ts`, `scripts/telegram-probe.ts`,
the cron line in `deploy/vps-daemons` or wherever journey C's cron lives today (grep it), tests in
`tests/unit/scripts/`.

## Constraints

- Scorers and the health line are pure functions with fixture tests. I/O happens only in the entry script.
- One run costs one turn per journey, about 12 turns a day. Print the credit delta at the end of each run.
- J4 runs only on FounderOS's own repo.

## Explicitly forbidden

- Using a model to judge replies.
- Sending anything except the one report, and J4's own issue, on the founder's behalf.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/scripts
```

## Acceptance criteria

- Fixture tests: each scorer passes a right reply and fails a wrong one. The health line marks a 402 or a limited CLI
  as red.
- One live run from `/opt/review/founderos-eval` on the VPS. Paste the full morning message.
- The cron line is installed by deploy, not by hand. Show `crontab -l` after deploy.
