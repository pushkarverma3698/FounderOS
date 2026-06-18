# ADR-035 — Daily Budget Guard (Universal Cost Control)

**Status:** Accepted · **Date:** 2026-06-17

## Context

Every operator running autonomous AI agents faces the same problem: **runaway LLM spend**.
FounderOS already had:

- Per-run caps (`RUN_BUDGET_USD`, `RUN_BUDGET_TOKENS`) enforced via `BudgetGuardCallback`
- Daily cap env var (`BUDGET_DAILY_USD`, default $5) documented in `.env.example`
- `getTodayCostUsd()` query on `ai_call_costs`

But **`BUDGET_DAILY_USD was never enforced`** — a busy day could accumulate unbounded
cost while only single-invoke caps applied. The schema comment referenced a
"cost_watchdog" that was never wired.

This is not Turicks-specific. Any FounderOS user (and any future SaaS tenant) needs
daily spend visibility + hard stops.

## Decision

Wire the daily cap end-to-end:

| Layer | Change |
|-------|--------|
| `src/infra/daily-budget.ts` | Pure assess/gate/format functions + `DailyBudgetExceededError` |
| `office-run.ts` | Check daily spend **before** every `office.invoke()` (new turns + HITL resume) |
| `/budget` | Dashboard: daily vs cap, per-run caps, 7-day breakdown by agent/model |
| `/status` | One-line budget summary |
| Scheduler | Hourly 80%/100% Telegram alerts (deduped per day via `founder_context`) |
| Monday brief | Skip LLM call when daily cap already reached |

## Why this boundary

- **Reuses existing data** — `ai_call_costs` table, no new migrations
- **Deterministic gate** — pure function check before invoke; no prompt instruction
- **Fail loud** — blocked runs surface clear Telegram message with `/budget` hint
- **Scales to SaaS** — tenant-scoped query + env cap; multi-tenant billing can swap cap source later

## Alert deduplication

Threshold alerts (80%, 100%) fire at most once per threshold per calendar day.
State: `founder_context.budget_alerts_sent = { date, levels: [80, 100] }`.

## Consequences

- Operators must set `BUDGET_DAILY_USD` intentionally — default $5/day
- HITL resume is also gated (approved sends can't bypass daily cap)
- Extractable later as standalone npm package (roadmap item, now partially unblocked)

## Verification

```bash
pnpm test tests/unit/infra/daily-budget.test.ts
pnpm lint && pnpm test
```
