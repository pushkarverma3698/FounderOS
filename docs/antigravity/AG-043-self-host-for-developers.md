# AG-043 — Self-host install for developer friends

**Source:** [docs/plans/2026-10-08-daily-driver-plan.md](../plans/2026-10-08-daily-driver-plan.md) goal 5.
**Depends on:** nothing.
**Branch:** `feat/self-host-install`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full (deploy, secrets handling). Follow `~/.claude/skills/production-ready/SKILL.md`.
**Moves:** unfreeze (founder approved 2026-10-08). Needs the `unfreeze` label.

## Goal
A developer with a fresh Ubuntu 24.04 VPS, their own Telegram bot token, their own Telegram user id, a GitHub token and one model API key gets their own FounderOS running in under an hour by following one doc and running one script. Each friend runs their own instance; there is no shared multi-tenant service and none of the founder's data or tokens are involved.

## What already exists (do not rebuild)
- `deploy/deploy.sh`, `deploy/sync-daemons.sh`, systemd units in `deploy/systemd/`, `scripts/apply-prod-env-overrides.sh`, `.env.example` (check how complete it is), `src/core/config.ts` (Zod config; at its 400-line budget).

## Expected behavior
1. `deploy/install.sh`: idempotent bootstrap for a fresh box. Installs Node 22, pnpm, Postgres, jq, ffmpeg, gh; creates the service user(s); clones the repo to a path the operator chooses; runs migrations; installs the systemd units and daemon crontab via the existing scripts; refuses to continue with a clear message when a required env var is missing. Re-running it changes nothing.
2. `docs/SELF-HOST.md`: prerequisites, the env vars that are required vs optional (grouped: core, Telegram, GitHub, models, optional Google/Antigravity), the install command, how to verify (`/where`, a plain question, `systemctl is-active`), and what does not work without optional pieces.
3. `.env.example` lists every env var `src/` and `deploy/` read, with a one-line comment each, no real values. A unit test fails when code reads an env var that `.env.example` doesn't list (scan `process.env.X` and `${X}` in deploy scripts; allowlist runtime-only vars like `HOME`, `PATH`).
4. `docs/self-host-hardcodes.md`: an inventory of founder-specific values still in code (repo allowlist in `src/tools/dispatch-repos.ts`, chat ids, owner names, domain names, the `pushkarverma3698` owner in defaults) with file:line and the proposed config move. Do not move them in this PR except where a value already has an env override and the default is founder-only (then make the default empty and fail loud at boot).

## Constraints
- No real tokens, chat ids or personal data in any file (the repo is PUBLIC).
- Don't change prod behavior: the founder's VPS keeps working with its current `.env` (anything newly required must already be set there; if unsure, don't make it required — list it in NOT VERIFIED).

## Verification commands
- Failing test first for the env-example check.
- `bash -n deploy/install.sh`, `shellcheck` if available, and a dry run in a throwaway `docker run --rm ubuntu:24.04` container if Docker is available on the Mac (note in the PR if it isn't).
- `pnpm lint && pnpm verify:arch && pnpm verify:doc-claims` + touched tests.

## Acceptance criteria
- A fresh container reaches "config invalid: <missing var>" or a running service with dummy values, shown in the PR.
- PR body: What changed · How it was verified · NOT VERIFIED, `Moves: unfreeze`, label `unfreeze`.
