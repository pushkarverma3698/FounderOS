# Daily QA — Regression & Stress

Run these **every day on `beta`** before promoting to `main`.

## Commands

| Command | What it runs | Typical time |
|---------|--------------|--------------|
| `pnpm regression:daily` | Full gate stack + live verifies + health boot | ~15–25 min |
| `pnpm regression:daily -- --skip-live` | Offline half (CI / no API keys) | ~5 min |
| `pnpm stress:daily` | Founder session simulation (12 tasks, real LLM) | ~10–20 min |
| `pnpm stress:daily:quick` | 6 core stress tasks | ~3–8 min |
| `pnpm qa:daily` | Regression then stress (full daily soak) | ~25–45 min |

## What regression covers

1. Postgres ping + `pnpm run setup`
2. `pnpm lint` + `pnpm verify:wiring` + `pnpm test`
3. `pnpm test:integration` (optional `--skip-integration`)
4. Phase verifies: `verify:beta`, `verify:p2`, `verify:p3`, `verify:p456`
5. Live gates (unless `--skip-live`):
   - `verify:p456:live` — signal tx + schema counts + hierarchy trace
   - `verify:p3:live` — CTO handoff isolation
   - `P2_LIVE_APPROVE=0 verify:p2:live` — engineering HITL interrupt only (no GitHub write)
6. `daily-health-probe.ts` — office compile + `/health` curl

## What stress covers

Simulates a founder session through the **real Postgres checkpointer**:

- Morning routing / agenda
- Research (`search_web`)
- Engineering read + **HITL-paused** write (never approved)
- Personal read + **security block** (`~/.ssh/id_rsa`)
- Shared-thread multi-turn recall
- Marketing draft (HITL pause)
- Direct `/q` routing
- Session summary

**PASS** = `PASS`, `HITL`, or `BLOCKED` (correct behaviour). **FAIL** = unexpected interrupt, errors, or validation miss.

## Reports

JSON artifacts land in `/tmp/founderos-qa/`:

- `latest-regression.json`
- `latest-stress.json`
- `latest-daily.json` (master suite)

Override dir: `DAILY_QA_REPORT_DIR=/path pnpm qa:daily`

## Prerequisites

- Postgres running: `sudo pg_ctlcluster 16 main start`
- `.env` with `DATABASE_URL` + live LLM key (`OPENROUTER_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`)
- For engineering subgraph stress: `ENGINEERING_SUBGRAPH=1` (set in `stress:daily` script)

## Not covered (manual)

- **MTProto Telegram round-trip** — needs `TELEGRAM_TESTER_SESSION`. Run:
  `node --env-file=.env --import tsx/esm scripts/e2e-telegram-qa.ts run group1`
- **Full 40-task live probe** — weekly: `node --env-file=.env --import tsx/esm scripts/probe-live-qa.ts`

## Promotion checklist

```bash
sudo pg_ctlcluster 16 main start
pnpm qa:daily
# Review /tmp/founderos-qa/latest-daily.json — ok must be true
# Then open beta → main PR
```
