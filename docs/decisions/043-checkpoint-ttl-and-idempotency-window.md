# ADR-043 — Checkpoint TTL Sweep + Opt-in Idempotency Window

**Status:** Accepted · **Date:** 2026-06-29 · **Branch:** `claude/founderos-roadmap-uhod8d`

## Context

The "Honest Improvement Roadmap" flagged four P0 items. An audit of the current
code (not the roadmap's assumptions) found **two already shipped** and **two real
gaps**:

| Roadmap P0 | Real state on `main` + S3 merge | Action |
|---|---|---|
| #1 Budget guard / kill switch | **Already shipped** — `src/infra/budget.ts` (`BudgetTracker` + `BudgetGuardCallback`, per-run token+$ caps), `src/infra/halt.ts` (file-flag kill switch, fail-safe), `src/infra/daily-budget*.ts` (daily cap + 80/100% Telegram alerts). | Audited, no change. |
| #2 Idempotency key audit | Key was `prefix:tenant:sha1(content)` — tenant + content but **no time window**. | **Fixed** (this ADR). |
| #3 Checkpoint growth | `clearThreadCheckpoints(threadId)` existed (per-thread, `/reset`), but **no time-based TTL sweep** across threads. | **Fixed** (this ADR). |
| #4 Personal blast radius | `path-guard` confines to `$HOME`; `flagDangerousCommand` flags destructive patterns; **every** shell/write/browser op is HITL-gated. | Audited; an explicit command **allowlist** (vs the current denylist+HITL) is deferred — see "Deferred". |

## Decision 1 — Opt-in time-bucketed idempotency (`recurringIdemKey`)

**The naive "add a time bucket to every key" is a bug, not a fix.** `idemKey` serves
two purposes with opposite requirements:

- **HITL-resume idempotency** (shell, claude_code, github, mcp, email, linkedin,
  gcal): when `interrupt()` fires, the tool throws and re-runs from the top after
  the founder approves — possibly *hours* later. The key must be **byte-identical
  across that gap** so the post-approval `hasBeenAudited` check skips the second
  execution. A time bucket here would change across an approval that crosses
  midnight → the action **re-executes → double-send** (exactly the "too narrow"
  failure the roadmap warns about).
- **Legitimately-repeatable scheduled sends** (a weekly newsletter, a monthly
  report with identical copy): a permanent key means the same content can *never*
  be re-sent (the "too broad" failure).

So `idemKey()` stays **time-invariant** (the correct, resume-safe default; every
existing call site is unchanged and audited safe). A new **opt-in**
`recurringIdemKey(prefix, granularity, ...parts)` appends a UTC `timeBucket`
(`day`/`week`/`month`) — for **non-interactive scheduled senders only**, which
fire-and-audit with no human approval gap. Documented constraint in code: never
use the windowed variant behind an `interrupt()`.

Both failure directions are pinned by unit tests (`tests/unit/agents/hitl.test.ts`):
- resume-safety: `idemKey` identical across a 23:59→00:01 midnight-crossing gap;
- within-window dedupe holds; next-window identical content gets a fresh key.

## Decision 2 — Daily checkpoint TTL sweep (`sweepStaleCheckpoints`)

`agents.checkpoints` grows one row per turn per thread, forever — a silent storage
+ query-latency tax. New `sweepStaleCheckpoints(maxAgeDays)` (`src/infra/checkpointer.ts`):

- Staleness = the thread's **latest** checkpoint `ts` (ISO string LangGraph always
  writes in the `checkpoint` JSONB; Postgres tracks no insert time). An active
  conversation is never truncated mid-stream.
- Reuses the already-tested `clearThreadCheckpoints` per stale thread, so
  `checkpoint_blobs`/`checkpoint_writes` never orphan.
- Defensive: missing table → logs + returns zeros (a maintenance sweep must never
  crash the cron loop); rejects `maxAgeDays <= 0` (guards an accidental wipe-all);
  interval is **parameterized**, never string-interpolated.
- Wired into `src/infra/scheduler.ts` as a daily 3:30am cron. Retention window =
  `CHECKPOINT_TTL_DAYS` (default 30; bad value falls back to 30, never disables).

## Verification (this branch, this session)

- `pnpm lint` (tsc --noEmit) — **clean, exit 0**.
- `pnpm test` — **1606 passed (158 files)**, up from 1590 baseline (+16 tests),
  zero regressions.
- New tests: 11 in `hitl.test.ts` (timeBucket + both idempotency failure
  directions), 4 in `checkpointer-reset.test.ts` (sweep), 4 in `scheduler.test.ts`
  (`getCheckpointTtlDays`).

**NOT live-verified (named gap, per Accountability Protocol):** this remote
environment has **no Postgres, no Docker, no API keys**. The SQL sweep against a
real `agents.checkpoints` table and any live LLM/Telegram path were **not run**.
All evidence here is the mocked unit suite ($0, the cost-gate's endorsed primary
loop). Live verification (real DB row-count before/after a sweep) is required on
the VPS before this is counted "production-done".

## Deferred (with reasons)

- **P0 #4 command allowlist:** shell is already HITL-gated on *every* exec +
  path-guarded + dangerous-pattern flagged. A hard allowlist is a more invasive
  security-model change (risks breaking legitimate builds/git ops) and earns its
  own ADR + live QA — not bundled here.
- **P1 Creative department (image-gen + nested pod):** requires a **paid** Gemini
  image API and keys absent from this env. Per rules #19/#23 I cannot claim it
  "works" without a live run, so it is **not** scaffolded-and-claimed here. It is
  the recommended next PR, with budget-gating (Flash default, Pro on explicit
  "final asset") routed through the freshly-merged S3 `agent_assets` layer.
- **P2/P3/P4** (cost attribution, model-split, eval expansion): need live
  LangSmith / `pnpm eval` runs — milestone-gated, not doable in this offline env.
