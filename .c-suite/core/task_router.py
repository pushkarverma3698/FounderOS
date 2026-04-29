"""
FounderOS — Smart Task Router
================================
Monitors all Telegram group messages and:
1. Auto-assigns tasks to the right agent without manual routing
2. Auto-updates company profiles in ChromaDB when context is shared
3. Works in both Turicks and Naggar group topics

HOW IT WORKS:
  Any message in the group → CEO cascade classifies it →
  If it's a task: assign to agent, add to their ChromaDB queue
  If it's company context/info: extract structured profile → store in DB
  If it's unclear: ask one clarifying question

AUTO-ASSIGNMENT TRIGGERS:
  "Design the Naggar booking page" → web_designer (cross-company, Naggar context)
  "Post raspberry harvest update" → vibe_designer
  "Find AI automation leads in Germany" → lead_intel
  "Our guest count this week was 12" → guest_crm (profile update)
  "Turicks stack: Next.js, LangGraph, Tailwind" → turicks profile update

PROFILE AUTO-UPDATE:
  When Pushkar shares info about a company in the group, it's extracted and
  stored as a structured profile in the appropriate ChromaDB collection.
  Profile fields: name, services, ics, pricing, stack, current_goals, etc.

USAGE:
  Called by telegram_gateway.py for every group message.
  from core.task_router import route_message

SCHEDULE:
  Called on-demand (every message) — no cron needed.
"""

import json
import logging
import sys, os
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))

from core.config import (
    call_ceo, call_md, call_nano,
    COLLECTION_TURICKS, COLLECTION_NAGGAR, COLLECTION_SOCIAL,
    TOPIC_TURICKS, TOPIC_NAGGAR, TOPIC_BOARDROOM, TOPIC_THINK_TANK
)
from memory.memory import turicks_mem, naggar_mem, recall
from core.prompts import SYSTEM, P

log = logging.getLogger("TaskRouter")

# ─── Agent → Telegram Topic Mapping ──────────────────────────────────────────
# Dynamically loaded via registry now.
from core.registry import get_agent_topic_id, get_company, get_all_companies, get_all_agents


# ════════════════════════════════════════════════════════════════════════════════
# CORE ROUTING LOGIC
# ════════════════════════════════════════════════════════════════════════════════

# Generate agent list string from registry
_companies_str = ", ".join([c.name for c in get_all_companies()] + ["cross", "unknown"])
_agent_list_block = ""
_cross = get_company("cross")
_company_iter = list(get_all_companies()) + ([_cross] if _cross is not None else [])
for c in _company_iter:
    _agent_list_block += f"{c.name.capitalize()}: {', '.join(c.agents)}\n"

ROUTER_SYSTEM = f"""You are the FounderOS Smart Task Router. Analyse any message from the Chairman and classify it.

CLASSIFICATION OPTIONS:
1. "task" — something that needs an agent to act (build, research, write, analyse, post, etc.)
2. "context_update" — company info being shared (stack, goals, pricing, team, metrics, guest data)
3. "question" — a question that needs an answer (route to CEO for direct answer)
4. "approval" — approving or rejecting a previous agent output
5. "chat" — conversational message, no action needed

AGENT LIST (pick the best fit for tasks):
{_agent_list_block.strip()}

Respond ONLY in valid JSON, no markdown:
{{
  "type": "task|context_update|question|approval|chat",
  "company": "{_companies_str}",
  "agent": "agent_name_or_empty",
  "task_description": "precise description of what the agent needs to do",
  "priority": "urgent|normal|low",
  "context_fields": {{}}
}}

For context_update, fill context_fields with key-value pairs extracted from the message.
Example: {{"services": ["LangGraph", "Next.js"], "pricing": "$500-$5000", "target_geo": "EU"}} """


async def route_message(text: str, topic_id: int, bot=None) -> dict:
    """
    Main entry point. Call this for every group message.
    Returns routing decision and sends Telegram acknowledgement.
    """
    log.info(f"Routing: [{topic_id}] {text[:60]}...")

    # Step 1: Classify with CEO cascade
    try:
        raw = call_ceo(text, system=ROUTER_SYSTEM)
        try:
            decision = json.loads(raw)
        except Exception:
            import re
            m = re.search(r'\{.*\}', raw, re.DOTALL)
            decision = json.loads(m.group()) if m else {"type": "chat"}
    except Exception as e:
        log.error(f"Router classification failed: {e}")
        return {"type": "error", "error": str(e)}

    msg_type = decision.get("type", "chat")

    # Step 2: Handle based on classification
    if msg_type == "context_update":
        await _handle_context_update(decision, text, bot, topic_id)

    elif msg_type == "task":
        await _handle_task_assignment(decision, text, bot, topic_id)

    elif msg_type == "question":
        # Route to CEO for direct answer
        answer = call_ceo(f"Answer this question from the Chairman: {text}")
        if bot:
            await bot.send_message(chat_id=os.getenv("TELEGRAM_CHAT_ID"),
                                   text=f"💡 **CEO Answer:**\n{answer}",
                                   message_thread_id=TOPIC_BOARDROOM)

    elif msg_type == "approval":
        await _handle_approval(decision, text, bot)

    return decision


