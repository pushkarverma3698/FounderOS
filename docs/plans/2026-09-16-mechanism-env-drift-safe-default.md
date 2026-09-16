# Mechanism fix — env preservation on deploy, inverted to a safe default

**Theme:** 4 — config/env drift on deploy, 8 independent instances
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md))
**Status:** implementation plan, not yet built

## Problem

`scripts/apply-prod-env-overrides.sh`'s `PRESERVE_IF_MISSING` is an allowlist: anything not
explicitly named is dropped the next time `.env` is re-rendered on deploy. Every fix to date has
been reactive — add one more variable to the list after it's already gone missing in prod
(`WORKER_AGENT_MODEL`, `MCP_BRIDGE_ENABLED`, `PERSONAL_CV_DIR`, `EVOLUTION_PERSIST_FINDINGS`, across
five separate months). Separately but same theme: `pnpm brain:sync` reads whatever `.env` is in the
current working directory, so running it from a worktree or the laptop silently writes to a local
Postgres and prints `✅ Sync complete` — a true statement about the wrong database
(flagged live in `CLAUDE.md`'s Automated Brain Sync section as of this session).

## Approach

Two separate fixes, same theme:

1. **Invert the allowlist.** Change `apply-prod-env-overrides.sh` so any key present in the current
   prod `.env` is preserved by default across a re-render, unless explicitly named in a new, small
   `INTENTIONALLY_DROP` list (rare — a key being deliberately retired). This flips the failure mode:
   an unlisted key now survives by default instead of vanishing by default.
2. **Make `brain:sync` refuse to report success against the wrong database.** Before writing,
   resolve the target host from `DATABASE_URL` and compare against an expected pattern (the VPS
   brain host, from a documented constant/env var). If it doesn't match, either refuse to run
   (require an explicit `--i-know-this-is-local` flag for intentional local testing) or print a
   loud, unambiguous warning distinguishing "wrote to local Postgres" from "wrote to the VPS brain"
   — never a bare `✅ Sync complete` that doesn't say which database.

## Files likely in scope

- `scripts/apply-prod-env-overrides.sh` — invert the list logic
- `scripts/sync-turicks-brain.ts` — host-check before reporting success
- `docs/ops/ENV-VARS.md` — document the new default-preserve behavior

## Out of scope

- Not attempting to auto-detect *which* variables are safe to drop — that stays a human decision
  via the new explicit `INTENTIONALLY_DROP` list.
- Not changing how `.env` itself is sourced/loaded elsewhere in the app — scoped to the deploy
  render step and `brain:sync`'s host check only.

## Verify

```bash
# Simulate a re-render with an unlisted key present; confirm it survives
bash scripts/apply-prod-env-overrides.sh --dry-run   # flag may need adding if it doesn't exist
```
For `brain:sync`: run once with a local `DATABASE_URL` and confirm it now refuses or clearly labels
itself as local, not a silent VPS-equivalent success message.

## Next step

Turn into an AG-NNN dispatch brief once prioritized. This one touches the deploy pipeline directly —
recommend extra scrutiny/manual review given the blast radius (a bad `PRESERVE_IF_MISSING` inversion
could itself cause a prod outage), consistent with this repo's "prod VPS access... verify before
destructive commands" discipline.
