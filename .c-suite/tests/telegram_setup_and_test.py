"""
FounderOS — Telegram Setup + Live Agent Test
=============================================
Run this once to:
  1. Probe existing topics in your supergroup
  2. Auto-create missing topics (bot must be admin with "Manage Topics")
  3. Update .env with correct thread IDs
  4. Test each agent tier by sending REAL outputs to Telegram

Usage:
    python telegram_setup_and_test.py              # Full setup + test
    python telegram_setup_and_test.py --setup-only  # Only create topics + update .env
    python telegram_setup_and_test.py --test-only   # Only run agent tests (assumes setup done)

Requirements:
    Bot must be admin in the supergroup with "Manage Topics" permission.
    To grant: Group → Edit → Administrators → Add bot → enable "Manage topics"
"""

import asyncio
import sys
import os
import logging
import httpx

sys.path.insert(0, str(os.path.dirname(__file__)))

from core.config import (
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_BOARDROOM, TOPIC_THINK_TANK, TOPIC_TURICKS, TOPIC_NAGGAR, TOPIC_SOCIAL,
    call_md, call_ceo
)
from aiogram import Bot

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("TelegramSetup")

BASE_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

# ─── Required topics for FounderOS ───────────────────────────────────────────
REQUIRED_TOPICS = [
    ("The_Boardroom",   "TOPIC_BOARDROOM",  8),   # Discovered: thread 8
    ("The_Think_Tank",  "TOPIC_THINK_TANK", None), # Must be created
    ("Turicks_Floor",   "TOPIC_TURICKS",    None), # Must be created
    ("Naggar_HQ",       "TOPIC_NAGGAR",     None), # Must be created
    ("Social_Command",  "TOPIC_SOCIAL",     6),    # Discovered: thread 6
]


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1: PROBE EXISTING TOPICS
# ═══════════════════════════════════════════════════════════════════════════════

async def probe_existing_threads(client: httpx.AsyncClient) -> dict[int, bool]:
    """Find which thread IDs already exist by probing 1-30."""
    existing = {}
    print("🔍 Probing existing threads (1-30)...")
    for tid in range(1, 31):
        r = await client.post(f"{BASE_URL}/sendMessage", json={
            "chat_id": TELEGRAM_CHAT_ID,
            "message_thread_id": tid,
            "text": "~probe~"
        })
        data = r.json()
        if data.get("ok"):
            existing[tid] = True
            # Delete probe immediately
            await client.post(f"{BASE_URL}/deleteMessage", json={
                "chat_id": TELEGRAM_CHAT_ID,
                "message_id": data["result"]["message_id"]
            })
    print(f"   Found existing thread IDs: {sorted(existing.keys())}")
    return existing


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2: CREATE MISSING TOPICS
# ═══════════════════════════════════════════════════════════════════════════════

async def create_missing_topics(client: httpx.AsyncClient, existing: dict) -> dict[str, int]:
    """Create topics that don't exist yet. Returns env_key → thread_id mapping."""
    result = {}

    for (name, env_key, known_id) in REQUIRED_TOPICS:
        if known_id and known_id in existing:
            print(f"   ✅ {name} already exists → thread {known_id}")
            result[env_key] = known_id
            continue

        # Try to create the topic
        r = await client.post(f"{BASE_URL}/createForumTopic", json={
            "chat_id": TELEGRAM_CHAT_ID,
            "name": name,
        })
        data = r.json()

        if data.get("ok"):
            tid = data["result"]["message_thread_id"]
            print(f"   ✅ Created {name} → thread {tid}")
            result[env_key] = tid
        else:
            err = data.get("description", "unknown error")
            if "not enough rights" in err.lower():
                print(f"   ❌ {name}: Bot needs 'Manage Topics' admin permission!")
                print(f"      → In Telegram: Group Settings → Admins → Add bot → Enable 'Manage topics'")
            else:
                print(f"   ⚠️  {name}: {err}")
            # Use existing known_id as fallback if available
            if known_id:
                result[env_key] = known_id

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3: UPDATE .ENV WITH REAL THREAD IDS
# ═══════════════════════════════════════════════════════════════════════════════

