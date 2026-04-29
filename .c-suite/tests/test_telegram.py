import asyncio
import os
import sys

# Ensure FounderOS modules can be imported
sys.path.insert(0, str(os.path.dirname(__file__)))

from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TOPIC_BOARDROOM, TOPIC_THINK_TANK, TOPIC_SOCIAL, TOPIC_TURICKS, TOPIC_NAGGAR
from aiogram import Bot

async def test_telegram_permissions():
    print(f"🤖 Starting FounderOS Telegram Connectivity Test...")
    print(f"Token (First 15 chars): {TELEGRAM_BOT_TOKEN[:15]}...")
    print(f"Chat ID: {TELEGRAM_CHAT_ID}")
    
    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    
    topics = {
        "Boardroom": TOPIC_BOARDROOM,
        "Think Tank": TOPIC_THINK_TANK,
        "Social Command": TOPIC_SOCIAL,
        "Turicks Floor": TOPIC_TURICKS,
        "Naggar HQ": TOPIC_NAGGAR
    }
    
    success_count = 0
    try:
        me = await bot.get_me()
        print(f"\n✅ Successfully connected to Telegram as Bot: @{me.username}")
        
        print("\n📡 Testing Topic Routing:")
        for name, topic_id in topics.items():
            print(f"   -> Sending handshake to {name} (Thread ID: {topic_id})...", end=" ")
            try:
                msg = await bot.send_message(
                    chat_id=TELEGRAM_CHAT_ID,
                    message_thread_id=topic_id,
                    text=f"✅ **FounderOS Handshake**\nBot has full Write permissions in {name}.",
                    parse_mode="Markdown"
                )
                print("SUCCESS!")
                success_count += 1
            except Exception as e:
                print(f"FAILED! Error: {type(e).__name__} - {str(e)}")
                
    except Exception as e:
        print(f"\n❌ FATAL: Could not connect to Telegram servers! Error: {type(e).__name__} - {str(e)}")
        print("Please check your Internet connection and confirm your BOT TOKEN is valid in .c-suite/.env")
    
    finally:
        await bot.session.close()
        
    print(f"\n📋 Test Complete. Validated {success_count}/{len(topics)} topics.")
    if success_count < len(topics):
        print("\n⚠️ PERMISSION TROUBLESHOOTING:")
        print("If a topic failed, ensure:")
        print("1. The bot is added as an ADMIN to your supergroup.")
        print("2. The Group has 'Topics' enabled.")
        print("3. The Thread IDs in .c-suite/.env match exactly (e.g. 2, 3, 4...).")
        print("4. The bot has 'Send messages' and 'Manage Topics' privileges.")

if __name__ == "__main__":
    asyncio.run(test_telegram_permissions())
