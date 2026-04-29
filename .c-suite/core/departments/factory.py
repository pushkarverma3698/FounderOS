"""
Department factory: assembles supervisor + worker nodes into a compiled subgraph.
The single source of truth for which agents belong to which department is registry.py.
"""
from __future__ import annotations
from langgraph.graph import StateGraph, END

from core.registry import get_all_agents, get_agent  # type: ignore
from .state import DeptState
from .supervisor import make_supervisor
from .worker import make_worker


# ── DEPARTMENT MEMBERSHIP MAP ─────────────────────────────
# Source: company_assignment in registry.py + JobOS bucket overlay.
# We split "cross" into Command (ops/comms/finance) and Career (JobOS) for clarity.
JOB_OS_AGENTS = {
    "job_coordinator", "job_intel", "ats_optimizer", "cover_letter_writer",
    "outreach_agent_personal", "resume_tailor", "lead_monitor",
    "interview_researcher", "hr_scout", "liaison_agent",
}

DEPARTMENTS = ["turicks", "naggar", "command", "career"]


def _agents_for_department(dept: str) -> list:
    all_agents = get_all_agents()
    if dept == "turicks":
        return [a for a in all_agents if a.company_assignment == "turicks"]
    if dept == "naggar":
        return [a for a in all_agents if a.company_assignment == "naggar"]
    if dept == "career":
        return [a for a in all_agents if a.name in JOB_OS_AGENTS]
    if dept == "command":
        # Cross agents that are NOT JobOS
        return [
            a for a in all_agents
            if a.company_assignment == "cross" and a.name not in JOB_OS_AGENTS
        ]
    raise ValueError(f"Unknown department: {dept}")


def _agent_description(a) -> str:
    """One-liner for the supervisor prompt."""
    bits = [a.cascade_tier]
    if "search_web" in a.allowed_tools: bits.append("web")
    if "firecrawl" in a.allowed_tools:  bits.append("scrape")
    if "github_mcp" in a.allowed_tools: bits.append("github")
    if "telegram_send" in a.allowed_tools: bits.append("telegram")
    return f"{a.cascade_tier} | {' '.join(bits)} | collections: {', '.join(a.allowed_collections)}"


def build_department(dept: str):
    """Compile a department subgraph that takes DeptState and returns DeptState."""
    agents = _agents_for_department(dept)
    if not agents:
        raise ValueError(f"No agents registered for department '{dept}'")

    workers_meta = [
        {"name": a.name, "tier": a.cascade_tier, "description": _agent_description(a)}
        for a in agents
    ]
    supervisor = make_supervisor(dept, workers_meta, max_iters=3)

    g = StateGraph(DeptState)
    g.add_node("supervisor", supervisor)
    for a in agents:
        g.add_node(a.name, make_worker(a))

    g.set_entry_point("supervisor")

    # Supervisor → routes to chosen worker OR ends
    def route_from_supervisor(state: DeptState) -> str:
        nxt = state.get("next_worker", "FINISH")
        if nxt == "FINISH" or state.get("finished"):
            return "summarize"
        if nxt in {a.name for a in agents}:
            return nxt
        return "summarize"

    g.add_conditional_edges(
        "supervisor",
        route_from_supervisor,
        {**{a.name: a.name for a in agents}, "summarize": "summarize"},
    )

    # Every worker loops back to supervisor for the next step
    for a in agents:
        g.add_edge(a.name, "supervisor")

    # Final summarize node — concatenates worker outputs into a single dept summary
    def summarize(state: DeptState) -> dict:
        outs = state.get("worker_outputs", [])
        if not outs:
            return {"summary": "(no workers ran)", "department": dept}
        bits = []
        for o in outs:
            mark = "✅" if o.get("status") == "ok" else "❌"
            bits.append(f"{mark} {o['agent']}\n{str(o.get('result',''))[:600]}")
        return {"summary": "\n\n".join(bits), "department": dept}

    g.add_node("summarize", summarize)
    g.add_edge("summarize", END)

    return g.compile()
