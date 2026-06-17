# ADR-034 — Proof Drop Pipeline (Phase D-Bis GTM)

**Status:** Accepted · **Date:** 2026-06-17

## Context

Phase D-Bis GTM prioritizes **Proof Drops** — 2–3 high-craft custom launch artifacts per week sent to the 30-account AI/dev-tool target list (`docs/strategy/03-GTM-ACQUISITION-ENGINE.md`). FounderOS already had:

- `/target` + `/outbound` — ICP scoring (research-only, no HITL)
- `/run outbound` — generic cold email workflow

Missing: a **structured pipeline** that connects research → artifact concept → personalized Proof Drop outreach with cadence tracking and typed cross-department signals.

## Decision

Ship a **Proof Drop Pipeline** reusing existing workflow + signal infrastructure:

| Layer | Change |
|-------|--------|
| Workflow | `proof_drop` in `workflows/registry.ts` — 4 steps: ICP gate → research → artifact concept → HITL email |
| Command | `/proofdrop <company>` — shortcut that runs the workflow + logs completion |
| Tracking | `proof_drop_log` in `founder_context` JSONB — weekly cadence vs target of 2 |
| Signal | `proof_drop_ready` typed contract — marketing → sales async nudge via hourly sweep |
| Scheduler | Wednesday 9:05am cadence nudge when below weekly target (zero LLM) |

## Why this boundary

- **No new department** — reuses research, marketing, sales via existing workflow runner
- **No new table** — cadence log lives in `founder_context` like `outbound_targets`
- **HITL unchanged** — only `send_email` at the final step requires approval
- **ICP gate in step 1** — stops low-fit companies before burning tokens on artifact design

## Artifact types (creative brief only)

The workflow produces a **concept brief**, not a built site:

- `hero_redesign` — cinematic landing hero mock description
- `launch_teaser` — scroll narrative outline
- `brand_motion` — WebGL/motion concept

The founder executes the craft; FounderOS orchestrates discovery + outreach.

## Consequences

- `/commands`, `/start`, and scheduler docs reference `/proofdrop`
- `contracts.ts` gains `proof_drop_ready` — registry test enforces parity
- Wednesday scheduler job replaces generic mid-week outbound nudge with Proof Drop cadence

## Verification

```bash
pnpm test tests/unit/outbound/proof-drop.test.ts
pnpm test tests/unit/agents/contracts.test.ts
pnpm test tests/unit/infra/scheduler.test.ts
```
