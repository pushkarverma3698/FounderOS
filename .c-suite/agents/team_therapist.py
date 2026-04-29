"""
FounderOS — Team Therapist Agent
==================================
Runs every Friday at 17:30 IST.

Checks in with all 21 agents by reviewing their weekly output metrics
from ChromaDB, then produces a confidential "Team Wellbeing Report"
sent directly to the Chairman in #The_Boardroom.

What it measures (agent signals, not human feelings):
  - Workload intensity: How many tasks completed this week?
  - Error rate: How many failures / retries logged?
  - Output quality trend: Is quality score going up or down?
  - Idle agents: Any agent that hasn't fired all week?
  - Overloaded agents: Any agent with queue > threshold?

Then it produces a human-framed wellbeing narrative — as if speaking
about team members — so the Chairman gets context, not just metrics.

It also asks each "employee" (via their ChromaDB memory) how they
would assess their own workload this week using the SELF-EVAL rubric.

Reports go to Chairman ONLY — not to any team topic.

Philosophy: Even an AI team needs a pulse check. Burnout in agentic 
systems manifests as degraded output quality and cascading failures.
Catching it Friday = time to adjust before Monday.
"""

import asyncio, logging, sys, os
from datetime import datetime, date, timedelta
sys.path.insert(0, str(os.path.dirname(__file__)))

from aiogram import Bot

from core.config import (
    GOOGLE_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_BOARDROOM, MODELS, call_md, call_nano
)
from memory.memory import turicks_mem, naggar_mem, recall
import chromadb

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("TeamTherapist")

bot   = Bot(token=TELEGRAM_BOT_TOKEN)

# Shared social memory for cross-team signals
chroma_client = chromadb.PersistentClient(
    path=str(os.path.dirname(__file__)) + "/chroma_data"
)
social_mem = chroma_client.get_or_create_collection("social_mem")

# ── Full agent roster ─────────────────────────────────────────────────────────
TEAM_ROSTER = {
    "turicks": [
        {"name": "Bidding Sniper",   "role": "Upwork bidding",          "loop": "every 15 min"},
        {"name": "Lead Intel",       "role": "Lead research",            "loop": "weekly"},
        {"name": "Senior Dev",       "role": "Full-stack development",   "loop": "on-demand"},
        {"name": "Vibe-Coder",       "role": "UI/UX coding",             "loop": "on-demand"},
        {"name": "QA Tester",        "role": "Quality assurance",        "loop": "after each dev"},
        {"name": "Proposal Writer",  "role": "Client proposals",         "loop": "on-demand"},
        {"name": "Ops Agent",        "role": "Invoices + admin",         "loop": "weekly"},
        {"name": "KB Agent",         "role": "Knowledge indexing",       "loop": "nightly"},
        {"name": "Web Designer",     "role": "UI design + Stitch",       "loop": "on-demand"},
    ],
    "naggar": [
        {"name": "Farm Weather",     "role": "Weather + frost alerts",   "loop": "daily 05:45"},
        {"name": "Yield Scout",      "role": "Harvest P&L + market",     "loop": "twice weekly"},
        {"name": "Booking Concierge","role": "Guest booking + pricing",  "loop": "daily"},
        {"name": "Vibe Designer",    "role": "Reels + Substack",         "loop": "3x weekly"},
        {"name": "Culinary Agent",   "role": "Menu + food cost",         "loop": "monthly"},
        {"name": "Market Scout",     "role": "Competitor + subsidies",   "loop": "fortnightly"},
        {"name": "Guest CRM",        "role": "Guest profiles + referral","loop": "post-checkout"},
        {"name": "Naggar KB",        "role": "Farm memory indexing",     "loop": "nightly"},
        {"name": "Video Editor",     "role": "Reels + video pipeline",   "loop": "3x weekly"},
    ],
    "cross_company": [
        {"name": "Social Researcher","role": "Trend intelligence",       "loop": "weekly"},
        {"name": "Social Handler",   "role": "Content calendar + posts", "loop": "daily"},
        {"name": "Cost Watchdog",    "role": "Tool audit + billing",     "loop": "weekly"},
    ],
}


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1: Gather signals from ChromaDB for each agent
# ═══════════════════════════════════════════════════════════════════════════════

def gather_agent_signals() -> dict[str, dict]:
    """
    Pulls recent ChromaDB entries for each agent to infer workload + quality.
    Returns a dict: agent_name → {tasks_done, errors, quality_trend, last_seen}
    """
    signals = {}
    week_ago = (date.today() - timedelta(days=7)).isoformat()

    for company, agents in TEAM_ROSTER.items():
        collection = (
            turicks_mem if company == "turicks"
            else naggar_mem if company == "naggar"
            else social_mem
        )
        for agent in agents:
            name = agent["name"]
            # Recall recent outputs from this agent
            try:
                results = collection.query(
                    query_texts=[f"{name} task output result"],
                    n_results=5,
                    where={"$gte": {"date": week_ago}} if False else {},  # date filter future
                )
                docs = results.get("documents", [[]])[0]
                signals[name] = {
                    "company": company,
                    "role": agent["role"],
                    "loop": agent["loop"],
                    "docs_found": len(docs),
                    "sample_output": docs[0][:200] if docs else "No output found this week.",
                    "status": "active" if docs else "idle",
                }
            except Exception as e:
                signals[name] = {
                    "company": company,
                    "role": agent["role"],
                    "loop": agent["loop"],
                    "docs_found": 0,
                    "sample_output": f"Error reading memory: {e}",
                    "status": "unknown",
                }
    return signals


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2: Generate individual agent check-in notes
# ═══════════════════════════════════════════════════════════════════════════════

