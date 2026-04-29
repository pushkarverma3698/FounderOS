# FounderOS — Departments Architecture (LangGraph Hierarchical Agents)

## Why this exists

The previous orchestrator was a flat 4-phase StateGraph (Research → Synthesis → Implementation → Verification) where every agent sat at the same level and the CEO node both classified _and_ executed routing. That coupling forced one prompt, one cascade, one set of guardrails for 39 very different agents.

The new architecture organises the same 39 agents into **4 departments**, each compiled as its own LangGraph subgraph with its own supervisor. The root graph treats each department as a single node.

## The hierarchy

```
                        ROOT GRAPH
                            │
                ┌──────── classify ────────┐   (LLM CEO — picks 1 dept)
                │                          │
   ┌────────────┼────────────┬─────────────┼──────────────┐
   ▼            ▼            ▼             ▼              ▼
┌───────┐   ┌───────┐    ┌─────────┐   ┌────────┐   ┌──────────┐
│TURICKS│   │NAGGAR │    │ COMMAND │   │ CAREER │   │ aggregate│
│  sub  │   │  sub  │    │   sub   │   │  sub   │   │   → END  │
│ 10 wk │   │ 9 wk  │    │  10 wk  │   │ 10 wk  │   └──────────┘
└───────┘   └───────┘    └─────────┘   └────────┘
   │            │            │             │
   └────────────┴── handoff ─┴─────────────┘
            (department supervisor may say
             "HANDOFF:turicks" → router re-enters)
```

## Each department subgraph

```
        ┌─────────────┐
   ───▶ │ supervisor  │ ◀───┐
        └─────┬───────┘     │
              │             │
        ┌─────┴───────┐     │
        │ pick worker │     │
        └──┬──────────┘     │
           │ (LLM-routed)   │ loop until
   ┌───────┼────────┐       │ FINISH /
   ▼       ▼        ▼       │ HANDOFF /
[worker][worker]  [worker] ─┘ max_iters
   │       │        │
   └───────┴────────┘
              │
              ▼
        ┌──────────┐
        │summarize │ → returns to root
        └──────────┘
```

- **Supervisor** (LLM, MD-tier): one prompt, sees the worker roster + scratchpad, replies `{"next": "<worker_name>|FINISH|HANDOFF:<dept>"}`
- **Worker** (LLM, agent's tier): pulls silo-safe ChromaDB context from `agent.allowed_collections`, runs one inference, appends to `worker_outputs`
- **Summarize**: concatenates outputs into a single `summary` string

## Departments

| Department | Source | Agents | Topic | Memory |
|---|---|---|---|---|
| **turicks** | `company_assignment == "turicks"` | 10 | TOPIC_TURICKS=111 | `turicks_mem` |
| **naggar** | `company_assignment == "naggar"` | 9 | TOPIC_NAGGAR=112 | `naggar_mem` |
| **command** | `cross` minus JobOS | 10 | TOPIC_BOARDROOM=8 / TOPIC_SOCIAL=6 | `turicks_mem`, `naggar_mem`, `social_mem` |
| **career** | JobOS V2 + V3 bucket | 10 | TOPIC_THINK_TANK=110 | `social_mem`, `career_mem` |

Membership is **fully derived from `core/registry.py`** — adding a new agent there automatically places it in the right department subgraph. No code changes needed.

## File map

```
.c-suite/core/departments/
├── __init__.py        # Public API: build_root_graph, run_founderos, build_department, DEPARTMENTS
├── state.py           # RootState, DeptState TypedDicts (annotated reducers)
├── llm.py             # OpenRouter free-tier cascade (BIG/MID/SMALL/CODE pools)
├── supervisor.py      # make_supervisor(dept_name, workers, max_iters) factory
├── worker.py          # make_worker(agent) factory — silo-safe memory recall
├── factory.py         # build_department(name) → compiled subgraph
└── root.py            # build_root_graph() → top-level graph + run_founderos(task)
```

## How to call it

```python
from core.departments import run_founderos

result = run_founderos("Draft a proposal for a $4K LangGraph legal-doc project.")
print(result["final_answer"])
print(result["handoff_chain"])         # which depts ran (in order)
print(result["department_results"])    # raw per-dept transcripts
```

## Key design decisions

1. **Subgraphs as nodes** — Each dept is `compiled_subgraph.invoke(sub_state)` inside its root node. State separation is enforced; cross-dept calls go through the root.
2. **Single source of truth** — Department membership lives in `registry.py`. Workers, tools, collections, tier are read from `Agent` dataclass at compile time.
3. **Silo-safe memory** — Worker nodes call `_safe_recall(agent.allowed_collections, …)`; cannot reach collections outside their grant. Existing `tool_hooks.py` zero-trust still enforces this at write time.
4. **Bounded supervisor loops** — `max_iters=3` per department prevents runaway. Supervisor sees the last 3 worker outputs (truncated) for routing decisions.
5. **Handoff protocol** — Supervisor may emit `HANDOFF:<dept>` to escalate. Root re-routes; `handoff_chain` audits the trail. Re-entry into a department already in the chain is blocked (no cycles).
6. **Free-tier cascade** — LLM helper (`llm.py`) tries 3-4 free OpenRouter models per tier with backoff. Keeps the existing model cascade philosophy without depending on Gemini paid quota.

## Compatibility with existing code

- The old `core/orchestrator.py` 4-phase graph is **untouched** — both can coexist
- `parallel_dispatch.py`, `tool_hooks.py`, `memory.py`, `prompts.py`, `telegram_gateway.py` are **reused as-is**
- `bridges/telegram_formatter.py` already accepts the dept output shape — wire it from `aggregator()` in `root.py` to send per-dept cards to topics

## Smoke test

```
$ python .c-suite/test_departments.py

[1] Department membership:
  turicks   → 10 workers : bidding_sniper, lead_intel, senior_dev, vibe_coder, qa_tester, proposal_writer ...
  naggar    →  9 workers : farm_weather, yield_scout, booking_concierge, vibe_designer, culinary_agent, market_scout ...
  command   → 10 workers : social_researcher, social_handler, cost_watchdog, team_therapist, hr_agent, revenue_scout ...
  career    → 10 workers : job_coordinator, job_intel, ats_optimizer, cover_letter_writer, outreach_agent_personal, resume_tailor ...

[2] End-to-end run — Turicks task: ✅ 3 workers called, final answer assembled
[3] Cross-company task — command dept ran scrum_pm, scrum_engine, hr_agent in sequence ✅
```

## Known tunings (next pass, not architectural)

- Root classifier sometimes routes Turicks-flavoured tasks to `command` — fix with a few-shot examples in `CEO_SYSTEM`
- Supervisor occasionally re-calls the same worker — add `seen_workers` to its prompt to nudge diversification
- Add a per-department evaluator node before `summarize` for scored quality gates
