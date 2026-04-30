"""
FounderOS — Coordinator Orchestrator (LangGraph State Machine)
===============================================================
Strict Coordinator Mode implementing the 4-Phase Lifecycle:
Research -> Synthesis -> Implementation -> Verification

The Coordinator never executes code itself; it spawns parallel TaskWorkers.
Every phase is followed by an approval gate per the Chairman's request.
"""

import sys, os, json, re
sys.path.insert(0, str(os.path.dirname(__file__)))

from typing import Annotated, Literal
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.sqlite import SqliteSaver
import httpx
from utils.doc_sync import DocumentationSync

try:
    from json_repair import repair_json
except ImportError:
    repair_json = None

from core.config import (
    CEO_MODEL, MD_MODEL, LOCAL_LLM_URL, LOCAL_MODEL_NAME,
    ANTHROPIC_API_KEY, GOOGLE_API_KEY, SQLITE_PATH, call_ceo, call_md, call_nano
)
from utils.skill_library import get_expert_system_prompt, SKILL_MAP
from memory.memory import turicks_mem, naggar_mem, recall
from core.parallel_dispatch import dispatch_parallel_sync, WorkerTask
from core.prompts import get_system

# ─── Graph State ──────────────────────────────────────────────────────────────
class FounderState(TypedDict):
    messages: Annotated[list, "Conversation history"]
    company:  str
    task:     str
    
    # 4-Phase Lifecycle Data
    research_results: str
    synthesis_result: str
    implementation_result: str
    verification_result: str
    result: str  # The output visible to Telegram/Chairman
    
    # Approval Gates
    approved: bool            # Generic approval flag from Telegram gateway
    pending_action: str       # Holds pending action details
    auto_approve: bool        # V8.3: Skip gates for simple/safe tasks
    research_approved: bool
    synthesis_approved: bool
    implementation_approved: bool
    
    # Validation Safety Net
    refined_once: bool
    gatekeeper_critique: str
    
    # Denial Loop Tracking
    denial_count: int
    denial_triggered: bool


# ─── Node 1: CEO Initiation ───────────────────────────────────────────────────
def ceo_node(state: FounderState) -> FounderState:
    user_msg = state["messages"][-1] if state["messages"] else "Hello"
    
    # Use the registry-aware CEO prompt: auto-injects company names, profiles and agents
    # This prevents hallucinating company names like 'FounderOS' or 'herb'
    ceo_system = get_system("CEO")
    
    # Enforce the exact output format the gateway expects
    ceo_system += """

CRITICAL: You MUST classify the company as EXACTLY one of these lowercase strings:
  - "turicks"  → Turicks AI Agency (software, MERN, AI automation, SEO audits)
  - "naggar"   → Naggar Retreat (Himalayan farm, homestay, raspberries)
  - "cross"    → Affects both companies OR general FounderOS system tasks

Assign the most relevant agent (e.g., 'seo_specialist' for website SEO, 'senior_dev' for code, etc.)

Output ONLY valid JSON, no markdown fences:
{
  "company": "turicks|naggar|cross", 
  "task": "...", 
  "agent": "...", 
  "auto_approve": true/false,
  "direct_answer": null
}

NOTE: Set "auto_approve": true for informational queries, simple research, or status checks. 
Set "auto_approve": false for code changes, financial tasks, or complex implementations.
"""

    raw = call_ceo(prompt=str(user_msg), system=ceo_system)
    try:
        parsed = repair_json(raw, return_objects=True) if repair_json else json.loads(raw)
        company = parsed.get("company", "cross")
        if company not in ("turicks", "naggar", "cross"):
            company = "cross"
        state["company"]      = company
        state["task"]         = parsed.get("task", str(user_msg))
        state["auto_approve"] = parsed.get("auto_approve", False)
    except Exception:
        state["company"]      = "cross"
        state["task"]         = str(user_msg)
        state["auto_approve"] = False
        
    state["refined_once"] = False
    state["gatekeeper_critique"] = ""
    return state


# ─── PHASE 1: Research ────────────────────────────────────────────────────────
def research_node(state: FounderState) -> FounderState:
    """Read-only agents gather data concurrently."""
    plan_system = """Decompose this task into 2 distinct background research queries to execute in parallel.
Return ONLY a valid JSON list of strings."""
    
    raw = call_md(state['task'], system=plan_system)
    queries = None
    if repair_json:
        try:
            queries = repair_json(raw, return_objects=True)
        except Exception:
            queries = None
    if queries is None:
        cleaned = re.sub(r"```(?:json)?", "", raw, flags=re.IGNORECASE).strip("` \n")
        try:
            queries = json.loads(cleaned)
        except Exception:
            queries = [f"Research basics for: {state['task']}"]
    if not isinstance(queries, list) or not queries:
        queries = [f"Research basics for: {state['task']}"]
        
    tasks = [WorkerTask(task_id=f"research-{i}", tier="MD", prompt=q) for i, q in enumerate(queries[:3])]
    results = dispatch_parallel_sync(tasks)
    
    state["research_results"] = "\n\n".join([f"Research {i}: {r.result}" for i, r in enumerate(results)])
    state["result"] = "🔍 Research Phase Complete. Awaiting approval to Synthesize."
    return state


