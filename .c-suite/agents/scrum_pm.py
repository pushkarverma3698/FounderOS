"""
FounderOS — Scrum Project Manager
=====================================
THE PM that runs the entire company's daily planning without Pushkar.

DAILY FLOW (runs AFTER evening scrum at 18:45 IST):
1. Collects all agent data from ChromaDB (yesterday's outputs, pending tasks, OKRs)
2. All agents "attend" by providing their current status + available capacity
3. Scrum PM synthesises → creates today's plan with resource allocation
4. Sends Chairman a concise task list with priorities
5. Waits for Chairman approval
6. On approval: queues tasks to agents via task_router.py
7. On no response in 30 min: implements plan automatically (safe tasks only)

CHAIRMAN MESSAGE FORMAT:
  "Approve plan" or "APPROVE" → execute all tasks
  "Approve 1,3,5" → execute only tasks 1, 3, 5
  "Reject 2" → drop task 2, execute rest
  "Scrum PM: add task X" → add to today's plan

ROLE: Project Manager with Scrum Master authority
SCHEDULE: Daily 18:45 IST (15 min after scrum completes)
CASCADE: DEEP_RESEARCH (plans must be research-quality)
"""

import json
import asyncio
import logging
import sys, os
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(__file__))

from core.config import (
    call_deep_research, call_md, call_nano,
    COLLECTION_TURICKS, COLLECTION_NAGGAR, COLLECTION_SOCIAL,
    TOPIC_BOARDROOM, TOPIC_TURICKS, TOPIC_NAGGAR
)
from memory.memory import turicks_mem, naggar_mem, recall, social_mem
from core.prompts import SYSTEM

log = logging.getLogger("ScrumPM")

TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

# ════════════════════════════════════════════════════════════════════════════════
# AGENT ROSTER — Each agent's role and typical daily capacity
# ════════════════════════════════════════════════════════════════════════════════

ALL_AGENTS = {
    # Turicks
    "bidding_sniper":    {"company": "turicks", "daily_capacity": 20, "unit": "proposals"},
    "lead_intel":        {"company": "turicks", "daily_capacity": 50, "unit": "leads"},
    "senior_dev":        {"company": "turicks", "daily_capacity": 4,  "unit": "hours"},
    "vibe_coder":        {"company": "turicks", "daily_capacity": 6,  "unit": "hours"},
    "qa_tester":         {"company": "turicks", "daily_capacity": 10, "unit": "test suites"},
    "proposal_writer":   {"company": "turicks", "daily_capacity": 5,  "unit": "proposals"},
    "ops_agent":         {"company": "turicks", "daily_capacity": 1,  "unit": "ops review"},
    "kb_agent":          {"company": "turicks", "daily_capacity": 1,  "unit": "index run"},
    "web_designer":      {"company": "turicks", "daily_capacity": 3,  "unit": "screens"},

    # Naggar
    "farm_weather":      {"company": "naggar",  "daily_capacity": 1,  "unit": "brief"},
    "yield_scout":       {"company": "naggar",  "daily_capacity": 1,  "unit": "p&l report"},
    "booking_concierge": {"company": "naggar",  "daily_capacity": 20, "unit": "inquiries"},
    "vibe_designer":     {"company": "naggar",  "daily_capacity": 3,  "unit": "content pieces"},
    "culinary_agent":    {"company": "naggar",  "daily_capacity": 2,  "unit": "recipes"},
    "market_scout":      {"company": "naggar",  "daily_capacity": 1,  "unit": "market report (fortnightly)"},
    "guest_crm":         {"company": "naggar",  "daily_capacity": 10, "unit": "guest contacts"},
    "naggar_kb":         {"company": "naggar",  "daily_capacity": 1,  "unit": "index run"},
    "video_editor":      {"company": "naggar",  "daily_capacity": 2,  "unit": "reels"},

    # Cross-company
    "social_researcher": {"company": "cross",   "daily_capacity": 1,  "unit": "trend report"},
    "social_handler":    {"company": "cross",   "daily_capacity": 6,  "unit": "posts"},
    "cost_watchdog":     {"company": "cross",   "daily_capacity": 1,  "unit": "audit (weekly)"},
    "team_therapist":    {"company": "cross",   "daily_capacity": 1,  "unit": "check-in (Friday)"},
    "hr_agent":          {"company": "cross",   "daily_capacity": 1,  "unit": "roster review (Monday)"},
    "revenue_scout":     {"company": "cross",   "daily_capacity": 5,  "unit": "opportunities"},
    "outreach_agent":    {"company": "cross",   "daily_capacity": 10, "unit": "messages"},
    "pipeline_md":       {"company": "cross",   "daily_capacity": 1,  "unit": "pipeline update"},
    "job_search_lead":   {"company": "cross",   "daily_capacity": 5,  "unit": "applications"},
}


# ════════════════════════════════════════════════════════════════════════════════
# STEP 1: Collect all agent data
# ════════════════════════════════════════════════════════════════════════════════

