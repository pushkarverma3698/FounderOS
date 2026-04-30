"""
FounderOS — Smart Router
=========================
Replaces the brittle string-match `complex_triggers` list. Uses an LLM to
classify any incoming Chairman task and decide:

  - mode:           "answer" | "execute" | "orchestrate"
  - agent:          best-fit agent name from the registry
  - company:        "turicks" | "naggar" | "cross"
  - needs_research: bool — fire auto_researcher first
  - needs_code:     bool — agent should write+run a Python script

Falls back to safe defaults on parse failure (no hallucinated routes).
"""
from __future__ import annotations
import json, logging, re
from typing import Dict, List

from core.config import call_local, call_md
from core.registry import get_all_agents, get_all_companies

log = logging.getLogger("SmartRouter")


def _agent_catalog() -> str:
    lines = []
    for a in get_all_agents():
        lines.append(f"- {a.name} ({a.company_assignment}, {a.cascade_tier})")
    return "\n".join(lines)


def _company_catalog() -> str:
    return ", ".join([c.name for c in get_all_companies()] + ["cross"])


ROUTER_PROMPT = """You are the FounderOS task router. Classify the Chairman's message.

AGENTS (pick exactly one for `agent`):
{agents}

COMPANIES: {companies}

MODES:
- "answer"     — pure information retrieval; no action needed
- "execute"    — needs ONE agent to run a script / make an API call / write content
- "orchestrate"— needs research → synthesis → implementation → verification (full pipeline)

NEEDS_RESEARCH: true if the answer requires fresh external info (web, API), false if memory + reasoning suffices.
NEEDS_CODE: true if the task requires running Python (scripting, posting to APIs, seeding data, fetching feeds).

Reply with ONLY a JSON object, no prose:
{{"mode":"...","agent":"...","company":"...","needs_research":bool,"needs_code":bool,"reasoning":"one line"}}
"""


def _safe_json(s: str) -> dict | None:
    s = (s or "").strip()
    # Strip markdown fences
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.S)
    # Find first {...} block
    m = re.search(r"\{[\s\S]*\}", s)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


_HEURISTIC_RULES = [
    # (keyword_regex, mode, agent, company, needs_code, needs_research)
    (r"\b(write|run|execute|seed|post to|publish to)\b.*\b(script|python|code)\b", "execute", "senior_dev", "cross", True, False),
    (r"\b(post|publish|draft)\b.*\b(linkedin|twitter|x|social)\b", "execute", "social_handler", "cross", True, False),
    (r"\b(send|draft|write)\b.*\b(cover letter|cv letter)\b", "execute", "cover_letter_writer", "cross", False, False),
    (r"\b(send|draft|write)\b.*\b(proposal|outreach|email)\b", "execute", "proposal_writer", "turicks", False, False),
    (r"\b(scrape|fetch|crawl|find leads|research|investigate)\b", "execute", "lead_intel", "turicks", True, True),
    (r"\b(audit|analyse|analyze|review|deep dive)\b", "orchestrate", "scrum_pm", "cross", False, True),
    (r"\b(list|show|what are|tell me about)\b.*\b(agents|services|pricing|memory|collections)\b", "answer", "scrum_engine", "cross", False, False),
    (r"\b(book|booking|guest|airbnb|naggar|farm|raspberr)", "answer", "booking_concierge", "naggar", False, False),
]


def _heuristic_route(text: str, valid_agents: set, valid_companies: set) -> Dict | None:
    import re as _re
    low = text.lower()
    for pattern, mode, agent, company, code, research in _HEURISTIC_RULES:
        if _re.search(pattern, low):
            if agent not in valid_agents:
                agent = "scrum_engine"
            if company not in valid_companies:
                company = "cross"
            return {"mode": mode, "agent": agent, "company": company,
                    "needs_research": research, "needs_code": code,
                    "reasoning": f"heuristic:{pattern[:30]}"}
    return None


def route(user_text: str, default_topic: str = "boardroom") -> Dict:
    """Return a routing decision dict. Never raises."""
    valid_agents = {a.name for a in get_all_agents()}
    valid_companies = {c.name for c in get_all_companies()} | {"cross"}

    # 0. Heuristic pre-filter — fast and reliable for common patterns
    heur = _heuristic_route(user_text, valid_agents, valid_companies)
    if heur:
        log.info(f"[SmartRouter:heuristic] '{user_text[:50]}' → {heur['mode']}/{heur['agent']}")
        return heur

    sys_prompt = ROUTER_PROMPT.format(
        agents=_agent_catalog(),
        companies=_company_catalog(),
    )

    # Try MD tier first (better classification), fall back to local
    raw = ""
    try:
        raw = call_md(user_text, system=sys_prompt, max_tokens=300)
    except Exception as e:
        log.warning(f"[SmartRouter] md failed: {e}")
    if not raw or len(raw) < 10:
        try:
            raw = call_local(user_text, system=sys_prompt, max_tokens=300)
        except Exception as e:
            log.warning(f"[SmartRouter] local failed: {e}")

    parsed = _safe_json(raw) or {}

    decision = {
        "mode":   parsed.get("mode", "answer"),
        "agent":  parsed.get("agent", "scrum_engine"),
        "company": parsed.get("company", "cross"),
        "needs_research": bool(parsed.get("needs_research", False)),
        "needs_code":     bool(parsed.get("needs_code", False)),
        "reasoning": parsed.get("reasoning", "fallback"),
    }
    if decision["mode"] not in {"answer", "execute", "orchestrate"}:
        decision["mode"] = "answer"
    if decision["agent"] not in valid_agents:
        decision["agent"] = "scrum_engine"
    if decision["company"] not in valid_companies:
        decision["company"] = "cross"

    log.info(f"[SmartRouter] '{user_text[:50]}...' → {decision}")
    return decision
