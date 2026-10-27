# Handoff 2026-10-11: OpenDots — 60-min shifts, free idle shifts, agy fallback

**Status:** Superseded by [2026-10-13-opendots-simplify.md](../sessions/2026-10-13-opendots-simplify.md) (2026-10-27).

Branch `claude/chore-opendots-migration` (PR #1120 → beta). Previous session compacted twice; start fresh here.
Background: `docs/sessions/2026-10-11-opendots-team-shift.md`.

## Founder decisions (2026-10-11)
1. Shift interval 60 min (`SHIFT_SECONDS=3600` in `deploy/opendots/setup-dots.sh`, rerun it on the VPS).
2. Build free idle shifts: a "No work" shift must not call the paid Dot model.
3. Build an agy fallback in `team-shift`: when claude hits its usage limit, run agy instead of blocking.
4. Budget: $10 OpenRouter for the whole month. Prompts stay small; no "senior engineer" text in Dot prompts.

## Build order (each: failing test first in `tests/unit/scripts/opendots-team-shift.test.ts`)
1. Interval: `SHIFT_SECONDS=3600`, rerun `setup-dots.sh`, read back the 3 shift tasks' interval. 10 min.
2. Free idle: read the OpenDots scheduler (`/opt/opendots/app/src/server`, read-only) first. Recommended shape: host
   cron runs `docker exec <role computer> team-shift <role>` every 15 min; on any output other than "No work" it
   triggers the role's shift task (`POST /api/tasks/<id>/actions run`, owner token read inside ssh only) or posts the
   output to the Dot's conversation. Pause the OpenDots-scheduled shift tasks so nothing runs twice. Alternative: a
   patch adding a pre-check command to scheduled tasks. Note: once idle is free, 15 min costs the same as 60 when
   idle; tell the founder and let him pick. 1-2 h.
3. agy fallback: in team-shift's `*)` branch, when the last output shows a usage limit, start agy on the same item
   with the same brief instead of `block`. Read `~/Projects/prompts/brain-doer-division.md` for the agy dispatch
   syntax. Only Builder and Reviewer computers have an agy login; Architect still blocks. agy has no per-tool
   allowlist like claude's, so the role limits rely on the prompt + gh token: say so in the PR. 1 h.

## Verify (live, sandbox `pushkarverma3698/opendots-sandbox` only)
- Idle: one cron tick with no queued items → 0 OpenRouter calls (OpenRouter activity unchanged).
- Work: label a sandbox issue `agent:plan` → the cron wakes the Architect → plan posted.
- agy: fake the limit (test fake run-bg exit + usage-limit text) in unit tests; live only if a real limit hits.

## Rules
Never print/echo the OpenDots OWNER_TOKEN or any token. Never change OpenRouter settings or the model. Never
touch `/opt/founderos`. Stage explicit paths. `--dangerously-skip-permissions` was refused: do not reintroduce.

## Still NOT VERIFIED from the last session
Dot-driven start → collect cycle; 90-min limit and lost-run restart live; a CHANGES round under team-shift;
PR #1120 CI after commit 65c437ac.
