"""
FounderOS — Hourly Ideator (Cross-Pollination Background Loop)
=============================================================
Every 60 minutes, searches both ChromaDB collections for synergy opportunities
and posts the result to #The_Think_Tank Telegram topic.
"""

import asyncio, sys, os, logging
sys.path.insert(0, str(os.path.dirname(__file__)))

import anthropic
from aiogram import Bot

from core.config import ANTHROPIC_API_KEY, CEO_MODEL, TELEGRAM_CHAT_ID, TOPIC_THINK_TANK, TELEGRAM_BOT_TOKEN
from memory.memory import cross_company_search

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("FounderOS-Ideator")

claude = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
bot    = Bot(token=TELEGRAM_BOT_TOKEN)

SYNERGY_TOPICS = [
    "automation workflows",
    "marketing content",
    "client communication",
    "data analytics",
    "booking and scheduling",
]


async def run_ideator():
    log.info("💡 Hourly Ideator executing via scheduler.")
    try:
        await generate_insight()
    except Exception as e:
        log.error(f"Ideator error: {e}")


async def generate_insight():
    import random
    topic = random.choice(SYNERGY_TOPICS)
    memories = cross_company_search(topic)

    context_blocks: list[str] = []
    for company_name, mem_list in memories.items():
        text = "\n".join(mem_list) if mem_list else f"No {company_name.title()} memories yet."
        context_blocks.append(f"{company_name.title()} recent context:\n{text}")

    dynamic_context = "\n\n".join(context_blocks)

    from core.prompts import get_system
    # Since HOURLY_IDEATOR prompt accepts {company_name} and {company_profile}, 
    # we can use the generic cross-pollination logic.
    prompt = f"""You are the FounderOS Hourly Ideator for Pushkar Verma's multi-company empire.

{dynamic_context}

Cross-pollination topic: "{topic}"

Generate ONE concise, actionable synergy insight. Format: 
"💡 *Synergy Alert* — [insight in 1-2 sentences]. [specific action Pushkar can take today]."
Keep it under 100 words."""

    response = claude.messages.create(
        model=CEO_MODEL,
        max_tokens=200,
        messages=[{"role": "user", "content": prompt}]
    )

    insight = response.content[0].text
    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=insight,
        message_thread_id=TOPIC_THINK_TANK,
        parse_mode="Markdown"
    )
    log.info(f"Ideator posted: {insight[:60]}...")


if __name__ == "__main__":
    if "--now" in sys.argv:
        asyncio.run(run_ideator())
    else:
        print("Run with --now to execute immediately, or let scheduler.py handle it.")
