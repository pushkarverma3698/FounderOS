"""
Generic department-supervisor node factory.
The supervisor is itself an LLM call that picks the next worker (or 'FINISH').
"""
from __future__ import annotations
from typing import Callable
from .state import DeptState
from .llm import call_llm_json


SUPERVISOR_SYSTEM = """You are the supervisor of the {dept_name} department in FounderOS.
You manage these workers (each is an LLM agent specialised in one job):

{workers_block}

Given the task and the work done so far, decide the SINGLE best next step.

You may pick:
- One worker name from the list above (to call them next)
- "FINISH" when the task is sufficiently answered
- "HANDOFF:<other_dept>" when this task belongs to another department
   (allowed: turicks, naggar, command, career)

Reply ONLY in JSON:
{{"next": "<worker_name|FINISH|HANDOFF:dept>", "reason": "<one sentence>"}}"""


def make_supervisor(
    dept_name: str,
    workers: list[dict],         # [{name, tier, description}]
    max_iters: int = 4,
) -> Callable[[DeptState], dict]:
    workers_block = "\n".join(
        f"- {w['name']} ({w['tier']}): {w['description']}" for w in workers
    )
    system = SUPERVISOR_SYSTEM.format(dept_name=dept_name, workers_block=workers_block)
    valid_workers = {w["name"] for w in workers}

    def supervisor_node(state: DeptState) -> dict:
        iters = state.get("iterations", 0)
        if iters >= max_iters:
            return {"next_worker": "FINISH", "finished": True}

        outputs = state.get("worker_outputs", [])
        already = ", ".join(w["agent"] for w in outputs) or "none"
        scratch = "\n\n".join(
            f"[{o['agent']}]: {str(o.get('result',''))[:400]}"
            for o in outputs[-3:]
        ) or "(no work yet)"

        user = (
            f"Task: {state['task']}\n\n"
            f"Workers already called: {already}\n"
            f"Recent outputs:\n{scratch}\n\n"
            f"Decide the next step."
        )
        decision = call_llm_json("md", system, user, max_tokens=200)
        nxt = str(decision.get("next", "FINISH")).strip()

        # Hand-off to another department
        if nxt.upper().startswith("HANDOFF:"):
            target = nxt.split(":", 1)[1].strip().lower()
            return {
                "next_worker": "FINISH",
                "finished": True,
                "handoff_to": target,
                "iterations": iters + 1,
            }
        # Finished
        if nxt.upper() == "FINISH":
            return {"next_worker": "FINISH", "finished": True, "iterations": iters + 1}
        # Validate worker
        if nxt not in valid_workers:
            # If hallucinated, just finish gracefully
            return {"next_worker": "FINISH", "finished": True, "iterations": iters + 1}
        return {"next_worker": nxt, "iterations": iters + 1}

    return supervisor_node
