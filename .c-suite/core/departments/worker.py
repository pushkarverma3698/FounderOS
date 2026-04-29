"""
Worker-node factory: turns any registered Agent into a LangGraph node that runs
a ReAct-style tool-calling loop.

Loop:
  1. LLM decides next step → JSON {"tool": "...", "input": "...", "thought": "..."}
                          OR  → JSON {"final_answer": "..."}
  2. If tool: dispatch via tools.execute_tool() (zero-trust via tool_hooks)
  3. Append observation, loop (≤ MAX_STEPS)
  4. On final_answer or limit reached → return result

Compatible with any free OpenRouter model (no native function-calling required).
"""
from __future__ import annotations
import time, json
from typing import Callable
from .state import DeptState, WorkerOutput
from .llm import call_llm
from .tools import execute_tool, tools_for_agent, TOOL_DOCS

MAX_STEPS = 4


REACT_SYSTEM = """You are the '{name}' agent in FounderOS ({company}, tier={tier}).
Your job: {role_hint}

You have these TOOLS (use them — do not hallucinate data when a tool can fetch it):
{tool_list}

⚠️  EXACT collection names for chromadb_read / chromadb_write — copy these EXACTLY:
{collections_exact}

RESPONSE FORMAT — every reply MUST be a single JSON object, no markdown fences, no prose outside:

To call a tool:
  {{"thought": "<why this tool>", "tool": "<tool_name>", "input": "<tool_input>"}}

To finish (only when you have enough info or no useful tool remains):
  {{"final_answer": "<your concise founder-grade answer>"}}

Rules:
- Prefer calling a tool first if data is missing.
- For chromadb_read / chromadb_write, input MUST be 'collection::query' or 'collection::content'.
- For write_file, input is 'path::content'.
- For telegram_send, input is 'topic::message' (topic ∈ boardroom|turicks|naggar|social|think_tank).
- Stop after at most {max_steps} tool calls.
- If a tool returns ERROR or DENIED, do NOT retry the same call — try another approach or finish."""


def _parse_json_reply(text: str) -> dict:
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`").lstrip("json").strip()
    try:
        return json.loads(t)
    except Exception:
        i, j = t.find("{"), t.rfind("}")
        if i != -1 and j > i:
            try:
                return json.loads(t[i:j+1])
            except Exception:
                pass
    return {"final_answer": text[:1500]}  # graceful degradation


def _role_hint(agent) -> str:
    # Compact one-line role description
    co = agent.company_assignment
    return {
        "turicks": "AI agency operator — pitches, code, proposals, SEO.",
        "naggar":  "Himalayan farm + homestay operator — bookings, guests, weather, menus.",
        "cross":   "Cross-company operator — ops, comms, costs, scrum, HR.",
    }.get(co, "Founder-grade specialist.")


def make_worker(agent) -> Callable[[DeptState], dict]:
    granted_tools = tools_for_agent(agent.name)
    tool_list = "\n".join(
        f"- {t}: {TOOL_DOCS.get(t,'(no docs)')}" for t in granted_tools
    ) or "(none — answer from reasoning alone)"
    # Format exact collection names with copy-ready examples
    col_exact = "\n".join(
        f'  • "{c}"  →  e.g. input: "{c}::your query here"'
        for c in agent.allowed_collections
    ) or "  (none)"
    system = REACT_SYSTEM.format(
        name=agent.name, company=agent.company_assignment, tier=agent.cascade_tier,
        role_hint=_role_hint(agent),
        tool_list=tool_list,
        collections_exact=col_exact,
        max_steps=MAX_STEPS,
    )

    def worker_node(state: DeptState) -> dict:
        scratchpad: list[str] = []
        final_answer = ""
        tools_used: list[str] = []
        t0 = time.time()
        last_model = "n/a"

        for step in range(MAX_STEPS):
            user = f"TASK: {state['task']}\n"
            if scratchpad:
                user += "\nWORK SO FAR:\n" + "\n".join(scratchpad[-6:])
            user += "\n\nReply with the next JSON action."

            try:
                text, last_model = call_llm(agent.cascade_tier, system, user, max_tokens=400)
            except Exception as e:
                final_answer = f"ERROR (LLM): {e}"
                break

            decision = _parse_json_reply(text)

            if "final_answer" in decision:
                final_answer = str(decision["final_answer"])[:2500]
                break

            tool = decision.get("tool", "")
            tool_input = str(decision.get("input", ""))
            thought = str(decision.get("thought", ""))[:200]

            if tool not in granted_tools:
                obs = f"DENIED: tool '{tool}' not in your grant {granted_tools}"
            else:
                try:
                    obs = execute_tool(tool, tool_input, agent.name)[:1200]
                    tools_used.append(tool)
                except Exception as e:
                    obs = f"ERROR: {e}"

            scratchpad.append(
                f"step {step+1}:\n  thought: {thought}\n  tool: {tool}({tool_input[:100]})\n  observation: {obs[:600]}"
            )

        if not final_answer:
            # Loop exhausted: ask LLM to summarize what it learned
            try:
                final_answer, last_model = call_llm(
                    agent.cascade_tier,
                    "Summarize your findings in 4 lines. Plain text only.",
                    f"Task: {state['task']}\n\nWork:\n" + "\n".join(scratchpad),
                    max_tokens=300,
                )
            except Exception as e:
                final_answer = f"(loop exhausted; summary failed: {e})"

        out: WorkerOutput = {
            "agent": agent.name,
            "result": final_answer,
            "model": last_model,
            "duration": time.time() - t0,
            "status": "ok" if not final_answer.startswith("ERROR") else "fail",
            # Extra fields for diagnostics
            "tools_used": tools_used,
            "steps": len(scratchpad),
        }
        return {
            "worker_outputs": [out],
            "workers_called": [agent.name],
        }
    return worker_node