def _collect_agent_data() -> dict:
    """Pull today's outputs and pending tasks for all agents from ChromaDB."""
    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    data = {}

    for agent, meta in ALL_AGENTS.items():
        company = meta["company"]
        collection = turicks_mem if company == "turicks" else naggar_mem
        if company == "cross":
            # Cross agents: alternately check turicks and naggar
            collection = turicks_mem

        # Get recent outputs (last 24h)
        try:
            results = collection.query(
                query_texts=[f"{agent} output task completed"],
                n_results=5,
                where={"type": {"$in": ["task_output", "task_assignment", "agent_output"]}}
            )
            recent = results["documents"][0] if results["documents"] else []
        except Exception:
            recent = []

        data[agent] = {
            "meta": meta,
            "recent_outputs": recent[:2],  # Only last 2 to keep PM prompt manageable
            "capacity": meta["daily_capacity"],
            "unit": meta["unit"],
        }

    return data


# ════════════════════════════════════════════════════════════════════════════════
# STEP 2: Generate today's plan
# ════════════════════════════════════════════════════════════════════════════════

PM_SYSTEM = """You are the FounderOS Project Manager and Scrum Master.
You run the daily planning session for a 27-agent autonomous company.
You have full authority to assign tasks to any agent.

YOUR MANDATE:
1. Review all agent data provided
2. Identify the highest-leverage tasks for TODAY across both companies
3. Create a clear task list with the right agent assigned to each
4. Prioritise: revenue-generating > client delivery > internal ops > content

PRINCIPLES:
- Don't overload agents — respect their daily_capacity
- Cross-company tasks need both companies to benefit
- Always have 1-2 "quick wins" schedulable in <2 hours
- If a task has been pending 2+ days: flag as OVERDUE in red

OUTPUT FORMAT (strict JSON):
{
  "plan_date": "YYYY-MM-DD",
  "company_focus": {
    "turicks": "one sentence on today's Turicks priority",
    "naggar": "one sentence on today's Naggar priority"
  },
  "tasks": [
    {
      "id": 1,
      "agent": "agent_name",
      "company": "turicks|naggar|cross",
      "task": "precise task description",
      "why": "one sentence on why this today",
      "priority": "P1|P2|P3",
      "est_completion": "time estimate"
    }
  ],
  "team_okr_check": "are we on track? one sentence",
  "pm_note": "one candid note to Chairman — what needs his attention"
}"""


def _generate_daily_plan(agent_data: dict) -> dict:
    """Use Gemini 2.5 Pro to generate today's task plan."""
    today = datetime.now().strftime("%A, %d %B %Y")

    # Build a concise agent status summary for the prompt
    status_lines = []
    for agent, data in agent_data.items():
        recent = data["recent_outputs"]
        recent_str = recent[0][:80] + "..." if recent else "No output today"
        status_lines.append(
            f"• {agent} [{data['meta']['company']}]: capacity={data['capacity']} {data['unit']}"
            f" | recent: {recent_str}"
        )

    agent_summary = "\n".join(status_lines)

    prompt = f"""Today is {today}.

AGENT STATUS (all 27):
{agent_summary}

Based on this data, create today's optimal task plan.
Prioritise: revenue > client delivery > ops > content.
Assign 8-12 tasks total. Keep task descriptions precise and actionable.
Each task should be achievable today."""

    raw = call_deep_research(prompt, system=PM_SYSTEM)

    try:
        plan = json.loads(raw)
    except Exception:
        import re
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        plan = json.loads(m.group()) if m else {"tasks": [], "pm_note": raw}

    return plan


# ════════════════════════════════════════════════════════════════════════════════
# STEP 3: Format and send to Chairman
# ════════════════════════════════════════════════════════════════════════════════

def _format_plan_message(plan: dict) -> str:
    """Format the plan as a Telegram-friendly message."""
    tasks = plan.get("tasks", [])
    today = datetime.now().strftime("%d %b %Y")

    lines = [
        f"📋 **Daily Plan — {today}**\n",
        f"**Turicks focus:** {plan.get('company_focus', {}).get('turicks', '—')}",
        f"**Naggar focus:** {plan.get('company_focus', {}).get('naggar', '—')}",
        f"**OKR check:** {plan.get('team_okr_check', '—')}\n",
        "**Today's Tasks:**\n"
    ]

    priority_emojis = {"P1": "🔴", "P2": "🟡", "P3": "🔵"}

    for task in tasks:
        emoji = priority_emojis.get(task.get("priority", "P2"), "📋")
        lines.append(
            f"{emoji} **{task['id']}.** `{task['agent']}` — {task['task']}\n"
            f"   _Why today:_ {task.get('why', '—')} | _ETA:_ {task.get('est_completion', '—')}\n"
        )

    lines.extend([
        f"\n💬 **PM Note:** {plan.get('pm_note', '—')}\n",
        "---",
        "**Reply:**",
        "• `APPROVE` — execute all tasks",
        "• `APPROVE 1,3,5` — execute specific tasks",
        "• `REJECT 2` — drop task 2, execute rest",
        "• `SCRUM PM: add [task]` — add to plan",
        "\n_No reply in 30 min = safe tasks auto-execute_"
    ])

    return "\n".join(lines)


