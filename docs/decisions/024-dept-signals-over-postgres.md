# ADR-024 — Durable cross-department signals over Postgres (Phase 4)

- **Date:** 2026-06-14
- **Status:** Accepted
- **Branch:** `feat/phase4-dept-signals` (stacked on `feat/phase2-typed-contracts`)
- **Follows:** [ADR-022](022-typed-interdept-contracts.md) (typed payloads), [ADR-023](023-claude-as-judge.md)

## Context

The `dept_signals` table existed (schema ready) but had **zero callers** — the
advisor doc proposed a BullMQ/Redis broker for cross-agent coordination. For a
single-operator system that is over-engineering (rule #17). The genuine need:
let one department *discover* something now and have a different department *act*
on it later, durably, without holding state in a single graph run.

## Decision

**1. Durable async over Postgres, not BullMQ/Redis.** A signal is a row in
`dept_signals` (rule #15: Postgres for durable, queryable state). Production
reuse of the already-present `publishDeptEvent` / `consumePendingEvents` — no new
infrastructure, no broker, no Redis (consistent with ADR-021's Redis-deferral).

**2. Typed at the boundary (ADR-022).** `publish_signal` validates every payload
with `validateSignalPayload` before the write; an invalid payload is rejected
with the contract error and never persisted. The handoff carries a typed object,
not a prose dump (rule #21).

**3. The signal surfaces work; it never performs it.** The exemplar flow:
research ICP-scores a prospect → `publish_signal(lead_discovered)` → durable row
→ hourly `sweepDeptSignals` consumes it (atomically marked consumed = exactly
once) → proactive Telegram nudge listing the typed lead. The founder then runs
the **HITL-gated** outreach via the normal sales path. The cron consumer
deliberately does **not** invoke the office or auto-send: a headless cron context
can't host the gateway's interrupt/resume loop, and faking an HITL flow there
would violate rule #4. Surfacing-not-acting keeps the exactly-once guarantee
simple and the human gate intact.

**4. `publish_signal` is not HITL-gated.** It's an internal coordination write
with no external side effect (no email/post/push of its own), so it carries no
approval gate — unlike every outbound tool.

## Verification

- Pure logic unit-tested: `prepareSignal` (contract validation + default target
  dept + provenance) and `formatLeadNudge` (render, plural, non-lead filter,
  never-auto-sends copy). 1008 tests green · tsc clean.
- **LIVE-VERIFIED on real Postgres** (`docker-postgres-1`): publish → row persisted
  (UUID returned) → `consumePendingEvents` returns the lead → nudge rendered
  (`🎯 New qualified lead (1) • ProbeCo · ICP 91 · via probe …`) → **second consume
  returns 0** (atomic exactly-once). Outbound send remains founder-gated.

## Consequences

- `dept_signals` now has a real writer + consumer; the scaffolded table is live.
- Durable, decoupled coordination demonstrated without a broker — senior judgment
  documented (deliberate non-adoption of BullMQ/Redis).
- Next: Phase 5 (one nested `revenue` supervisor over {marketing, sales}, RED-first
  nested-HITL integration test, gated on live MTProto verification; wires the
  ADR-022 `stateSchema` channel that was deferred to its first real reader).
