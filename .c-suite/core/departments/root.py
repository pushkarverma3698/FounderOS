"""
ROOT GRAPH — the top of the FounderOS hierarchy.
A CEO classifier picks one (or more) departments. Each is a compiled subgraph node.
A handoff in any department is honored by re-routing here.
"""
from __future__ import annotations
from typing import Literal
from langgraph.graph import StateGraph, END

from .state import RootState, DeptState
from .factory import build_department, DEPARTMENTS
from .llm import call_llm_json


# ── Build all 4 departments once, reuse across calls ────────
_DEPT_GRAPHS = {name: build_department(name) for name in DEPARTMENTS}


CEO_SYSTEM = """You are FounderOS Root Supervisor.
Pushkar (one-man company) runs:
- turicks  → AI agency (LangGraph, Next.js, MERN, AI automation)
- naggar   → Himalayan farm + premium homestay (raspberries, Airbnb, bookings)
- command  → Cross-company ops: scrum, costs, social, outreach, HR, revenue, therapy
- career   → JobOS — personal job-search engine

Given a task, pick the SINGLE best starting department. (Departments may hand off later.)
Reply ONLY in JSON:
{"department": "turicks|naggar|command|career", "reason": "<one sentence>"}"""


def root_classifier(state: RootState) -> dict:
    """LLM CEO — picks the entry department."""
    decision = call_llm_json("ceo", CEO_SYSTEM, f"Task: {state['task']}", max_tokens=120)
    dept = str(decision.get("department", "command")).lower()
    if dept not in DEPARTMENTS:
        dept = "command"
    return {"company": dept, "routed_to": [dept]}


def make_dept_node(name: str):
    """Wrap a compiled department subgraph as a single node in the root graph."""
    sub = _DEPT_GRAPHS[name]

    def dept_node(state: RootState) -> dict:
        sub_state: DeptState = {
            "department": name,
            "task": state["task"],
            "iterations": 0,
            "finished": False,
        }
        result = sub.invoke(sub_state)
        dept_result = {
            "department": name,
            "summary": result.get("summary", ""),
            "workers_called": result.get("workers_called", []),
            "outputs": result.get("worker_outputs", []),
        }
        update = {
            "department_results": [dept_result],
            "handoff_chain": [name],
        }
        # If the dept supervisor escalated, propagate the handoff
        if result.get("handoff_to"):
            update["routed_to"] = [result["handoff_to"]]
        return update

    return dept_node


def aggregator(state: RootState) -> dict:
    """Merge all department summaries into the final answer."""
    parts = state.get("department_results", [])
    if not parts:
        return {"final_answer": "(no department produced output)"}
    chunks = []
    for p in parts:
        wks = ", ".join(p.get("workers_called", [])) or "—"
        chunks.append(f"━━ {p['department'].upper()} ━━ (workers: {wks})\n{p.get('summary','')}")
    return {"final_answer": "\n\n".join(chunks)}


# ── Build the root state-graph ─────────────────────────────
def build_root_graph():
    g = StateGraph(RootState)
    g.add_node("classify", root_classifier)
    for name in DEPARTMENTS:
        g.add_node(name, make_dept_node(name))
    g.add_node("aggregate", aggregator)

    g.set_entry_point("classify")

    def route_from_classify(state: RootState) -> str:
        # Pick the most-recently routed department
        routed = state.get("routed_to") or ["command"]
        return routed[-1]

    g.add_conditional_edges(
        "classify", route_from_classify, {n: n for n in DEPARTMENTS}
    )

    # After each department, decide: handoff to another OR aggregate
    def route_from_dept(state: RootState) -> str:
        routed = state.get("routed_to") or []
        chain = state.get("handoff_chain") or []
        # Did the most recent department request a handoff?
        if routed and routed[-1] not in chain:
            return routed[-1]
        return "aggregate"

    for n in DEPARTMENTS:
        g.add_conditional_edges(n, route_from_dept,
                                {**{d: d for d in DEPARTMENTS}, "aggregate": "aggregate"})

    g.add_edge("aggregate", END)
    return g.compile()


# ── Convenience runner ────────────────────────────────────
_ROOT = None
def run_founderos(task: str) -> dict:
    global _ROOT
    if _ROOT is None:
        _ROOT = build_root_graph()
    return _ROOT.invoke({"task": task})
