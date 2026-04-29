"""
FounderOS — Cross-Company Task Router
=======================================
Handles work that flows BETWEEN companies.

Example: "Turicks Web Designer designs the Naggar website"
  → CEO detects cross-company work
  → Router checks if target company has a capable agent
  → If YES: delegates to that agent with proper company context
  → If NO: HR Agent researches + spawns a new specialist sub-agent

Key rules:
  1. Data siloing is ALWAYS respected — no ChromaDB cross-contamination
  2. The receiving company's Telegram topic gets the output
  3. A cross-company log is maintained for billing/tracking
  4. The Chairman approves any new permanent agent spawning

This module is imported by orchestrator.py and called when CEO
detects company != source_company in the task.
"""

import json, logging, sys, os
from datetime import datetime
sys.path.insert(0, str(os.path.dirname(__file__)))

import anthropic
from core.config import ANTHROPIC_API_KEY, MODELS, TOPIC_TURICKS, TOPIC_NAGGAR

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("CrossCompanyRouter")

claude = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# ── All agents and their capabilities ─────────────────────────────────────────
AGENT_CAPABILITY_MAP = {
    "turicks": {
        "web_designer":   ["website design", "ui", "ux", "stitch", "figma", "landing page", "frontend"],
        "vibe_coder":     ["react", "tailwind", "nextjs", "component", "code", "frontend", "animation"],
        "senior_dev":     ["backend", "api", "database", "fullstack", "bug", "feature", "code"],
        "proposal_writer":["proposal", "copy", "content", "email", "pitch", "marketing copy"],
        "bidding_sniper": ["bid", "upwork", "freelance", "client", "pricing"],
        "qa_tester":      ["test", "qa", "quality", "bug", "review"],
        "video_editor":   ["video", "reel", "film", "footage", "edit"],
        "lead_intel":     ["research", "lead", "market research", "competitor"],
    },
    "naggar": {
        "vibe_designer":  ["brand", "social media", "content", "visual", "aesthetic", "instagram"],
        "video_editor":   ["video", "reel", "film", "footage", "farm video"],
        "culinary_agent": ["menu", "food", "recipe", "restaurant"],
        "booking_concierge": ["booking", "pricing", "guest", "airbnb"],
        "yield_scout":    ["harvest", "raspberry", "farm", "yield", "market price"],
        "farm_weather":   ["weather", "temperature", "frost", "rain"],
        "market_scout":   ["competitor", "market research", "pricing research"],
    }
}


def find_capable_agent(task: str, target_company: str) -> str | None:
    """
    Checks if target company already has an agent capable of the task.
    Returns agent name if found, None if a new agent needs to be spawned.
    """
    task_lower = task.lower()
    agents = AGENT_CAPABILITY_MAP.get(target_company, {})

    best_agent = None
    best_score = 0
    for agent_name, keywords in agents.items():
        score = sum(1 for kw in keywords if kw in task_lower)
        if score > best_score:
            best_score = score
            best_agent = agent_name

    return best_agent if best_score >= 1 else None


def route_cross_company_task(task: str, source_company: str, target_company: str) -> dict:
    """
    Main cross-company routing function called by orchestrator.

    Returns:
        {
          "routed_to": "web_designer" | "new_agent",
          "agent_name": str,
          "context_injection": str,   ← injected into agent prompt
          "output_topic": int,        ← Telegram topic for response
          "spawn_required": bool
        }
    """
    if source_company == target_company:
        return {"error": "Not a cross-company task"}

    # Check for existing capable agent
    capable_agent = find_capable_agent(task, target_company)

    output_topic = TOPIC_TURICKS if target_company == "turicks" else TOPIC_NAGGAR

    if capable_agent:
        log.info(f"Cross-company route: {source_company}→{target_company} via {capable_agent}")
        
        # Build context injection — gives agent both companies' context without sharing data
        context = f"""
CROSS-COMPANY TASK — READ CAREFULLY
=====================================
You are working on a task that originates from {source_company.title()} 
but is being delivered for {target_company.title()}.

Source company: {source_company.title()}
Target company: {target_company.title()}

IMPORTANT: Use ONLY {target_company.title()}'s brand voice, style, and requirements.
Do NOT mix data or brand guidelines between the two companies.
Output will be delivered to the {target_company.title()} team.

Task: {task}
"""
        return {
            "routed_to": "existing_agent",
            "agent_name": capable_agent,
            "context_injection": context,
            "output_topic": output_topic,
            "spawn_required": False,
        }

    else:
        log.info(f"No capable agent found in {target_company} for task. HR Agent will spawn one.")
        return {
            "routed_to": "new_agent",
            "agent_name": f"{target_company}_specialist",
            "context_injection": task,
            "output_topic": output_topic,
            "spawn_required": True,
            "spawn_brief": f"""
HR AGENT SPAWN REQUEST
========================
Target company: {target_company.title()}
Task that needs handling: {task}
Source company requesting: {source_company.title()}

Research and define a new specialist agent with:
1. Role name
2. Required skills (search web for current best tools/practices)
3. Model tier recommendation
4. Whether this is a permanent or one-off role
""",
        }


def log_cross_company_work(task: str, source: str, target: str, agent: str):
    """Append cross-company work log for billing/audit purposes."""
    log_path = os.path.expanduser("~/Documents/Coding stuff/FounderOS/cross_company_log.jsonl")
    entry = {
        "timestamp": datetime.now().isoformat(),
        "task": task[:100],
        "source_company": source,
        "target_company": target,
        "handled_by": agent,
    }
    with open(log_path, "a") as f:
        f.write(json.dumps(entry) + "\n")
    log.info(f"Cross-company log: {source}→{target} via {agent}")
