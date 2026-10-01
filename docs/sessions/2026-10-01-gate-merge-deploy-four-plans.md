# 2026-10-01 — gate, merge and deploy of the four plans (#777 → beta, #778 → main)

## What we did

Gated PR #777 at Full depth (`pr-adversary`), merged it into `beta` (`d779e69c`), promoted `beta`
to `main` through #778 (`3feeebfa`), watched the deploy (run 36872319495, 1m45s, both steps green)
and verified production. No blocker was found, so no code changed. The verdict and evidence are in
the PR #777 comment; the rollback is in the #778 body.

What was checked, and where it ran:

- `pnpm ci:quality` exit 0 and `verify:doc-claims` 6/6 on the merged tree.
- `pnpm test` on macOS: 6,561 pass, 25 fail, all in the seven bash-daemon files (bash 3.2, BSD
  `date`). The same SHA on CI (Linux): 508/508 files. `tests/unit/scripts` on the VPS: 28 files, 577/577.
- Mac client `pytest` on Playwright 1.49.1 (the pin): 340 passed.
- A throwaway `pgvector/pgvector:pg16` container on the VPS: migrations 0000–0042 (43 rows); the real
  seed on a copy of the prod `founder_context` row removed exactly four June keys and a second run
  changed nothing; `goals-postgres.test.ts` 30/30.
- After the deploy, on prod: `HEAD` = merge commit, service restarted 13:56:57Z, migration ledger 42 rows
  with max `1790685051955`, goals tables present, all five daemon files byte-identical to the merge commit
  in `~/bin` (with `~/bin/lib`), both crons registered in `Asia/Kolkata`, boot catch-up `nothing-due`,
  `goals-standup --dry-run` "no open goals", `jobhunt-findings-check` "would file nothing", and the first
  14:00Z cron tick of both daemons clean.

## What we fixed

Nothing in code. Findings that are not defects of #777, each recorded in the brain:

- Prod's migration ledger has no row for `0040_ats_board_cache` (`when` below 0039's), though the table
  exists; harmless to 0042, whose `when` is above the ledger maximum.
- The VPS `date` is uutils coreutils 0.8.0, not GNU; the daemons' tests pass on it.
- Gmail and Calendar are down on prod (`gws` token: `invalid_grant`), identical at the previous boot, so
  `/health` reports `degraded`. Not caused by this deploy.

## Why

The VPS gate (pr-brain) is paused by the Claude weekly usage limit until 2026-10-05 06:00 UTC, so this
review was the only gate. The daemon tests cannot run on macOS, so they were gated on the VPS from a
scratch export with a scratch `HOME`, and the migration and seed were rehearsed against a throwaway
Postgres instead of prod.

## Metrics

| | |
|---|---|
| PR | #777: 222 files, +30,778 / −576, 87 commits promoted |
| Tests | 6,586 TypeScript (CI 508/508 files), 577 daemon (VPS), 340 Mac client, 30 goals on real Postgres |
| Deploy | 1m45s; ledger 41 → 42 rows |

## Outstanding

- The 09:30 jobhunt check is on by default (`SELF_IMPROVE_DISPATCH_ENABLED` defaults to `"true"`) and can file an
  `agent:ready` issue unattended. On today's data it would file nothing. Stop switches are in the #778 body.
- Founder facts the seed did not date read "⚠ date unknown" and nothing can re-date them (no `/confirm`).
- The claim-time check on the VPS verifies the nine headings only; file existence is checked on `/task` and
  auto-filed issues.
- Not verified: `ps` showing no Gemini key during a live Antigravity run (queue empty), the first real 09:00
  standup and 09:30 check, "Plan next step" on a live model, the planner prompt line (`pnpm eval`, paid),
  the Mac client on a live employer form, and the real Telegram path (no tester session).
