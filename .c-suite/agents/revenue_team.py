"""
FounderOS — Turicks Revenue Team
===================================
A 3-agent revenue sub-team focused on finding and closing projects.

Agents:
  1. **Revenue Scout**  — scans for high-value project opportunities
  2. **Outreach Agent** — sends personalised first-contact messages
  3. **Pipeline MD**    — manages the revenue pipeline, tracks deals

Based on turicks.com — an AI agency offering:
  - Agentic AI systems (LangGraph, AutoGen)
  - MERN stack development
  - AI automation for SMEs
  - Rapid prototyping (3-5 day delivery)
  - Performance web apps (Next.js 14+)

Revenue channels to mine:
  - Upwork (existing — Bidding Sniper handles)
  - LinkedIn outbound (new)
  - Indie Hackers / Product Hunt (AI dev communities)
  - EU startup communities (Slack, Discord)
  - Direct website leads (via turicks.com contact form)
  - Tech communities where founders discuss automation needs
"""

import asyncio, logging, sys, os
from datetime import datetime, date
sys.path.insert(0, str(os.path.dirname(__file__)))

import httpx
from aiogram import Bot

from core.config import (
    GOOGLE_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_TURICKS, TOPIC_BOARDROOM, MODELS, call_md
)
from core.registry import get_all_companies, get_company
from memory.memory import store, recall, get_collection
from core.prompts import get_prompt, get_system

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("RevenueTeam")

bot   = Bot(token=TELEGRAM_BOT_TOKEN)


# ═══════════════════════════════════════════════════════════════════════════════
# AGENT 1: Revenue Scout — find project opportunities
# ═══════════════════════════════════════════════════════════════════════════════

def scan_for_opportunities(company_name: str) -> str:
    """
    Scouts for high-value project leads across multiple channels.
    Returns a scored list of opportunities.
    """
    comp = get_company(company_name)
    if not comp:
        return ""
    
    channels = "LinkedIn outbound, Open platforms, Tech communities, Direct outreach"
    prompt = get_prompt("REVENUE_OPPORTUNITIES", company_name=company_name, date=datetime.now().strftime('%A, %B %d, %Y'), channels=channels)
    
    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# AGENT 2: Outreach Agent — craft personalised first contact
# ═══════════════════════════════════════════════════════════════════════════════

def generate_outreach_sequence(company_name: str, prospect_context: str, channel: str = "linkedin") -> str:
    """
    Generates a 3-touch personalised outreach sequence for a prospect.
    channel: "linkedin" | "email" | "twitter"
    """
    comp = get_company(company_name)
    if not comp: return ""
    profile_str = str(comp.profile)

    # Simplified formatting string without getting stuck in string templates
    prompt = f"""You are the Outreach Agent for {company_name.title()}.

Company Context: {profile_str}

Prospect context: {prospect_context}
Channel: {channel}

Write a 3-touch outreach sequence:

**Touch 1 (Day 1):** Connection/first message
- Max 300 chars (LinkedIn) or 3 sentences (email)
- Lead with THEIR problem, not our service
- Zero sales pressure — you're starting a conversation

**Touch 2 (Day 4):** Value add
- Share something genuinely useful (insight, tool, resource)
- Soft reference to our work — don't pitch
- Max 150 words

**Touch 3 (Day 10):** Gentle close
- One specific CTA: "15-min call?" or "Can I show you what I built for [similar company]?"
- Reference both previous touches
- Max 100 words

Tone rules: Direct and confident. Not desperate. Peer-to-peer.
NO: "I hope this finds you well" / "I wanted to reach out" / filler phrases."""

    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# AGENT 3: Pipeline MD — track and report revenue pipeline
# ═══════════════════════════════════════════════════════════════════════════════

def generate_pipeline_report(company_name: str) -> str:
    """
    Weekly revenue pipeline report: what's in progress, what's close to close.
    Reads from companies memory ChromaDB for deal context.
    """
    comp = get_company(company_name)
    if not comp: return ""
    col = get_collection(comp.memory_collection)

    pipeline_data = recall(col, "prospect deal proposal sent client interested", n_results=8)
    context = "\n".join(pipeline_data) if pipeline_data else "No active deals in memory yet."

    prompt = f"""You are the Pipeline MD for {company_name.title()}. Review the current revenue situation.

Pipeline data from agent memory:
{context}

Generate a weekly pipeline report:

## {company_name.title()} Revenue Pipeline — {date.today()}

### 💰 Pipeline Summary
| Stage | Count | Est. Value |
|---|---|---|
| Leads identified | ? | ? |
| Outreach sent | ? | ? |
| In conversation | ? | ? |
| Proposal sent | ? | ? |
| Closing | ? | ? |

(Fill with best estimate from context, mark unknown as "?" with tracking note)

### 🎯 This Week's Revenue Goal
[Based on what's in pipeline, what's realistic to close this week?]

### 🔴 Deals at Risk
[Any that went cold? Recommended re-engagement action]

### 📋 3 Revenue Actions for Tomorrow
1. 
2. 
3."""

    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# WEBSITE ANALYSIS: What should turicks.com be doing?
# ═══════════════════════════════════════════════════════════════════════════════

async def analyze_website_strategy(company_name: str) -> str:
    """Analyses company website positioning and recommends revenue improvements."""
    comp = get_company(company_name)
    if not comp: return ""
    icp_context = str(comp.profile)

    prompt = get_prompt("WEBSITE_AUDIT", company_website=f"{company_name} website", icp_context=icp_context)
    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN PIPELINE — Weekly Revenue Brief
# ═══════════════════════════════════════════════════════════════════════════════

async def run_weekly_revenue_brief():
    """Wednesday 09:00 — Full revenue brief: opportunities + pipeline + website."""
    log.info("💰 Running weekly revenue brief for all companies...")

    for comp in get_all_companies():
        # Skip checking revenue for board/cross
        if comp.name == "cross": continue

        opportunities = scan_for_opportunities(comp.name)
        pipeline = generate_pipeline_report(comp.name)
        website  = await analyze_website_strategy(comp.name)

        report = f"""💰 *{comp.name.title()} Revenue Brief — {date.today()}*

{str(opportunities)[:1000]}

---

{str(pipeline)[:800]}

---
**Website Strategy:**
{str(website)[:500]}

---
_Reply "outreach: [prospect description]" to generate a personalised sequence._"""

        await bot.send_message(
            chat_id=TELEGRAM_CHAT_ID,
            text=str(report)[:4000],
            message_thread_id=comp.telegram_topic_id or TOPIC_BOARDROOM,
            parse_mode="Markdown"
        )
        log.info(f"✅ Revenue brief sent to #{comp.name} topic")


if __name__ == "__main__":
    if "--now" in sys.argv:
        asyncio.run(run_weekly_revenue_brief())
    elif "--website" in sys.argv:
        import asyncio
        print(asyncio.run(analyze_website_strategy("turicks")))
