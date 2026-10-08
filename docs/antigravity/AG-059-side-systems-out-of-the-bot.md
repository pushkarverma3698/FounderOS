# AG-059 — Jobhunt, evolution, goals and video out of the bot process

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-059.
**Depends on:** AG-053 (the registry is how the bot still reaches these as tools).
**Branch:** `task/issue-<N>-side-systems-out`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: process lifecycle, cron, messages sent on the founder's behalf.
**Moves:** A (a smaller core) and C (jobhunt keeps running).

Read [STANDARDS.md](STANDARDS.md), `.claude/rules/prod-vps.md` and `~/.claude/skills/production-ready/SKILL.md` first.

## Goal

The Telegram bot process does chat: commands, the loop and approvals. Jobhunt, the evolution self-audit, goals and
standups, and video run on their own schedule as separate jobs. Their crash, slow run or memory use can no longer stall
a reply.

## Problem (measured)

- `src/tools/jobhunt` is 22,402 lines (23% of `src/`). 12 files in `src/gateway/` import jobhunt, evolution or goals
  code (`grep -rln "evolution/\|jobhunt/" src/gateway`).
- `src/infra/scheduler.ts:306-362` registers 11 `cron.schedule` jobs inside the bot process. Two of them run every
  minute.
- `src/index.ts:32,119` runs the goal standup catch-up at boot.
- The 86 restarts from 10-01 to 10-07 (AG-037) each reset these in-process schedules too.

## Expected behavior

1. **Inventory.** For each of the 11 cron jobs: what it does, its runtime, whether it sends anything, and whether it
   must run in-process (only if it needs the bot's live grammy instance). Paste the table in the PR.
2. **Move out.** Each job that does not need the live bot becomes a `fos-job@` job (`deploy/job-run`) or a systemd
   timer, with `node dist/jobs/<name>.js` as its entry. It sends Telegram messages through the Bot API with the
   existing token, the way `deploy/lib/tg-quiet.sh` does.
3. **Tools stay.** The jobhunt, goal and video tools stay in the registry so the founder can still ask for them in
   Telegram. Only the schedules and background loops leave the process.
4. **Gateway.** Jobhunt and goal callback handlers stay, since they answer taps. Instruction or sender-profile code
   that only the moved jobs use moves with them.
5. **Evolution self-audit.** If no founder-visible output came from it in the last 14 days (check `action_log`), turn
   its schedule off and say so in the PR. Do not delete the code here.

## Files in scope

`src/infra/scheduler.ts`, `src/index.ts`, `src/jobs/` (new entry points), `deploy/systemd/`, `deploy/job-run`,
`src/gateway/` (imports only), tests.

## Constraints

- Every moved job keeps its schedule (IST times unchanged) and its idempotency.
- Journey B (`scripts/journey-jobs-group.ts`) passes before and after.
- The wife's group chat keeps getting the same jobhunt messages (Telegram 8924092987 in group -5319642142).

## Explicitly forbidden

- Deleting jobhunt features.
- Changing what any job sends.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/infra tests/unit/tools/jobhunt
ssh founderos-vps 'systemctl list-timers --no-pager | grep fos'
```

## Acceptance criteria

- The bot's RSS memory before and after, from `ps` on prod. Paste both.
- The morning journeys, including B, stay green for 2 days after deploy.
- `grep -c "cron.schedule" src/infra/scheduler.ts` is down to the jobs that need the live bot. Paste the number.
