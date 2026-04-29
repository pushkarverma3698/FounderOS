"""
FounderOS — Day-in-the-Life E2E Telegram Test Suite
=====================================================
Simulates 17 realistic tasks a founder sends across all 5 topics.
Run AFTER starting telegram_gateway.py.

Usage:
    python .c-suite/test_e2e_telegram_tasks.py

Each message fires with a 3-second gap to avoid rate limits.
Watch your Telegram group for Kai's responses.

Topics tested:
  - #The_Boardroom  (2)  → 10 tests
  - #The_Think_Tank (3)  → 2 tests
  - #Turicks_Floor  (4)  → 2 tests
  - #Naggar_HQ      (5)  → 2 tests
  - #Social_Command (6)  → 1 test
"""

import asyncio
import sys
import os
import time
import logging
from datetime import datetime

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from core.config import TOPIC_BOARDROOM, TOPIC_THINK_TANK, TOPIC_TURICKS, TOPIC_NAGGAR, TOPIC_SOCIAL
from aiogram import Bot

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("E2E-Test")

# ─── Test Scenarios ───────────────────────────────────────────────────────────
# Format: (test_id, topic_id, topic_name, message, expected_behaviour)
TEST_CASES = [

    # ── BOARDROOM: Quick / conversational ────────────────────────────────────
    (
        "T01", TOPIC_BOARDROOM, "#Boardroom",
        "Hello Kai! What agents do you currently have in your swarm?",
        "Quick reply listing all agents by company"
    ),
    (
        "T02", TOPIC_BOARDROOM, "#Boardroom",
        "What two companies are you managing right now?",
        "Quick reply — Turicks + Naggar Retreat"
    ),
    (
        "T03", TOPIC_BOARDROOM, "#Boardroom",
        "What is today's date and time?",
        "Instant nano reply with current IST timestamp"
    ),
    (
        "T04", TOPIC_BOARDROOM, "#Boardroom",
        "Give me a quick cost summary of our AI stack — which tools are free vs paid?",
        "Quick cost_watchdog briefing from MD cascade"
    ),

    # ── BOARDROOM: Complex / orchestrator tasks ───────────────────────────────
    (
        "T05", TOPIC_BOARDROOM, "#Boardroom",
        "Write a professional proposal for an AI automation project for a UK-based e-commerce brand. "
        "They need a product recommendation engine and an automated customer support bot. Budget: £8,000.",
        "Full 4-phase orchestrator → proposal_writer → result in #Turicks_Floor"
    ),
    (
        "T06", TOPIC_BOARDROOM, "#Boardroom",
        "Find the top 5 revenue opportunities for Turicks this week. Focus on Upwork, LinkedIn, and ProductHunt.",
        "Orchestrator → revenue_scout agent → research + results"
    ),
    (
        "T07", TOPIC_BOARDROOM, "#Boardroom",
        "Run a full SEO audit on turicks.com — give me the top 3 technical issues and keyword gaps.",
        "Orchestrator → seo_specialist → Firecrawl scrape + analysis"
    ),
    (
        "T08", TOPIC_BOARDROOM, "#Boardroom",
        "Write a cold outreach email to a SaaS founder in Berlin who runs a €500K ARR HR tool. "
        "They mentioned on LinkedIn they're overwhelmed with manual reporting.",
        "Orchestrator → outreach_agent → personalised email draft"
    ),
    (
        "T09", TOPIC_BOARDROOM, "#Boardroom",
        "Create an Instagram Reel script for Naggar Retreat about the spring raspberry blossom season.",
        "Orchestrator → vibe_designer → Naggar content → result in #Naggar_HQ"
    ),
    (
        "T10", TOPIC_BOARDROOM, "#Boardroom",
        "Implement a pricing strategy for Naggar Retreat's peak season (May–August). "
        "Consider competitor rates and suggest dynamic pricing tiers.",
        "Orchestrator → booking_concierge + market_scout → strategy doc"
    ),

    # ── THINK TANK: Deep research ─────────────────────────────────────────────
    (
        "T11", TOPIC_THINK_TANK, "#ThinkTank",
        "Research the best AI agent frameworks in 2025 — compare LangGraph, AutoGen, CrewAI, and OpenAI Swarms.",
        "Deep research cascade — structured comparison report"
    ),
    (
        "T12", TOPIC_THINK_TANK, "#ThinkTank",
        "What are the top 5 emerging business models for AI agencies in 2025? "
        "Focus on how solo founders 1-person shops are building $500K+ revenue.",
        "Deep research — strategic market intelligence report"
    ),

    # ── TURICKS FLOOR: Direct agent / context ────────────────────────────────
    (
        "T13", TOPIC_TURICKS, "#Turicks_Floor",
        "Update: Turicks now specializes in RAG systems, LangGraph agentic pipelines, and WhatsApp automation. "
        "Our new ICP is fintech and e-commerce brands in the EU with $200K–$2M ARR.",
        "Context update → turicks profile updated in ChromaDB"
    ),
    (
        "T14", TOPIC_TURICKS, "#Turicks_Floor",
        "What is Turicks' current ICP and pricing structure?",
        "Turicks MD direct reply from profile + memory"
    ),

    # ── NAGGAR HQ: Farm / retreat ops ────────────────────────────────────────
    (
        "T15", TOPIC_NAGGAR, "#Naggar_HQ",
        "What's the current frost risk forecast for the Naggar farm this week? "
        "Should we take any protective action for the raspberries?",
        "Naggar MD → farm_weather agent response"
    ),
    (
        "T16", TOPIC_NAGGAR, "#Naggar_HQ",
        "Draft a warm welcome message for guests checking in tomorrow — "
        "a family of 4 from Delhi celebrating an anniversary. Include activity suggestions.",
        "Naggar MD → booking_concierge → personalised welcome note"
    ),

    # ── SOCIAL COMMAND: Content ───────────────────────────────────────────────
    (
        "T17", TOPIC_SOCIAL, "#Social_Command",
        "Draft 3 Instagram captions for Turicks this week. "
        "Theme: how AI agents are replacing repetitive business tasks. Include CTAs.",
        "Social handler → 3 captions with hooks and hashtags"
    ),
]


