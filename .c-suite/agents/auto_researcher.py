"""
FounderOS — Auto-Researcher (Self-Improving Agent Engine)
==========================================================
Runs nightly at 01:00. For each agent, it:

  1. Searches the web for the latest techniques in the agent's domain
  2. Evaluates the finding using Claude as LLM-Judge
  3. If the finding scores ≥ 7/10, it writes a new "skill upgrade" into ChromaDB
  4. Posts a digest to #The_Think_Tank each morning

This makes all 16 agents continuously improve without you doing anything.

Architecture follows the "Agentic RAG + Self-Evolving Loop" pattern (2026):
  Research → Evaluate → Store → Inject (next agent call reads upgraded skills)
"""

import asyncio, sys, os, logging, json
from datetime import datetime, date
sys.path.insert(0, str(os.path.dirname(__file__)))

import anthropic
from aiogram import Bot
import httpx

from core.config import (
    ANTHROPIC_API_KEY, CEO_MODEL, TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID, TOPIC_THINK_TANK
)
from memory.memory import store, recall, get_collection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [AutoResearcher] %(message)s")
log = logging.getLogger("auto_researcher")

claude = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
bot    = Bot(token=TELEGRAM_BOT_TOKEN)

# ─── Research Agenda  ──────────────────────────────────────────────────────────
# Each entry: agent_name, company, ChromaDB collection, search queries to rotate through
RESEARCH_AGENDA = [
    {
        "agent": "bidding_sniper",
        "company": "turicks",
        "collection_name": "turicks_mem",
        "queries": [
            "Upwork winning proposal techniques 2026",
            "freelance AI automation bidding strategy latest",
            "how to win Upwork proposals faster 2026",
            "LangGraph CrewAI freelance demand trends",
        ]
    },
    {
        "agent": "lead_intel",
        "company": "turicks",
        "collection_name": "turicks_mem",
        "queries": [
            "B2B SaaS lead generation AI automation 2026",
            "LinkedIn prospecting techniques for agencies 2026",
            "ICP scoring model best practices",
            "EU tech startup funding trends March 2026",
        ]
    },
    {
        "agent": "senior_dev",
        "company": "turicks",
        "collection_name": "turicks_mem",
        "queries": [
            "Next.js 15 new features best practices 2026",
            "LangGraph 0.4 production patterns",
            "FastAPI performance optimization 2026",
            "AI code review automation techniques",
        ]
    },
    {
        "agent": "proposal_writer",
        "company": "turicks",
        "collection_name": "turicks_mem",
        "queries": [
            "cold email conversion rates B2B 2026",
            "copywriting frameworks sales proposals 2026",
            "LinkedIn DM sequence best practices 2026",
            "case study writing formula high conversion",
        ]
    },
    {
        "agent": "farm_weather",
        "company": "naggar",
        "collection_name": "naggar_mem",
        "queries": [
            "Himachal Pradesh weather forecast Kullu Valley March",
            "raspberry frost protection techniques mountain farming",
            "precision agriculture weather monitoring small farm",
            "IMD Himachal weather alerts agronomic advice",
        ]
    },
    {
        "agent": "yield_scout",
        "company": "naggar",
        "collection_name": "naggar_mem",
        "queries": [
            "European raspberry market price 2026",
            "Dutch berry import wholesale trends",
            "raspberry yield optimization small farm techniques",
            "India EU agricultural export regulations soft fruit",
        ]
    },
    {
        "agent": "booking_concierge",
        "company": "naggar",
        "collection_name": "naggar_mem",
        "queries": [
            "boutique homestay pricing strategy India 2026",
            "Airbnb dynamic pricing small property 2026",
            "Himachal Pradesh tourism booking trends",
            "guest review response templates hospitality",
        ]
    },
    {
        "agent": "vibe_designer",
        "company": "naggar",
        "collection_name": "naggar_mem",
        "queries": [
            "Instagram Reels algorithm 2026 best practices",
            "slow travel content strategy hospitality brand",
            "Substack growth strategy niche newsletter 2026",
            "Pinterest hospitality aesthetic board trends 2026",
        ]
    },
    {
        "agent": "culinary_agent",
        "company": "naggar",
        "collection_name": "naggar_mem",
        "queries": [
            "Himachal Pradesh traditional recipes seasonal 2026",
            "menu engineering food cost optimization restaurant",
            "farm-to-table content marketing trends",
            "North Indian cuisine branding storytelling",
        ]
    },
]


# ─── Core Research Pipeline ─────────────────────────────────────────────────