# ════════════════════════════════════════════════════════════════════════════════
# STEP 4: Handle Chairman approval
# ════════════════════════════════════════════════════════════════════════════════

async def handle_approval_reply(reply_text: str, plan: dict, bot=None) -> list:
    """
    Process Chairman's approval reply.
    Returns list of task IDs that were approved and queued.
    """
    reply = reply_text.strip().upper()
    tasks = plan.get("tasks", [])
    approved_ids = []

    if reply.startswith("APPROVE"):
        # Parse "APPROVE 1,3,5" or just "APPROVE"
        parts = reply.replace("APPROVE", "").strip()
        if parts:
            try:
                approved_ids = [int(x.strip()) for x in parts.split(",")]
            except Exception:
                approved_ids = [t["id"] for t in tasks]
        else:
            approved_ids = [t["id"] for t in tasks]

        # Remove REJECT overrides
    elif reply.startswith("REJECT"):
        parts = reply.replace("REJECT", "").strip()
        try:
            rejected_ids = [int(x.strip()) for x in parts.split(",")]
            approved_ids = [t["id"] for t in tasks if t["id"] not in rejected_ids]
        except Exception:
            approved_ids = [t["id"] for t in tasks]

    # Queue approved tasks
    approved_tasks = [t for t in tasks if t["id"] in approved_ids]
    for task in approved_tasks:
        company = task.get("company", "turicks")
        collection = turicks_mem if company == "turicks" else naggar_mem
        collection.add(
            documents=[json.dumps({
                "agent": task["agent"],
                "task": task["task"],
                "priority": task["priority"],
                "assigned_at": datetime.now().isoformat(),
                "status": "approved",
                "source": "scrum_pm",
            })],
            metadatas=[{"type": "task_assignment", "agent": task["agent"]}],
            ids=[f"pm_task_{task['id']}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"]
        )

    if bot:
        n = len(approved_tasks)
        agent_badges = ', '.join([f"`{t['agent']}`" for t in approved_tasks])
        await bot.send_message(
            chat_id=TELEGRAM_CHAT_ID,
            text=f"✅ **{n} tasks queued** for today.\n{agent_badges}",
            message_thread_id=TOPIC_BOARDROOM,
            parse_mode="Markdown"
        )

    return approved_ids


# ════════════════════════════════════════════════════════════════════════════════
# MAIN: Run daily planning
# ════════════════════════════════════════════════════════════════════════════════

async def run_daily_planning(bot=None):
    """Main entry called by scheduler.py at 18:45 IST."""
    log.info("🗓️  Scrum PM: Starting daily planning session...")

    # Step 1: Collect data
    agent_data = _collect_agent_data()
    log.info(f"   Collected data for {len(agent_data)} agents")

    # Step 2: Generate plan
    plan = _generate_daily_plan(agent_data)
    log.info(f"   Plan generated: {len(plan.get('tasks', []))} tasks")

    # Step 3: Send to Chairman
    message = _format_plan_message(plan)

    if bot:
        try:
            await bot.send_message(
                chat_id=TELEGRAM_CHAT_ID,
                text=message,
                message_thread_id=TOPIC_BOARDROOM,
                parse_mode="Markdown"
            )
        except Exception as e:
            log.warning(f"Markdown parsing failed, sending raw text: {e}")
            await bot.send_message(
                chat_id=TELEGRAM_CHAT_ID,
                text=message,
                message_thread_id=TOPIC_BOARDROOM
            )
    else:
        print(message)

    log.info("   Plan sent to Chairman. Waiting for approval...")

    # Step 4: Auto-execute safe P3 tasks after 30 min if no response
    await asyncio.sleep(1800)  # 30 minutes

    safe_tasks = [t for t in plan.get("tasks", []) if t.get("priority") == "P3"]
    if safe_tasks and bot:
        await bot.send_message(
            chat_id=TELEGRAM_CHAT_ID,
            text=f"⏰ 30 min passed — auto-executing {len(safe_tasks)} low-priority tasks.",
            message_thread_id=TOPIC_BOARDROOM
        )
        # Queue safe tasks
        for task in safe_tasks:
            collection = turicks_mem if task.get("company") == "turicks" else naggar_mem
            collection.add(
                documents=[json.dumps({**task, "status": "auto_approved", "source": "scrum_pm"})],
                metadatas=[{"type": "task_assignment", "agent": task["agent"]}],
                ids=[f"auto_task_{task['id']}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"]
            )

    return plan


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)

    if "--now" in sys.argv:
        from aiogram import Bot
        bot = Bot(token=os.getenv("TELEGRAM_BOT_TOKEN") or "8398351386:AAGFXmt-2QZk4XAFAGjOXjnjFAXhdkosuc0")
        asyncio.run(run_daily_planning(bot=bot))
    else:
        print("Usage: python scrum_pm.py --now")
        print("Normally called by scheduler.py at 18:45 IST")
