"""
FounderOS — HR Agent
=====================
The talent manager and agent factory of FounderOS.

Responsibilities:
1. Research web for best skills/tools for any new agent role
2. Generate a complete SOUL prompt + skill set for new agents
3. Spawn new agents dynamically (via Claude sub-agent API)
4. Keep managers informed of team composition
5. Weekly check with MDs: what specialist is missing?
6. Cross-reference the current agent roster to avoid duplication

Runs:
  - On-demand: when cross_company_router.py reports spawn_required=True
  - Weekly: Monday 07:00 — proactive "what's missing?" report to MDs
  - On Chairman command: "spawn [role] for [company]"

HR Agent is the bridge between human-level team planning and 
autonomous agent creation. It ensures every new agent is:
  ✓ Justified by a specific need
  ✓ Built with current best practices (web-researched)
  ✓ Non-duplicating existing capabilities
  ✓ Reported to Chairman before permanent deployment
"""

import asyncio, logging, sys, os, json
from datetime import datetime, date
sys.path.insert(0, str(os.path.dirname(__file__)))

from aiogram import Bot

from core.config import (
    GOOGLE_API_KEY,
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_BOARDROOM, MODELS, call_deep_research, call_ceo
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("HRAgent")

bot     = Bot(token=TELEGRAM_BOT_TOKEN)

from core.registry import get_all_agents

def get_current_roster():
    roster = {"turicks": [], "naggar": [], "cross_company": []}
    for agent in get_all_agents():
        company = "cross_company" if agent.company_assignment == "cross" else agent.company_assignment
        if company in roster:
            roster[company].append(agent.name)
    return roster


# ═══════════════════════════════════════════════════════════════════════════════
# CORE: Research + Generate Agent Definition
# ═══════════════════════════════════════════════════════════════════════════════

def research_agent_skills(role_name: str, company: str, task_context: str) -> str:
    """
    Uses Gemini Flash to research best practices + tools for a new agent role.
    Then generates a complete agent definition (SOUL prompt + skill set).
    """
    # Check duplication first
    roster = get_current_roster()
    all_agents = (
        roster["turicks"] +
        roster["naggar"] +
        roster["cross_company"]
    )
    similar = [a for a in all_agents if any(w in a for w in role_name.lower().split("_"))]
    
    prompt = f"""You are the HR Agent for FounderOS — an AI system managing two companies:
- Turicks (AI/tech agency)
- Naggar Retreat (Himalayan farm + homestay)

A new agent is needed:
Role: {role_name}
Company: {company}
Triggered by: {task_context}
Existing similar agents: {similar or 'None'}

STEP 1: Determine if this role is truly needed or if an existing agent can be extended.
STEP 2: If needed, research and define:

Generate a complete agent definition:

```json
{{
  "role_name": "{role_name}",
  "company": "{company}",
  "is_permanent": true/false,
  "justification": "specific reason this role doesn't duplicate existing agents",
  "model_tier": "local|nano|flash|pro|claude",
  "schedule": "on-demand|daily HH:MM|weekly day HH:MM",
  "expert_skills": [
    "skill or framework 1 (research-backed)",
    "skill or framework 2",
    "skill or framework 3"
  ],
  "tools": ["tool1", "tool2"],
  "soul_prompt_summary": "2-sentence SOUL description of this agent's personality and approach",
  "first_task": "The first specific task this agent should handle"
}}
```

Base skills on current 2026 best practices. Only include tools that exist and are free/freemium where possible."""

    resp = call_deep_research(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# SPAWN: Create a sub-agent for heavy one-off tasks (Claude sub-agent pattern)
# ═══════════════════════════════════════════════════════════════════════════════

def spawn_subagent_via_claude(task: str, agent_name: str, parent_agent: str) -> str:
    """
    Spawns a temporary Claude sub-agent for a heavy one-off task.
    This uses Claude's extended thinking + tool use as a "sub-agent."
    
    Pattern: Parent agent hits a complex subtask → spawns this sub-agent
    → sub-agent executes → returns result to parent → parent continues.
    
    The sub-agent is temporary: no ChromaDB storage, no schedule, dies after task.
    """
    log.info(f"Spawning sub-agent: {agent_name} for parent: {parent_agent}")
    
    system_prompt = f"""You are a specialized sub-agent named {agent_name}, 
spawned by {parent_agent} to handle a complex specific task.

You have full expertise for this task. Think step by step.
Return ONLY the completed work output — no meta-commentary.
This is a one-time task: complete it fully in a single response."""
    
    result = call_ceo(prompt=task, system=system_prompt)
    log.info(f"Sub-agent {agent_name} completed task ({len(result)} chars)")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# WEEKLY: Proactive "What's Missing?" report to MDs
# ═══════════════════════════════════════════════════════════════════════════════

async def run_weekly_roster_review():
    """
    Monday 07:00: HR Agent asks "what specialist is needed next?"
    Reads recent ChromaDB errors/bottlenecks and recommends new agents.
    """
    roster = get_current_roster()
    prompt = f"""You are the HR Agent conducting a Monday morning roster review.

Current team roster:
Turicks: {', '.join(roster['turicks'])}
Naggar: {', '.join(roster['naggar'])}
Cross-company: {', '.join(roster['cross_company'])}

Today: {datetime.now().strftime('%A, %B %d, %Y')}

Based on common bottlenecks in AI agency + farm/hospitality businesses, answer:

1. **Gap Analysis**: What specialist role is most likely MISSING from each company's team?
2. **Trending Tools**: What new AI tools (released in last 30 days) could any existing agent use?
3. **Spawn Recommendation**: ONE new agent to create this week. Full definition:
   - Role + company
   - Top 3 skills (current best practices)
   - Model tier
   - First task

Keep it concise. This is a Monday morning standup, not an essay."""

    resp = call_deep_research(prompt)
    
    report = f"👥 *HR Agent — Monday Roster Review*\n\n{resp}"
    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=report[:4000],
        message_thread_id=TOPIC_BOARDROOM,
        parse_mode="Markdown"
    )
    log.info("HR weekly roster review sent to Chairman.")


# ═══════════════════════════════════════════════════════════════════════════════
# ON-DEMAND: Handle spawn request from cross_company_router
# ═══════════════════════════════════════════════════════════════════════════════

async def handle_spawn_request(spawn_brief: str, requesting_company: str) -> str:
    """
    Called when cross_company_router.py determines a new agent is needed.
    1. Researches the role
    2. Generates a full definition
    3. Reports to Chairman for approval (always — no silent agent creation)
    4. Returns the agent definition for temporary use
    """
    # Extract role name from brief
    role_name = f"{requesting_company}_specialist_{date.today().strftime('%m%d')}"
    
    definition = research_agent_skills(role_name, requesting_company, spawn_brief)
    
    approval_msg = f"""👥 *HR Agent — New Agent Spawn Request*

A new specialist agent is needed. Awaiting your approval.

**Requested by:** Cross-Company Router
**For company:** {requesting_company.title()}
**Trigger:** {spawn_brief[:200]}

**Proposed Definition:**
{definition[:1500]}

Reply *"approve agent"* to add permanently, or *"temp agent"* to use once only."""

    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=approval_msg[:4000],
        message_thread_id=TOPIC_BOARDROOM,
        parse_mode="Markdown"
    )
    
    log.info(f"Spawn request sent to Chairman for approval: {role_name}")
    return definition


if __name__ == "__main__":
    import sys
    if "--review" in sys.argv:
        asyncio.run(run_weekly_roster_review())
    elif "--spawn" in sys.argv:
        role = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else "general specialist"
        print(research_agent_skills(role, "turicks", "direct test"))