async def research_one_agent(agenda_item: dict) -> dict | None:
    """Run one full research cycle for one agent."""
    agent      = agenda_item["agent"]
    company    = agenda_item["company"]
    collection = get_collection(agenda_item["collection_name"])
    queries    = agenda_item["queries"]

    # Rotate through queries based on day of week
    day_idx = date.today().weekday()
    query   = queries[day_idx % len(queries)]

    log.info(f"[{agent}] Searching: '{query}'")

    # 1. Web search via DuckDuckGo lite
    search_results = await web_search(query)
    if not search_results:
        log.warning(f"[{agent}] No results for query.")
        return None

    # 2. LLM-as-Judge: evaluate and extract insight
    judgment = await evaluate_and_extract(agent, company, query, search_results)
    if not judgment:
        return None

    if judgment["score"] < 7:
        log.info(f"[{agent}] Low-quality finding (score={judgment['score']}). Skipping.")
        return None

    # 3. Store in ChromaDB under the agent's namespace
    doc_id   = f"{agent}_{date.today()}_{day_idx}"
    metadata = {
        "agent":   agent,
        "company": company,
        "query":   query,
        "score":   str(judgment["score"]),
        "date":    str(date.today()),
        "type":    "auto_research"
    }
    store(collection, doc_id, judgment["insight"], metadata)
    log.info(f"[{agent}] Stored upgrade (score={judgment['score']}): {judgment['insight'][:80]}...")

    return {"agent": agent, "company": company, "insight": judgment["insight"], "score": judgment["score"]}


async def evaluate_and_extract(agent: str, company: str, query: str, raw_text: str) -> dict | None:
    """Use Claude as LLM-Judge to score and extract a usable skill upgrade."""
    prompt = f"""You are a senior AI systems architect reviewing web research for an autonomous agent.

Agent: {agent} (works for {company})
Research query: "{query}"
Raw search results:
{str(raw_text)[:3000]}

Your tasks:
1. Extract ONE specific, actionable insight this agent can apply immediately.
2. Score the insight quality 1-10 (10 = highly specific, immediately actionable, non-obvious).
3. Rewrite the insight as a crisp, expert-level skill upgrade (max 100 words).

Return ONLY this JSON (no markdown, no other text):
{{"score": <int>, "insight": "<skill upgrade text>"}}"""

    try:
        resp = claude.messages.create(
            model=CEO_MODEL,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}]
        )
        from json_repair import repair_json
        return repair_json(resp.content[0].text, return_objects=True)
    except Exception as e:
        log.error(f"Judge failed: {e}")
        return None


async def web_search(query: str) -> str:
    """Lightweight DuckDuckGo HTML search returning top 3 snippets."""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={"User-Agent": "Mozilla/5.0 (FounderOS AutoResearcher)"}
            )
            # Extract text between <a class="result__snippet"> tags (simple approach)
            import re
            snippets = re.findall(r'class="result__snippet">(.*?)</a>', resp.text, re.DOTALL)
            # Clean HTML tags
            clean = [re.sub(r'<[^>]+>', '', s).strip() for s in snippets[:5]]
            return "\n\n".join(clean) if clean else ""
    except Exception as e:
        log.error(f"Search failed: {e}")
        return ""


# ─── Nightly Runner ─────────────────────────────────────────────────────────




async def run_research_cycle():
    """Run research for all agents and post digest to #Think_Tank."""
    log.info("🔬 Starting nightly research cycle...")
    upgrades = []

    for item in RESEARCH_AGENDA:
        try:
            result = await research_one_agent(item)
            if result:
                upgrades.append(result)
        except Exception as e:
            log.error(f"Research failed for {item['agent']}: {e}")
        await asyncio.sleep(2)   # Polite delay between searches

    if upgrades:
        await post_digest(upgrades)
    else:
        log.info("No high-quality upgrades found tonight.")

    log.info(f"✅ Research cycle complete. {len(upgrades)} upgrades stored.")


async def post_digest(upgrades: list[dict]):
    """Post the nightly skill upgrade digest to #The_Think_Tank."""
    lines = ["🔬 *Nightly Skill Upgrade Digest*\n"]
    for u in upgrades:
        emoji = "🏢" if u["company"] == "turicks" else "🌿"
        lines.append(f"{emoji} *{u['agent']}* (score: {u['score']}/10)\n_{u['insight']}_\n")

    message = "\n".join(lines)
    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=str(message)[:4000],   # Telegram limit
        message_thread_id=TOPIC_THINK_TANK,
        parse_mode="Markdown"
    )


# ─── Manual trigger for testing ──────────────────────────────────────────────

async def run_once():
    """Run one full research cycle immediately (for testing)."""
    log.info("Running one-shot research cycle...")
    await run_research_cycle()


if __name__ == "__main__":
    import sys
    if "--now" in sys.argv:
        asyncio.run(run_once())
    else:
        print("Run with --now to execute immediately, or let scheduler.py handle it.")