# ─── Runner ───────────────────────────────────────────────────────────────────

async def run_e2e_suite():
    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    results = []
    
    print("\n" + "="*65)
    print("  🚀 FounderOS Day-in-the-Life E2E Test Suite")
    print(f"  📡 Target Chat:  {TELEGRAM_CHAT_ID}")
    print(f"  🕐 Started at:   {datetime.now().strftime('%H:%M:%S IST')}")
    print(f"  📋 Total Tests:  {len(TEST_CASES)}")
    print("="*65 + "\n")

    try:
        me = await bot.get_me()
        print(f"✅  Bot connected as @{me.username}\n")
        
        # Fire the gateway boot notification first (non-fatal if thread ID wrong)
        try:
            await bot.send_message(
                chat_id=TELEGRAM_CHAT_ID,
                text=(
                    "🧪 *FounderOS E2E Test Suite Starting*\n\n"
                    f"Firing {len(TEST_CASES)} day-in-life test messages across all 5 topics.\n"
                    "Watch for Kai's responses in each topic thread.\n\n"
                    f"_Started at {datetime.now().strftime('%H:%M IST')}_"
                ),
                message_thread_id=TOPIC_BOARDROOM,
                parse_mode="Markdown"
            )
            print(f"✅  Boot notification sent to #Boardroom\n")
        except Exception as e:
            print(f"⚠️  Boot notification failed (thread ID issue?): {e}\n   Continuing with tests...\n")
        await asyncio.sleep(2)

        for test_id, topic_id, topic_name, message, expected in TEST_CASES:
            print(f"  [{test_id}] → {topic_name}")
            print(f"         Message: {message[:70]}...")
            print(f"         Expects: {expected[:60]}...")

            try:
                await bot.send_message(
                    chat_id=TELEGRAM_CHAT_ID,
                    message_thread_id=topic_id,
                    text=message,
                )
                results.append({"id": test_id, "topic": topic_name, "status": "SENT", "message": message[:60]})
                print(f"         ✅ SENT\n")
            except Exception as e:
                results.append({"id": test_id, "topic": topic_name, "status": "FAILED", "error": str(e)})
                print(f"         ❌ FAILED: {e}\n")
            
            # Staggered delay: quick tests 3s, complex orchestrator tasks 5s
            if test_id in ("T05", "T06", "T07", "T08", "T09", "T10"):
                await asyncio.sleep(5)  # Give orchestrator more breathing room
            else:
                await asyncio.sleep(3)

        # ── Final Summary ─────────────────────────────────────────────────────
        sent    = [r for r in results if r["status"] == "SENT"]
        failed  = [r for r in results if r["status"] == "FAILED"]
        
        print("\n" + "="*65)
        print("  📋 E2E TEST SUITE — FINAL DELIVERY REPORT")
        print("="*65)
        print(f"  ✅  Delivered:  {len(sent)}/{len(TEST_CASES)} messages")
        print(f"  ❌  Failed:     {len(failed)}/{len(TEST_CASES)} messages")
        
        if failed:
            print("\n  ⚠️  FAILURES:")
            for r in failed:
                print(f"     {r['id']} [{r['topic']}]: {r.get('error', '?')}")
        
        print("\n  ⏳  All messages delivered to Telegram.")
        print("  📱  Check your 5 topics for Kai's responses.")
        print("\n  TOPIC BREAKDOWN:")
        
        by_topic = {}
        for r in results:
            k = r["topic"]
            by_topic.setdefault(k, []).append(r["id"])
        for topic, ids in by_topic.items():
            print(f"     {topic}: {', '.join(ids)}")
        
        print("="*65 + "\n")
        
        # Send summary to boardroom (non-fatal)
        summary_text = (
            "✅ *E2E Test Suite Complete*\n\n"
            f"*Delivered:* {len(sent)}/{len(TEST_CASES)} messages\n"
            f"*Failed:*    {len(failed)}/{len(TEST_CASES)}\n\n"
            "*Topics covered:* Boardroom, Think Tank, Turicks, Naggar, Social\n"
            "_Check each topic thread for agent responses._"
        )
        try:
            await bot.send_message(
                chat_id=TELEGRAM_CHAT_ID,
                text=summary_text,
                message_thread_id=TOPIC_BOARDROOM,
                parse_mode="Markdown"
            )
        except Exception as e:
            print(f"⚠️  Summary notification failed: {e}")

    except Exception as e:
        print(f"\n❌ FATAL: Could not connect to Telegram: {e}")
        print("   Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .c-suite/.env")

    finally:
        await bot.session.close()


if __name__ == "__main__":
    # Quick validation before running
    from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TOPIC_BOARDROOM
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("❌ ERROR: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env")
        sys.exit(1)
    if TOPIC_BOARDROOM == 0:
        print("❌ ERROR: TOPIC_BOARDROOM=0 — set topic IDs in .env before running")
        sys.exit(1)
    
    asyncio.run(run_e2e_suite())
