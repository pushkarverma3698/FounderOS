# 05 — Risks, Gates and Invariants

## Governance — how this plan may change

**No vision documents. No architecture passes.** Every future change must originate from exactly
one of three sources:

1. **Measured production telemetry**
2. **A concrete founder pain point**
3. **A business KPI that is not improving**

This rule is part of the plan. Violating it is a defect.

*(Origin: eight design passes produced zero shipped code. The 20% self-improvement cap applies to
the design process itself.)*

## Invariants — the things that must never break

| # | Invariant | Enforced by |
|---|---|---|
| I1 | **No LLM in the scheduler.** Routing, ranking and dispatch are pure, unit-tested code | Review + `verify:arch` regex-routing rule |
| I2 | **Events never route.** A consumed signal becomes *planner input*, never a routing decision | Fitness rule (post-crossover): consumer may import the kernel entry point only |
| I3 | **Only code emits signals**, after a written audit row. A signal is a projection of the audit log | M4 single tool boundary |
| I4 | **Autonomy ends at a green PR.** Nothing self-merges | Branch protection + M-R risk classes |
| I5 | **Safety rails are founder-only.** Missions touching `verify-architecture.ts`, HITL sets in `capabilities.ts`, or CI config are always founder-merge | Fitness rule (M6) |
| I6 | **Every mission produces an asset**, or fails acceptance | Constitution rule 2, checked at collect |
| I7 | **20% self-improvement cap.** `business_id = founderos` missions ≤20% of spend/time per rolling 30 days; past it, proposals queue | Executive Engine (M1) |
| I8 | **Every rate carries its N.** No success percentage is ever shown or used for routing without sample size and a Wilson lower bound | Intelligence Engine (M2) |
| I9 | **Tombstones stay dead.** `office.ts`, `pre-router.ts`, domain subgraphs must never return | `verify:arch` R6 (already live) |
| I10 | **Temp-0 determinism.** Plan variation comes from strategy prompts, never temperature | CI runs the golden set twice expecting identical plans |

## Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| **Design loop never ships** (8 passes, 0 files) | **Realized** | **Critical** | Design frozen; governance rule above; M0.5 started 2026-08-06 |
| M0.5 started late → 2-week measurement delays M6's proof | High | Med | **Started day 1**, in parallel, before any code |
| System optimizes itself, never ships business value | High | Critical | I7 — 20% cap, Executive-enforced |
| Founder review becomes the bottleneck | High | High | M-R risk-classed merge; track PRs-awaiting-founder weekly |
| Hierarchy over-built before ventures exist | Med | Med | Thin keys only; no Portfolio/Org/Product tables until N≥3 |
| Intelligence Engine learns confident noise from tiny N | High | High | I8 — Wilson bounds + N + ε-greedy (non-negotiable) |
| Policy derived from too few instances becomes dogma | Med | High | Policy requires N observations **plus founder ratification** before becoming a fitness rule |
| Prediction/Simulation built on thin data discredits the system | Med | High | Deferred until ≥1 quarter of outcomes |
| Evolution ships regressions | Med | High | No self-proposed merge without a before/after number |
| Self-construction edits its own safety rails | Low | **Critical** | I5 |
| Antigravity output outruns verification | High | High | Read `git diff` + re-run verify; **never** accept its summary |
| M4 regresses a side-effecting tool (double-send) | Med | High | Batches of 3; per-tool regression test; live-verify each gated tool once |
| Migration applied but inert in prod | Med | High | Recorded gotcha: a stale drizzle journal makes migrations inert. Verify applied state; **never hand-apply to prod** |
| VPS contention with the live bot | Med | Med | Cadence ladder, not daemons; measure p95 turn latency before/after |

## Verification gates

Every node must pass **all** of these before it is called done.

0. **Baseline (2026-08-06):** `tsc --noEmit` clean · `verify:arch` green at baseline ·
   `pnpm test` **238 files / 2,498 tests / 0 failures / 15.03s**.
1. `pnpm gate` green; ratchet must not rise; tombstones intact.
2. **M0a:** the self-audit independently re-derives findings found by hand — dead `missions` API,
   5 unused deps, orphaned `src/outreach`, unwired `COMPANY_PROFILES`. *If it cannot re-derive a
   known-true finding, the sensor is wrong and everything downstream is untrustworthy.*
3. **M0b:** a live turn creates a `missions` row linked to a `problem` with `business_id`, advances
   phases, and writes an outcome row carrying a KPI reference — **verified by querying prod, not by
   reading logs.**
4. **M1:** the 20% cap demonstrably queues a self-improvement mission when breached.
5. **M2:** profiles reproduce `bench/metrics.ts` scores on a replayed mission set; every rate carries N.
6. **M5:** a derived policy becomes a live fitness rule that fails CI on violation.
7. **M6 — the real one:** a capability the Evolution Engine proposed, built and shipped moves a
   **business KPI or a number in [M0.5-FOUNDER-TIME-LOG.md](M0.5-FOUNDER-TIME-LOG.md)**.
   Until that number exists, the Evolution Engine is **unproven** and must be described that way.

## Evidence discipline

"Done" means the verification command was run fresh in the same session with output shown.
Unit tests are necessary, not sufficient — exercise the real path (gateway → kernel → tool → reply →
DB row) before claiming anything works. **Unverifiable ⇒ say "NOT VERIFIED — reason".**

## Currently NOT verified

- No VPS/prod state inspected during the 2026-08-06 audit.
- `langsmith` dependency: may activate via env without an import — check before removing.
- All effort estimates are estimates, not measurements.
