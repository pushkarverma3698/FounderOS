"""
FounderOS — All-Agent Telegram Connectivity Test
================================================
Iterates through EVERY agent in registry.py and sends a handshake message
to verify the bot has correct topic permissions for each agent.
"""

import asyncio
import os
import sys
import logging

# Ensure FounderOS modules can be imported
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__))))

from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from core.registry import get_all_agents, get_agent_topic_id
from aiogram import Bot

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("HandshakeTest")

async def test_all_agents():
    print(f"🚀 Starting FounderOS Global Agent Handshake...")
    print(f"Chat ID: {TELEGRAM_CHAT_ID}")
    
    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    agents = get_all_agents()
    
    print(f"📡 Found {len(agents)} agents in registry.")
    
    results = []
    
    try:
        me = await bot.get_me()
        print(f"\n✅ Connected as Bot: @{me.username}")
        
        # We group by topic_id to avoid sending redundant messages to the same topic 
        # (Though the user asked for "each agent", we will list the agents reporting to that topic)
        topic_groups = {}
        for agent in agents:
            tid = get_agent_topic_id(agent.name)
            if tid not in topic_groups:
                topic_groups[tid] = []
            topic_groups[tid].append(agent.name)
            
        print(f"\n📦 Grouped agents into {len(topic_groups)} target topics.")
        
        for topic_id, agent_list in topic_groups.items():
            agent_names = ", ".join([f"`{a}`" for a in agent_list])
            print(f"   -> Sending handshake to Thread ID {topic_id} for agents: {agent_list}...", end=" ")
            
            try:
                text = (
                    f"🛡️ **Global Handshake: Connectivity Verified**\n\n"
                    f"The following agents are now confirmed for real-time reporting:\n"
                    f"{agent_names}\n\n"
                    f"Topic ID: `{topic_id}` | Status: ✅ **Active**"
                )
                
                await bot.send_message(
                    chat_id=TELEGRAM_CHAT_ID,
                    message_thread_id=topic_id,
                    text=text,
                    parse_mode="Markdown"
                )
                print("SUCCESS!")
                results.append({"topic_id": topic_id, "status": "SUCCESS", "agents": agent_list})
            except Exception as e:
                print(f"FAILED! Error: {type(e).__name__} - {str(e)}")
                results.append({"topic_id": topic_id, "status": "FAILED", "error": str(e), "agents": agent_list})
                
    except Exception as e:
        print(f"\n❌ FATAL Connectivity Error: {e}")
    
    finally:
        await bot.session.close()
        
    # --- Summary ---
    print("\n" + "="*50)
    print("📋 FINAL CONNECTIVITY SUMMARY")
    print("="*50)
    success = [r for r in results if r["status"] == "SUCCESS"]
    failed  = [r for r in results if r["status"] == "FAILED"]
    
    print(f"✅ Successful Channels: {len(success)}")
    print(f"❌ Failed Channels:     {len(failed)}")
    
    if failed:
        print("\n⚠️ FAILURES DETECTED:")
        for r in failed:
            print(f"   - Topic {r['topic_id']} (Agents: {r['agents']}): {r['error']}")
    else:
        print("\n💎 All agent communication channels are fully operational.")

if __name__ == "__main__":
    asyncio.run(test_all_agents())