def gate_research(state: FounderState) -> FounderState:
    if state.get("auto_approve"):
        state["research_approved"] = True
        return state

    if not state.get("research_approved"):
        state["result"] = "⏸️ APPROVAL REQUIRED: Research complete. Reply YES to proceed to Synthesis."
    return state


def route_research(state: FounderState) -> Literal["synthesis_node", "finalize"]:
    return "synthesis_node" if state.get("research_approved") else "finalize"


# ─── PHASE 2: Synthesis ───────────────────────────────────────────────────────
def synthesis_node(state: FounderState) -> FounderState:
    """Orchestrator creates the spec."""
    prompt = f"""Task: {state['task']}
Parallel Research Results: {state['research_results']}

Synthesize the research and create a strict, highly detailed Implementation Spec for the specialist worker."""
    
    # Speed Optimization: Use call_nano for synthesis if research results are concise
    if len(state["research_results"]) < 2000:
        state["synthesis_result"] = call_nano(prompt)
    else:
        state["synthesis_result"] = call_ceo(prompt)
        
    state["result"] = "🧠 Synthesis Phase Complete. Awaiting approval to Implement."
    return state


def gate_synthesis(state: FounderState) -> FounderState:
    if state.get("auto_approve"):
        state["synthesis_approved"] = True
        return state

    if not state.get("synthesis_approved"):
        state["result"] = "⏸️ APPROVAL REQUIRED: Synthesis complete. Reply YES to proceed to Implementation:\n\n" + state["synthesis_result"][:500] + "..."
    return state


def route_synthesis(state: FounderState) -> Literal["implementation_node", "finalize"]:
    return "implementation_node" if state.get("synthesis_approved") else "finalize"


# ─── PHASE 3: Implementation ──────────────────────────────────────────────────
def implementation_node(state: FounderState) -> FounderState:
    """Write-heavy agent does the work."""
    system_prompt = "You are the local Implementation Worker. Execute the spec."
    
    # [Denial Loops] If rejected multiple times, insert BAN flag.
    denial_count = state.get("denial_count", 0)
    if denial_count >= 3:
        banned = state.get("implementation_result", "Unknown previous action")
        system_prompt += f"\n\n🚨 [BANNED_ACTION] The Chairman has explicitly DENIED the following implementation 3+ times. Do NOT attempt this approach again:\n{banned[:200]}"
    
    # Inject MCP tools (safe whether called sync or from an active event loop)
    try:
        from bridges.mcp_bridge import MCPRegistry
        import asyncio

        async def _fetch():
            return await MCPRegistry.get_tools("github_mcp")

        try:
            loop = asyncio.get_event_loop()
            already_running = loop.is_running()
        except RuntimeError:
            already_running = False

        if already_running:
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                github_tools = ex.submit(asyncio.run, _fetch()).result(timeout=30)
        else:
            github_tools = asyncio.run(_fetch())

        if github_tools:
            system_prompt += "\n\nAvailable MCP Tools:\n" + str(github_tools)
            system_prompt += "\nTo invoke an MCP tool, strictly output the following XML block: <call_tool> {\"name\": \"tool_name\", \"arguments\": {...}} </call_tool>"
    except Exception:
        pass
    
    # [Context Compaction] If messages grow too unwieldy, summarize the task prompt.
    raw_task = state.get("synthesis_result", "")
    if len(raw_task) > 10000:  # Safely cut at paragraph boundaries for VRAM protection
        cutoff = raw_task.rfind("\n\n", 0, 8000)
        if cutoff == -1:
            cutoff = 8000
        raw_task = f"[COMPACTED] {raw_task[:cutoff]}\n\n... [TEXT REDACTED TO CONSERVE MEMORY]"

    user_content = f"Execute this spec exactly:\n{raw_task}"
    if state.get("refined_once") and state.get("gatekeeper_critique"):
        user_content = f"PREVIOUS ATTEMPT FAILED EVALUATION.\nCritique: {state['gatekeeper_critique']}\n\nPlease refine and fix the implementation based on the critique.\n\nOriginal Spec:\n{raw_task}"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": user_content}
    ]
    
    try:
        resp = httpx.post(
            f"{LOCAL_LLM_URL}/v1/chat/completions",
            json={"model": LOCAL_MODEL_NAME, "messages": messages, "max_tokens": 2000},
            timeout=120
        )
        raw_output = resp.json()["choices"][0]["message"]["content"]
        state["implementation_result"] = raw_output
    except Exception as e:
        state["implementation_result"] = f"[Worker Error] Implementation failed: {e}"
        
    state["result"] = "🛠️ Implementation Phase Complete. Awaiting approval to Verify."
    return state


