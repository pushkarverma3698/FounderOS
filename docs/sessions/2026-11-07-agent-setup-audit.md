# 2026-11-07 — Agent setup audit (Mac, VPS, phone sessions)

## What we did
- Moved process out of always-loaded rules into on-demand skills: `ship` (Lite), `production-ready` (Full), `pr-adversary`, `work-the-tracker` (scripts#63). Hooks and CI enforce; prose rules keep only facts and hard limits.
- Telegram noise: the reaper writes to the journal, Blocked rows are no longer re-sent daily, and "did not start" is sent at most once a day (claude-agent-setup#32). The jobs lane stays quiet when the 09:30 check is clean, and the sweep alive ping fires at most once a day (FounderOS#1270).
- Verdict and tracker: one numbered "Needs you" list per project (#34), `tracker add` from the phone (#35), and `tracker unblock` to answer a Blocked row (#36).
- Ended the 11-01 PR freeze; `Checked first:` stays (FounderOS#1271). Promoted to main in #1272, deployed 13:47 UTC.
- Retired the PR digest routine (scripts#62). Dropped the two idle Oplify Remote Control servers (scripts#64).

## What we fixed
- BachelorHouse stalled: 6 rows sat in Blocked with no way back to Ready. They were turned into leftover claims with `tracker unblock`.
- Hung-bot watchdog was dead: the founderos crontab called `~/bin/founderos-watchdog.sh`, which no longer existed. The crontab now runs `/opt/founderos/deploy/watchdog.sh`.
- Phone sessions stayed stopped after a usage limit until someone typed. `rate_limit` was added to the StopFailure wake matcher (scripts#65, claude-agent-setup#37).
- Every session start printed `not a valid identifier` from re-declaring desktop-app env names (claude-agent-setup#38).
- `guard-bash` now judges each command of a chain on its own (claude-agent-setup#33).

## Why
The setup is meant to finish work while the founder is on his phone. Each of these either stopped work silently (Blocked rows, usage limits, a dead watchdog) or buried the one message that needed him under routine pings.

## Metrics
- "Needs you" on BachelorHouse: 12 → 6 rows.
- Usage-limit stops that waited for a human: 59 in the 8 days before the fix.
- VPS disk: 77% → 70% after pruning the docker build cache.
- A fresh VPS session (alt account) lists all four process skills.

## Outstanding
- Remote Control sessions started before 13:42 UTC keep the old wake matcher until they restart.
- The VPS main account hit its weekly limit; it resets 00:00 UTC. Routines run on the alt accounts.
- A fresh `claude -p` run on the Mac was not checked: the CLI in the agent sandbox reports "Not logged in". The skill files exist and load in the desktop app.
