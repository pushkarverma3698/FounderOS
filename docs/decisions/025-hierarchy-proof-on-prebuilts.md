# ADR-025 — Hierarchy proof on the prebuilt supervisor (Phase 5 spike)

- **Date:** 2026-06-14
- **Status:** Accepted (capability proven; production promotion deferred + gated)
- **Branch:** `feat/phase5-hierarchy-spike`
- **Follows:** [ADR-021](021-multi-agent-transition-and-token-measurement.md) … [ADR-024](024-dept-signals-over-postgres.md)

## Context

The advisor doc's headline item was hierarchical supervisors. FounderOS runs a
FLAT 7-department supervisor today. The real question wasn't "can we draw a tree"
— it was: **does an HITL `interrupt()` raised deep inside a nested supervisor
still surface and resume through the gateway's `getState().tasks` path?** That run
loop (`office-run.ts`, 621 LOC) is the single most fragile, most-regressed piece
of the system (wedge loops, duplicate instances, stale replies all lived there).
Promoting nesting blind would risk it.

## Decision

**1. Prove the capability with an additive spike — do NOT touch the live office.**
`src/agents/revenue-domain.ts` builds a `revenue` sub-supervisor over
{marketing, sales} and a 2-level parent over [research, revenue]. The live
`office.ts` stays flat (7 depts); the spike is reachable only from the
integration test. Zero change to `office-run.ts`, the pre-router, or the flat
graph — so the risky run loop is untouched.

**2. Verify nested interrupt/resume at the canonical HITL level.**
`tests/integration/nested-hitl.test.ts` drives the live Gemini model through
parent → revenue → marketing → `linkedin_post` → `interrupt()` and asserts:
   - the interrupt **surfaces** via `getPendingApproval` (the exact
     `getState().tasks` path the gateway uses) — three levels deep;
   - **reject** → the real LinkedIn tool is NEVER called;
   - **approve** → it runs exactly once;
   - a research question routes parent → research with **no** interrupt (control).
   This is the same proof level as `office-hitl.test.ts` (the repo's canonical
   HITL test). **Verified GREEN against the live model** (47s, 3/3).

**3. Promotion to production is double-gated (deliberately not done now).**
Swapping the live office to nested topology is gated on BOTH:
   - a real **trigger** — a domain with ≥2 genuinely-coordinating agents (rule
     #17: don't shatter into micro-agents preemptively); and
   - **live MTProto verification** of nested interrupt/resume/wedge on the real
     Telegram gateway (the plan's Phase 5 gate; needs the founder's MTProto login).
   Until both hold, FLAT is correct. Depth is capped at 2 if/when promoted.

## Consequences

- The "hierarchical-capable" portfolio claim is now **evidence, not a slogan** —
  nested HITL works on the prebuilt `createSupervisor` with no `StateGraph`
  rewrite (vindicates ADR-021's "build on prebuilts").
- The fragile run loop carries zero new risk; production behaviour is unchanged
  (989 unit tests green, tsc clean; nested test is live-gated/skipped by default).
- The deferred ADR-022 `stateSchema` channel still has no live reader; it rides
  with the eventual production promotion, not the spike. Honest deferral stands.
- Next: Phase 6 (CLAUDE rules #20–21, graph regen, brain:sync) + Phase 7
  (specialist hardening pass).