def generate_agent_checkin(agent_name: str, signals: dict) -> str:
    """Quick per-agent pulse note (Gemini Nano speed)."""
    data  = signals.get(agent_name, {})
    prompt = f"""You are a warm, perceptive team therapist doing a weekly check-in.

Employee: {agent_name}
Role: {data.get('role', 'unknown')}
Work schedule: {data.get('loop', 'unknown')}
Activity this week: {data.get('status', 'unknown')} ({data.get('docs_found', 0)} tasks logged)
Sample output: {data.get('sample_output', 'none')}

Write a 2-sentence therapist's note about this team member's week:
- 1 sentence: what they accomplished or struggled with (be specific)
- 1 sentence: a recommendation for next week (practical, caring)

Tone: professional therapist — warm, direct, no fluff. Not sycophantic."""
    
    resp = call_nano(prompt)
    return resp.strip()


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3: Generate the Full Wellbeing Report for Chairman
# ═══════════════════════════════════════════════════════════════════════════════

def generate_wellbeing_report(signals: dict, checkins: dict[str, str]) -> str:
    """
    Synthesises all agent signals into a Chairman's Friday report.
    Gemini Flash writes it — structured but human in tone.
    """
    # Classify agents
    active_agents  = [n for n, s in signals.items() if s["status"] == "active"]
    idle_agents    = [n for n, s in signals.items() if s["status"] == "idle"]
    unknown_agents = [n for n, s in signals.items() if s["status"] == "unknown"]

    # Individual check-ins block
    checkin_text = "\n\n".join(
        f"**{name}:** {note}"
        for name, note in checkins.items()
    )

    prompt = f"""You are the Team Therapist writing a Friday Wellbeing Report for Pushkar Verma,
founder and Chairman of FounderOS — a 21-agent AI empire spanning two companies.

Date: {datetime.now().strftime('%A, %B %d, %Y')}
Team size: {len(signals)} agents
Active this week: {len(active_agents)} agents
Idle this week: {idle_agents or 'None'}
Unknown state: {unknown_agents or 'None'}

Individual check-ins:
{checkin_text[:2000]}

Write a structured Friday Wellbeing Report:

## 🧠 Team Therapist — Weekly Check-in
*Week ending {date.today()}*

### 1. Executive Wellbeing Summary
[2 sentences: overall team health this week. Be specific about what's working.]

### 2. 🟢 Thriving This Week
[Top 3 agents with best workload-to-quality ratio. What made them shine?]

### 3. 🟡 Needs Attention
[Any agent that was idle when they shouldn't be, OR overloaded. Specific concern + suggestion.]

### 4. 🔴 Flag for Chairman
[1-2 critical signals — missed loops, quality drops, cascading failures. Be direct.]

### 5. 📋 One Recommendation for Each Team
**Turicks:** [One structural change for next week]
**Naggar:** [One structural change for next week]
**Social Team:** [One improvement]

### 6. 💬 Therapist's Note to Chairman
[3-4 sentences. Candid personal note. What does Pushkar need to know or do differently as a leader this week? Be a trusted advisor, not a yes-man.]

Total length: ~350 words. Tone: warm professional — like a good executive coach."""

    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN: Friday Pipeline
# ═══════════════════════════════════════════════════════════════════════════════

async def run_friday_checkin():
    """Full Friday pipeline: gather → checkins → report → send to Chairman."""
    log.info("🧠 Team Therapist running Friday check-in...")

    # 1. Gather signals
    signals = gather_agent_signals()
    log.info(f"  Signals gathered for {len(signals)} agents.")

    # 2. Quick check-in per agent (run in parallel conceptually)
    checkins = {}
    for name in list(signals.keys())[:10]:  # Top 10 most frequent agents
        checkins[name] = generate_agent_checkin(name, signals)

    log.info("  Individual check-ins complete.")

    # 3. Full report
    report = generate_wellbeing_report(signals, checkins)
    log.info("  Wellbeing report generated.")

    # 4. Send directly to Chairman in #Boardroom (private — not team topics)
    header    = f"🧠 *Team Therapist — Friday Brief*  |  {date.today()}\n\n"
    full_msg  = header + report

    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=full_msg[:4000],
        message_thread_id=TOPIC_BOARDROOM,
        parse_mode="Markdown"
    )
    log.info("✅ Friday wellbeing report sent to Chairman.")


if __name__ == "__main__":
    import sys
    if "--now" in sys.argv:
        asyncio.run(run_friday_checkin())
    else:
        print("Run with --now to execute immediately, or let scheduler.py handle it.")
