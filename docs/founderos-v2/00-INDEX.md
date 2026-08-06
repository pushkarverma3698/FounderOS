# FounderOS V2 — Venture Operating System

**Status:** design **FROZEN** (v8, 2026-08-06) · build in progress
**Identity:** FounderOS is an Executive Intelligence System — *a system that converts founder intent
into executed, measured outcomes across a portfolio of ventures.*

> **FounderOS is not the product. It is the internal operating system. The product is everything it
> builds.**

## Documents

| # | Doc | What it holds |
|---|---|---|
| 01 | [CODE-AUDIT](01-CODE-AUDIT.md) | Evidence-based audit. Code as source of truth; docs treated as untrusted |
| 02 | [TARGET-ARCHITECTURE](02-TARGET-ARCHITECTURE.md) | Venture OS layering, Constitution, capability-first design, what's deferred and dropped |
| 03 | [BACKLOG-GRAPH](03-BACKLOG-GRAPH.md) | The work as data — loaded into `missions` at M0b |
| 04 | [DESIGN-LOG](04-DESIGN-LOG.md) | All 8 passes: accepted / modified / dropped, with reasons. First entry in the decision corpus |
| 05 | [RISKS-AND-GATES](05-RISKS-AND-GATES.md) | Invariants, risk register, verification gates, governance rule |
| 06 | [HANDOFF-CRITERIA](06-HANDOFF-CRITERIA.md) | **When bootstrapping stops.** Phases 0/1/2, the Doctrine, M-C Capability Transfer ledger, the six-step handoff test |
| — | [M0.5-FOUNDER-TIME-LOG](M0.5-FOUNDER-TIME-LOG.md) | **LIVE** — the two-week baseline. Clock started 2026-08-06 |
| — | [../antigravity/](../antigravity/README.md) | Implementation briefs delegated to Antigravity + the review discipline |

## The stopping condition

Not "implement the 33 days." **Implement until FounderOS can execute the next milestone itself.**

```
Phase 0  Bootstrap            humans + Claude + Antigravity build the factory   ◄── WE ARE HERE
Phase 1  Assisted Evolution   FounderOS proposes; founder approves high-risk
Phase 2  Autonomous Improve.  FounderOS owns its own backlog
```

**The Doctrine:** *if FounderOS is capable of doing a task, humans are no longer allowed to do it
manually.* Full criteria and the six-step handoff test: [06-HANDOFF-CRITERIA](06-HANDOFF-CRITERIA.md).

## Where we are

**Verified 2026-08-06:** `tsc --noEmit` clean · `verify:arch` green **exactly at baseline** ·
`pnpm test` **238 files / 2,498 tests / 0 failures / 15.03s** · 259 src files / 42,391 LOC ·
kernel 2,458 LOC with pure-code routing and code-recorded receipts.

**The kernel is the strongest component in this repo and is not rewritten by this plan.**

### The finding that defines the work

**Four complete layers are built, tested, and wired to nothing:**

| Layer | Built | Connected |
|---|---|---|
| Mission state machine | `missions` + lifecycle + 7 query fns | ❌ zero callers |
| Event bus | `dept_signals` + 6 Zod contracts + exactly-once claim | ❌ zero callers |
| Business registry | `COMPANY_PROFILES` (turicks, naggar) | ❌ zero importers |
| Tool boundary | `tool-adapter.ts`, unit-tested | ❌ zero importers; 20 files bypass it |

Plus ~1,865 LOC orphaned and 5 unused production dependencies.

**This is unused architecture, not absent architecture — a much cheaper problem**, and it is why
the crossover path is ~27–33 days rather than a rewrite.

## The plan in one screen

```
M0.5 ─────────────────────────────────────────────► (parallel; gates M6's proof)
  │
M0a ──► M0b ──► M-R ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6 ⟨CROSSOVER⟩
                                                                 │
                                        after crossover, the system builds:
                                        Knowledge Graph · Capability Marketplace ·
                                        Business Workflows · Signal bus · Founder Memory ·
                                        Market Awareness · Metrics · Plugins ·
                                        Parallel exec · Amputation
                                        …then with data: Simulation · Prediction · Portfolio
```

**Crossover** = the point where FounderOS proposes and builds its own increments to a green PR.
Everything before it is hand-built; everything after can be built by the system. **The optimization
target is time-to-crossover, not total scope.**

## The two rules everything answers

> **1. Every manual action must become a future capability.**
> **2. Every capability must generate knowledge.**

And the mechanism that keeps it honest:

> **20% self-improvement cap** — missions with `business_id = founderos` may not exceed 20% of
> mission spend/time in any rolling 30-day window. Past the cap, Evolution Engine proposals are
> queued, not dispatched.

## First KPI

Not "how autonomous?" but **"how much founder work disappeared?"** — measured against
[M0.5-FOUNDER-TIME-LOG.md](M0.5-FOUNDER-TIME-LOG.md).

## Governance

No vision documents. No architecture passes. Changes originate only from **measured telemetry**,
**a concrete founder pain point**, or **a business KPI that is not improving**.

## Open decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Which `risk_class` may auto-merge on green (M-R) | `low` only — tests, docs, pure functions with no side effects |
| 2 | M0.5 capture: manual log vs `/time` command | Manual for now (clock already running); `/time` is an 8th command against the "7 essential" rule — founder's call |
| 3 | langgraphjs PR #2665 status | Needed before parallel execution; merged, or pin a patched build |
| 4 | Amputation list approval | Listed in [03-BACKLOG-GRAPH](03-BACKLOG-GRAPH.md); execute post-crossover |