def gate_implementation(state: FounderState) -> FounderState:
    if not state.get("implementation_approved"):
        if state.get("denial_triggered"):
            state["denial_count"] = state.get("denial_count", 0) + 1
            state["denial_triggered"] = False # Reset trigger
            
        state["result"] = f"⏸️ APPROVAL REQUIRED (Denials: {state.get('denial_count', 0)}): Implementation complete. Reply YES to proceed to Verification:\n\n" + state.get("implementation_result", "")[:500] + "..."
    else:
        state["denial_count"] = 0 # Reset on success
    return state


def route_implementation(state: FounderState) -> Literal["verification_node", "finalize"]:
    return "verification_node" if state.get("implementation_approved") else "finalize"


# ─── PHASE 4: Verification (Hard Gate) ────────────────────────────────────────
def verification_node(state: FounderState) -> FounderState:
    """Gatekeeper/Reviewer verifies the output. One-time safety net."""
    prompt = f"""Task: {state['task']}
Implementation to Review: {state['implementation_result']}

Act as Gatekeeper. Verify if the implementation perfectly fulfills the task. 
Begin your response with either "YES" or "NO".
Then provide your reasoning or critique. Keep it strict."""
    
    review = call_md(prompt).strip()
    
    if review.startswith("NO") and not state.get("refined_once"):
        state["refined_once"] = True
        state["gatekeeper_critique"] = review
        state["result"] = f"⚠️ HARD GATE ACTIVATED: Quality rejected. Refining once based on critique:\n{review[:200]}..."
        # Reset implementation approval here (not in the router) so routing stays pure
        state["implementation_approved"] = False
    else:
        status_prefix = "✅ FINAL OUTPUT (Verified):" if review.startswith("YES") else "⚠️ FINAL OUTPUT (Forced through after 1 refinement):"
        state["verification_result"] = review
        state["result"] = f"{status_prefix}\n\n{state['implementation_result']}"

    return state

def route_verification(state: FounderState) -> Literal["implementation_node", "finalize"]:
    """Pure router: inspect state and return next node. Must not mutate state."""
    if state["result"].startswith("⚠️ HARD GATE ACTIVATED"):
        return "implementation_node"
    return "finalize"


# ─── Finalize ─────────────────────────────────────────────────────────────────
def finalize_node(state: FounderState) -> FounderState:
    """Terminal node when waiting or finished."""
    return state

def doc_sync_node(state: FounderState) -> FounderState:
    """Trigger autonomous documentation update if heavy architectural shifts occurred."""
    if state.get("verification_result") and "YES" in state["verification_result"]:
        try:
            sync = DocumentationSync()
            sync.evaluate_and_sync(state["messages"], state["task"])
        except Exception as e:
            print(f"[DocSync Warning] Auto-documentation failed: {e}")
    return state


# ─── Build Graph ──────────────────────────────────────────────────────────────
import sqlite3

def build_graph():
    conn = sqlite3.connect(SQLITE_PATH, check_same_thread=False)
    memory = SqliteSaver(conn)
    builder = StateGraph(FounderState)

    builder.add_node("ceo",            ceo_node)
    
    builder.add_node("research_node",  research_node)
    builder.add_node("gate_research",  gate_research)
    
    builder.add_node("synthesis_node", synthesis_node)
    builder.add_node("gate_synthesis", gate_synthesis)
    
    builder.add_node("implementation_node", implementation_node)
    builder.add_node("gate_implementation", gate_implementation)
    
    builder.add_node("verification_node",   verification_node)
    builder.add_node("finalize",            finalize_node)

    # 1. CEO -> Research
    builder.set_entry_point("ceo")
    builder.add_edge("ceo", "research_node")
    
    # 2. Research -> Gate -> conditional Synthesis
    builder.add_edge("research_node", "gate_research")
    builder.add_conditional_edges("gate_research", route_research)
    
    # 3. Synthesis -> Gate -> conditional Implementation
    builder.add_edge("synthesis_node", "gate_synthesis")
    builder.add_conditional_edges("gate_synthesis", route_synthesis)
    
    # 4. Implementation -> Gate -> conditional Verification
    builder.add_edge("implementation_node", "gate_implementation")
    builder.add_conditional_edges("gate_implementation", route_implementation)
    
    # 5. Verification -> Hard Gate Routing
    builder.add_node("route_verification_node", lambda s: s)
    builder.add_edge("verification_node", "route_verification_node")
    builder.add_conditional_edges("route_verification_node", route_verification)
    
    # 6. Finalize -> DocSync -> END
    builder.add_node("doc_sync_node", doc_sync_node)
    builder.add_edge("finalize", "doc_sync_node")
    builder.add_edge("doc_sync_node", END)

    return builder.compile(checkpointer=memory)

graph = build_graph()
