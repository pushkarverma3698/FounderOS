# Roadmap Execution — 2026-06-29

Execution log for the "Honest Improvement Roadmap". One branch
(`claude/founderos-roadmap-uhod8d`), based on **latest `main` + the S3
asset-storage layer** (merged from `claude/s3-asset-storage-uyfwjv`).

Skipped by founder directive: **P0 #4** (shell command allowlist).

## Evidence table — what was done and how it was verified

| Item | Status | Verification |
|---|---|---|
| **Branch/base** | ✅ | Merged S3 branch onto latest main; lockfile regenerated; `pnpm test` 1590 green baseline. |
| **S3 migration bug** | ✅ FIXED + LIVE | `0010_agent_assets` was unregistered in the Drizzle journal → table never created. Registered it; **real Postgres**: `migrate` exit 0, `\d agents.agent_assets` now shows the table + indexes. |
| **P0 #1 budget guard / kill switch** | ✅ ALREADY SHIPPED | Audited `budget.ts` + `halt.ts` + `daily-budget*.ts`. No change. |
| **P0 #2 idempotency window** | ✅ DONE + LIVE | Opt-in `recurringIdemKey`/`timeBucket`; resume-safe default kept. **Real Postgres**: D1 resume-dedup (no double-send across midnight), D2 cross-window (legit repeat allowed). Unit: 11 tests, both failure directions. |
| **P0 #3 checkpoint TTL sweep** | ✅ DONE + LIVE | `sweepStaleCheckpoints` + daily 3:30am cron. **Real Postgres**: BEFORE 4 rows (STALE 2/ACTIVE 2) → sweep purges 1 thread/2 rows → AFTER STALE 0, ACTIVE 2. Unit: 4 tests. |
| **P0 #4 allowlist** | ⛔ SKIPPED | Per founder directive. |
| **P1 Creative department** | ✅ BUILT + PARTIAL-LIVE | Nested Creative Director over art_director/copywriter/brand_designer; image-gen (Flash default, Pro gated); asset lifecycle via S3. **Live**: graph compiles w/ `CREATIVE_SUBGRAPH=1`; brand-asset DB layer returns real rows. **Not live**: paid image call + S3 upload + routing (no key). |
| **P2 #9 cost attribution** | ✅ DONE + LIVE | `getCostByDepartment` + cost-per-task formatter. **Real Postgres**: aggregates real `ai_call_costs` rows (creative $0.144/2, research $0.000135/1; cost/task $0.048). |
| **P2 #10 model split** | ✅ DONE | `getWorkerModel`; supervisor strong, workers cheap via `WORKER_AGENT_MODEL`. Default == primary. Unit-tested. |
| **P2 #11 context** | ✅ DONE (deterministic part) | Opt-in `preserveTaskAnchor` stops silent early-task loss; test reproduces the bug + proves the fix. Full LLM summary-buffer deferred (needs a key). |
| **P3 #12/#13 creative eval** | ✅ DONE | `CREATIVE_GOLDEN_TASKS` incl. budget-bypass adversarial; merged into eval only when flag on. |
| **P3 #14 judge** | ✅ ALREADY SHIPPED | `judgeOutbound` wired in `comms.ts` before send. Audited. |
| **P4 scaling discipline** | ✅ DOCUMENTED | ADR-044: nest-only-on-6+, ~10–20 specialists, cost-per-task scoreboard, MCP-for-sharing-only, keep `createSupervisor`. |

## The environment constraint (named, not hidden)

This Claude-Code-on-the-web container has **no `.env`** — no
`GOOGLE_GENERATIVE_AI_API_KEY`, no `OPENROUTER_API_KEY`, no `LANGCHAIN_API_KEY`,
no `DATABASE_URL`. Proven empirically (the Gemini API returned
`400 API_KEY_INVALID`). So:

- **Live DB verification WAS possible** — a real PostgreSQL 16 was stood up
  in-session with `initdb` (+ `pgvector`), migrations applied, and the DB-backed
  work verified against it with real before/after row counts.
- **Live LLM/image/Telegram verification was NOT possible** — no key. Everything
  LLM-dependent (paid image gen, creative routing, `pnpm eval`, MTProto QA) is
  flagged NOT-VERIFIED and gated OFF by default so production is unchanged.

## Final-step runbook (on the VPS, where the keys live)

```bash
# 1. Apply the new migration journal entry (creates agent_assets if missing)
DATABASE_URL=... node node_modules/drizzle-kit/bin.cjs migrate

# 2. Enable the creative dept + (optional) cheaper workers, then eval routing
export CREATIVE_SUBGRAPH=1
export GOOGLE_GENERATIVE_AI_API_KEY=...        # Nano Banana
export WORKER_AGENT_MODEL=openrouter:google/gemini-2.5-flash-lite   # optional split
pnpm eval                                       # now includes the 5 creative tasks

# 3. Live MTProto QA of a creative request through the real gateway
npx tsx scripts/telegram-tester.ts send "make a draft launch graphic for the X feature"

# 4. (Optional) enable task-anchor on long-thread departments + re-eval
#    preserveTaskAnchor is opt-in per agent in office.ts middleware.
```

## Test totals

`pnpm test`: **1638 passed / 162 files** (baseline 1590 → +48 across all items).
`pnpm lint` (tsc --noEmit): clean. Full live-DB evidence is in the commit messages
and ADR-043/044.
