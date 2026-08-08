# Context, RAG & Memory

## What actually enters the model per turn

Traced through `makePlanNode` → `makeAgentNode`. **This is smaller than the thesis assumed.**

### Planner call (1 per turn)

| Component | Size | Source |
|---|---:|---|
| Planner rules | ~4,300 chars | static, `buildPlannerPrompt` |
| Worker catalog | **79 tool slots / 65 names** | `DEPARTMENT_TOOLS` via `buildWorkerSpecs` |
| `plannerNowLine(clock)` | ~80 chars | injected clock |
| Replayed history | ≤600 in + ≤1,500 reply **per turn**, unbounded turn count | `state.history` |
| Founder message | — | — |

### Worker call (1..n per turn)

| Component | Size |
|---|---|
| Worker prompt | 2,039 – 13,138 chars |
| **TaskEnvelope only** | objective + inputs + expected + constraints |
| Bound tools | that worker's tools |

**Workers never see the conversation.** That is a real strength — context isolation is genuine
here, not aspirational.

### What is NOT injected

No RAG. No brain dump. No architecture docs. No memory. No skills.

**Retrieval only happens when the model calls a retrieval tool.** FounderOS is already
just-in-time, exactly as the thesis recommends.

---

## Correcting the thesis

> *"Your RAG might return 30 pieces of relevant information… the model shouldn't reason over the
> entire brain."*

**This does not happen in FounderOS.** The CSV turn made **zero** retrieval calls — it called
`job_brief` and answered. The failure was a missing capability, not context noise.

**Revised diagnosis:** the problem is not *too much retrieved context*. It is:

1. **Too many retrieval tool names at the decision point** (5, no router) — a *choice* problem
2. **No structured-state tier at all** — Tier 0 of the thesis's own hierarchy is missing

The thesis's Tier 0 / 1 / 2 / 3 model is right. FounderOS has Tiers 1–3 and **no Tier 0**.

| Tier | Thesis | FounderOS today |
|---|---|---|
| **0 — structured current state** | deterministic DB/API query | **MISSING** |
| 1 — task memory | targeted retrieval | `search_memory` (admin only) |
| 2 — semantic/historical | RAG | 3 pgvector tools + `search_knowledge` |
| 3 — exploration | agent searches | `search_web`, `deep_research`, `crawl_site` |

**This is why "what jobs have been captured" fails.** It is a Tier-0 question, and Tier 0 does not
exist, so the worker answered it with a Tier-2 instrument (`job_brief`).

---

## Unbounded surface: replayed history

`state.history` grows without a turn cap. Per-turn truncation exists (600/1500 chars) but nothing
caps the number of turns. On a long-lived thread the planner prompt grows without bound.

Not yet observed as a failure — **measure in Phase 9, cap only if the benchmark shows drift.**
Do not pre-optimise.

---

## Memory systems inventory

| Store | Backend | Rows (prod) | Read by |
|---|---|---:|---|
| `episodic_memory` | Postgres | 44 | `search_memory` (admin) |
| mem0 | external | — | `search_memory` |
| `personal_rag` | pgvector | — | `search_personal_rag` |
| `turicks_brain` | pgvector | — | `search_turicks_brain` |
| research cache | pgvector | — | `search_research_cache` |
| `knowledge_entries` | relational | — | `search_knowledge` |
| `failure_lessons` | Postgres | 2 | kernel `LessonStore` (code, not a tool) |
| `founder_context` | Postgres | — | `read_context` (admin) |
| `agent_results` | Postgres | **0** | nothing |

Nine stores. Seven exposed as five tool names. One (`agent_results`) is empty and unread.

> **2026-08-07 precedent:** a shadow `agents.turicks_brain` table made *all* local vector search
> return zero rows, silently, for weeks. Any change here must assert non-zero retrieval against
> the real prod schema, not a fixture.

---

## Target — minimal change, no new layer

```
                       QUESTION
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    Tier 0 STATE     Tier 1/2 RECALL   Tier 3 EXPLORE
   (deterministic)    (one tool,        (search_web,
    job/schedule/      code routes       deep_research)
    cost/application   the backend)
    queries)
```

**Two changes total:**

1. **Add Tier 0** — Phase 2. A small set of read-only structured-state tools. `job_state` first,
   because that is the failing case with evidence.
2. **Collapse Tiers 1–2 to one `recall` tool** — Phase 7. Backends unchanged; only the name
   surface shrinks 5 → 1.

**Do not** build a Context Compiler. One already exists
(`src/kernel/context-composer.ts`), is fully tested, and is called by nothing. Adding a second
would repeat the exact failure mode this program is meant to end. Either wire that file in
Phase 7 or delete it in Phase 6 — **decide, do not duplicate.**