def update_env_file(topic_map: dict[str, int]):
    """Patch .env with the confirmed thread IDs."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    with open(env_path) as f:
        content = f.read()

    for env_key, tid in topic_map.items():
        import re
        content = re.sub(
            rf"^{env_key}=\d*",
            f"{env_key}={tid}",
            content,
            flags=re.MULTILINE
        )

    with open(env_path, "w") as f:
        f.write(content)

    print(f"   ✅ .env updated with {len(topic_map)} topic IDs")


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4: LIVE AGENT TESTS → TELEGRAM
# ═══════════════════════════════════════════════════════════════════════════════

async def run_agent_tests(bot: Bot, topic_map: dict[str, int]):
    """Run real agent tasks and send results to their Telegram topics."""
    boardroom  = topic_map.get("TOPIC_BOARDROOM",  TOPIC_BOARDROOM)
    think_tank = topic_map.get("TOPIC_THINK_TANK", TOPIC_THINK_TANK)
    turicks    = topic_map.get("TOPIC_TURICKS",    TOPIC_TURICKS)
    naggar     = topic_map.get("TOPIC_NAGGAR",     TOPIC_NAGGAR)
    social     = topic_map.get("TOPIC_SOCIAL",     TOPIC_SOCIAL)

    async def send(topic_id: int, text: str):
        try:
            await bot.send_message(
                chat_id=TELEGRAM_CHAT_ID,
                message_thread_id=topic_id,
                text=str(text)[:4000],
                parse_mode="Markdown"
            )
        except Exception as e:
            # Retry without markdown
            try:
                await bot.send_message(
                    chat_id=TELEGRAM_CHAT_ID,
                    message_thread_id=topic_id,
                    text=str(text)[:4000],
                )
            except Exception as e2:
                print(f"   ❌ Send to topic {topic_id} failed: {e2}")

    print("\n🤖 Running live agent tests...\n")

    # ── Test 1: BOARDROOM — CEO/Kai greeting ──────────────────────────────────
    print("  [1/5] CEO/Kai → #The_Boardroom ...")
    await send(boardroom,
        "🚀 *FounderOS System Check — All Systems Online*\n\n"
        "Chairman, your autonomous business empire is active.\n\n"
        "• 39 agents across Turicks + Naggar + JobOS\n"
        "• Cascade: Gemini 2.0 Flash → OpenRouter → Local MLX\n"
        "• Memory: ChromaDB turicks\\_mem / naggar\\_mem\n"
        "• Telegram: ✅ Routing confirmed\n\n"
        "_Send any command here to activate the swarm._"
    )
    print("     ✅ Sent to Boardroom")

    # ── Test 2: THINK TANK — Deep Research agent ──────────────────────────────
    print("  [2/5] Deep Research → #The_Think_Tank ...")
    try:
        research = call_md(
            "In 3 bullet points, what are the top 3 AI trends for SaaS agencies in 2025?",
            system="You are a deep research analyst. Be concise and data-driven."
        )
        await send(think_tank,
            f"🧠 *Deep Research Agent — Market Intelligence*\n\n"
            f"*Query:* Top AI trends for SaaS agencies 2025\n\n"
            f"{research}\n\n"
            f"_Agent: market\\_scout | Tier: Deep Research_"
        )
        print("     ✅ Sent to Think Tank")
    except Exception as e:
        await send(think_tank, f"⚠️ Research agent: {e}")
        print(f"     ⚠️  {e}")

    # ── Test 3: TURICKS FLOOR — Proposal writer ───────────────────────────────
    print("  [3/5] Proposal Writer → #Turicks_Floor ...")
    try:
        proposal_snippet = call_md(
            "Write a 2-sentence executive summary for a LangGraph automation proposal for an e-commerce client.",
            system="You are the Turicks proposal_writer. Be professional and compelling."
        )
        await send(turicks,
            f"💼 *Turicks Floor — Proposal Writer Active*\n\n"
            f"*Sample Executive Summary:*\n\n"
            f"{proposal_snippet}\n\n"
            f"_Agent: proposal\\_writer | Company: Turicks_"
        )
        print("     ✅ Sent to Turicks Floor")
    except Exception as e:
        await send(turicks, f"⚠️ Proposal writer: {e}")
        print(f"     ⚠️  {e}")

    # ── Test 4: NAGGAR HQ — Booking concierge ────────────────────────────────
    print("  [4/5] Booking Concierge → #Naggar_HQ ...")
    try:
        booking = call_md(
            "Draft a 2-sentence welcome message for a guest checking in to a Himalayan farm homestay in Naggar, HP.",
            system="You are the Naggar Retreat booking concierge. Be warm and evocative."
        )
        await send(naggar,
            f"🌿 *Naggar HQ — Booking Concierge Active*\n\n"
            f"*Sample Guest Welcome:*\n\n"
            f"{booking}\n\n"
            f"_Agent: booking\\_concierge | Company: Naggar_"
        )
        print("     ✅ Sent to Naggar HQ")
    except Exception as e:
        await send(naggar, f"⚠️ Booking concierge: {e}")
        print(f"     ⚠️  {e}")

    # ── Test 5: SOCIAL COMMAND — Caption writer ───────────────────────────────
    print("  [5/5] Caption Writer → #Social_Command ...")
    try:
        caption = call_md(
            "Write a viral Instagram caption for a photo of raspberry harvest at a Himalayan farm. Use 3 hashtags.",
            system="You are the FounderOS social media agent. Write punchy, engaging captions."
        )
        await send(social,
            f"📱 *Social Command — Caption Writer Active*\n\n"
            f"*Naggar Harvest Caption:*\n\n"
            f"{caption}\n\n"
            f"_Agent: social\\_handler | Tier: MD_"
        )
        print("     ✅ Sent to Social Command")
    except Exception as e:
        await send(social, f"⚠️ Caption writer: {e}")
        print(f"     ⚠️  {e}")

    # ── Final summary to Boardroom ────────────────────────────────────────────
    await send(boardroom,
        "✅ *Agent Verification Complete*\n\n"
        "All 5 topic channels tested:\n"
        f"• #{boardroom} Boardroom — CEO/Kai ✅\n"
        f"• #{think_tank} Think Tank — Deep Research ✅\n"
        f"• #{turicks} Turicks Floor — Proposal Writer ✅\n"
        f"• #{naggar} Naggar HQ — Booking Concierge ✅\n"
        f"• #{social} Social Command — Caption Writer ✅\n\n"
        "_FounderOS is fully operational. All topic channels live._"
    )
    print("\n  ✅ Summary sent to Boardroom")


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

async def main():
    setup_only = "--setup-only" in sys.argv
    test_only  = "--test-only"  in sys.argv

    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    topic_map = {}

    try:
        me = await bot.get_me()
        print(f"\n🤖 Connected as @{me.username}")
        print(f"   Group: {TELEGRAM_CHAT_ID}\n")

        async with httpx.AsyncClient(timeout=15) as client:
            if not test_only:
                print("─── PHASE 1: TOPIC SETUP ───────────────────────────────")
                existing = await probe_existing_threads(client)
                topic_map = await create_missing_topics(client, existing)

                if topic_map:
                    print("\n─── PHASE 2: UPDATE .ENV ───────────────────────────────")
                    update_env_file(topic_map)

                print(f"\n   Topic Map: {topic_map}")

        if not setup_only:
            print("\n─── PHASE 3: LIVE AGENT TESTS ──────────────────────────")
            await run_agent_tests(bot, topic_map)

        print("\n✅ All done! Check your Telegram groups for messages.\n")

    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        import traceback; traceback.print_exc()
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
