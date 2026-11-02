# AG-052 — VPS cleanup: stray processes, failed units, unused containers and tables

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-052.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-vps-cleanup`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: infra, prod data.
**Moves:** none directly. It removes noise that hides real failures.

Read [STANDARDS.md](STANDARDS.md), `.claude/rules/prod-vps.md` and `~/.claude/skills/production-ready/SKILL.md` first.

## Goal

The VPS runs only what FounderOS uses, and anything left over is reaped by code, so the health line in AG-051 means
something.

## Problem (measured 2026-10-08)

- 5 MCP hub processes left over from closed laptop sessions.
- 5 failed `fos-job@` units in `systemctl --failed`.
- 5 containers. One of them, `jolly-babbage-job-tracker`, has no known owner.
- 7 cron lines. Some may duplicate systemd timers.
- 43 database tables against the 20 in CLAUDE.md: 7 are empty, and 1 is a leftover backup table.
- 43 of 75 GB of disk used.

## Expected behavior

1. **Inventory first.** In the PR body, list every process, unit, timer, cron line, container and table with its
   owner, either the file that creates it or "unknown". Unknown items get a founder question in the PR, not a deletion.
2. **Reap stray hubs in code.** The hub process exits when its stdio peer closes, and a watchdog line in
   `deploy/watchdog.sh` kills hub processes older than 12 h with no peer. Find why they outlive the session first:
   SSH ControlMaster, `nohup`, or no stdin EOF handling in `src/mcp/hub-server.ts`.
3. **Failed units.** Read each failed unit's journal and name its cause. Then `systemctl reset-failed` through a deploy
   step, not by hand. If the cause is a code bug, fix it here or file it in the plan's §9.
4. **Cron.** Each job lives in one place: cron or a systemd timer, not both. Deploy installs cron (`crontab -l` before
   and after).
5. **Tables.** No drops here. List the 7 empty tables and the backup table for AG-058, with their row counts and the
   code that reads them (grep).

## Files in scope

`deploy/watchdog.sh`, `deploy/sync-daemons.sh`, `deploy/systemd/`, `deploy/vps-daemons/`, `src/mcp/hub-server.ts`,
tests in `tests/unit/scripts/` and `tests/unit/mcp/`.

## Constraints

- Never edit `/opt/founderos`. Changes reach the VPS through deploy. Read-only commands over `ssh founderos-vps` are
  fine.
- Never stop or remove `jolly-babbage-job-tracker`. Ask the founder.
- A database backup (`deploy/backup-db.sh`) runs before any deploy that touches units.

## Explicitly forbidden

- Dropping tables. That is AG-058.
- `docker system prune`, or any blanket delete.

## Verification commands

```bash
pnpm gate
ssh founderos-vps 'systemctl --failed --no-legend | wc -l; pgrep -fc hub-server; docker ps --format "{{.Names}}"; crontab -l'
```

## Acceptance criteria

- The inventory table in the PR body.
- After deploy: 0 failed units, at most 1 hub process per live laptop session, and no duplicate cron jobs. Paste the
  command output above.
- A unit test proves the hub exits when stdin closes.
