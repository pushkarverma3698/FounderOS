"""
FounderOS — Cost Watchdog Agent
================================
The CFO of FounderOS. Reports directly to the Chairman.

Runs every Sunday at 22:00. Audits:
1. Every tool in TOOLS registry from config.py
2. Researches FREE alternatives for any paid tool
3. Monitors for new free tiers or pricing changes
4. Flags tools we're paying for but not using
5. Calculates estimated monthly spend
6. Produces a "Cost Optimization Report" directly to #The_Boardroom

Philosophy: Every $$$ tool must justify its cost with a specific, 
measurable output. If a FREE alternative does 80%, switch.
"""

import asyncio, logging, sys, os
from datetime import datetime, date
sys.path.insert(0, str(os.path.dirname(__file__)))

from aiogram import Bot

from core.config import (
    GOOGLE_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_BOARDROOM, MODELS, TOOLS, get_tool_cost_summary, call_md
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("CostWatchdog")
bot   = Bot(token=TELEGRAM_BOT_TOKEN)


# ── Tool Usage Tracker (update this weekly) ───────────────────────────────────
# Set actual_usage = True if we actively used this tool last week
TOOL_USAGE = {
    "claude-3-5-sonnet":    {"used": True,  "frequency": "daily",   "est_cost_month": "$15"},
    "gemini-1.5-flash":     {"used": True,  "frequency": "daily",   "est_cost_month": "$8"},
    "gemini-1.5-pro":       {"used": True,  "frequency": "weekly",  "est_cost_month": "$5"},
    "gemini-flash-8b":      {"used": True,  "frequency": "daily",   "est_cost_month": "$2"},
    "veo-2.0":              {"used": False, "frequency": "never",   "est_cost_month": "$0"},
    "qwen-2.5-7b-mlx":      {"used": True,  "frequency": "daily",   "est_cost_month": "FREE"},
    "chromadb":             {"used": True,  "frequency": "daily",   "est_cost_month": "FREE"},
    "langgraph-sqlite":     {"used": True,  "frequency": "daily",   "est_cost_month": "FREE"},
    "firecrawl":            {"used": False, "frequency": "never",   "est_cost_month": "$0"},
    "duckduckgo-html":      {"used": True,  "frequency": "nightly", "est_cost_month": "FREE"},
    "openweathermap":       {"used": False, "frequency": "planned", "est_cost_month": "FREE"},
    "google-stitch":        {"used": False, "frequency": "planned", "est_cost_month": "FREE"},
    "figma":                {"used": False, "frequency": "planned", "est_cost_month": "$15"},
    "framer":               {"used": False, "frequency": "planned", "est_cost_month": "$15"},
    "pollinations-ai":      {"used": True,  "frequency": "weekly",  "est_cost_month": "FREE"},
    "ffmpeg":               {"used": True,  "frequency": "weekly",  "est_cost_month": "FREE"},
    "macos-tts":            {"used": True,  "frequency": "weekly",  "est_cost_month": "FREE"},
    "telegram":             {"used": True,  "frequency": "daily",   "est_cost_month": "FREE"},
    "notebooklm":           {"used": False, "frequency": "planned", "est_cost_month": "FREE"},
    "github-mcp":           {"used": False, "frequency": "planned", "est_cost_month": "FREE"},
    "notion-mcp":           {"used": False, "frequency": "planned", "est_cost_month": "$10"},
    "langsmith":            {"used": False, "frequency": "planned", "est_cost_month": "FREE"},
}


# ═══════════════════════════════════════════════════════════════════════════════
# ANALYSIS 1: Cost Audit
# ═══════════════════════════════════════════════════════════════════════════════

def run_cost_audit() -> dict:
    """Analyse all tools and calculate estimated monthly spend."""
    paid_tools   = [(t, m) for t, m in TOOL_USAGE.items() if m["est_cost_month"] not in ("FREE", "$0")]
    unused_paid  = [(t, m) for t, m in paid_tools if not m["used"]]
    free_tools   = [(t, m) for t, m in TOOL_USAGE.items() if m["est_cost_month"] == "FREE"]
    
    # Estimate total monthly spend by summing numeric $ values
    total_monthly = 0
    for _, m in paid_tools:
        raw = m["est_cost_month"].replace("$", "").strip()
        if raw.isdigit():
            total_monthly += int(raw)

    return {
        "paid_tools": paid_tools,
        "unused_paid": unused_paid,
        "free_tools": len(free_tools),
        "total_tools": len(TOOL_USAGE),
        "paid_count": len(paid_tools),
        "total_monthly": total_monthly,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# ANALYSIS 2: Research Free Alternatives (Claude/Gemini powered)
# ═══════════════════════════════════════════════════════════════════════════════

def research_free_alternatives() -> str:
    """LLM-powered research: find cheaper/free alternatives for every paid tool."""
    audit = run_cost_audit()
    paid_list = "\n".join(f"- {t}: {m['est_cost_month']}/mo — {TOOLS.get(t, {}).get('purpose', '')}"
                          for t, m in audit["paid_tools"])

    prompt = f"""You are the CFO of a lean AI agency startup. Audit these paid tools and find free or cheaper alternatives.

Current paid tools:
{paid_list}

For each tool, research and provide:
1. Is there a FREE alternative that covers ≥80% of the use case?
2. What's the switching effort (Low/Medium/High)?
3. Specific recommendation: Keep / Switch / Downgrade / Cancel

Also suggest 3 NEW free tools or practices trending in 2026 that we should add.

Format as a table:
| Tool | Current Cost | Free Alternative | Covers? | Switch Effort | Recommendation |

Then a section:
## 🆕 New Free Tools to Add (2026)
| Tool | What it does | Replaces |"""

    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# ANALYSIS 3: Identify Architecture Cost Savings
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_model_costs() -> str:
    """Specific analysis: are we using the right model tier for each task?"""
    prompt = f"""You are auditing AI model costs for FounderOS (agent architecture).

Current model assignments:
{get_tool_cost_summary()}

Context:
- Claude Sonnet: ~$15/$75 per 1M input/output tokens (most expensive)
- Gemini Flash: ~$0.075/$0.30 per 1M tokens (very cheap)
- Gemini Pro: ~$1.25/$5 per 1M tokens
- Gemini Nano (flash-8b): ~$0.0375/$0.15 per 1M tokens (cheapest cloud)
- Qwen 2.5 7B Local: $0 (runs on M4)
- Veo 2: ~$0.01-0.035 per second of video generated

Analyze:
1. Are any tasks using Claude that Gemini Flash could handle equally well?
2. Which tasks MUST use Claude (can't be downgraded)?
3. Estimate: if we route 60% of current Claude calls to Gemini Flash, monthly saving?
4. What tasks should we push to local Qwen instead of any cloud model?

Output: Specific routing changes with estimated monthly savings."""

    resp = call_md(prompt)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN REPORT: Compile and send to #The_Boardroom
# ═══════════════════════════════════════════════════════════════════════════════

async def generate_cost_report():
    """Full weekly cost watchdog report — sent directly to Chairman in #Boardroom."""
    log.info("💰 Running weekly cost audit...")

    audit        = run_cost_audit()
    alternatives = research_free_alternatives()
    model_audit  = analyze_model_costs()

    # Build the report
    unused_block = ""
    if audit["unused_paid"]:
        unused_block = "⚠️ *UNUSED PAID TOOLS (Stop paying now):*\n"
        for t, m in audit["unused_paid"]:
            unused_block += f"  • {t}: {m['est_cost_month']}/mo — not used last week\n"

    report = f"""💰 *FounderOS Cost Watchdog Report — {date.today()}*

📊 *Stack Overview:*
  Total tools: {audit['total_tools']}
  Free tools: {audit['free_tools']} ({round(audit['free_tools']/audit['total_tools']*100)}%)
  Paid tools active: {audit['paid_count']}
  Estimated monthly spend: ${audit['total_monthly']}

{unused_block}

🔍 *Free Alternatives Research:*
{alternatives[:1200]}

🤖 *Model Cost Analysis:*
{model_audit[:800]}

---
_This report runs every Sunday 22:00. Reply "cost detail" for full breakdown._"""

    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=report[:4000],
        message_thread_id=TOPIC_BOARDROOM,
        parse_mode="Markdown"
    )
    log.info("✅ Cost report sent to #The_Boardroom")
    return report


# ── Nightly alert: flag any unused paid tool ───────────────────────────────────

if __name__ == "__main__":
    import sys
    if "--now" in sys.argv:
        asyncio.run(generate_cost_report())
    else:
        print("Run with --now to execute immediately, or let scheduler.py handle it.")
