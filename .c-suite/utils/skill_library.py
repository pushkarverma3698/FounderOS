"""
FounderOS — Skill Library (v5 — Dynamic JSON Registry)
================================================================
Mastery modules for all agents loaded from .founder/skills/prompts.json
"""

import os
import json

SKILLS_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".founder", "skills", "prompts.json"))

SKILL_MAP = {}
UNIVERSAL_SELF_EVAL = ""

def load_skills():
    global UNIVERSAL_SELF_EVAL, SKILL_MAP
    if not os.path.exists(SKILLS_FILE):
        return

    try:
        with open(SKILLS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        # Convert the JSON schema into dynamic strings
        UNIVERSAL_SELF_EVAL = data.get("_universal_self_eval", "")
        agents = data.get("agents", {})
        
        for agent_name, config in agents.items():
            framework = config.get("Framework", "")
            tone = config.get("Tone", "Professional")
            task_types = "\n".join([f"- {t}" for t in config.get("Task Type", [])])
            
            compiled_mastery = f"TONE: {tone}\nFRAMEWORK: {framework}\nTASKS:\n{task_types}"
            SKILL_MAP[agent_name] = compiled_mastery
    except Exception as e:
        print(f"Failed to load prompts library: {e}")

# Initial load
load_skills()

def get_expert_system_prompt(agent_name: str, base_role: str) -> str:
    """Build a master-level system prompt for any agent."""
    mastery = SKILL_MAP.get(agent_name, "No specialized mastery found.")
    return f"""You are a world-class expert operating as '{agent_name}' inside FounderOS.
Your role: {base_role}

{mastery}

{UNIVERSAL_SELF_EVAL}

Think like a domain master, not a generalist assistant. Apply your expert frameworks before responding.
"""

def list_agents() -> list[str]:
    """Return all registered agent names."""
    return list(SKILL_MAP.keys())
