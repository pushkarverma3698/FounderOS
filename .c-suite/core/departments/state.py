"""Shared TypedDict state schemas for the root graph and every department subgraph."""
from __future__ import annotations
from typing import Annotated, TypedDict, Literal
from operator import add


# ───────────────────────────────────────────
# ROOT graph state — flows BETWEEN departments
# ───────────────────────────────────────────
class RootState(TypedDict, total=False):
    """State at the top of the hierarchy. Routes to one or more departments."""
    task: str                       # Raw user/system task
    routed_to: list[str]            # Departments selected by root supervisor
    handoff_chain: Annotated[list[str], add]  # Inter-dept handoff trail
    department_results: Annotated[list[dict], add]  # All sub-graph outputs
    final_answer: str               # Aggregated answer
    company: str                    # "turicks" | "naggar" | "cross" | "career"


# ───────────────────────────────────────────
# DEPARTMENT subgraph state — internal to one dept
# ───────────────────────────────────────────
class DeptState(TypedDict, total=False):
    """State scoped to a single department subgraph."""
    department: str                 # Self-identification
    task: str                       # Task copied from root
    memory_context: str             # ChromaDB recall (silo-enforced)
    next_worker: str                # Picked by supervisor
    workers_called: Annotated[list[str], add]
    worker_outputs: Annotated[list[dict], add]   # [{agent, result, model, dur}]
    iterations: int                 # Supervisor reroute counter
    finished: bool                  # Supervisor signal to stop
    summary: str                    # Final department output
    handoff_to: str                 # If non-empty → escalate to another dept


WorkerOutput = TypedDict(
    "WorkerOutput",
    {"agent": str, "result": str, "model": str, "duration": float, "status": str},
    total=False,
)