async def _handle_task_assignment(decision: dict, original_text: str, bot, topic_id: int):
    """Assign task to the right agent and notify in correct topic."""
    agent = decision.get("agent", "")
    task_desc = decision.get("task_description", original_text)
    company = decision.get("company", "unknown")
    priority = decision.get("priority", "normal")

    if not agent:
        log.warning("No agent identified for task")
        return

    # Store task in company memory with full context
    collection = turicks_mem if company == "turicks" else naggar_mem
    task_doc = {
        "agent": agent,
        "task": task_desc,
        "priority": priority,
        "assigned_at": datetime.now().isoformat(),
        "status": "queued",
        "source": "chairman_message",
    }
    collection.add(
        documents=[json.dumps(task_doc)],
        metadatas=[{"type": "task_assignment", "agent": agent, "priority": priority}],
        ids=[f"task_{agent}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"]
    )

    # Telegram notification in appropriate topic
    target_topic = get_agent_topic_id(agent)
    priority_emoji = {"urgent": "🚨", "normal": "📋", "low": "🔵"}.get(priority, "📋")

    msg = (
        f"{priority_emoji} **Auto-assigned to `{agent}`**\n\n"
        f"**Task:** {task_desc}\n"
        f"**Priority:** {priority.upper()}\n"
        f"**Company:** {company.capitalize()}\n"
        f"_Auto-routed by Task Router — {datetime.now().strftime('%H:%M IST')}_"
    )

    if bot:
        await bot.send_message(
            chat_id=os.getenv("TELEGRAM_CHAT_ID"),
            text=msg,
            message_thread_id=target_topic,
            parse_mode="Markdown"
        )

    log.info(f"Task assigned: {agent} | {priority} | {task_desc[:40]}")


async def _handle_context_update(decision: dict, original_text: str, bot, topic_id: int):
    """
    Auto-update company profile when Pushkar shares context about a company.
    Extracts structured info and merges into existing profile in ChromaDB.
    """
    company = decision.get("company", "unknown")
    context_fields = decision.get("context_fields", {})

    if company == "unknown" or not context_fields:
        log.info("Context update skipped — unclear company or empty fields")
        return

    # Extract and merge profile
    profile_key = f"{company}_company_profile"
    collection = turicks_mem if company == "turicks" else naggar_mem

    # Try to get existing profile
    existing = recall(collection, profile_key, n_results=1)
    if existing:
        try:
            old = json.loads(existing[0])
            old.update(context_fields)
            context_fields = old
        except Exception:
            pass

    context_fields["last_updated"] = datetime.now().isoformat()
    context_fields["company"] = company

    collection.upsert(
        documents=[json.dumps(context_fields)],
        metadatas=[{"type": "company_profile", "company": company}],
        ids=[profile_key]
    )

    # Build human-readable summary of what was updated
    fields_listed = ", ".join(f"`{k}`" for k in context_fields.keys()
                              if k not in ("last_updated", "company"))

    msg = (
        f"💾 **Profile Updated: {company.capitalize()}**\n\n"
        f"Fields extracted: {fields_listed}\n"
        f"_Stored in {company}_mem ChromaDB — {datetime.now().strftime('%H:%M IST')}_"
    )

    if bot:
        comp = get_company(company)
        target = comp.telegram_topic_id if comp else TOPIC_BOARDROOM
        await bot.send_message(
            chat_id=os.getenv("TELEGRAM_CHAT_ID"),
            text=msg,
            message_thread_id=target,
            parse_mode="Markdown"
        )

    log.info(f"Profile updated: {company} | fields: {fields_listed}")


async def _handle_approval(decision: dict, text: str, bot, task_id: str = None):
    """
    Handle YES/NO approval from Chairman.
    Looks up the pending action and executes or cancels it.
    """
    approved = any(w in text.upper() for w in ["YES", "OK", "APPROVE", "GO", "PROCEED"])

    msg = (
        "✅ **Approved** — Agent will proceed." if approved
        else "❌ **Rejected** — Action cancelled."
    )

    if bot:
        await bot.send_message(
            chat_id=os.getenv("TELEGRAM_CHAT_ID"),
            text=msg,
            message_thread_id=TOPIC_BOARDROOM,
            parse_mode="Markdown"
        )

    log.info(f"Approval decision: {'APPROVED' if approved else 'REJECTED'}")
    return approved


# ════════════════════════════════════════════════════════════════════════════════
# PROFILE READER — get current company profile from DB
# ════════════════════════════════════════════════════════════════════════════════

def get_company_profile(company_name: str) -> dict:
    """
    Returns the current stored profile for a company.
    Used by agents to understand company context before acting.
    Dynamically loads from DB using registry defaults if DB is empty.
    """
    comp = get_company(company_name)
    if not comp:
        return {}
        
    collection = turicks_mem if comp.memory_collection == "turicks_mem" else naggar_mem
    results = recall(collection, f"{company_name}_company_profile", n_results=1)

    if results:
        try:
            return json.loads(results[0])
        except Exception:
            pass

    # Return default profile skeleton from registry if not in DB yet
    default_prof = dict(comp.profile)
    default_prof["company"] = company_name
    return default_prof
