"""
FounderOS — Daily Scrum Engine
================================
Runs every evening at 18:30 IST for both companies.

The Scrum Engine is the operational heartbeat of FounderOS:
  - MDs run a structured 15-minute "standup" with their agents
  - Agents "report" by surfacing their last ChromaDB outputs
  - MD synthesises into 3 blockers + 3 wins + tomorrow's priorities
  - Auto-generated report sent to Chairman (#Boardroom, private)

Two scrum loops run independently:
  1. Turicks MD Scrum → #Boardroom
  2. Naggar MD Scrum → #Boardroom

Format: async, lightweight, no human needed. You just receive the report.

Q&A Mode: Chairman can also ask "Scrum question: [question]" and the
relevant MD will query all its agents and respond with a consolidated answer.
"""

import asyncio, logging, sys, os
from datetime import datetime, date
sys.path.insert(0, str(os.path.dirname(__file__)))

from aiogram import Bot

from core.config import (
    GOOGLE_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_BOARDROOM, MODELS, call_md
)
from core.registry import get_all_companies
from memory.memory import client, recall
from core.prompts import get_system

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ScrumEngine")

bot   = Bot(token=TELEGRAM_BOT_TOKEN)


# ═══════════════════════════════════════════════════════════════════════════════
# AGENT STANDUP: Pull each agent's last output from ChromaDB
# ═══════════════════════════════════════════════════════════════════════════════

def get_agent_standup(agent_name: str, collection) -> str:
    """Pull the most recent summary for this agent from ChromaDB."""
    memories = recall(collection, f"{agent_name} completed task output result", n_results=2)
    if memories:
        return f"**{agent_name.replace('_', ' ').title()}:** {memories[0][:150]}"
    return f"**{agent_name.replace('_', ' ').title()}:** No output recorded today."


# ═══════════════════════════════════════════════════════════════════════════════
# MD SCRUM: Run the full standup for one company
# ═══════════════════════════════════════════════════════════════════════════════

def run_company_scrum(company_name: str, agents: list, collection_name: str) -> str:
    """
    MD synthesises all agent standups into a structured scrum report.
    Uses Gemini Flash (fast) — this should complete in <10 seconds.
    """
    collection = client.get_or_create_collection(collection_name)
    # Gather all agent standups
    standups = [get_agent_standup(agent, collection) for agent in agents]
    standup_block = "\n".join(standups)

    # Convert standups array to text, inject it via formatting
    prompt_template = get_system("SCRUM_MD", company_name=company_name.title(), date=datetime.now().strftime('%d %b'))
    prompt = f"{prompt_template}\n\nTeam reports from today:\n{standup_block}"

    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# CHAIRMAN Q&A: MD answers a specific question by querying agents
# ═══════════════════════════════════════════════════════════════════════════════

async def answer_scrum_question(question: str, company_name: str) -> str:
    """
    On-demand: Chairman asks a scrum question → MD queries relevant agents
    → synthesises answer → sends to Chairman.
    """
    from core.registry import get_company
    comp = get_company(company_name)
    if not comp:
        return "Company config not found."

    collection = client.get_or_create_collection(comp.memory_collection)
    relevant_memories = recall(collection, question, n_results=5)
    context = "\n".join(relevant_memories) if relevant_memories else "No data found."

    prompt = f"""You are the {company_name.title()} MD answering a direct question from the Chairman.

Chairman's question: {question}

Agent memory context:
{context}

Answer directly and specifically. Max 100 words. 
If the data doesn't exist in memory, say so clearly — don't fabricate."""

    resp = call_md(prompt)
    return f"**{company_name.title()} MD answers:** {resp}"


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN: Evening Scrum Run (both companies)
# ═══════════════════════════════════════════════════════════════════════════════

async def run_evening_scrum():
    """Run company scrums and send consolidated report to Chairman."""
    log.info("🔄 Running evening scrum...")

    reports = []
    for comp in get_all_companies():
        if not comp.agents:
            continue
        scrum_text = run_company_scrum(comp.name, comp.agents, comp.memory_collection)
        reports.append(scrum_text)

    full_report = f"📋 *Evening Scrum Report — {datetime.now().strftime('%d %b %Y, %I:%M %p')}*\n\n"
    full_report += "\n\n---\n\n".join(reports)
    full_report += "\n\n---\n_Reply \"Scrum question: [company] [your question]\" for MD to investigate._"

    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=str(full_report)[:4000],
        message_thread_id=TOPIC_BOARDROOM,
        parse_mode="Markdown"
    )
    log.info("✅ Evening scrum sent to Chairman.")


if __name__ == "__main__":
    import sys
    if "--now" in sys.argv:
        asyncio.run(run_evening_scrum())
    else:
        print("Run with --now to execute immediately, or let scheduler.py handle it.")
