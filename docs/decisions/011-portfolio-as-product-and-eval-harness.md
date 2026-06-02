# ADR-011: Portfolio-as-Product + Eval Harness over a Critic

**Date:** 2026-06-02
**Status:** Accepted
**Supersedes (in part):** ADR-003 (the v1 critic) for the *quality-gate* responsibility.
**Context:** The founder has one quarter of runway and two goals — land an AI/agent engineering job
and start earning realistic money. We must decide how to direct FounderOS development to serve both.

---

## The Problem

FounderOS v2 is a production-grade LangGraph multi-agent system, but it is **private**, so its
considerable hiring signal is currently worth nothing. Separately, the four Gumroad products are
built but unlaunched. Pursuing "job" and "money" as two separate tracks would split a solo founder's
limited time and ship neither well.

There is also an open quality question inherited from v1: should we re-add a **critic** node to
raise output quality (ADR-003)? v2 dropped it when moving to ReAct + HITL (ADR-010).

---

## Decision 1 — Portfolio-as-Product

Treat **one public, open-core FounderOS** as the single artifact that serves both goals:

- The open repo (with eval harness, observability, HITL, production-hardening writeups) is both the
  **job-winning portfolio** and the **product's discovery funnel**.
- FounderOS **generates its own build-in-public content** (LinkedIn BUILD_LOG, deep-dives), which is
  inbound for both job offers and product sales — and is itself a live demo of the system.
- Monetization layers on top open-core: free base → Gumroad packs → "FounderOS Pro" → DFY/SaaS.

**Why:** 2026 deep research (see `docs/study/SCALING-AND-PORTFOLIO-STRATEGY.md`) shows recruiters
engage 80% more with runnable public repos than resumes; agentic-AI hiring is +280% YoY and clusters
on LangGraph; and open-core ("picks-and-shovels") is the proven monetization pattern. The same work
counts twice.

**Rejected:** *job-sprint / freeze product* (discards revenue compounding) and *revenue-sprint / job
later* (highest income variance, underweights engineering depth).

---

## Decision 2 — Eval Harness instead of a Critic

For the quality-gate responsibility, build a **deterministic, reproducible eval harness** rather than
re-adding the v1 cross-model critic node.

| | v1 Critic (ADR-003) | Eval Harness (this ADR) |
|---|---|---|
| Cost | +1 LLM call **per generation** | LLM calls **only on demand** (`pnpm eval`); unit tests use a stub |
| Determinism | non-deterministic (LLM judgment) | deterministic scoring over a fixed golden set |
| Portfolio value | "I added a self-critique" (common) | "eval design" = *the hardest skill to fake*, the top screened signal |
| Regression safety | none | golden set catches routing/tool regressions over time |
| Overlap with HITL | redundant (human already approves) | complementary (measures the system, not one message) |

In a ReAct + HITL architecture the agent already self-corrects in its loop and the founder gives
final approval on every external action; a per-action critic adds latency and cost for little gain.
A reproducible eval harness measures the *whole system's* behavior, is cheap (opt-in), and is exactly
the artifact 2026 employers screen for. The brand validator (PR #13) remains the cheap deterministic
content gate before `interrupt()`.

---

## Consequences

- **First implementation increment:** `src/eval/` — pure scoring + report + an injectable runner;
  golden-task dataset; `pnpm eval` writes `EVAL.md`. Unit tests use a deterministic stub invoker
  (zero LLM credits); the live eval is opt-in.
- **Routing is observable** via the supervisor's `transfer_to_<agent>` handoff tool calls in the
  message trail; tool usage and HITL coverage are read from the same trail + `getState().tasks`.
- **ADR-003 stays on record** as the v1 design; its quality-gate role is now served by the eval
  harness. If a future need arises for per-message LLM critique (e.g., a SaaS tier with no human in
  the loop), revisit.
- **Tier 0 ("make public") is a founder decision** + a secrets audit — surfaced for approval, not
  done unilaterally.

---

## Related
- `docs/study/SCALING-AND-PORTFOLIO-STRATEGY.md` — the full strategy + sources
- `docs/decisions/003-critic-pattern.md` — the superseded critic design
- `docs/decisions/010-v2-react-agent-rebuild.md` — where the critic was first dropped
- `docs/study/V1-FEATURE-INVENTORY.md` — dropped-feature backlog
