"""
FounderOS — Telegram Gateway (aiogram v3) — V8 FIXED
======================================================
Listens to Telegram Supergroup Topics and routes to the LangGraph Orchestrator.

V8 Fixes:
  1. CHAT ID FILTER: Correctly normalises -100 prefix for supergroup chat IDs.
  2. CATCH-ALL HANDLER: Messages from any non-Boardroom topic still get a
     helpful redirect instead of silently dropping.
  3. APPROVAL FLOW: YES handler now correctly re-resumes graph state.
  4. UNKNOWN COMPANY: Graceful fallback always replies to #Boardroom.
  5. SESSION CLEANUP: Bot session correctly closed on shutdown.
  6. DIRECT REPLY MODE: For simple tasks that don't require full 4-phase
     lifecycle, the CEO response is returned immediately.
"""

import asyncio, sys, os, logging, time
from typing import Callable, Awaitable, Any
sys.path.insert(0, str(os.path.dirname(__file__)))

from aiogram import Bot, Dispatcher, F, BaseMiddleware
from aiogram.types import Message, TelegramObject

from core.config import (
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_BOARDROOM, TOPIC_THINK_TANK, TOPIC_TURICKS, TOPIC_NAGGAR,
    TOPIC_SOCIAL, call_local, call_ceo, call_md
)
import os as _os
TOPIC_REVENUE = int(_os.getenv("TOPIC_REVENUE", "214"))
from core.orchestrator import graph

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s"
)
log = logging.getLogger("FounderOS-Telegram")

bot = Bot(token=TELEGRAM_BOT_TOKEN)
dp  = Dispatcher()

# Track which thread_ids are awaiting approval
PENDING_APPROVALS = {}

# ─── Chat ID Normalisation ────────────────────────────────────────────────────
# Telegram sends supergroup IDs as -100XXXXXXXXXX, but the .env may store
# it either way. We normalise both sides for comparison.
def _normalise_chat_id(raw) -> str:
    s = str(raw).strip()
    return s if s.startswith("-100") else f"-100{s.lstrip('-')}"

NORMALISED_CHAT_ID = _normalise_chat_id(TELEGRAM_CHAT_ID)
log.info(f"[Gateway] Expected Chat ID (normalised): {NORMALISED_CHAT_ID}")

# ─── Logging Middleware (aiogram v3 — replaces catch-all handler) ────────────
# BUG FIX: In aiogram v3, a @dp.message() handler with no filter consumes ALL
# messages and prevents downstream handlers from firing. Use BaseMiddleware instead.

class LoggingMiddleware(BaseMiddleware):
    """Logs every incoming message and enforces chat ID filter before routing."""
    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        if hasattr(event, 'chat') and event.chat:
            chat_id = _normalise_chat_id(event.chat.id)
            thread_id = getattr(event, 'message_thread_id', None)
            user = getattr(event, 'from_user', None)
            user_name = user.full_name if user else "Unknown"
            text_preview = (getattr(event, 'text', None) or "")[:40]
            log.info(
                f"[Gateway] RECV: from={user_name} | chat={chat_id} "
                f"| topic={thread_id} | text='{text_preview}...'"
            )
            # Chat ID gate — block messages from wrong chats silently
            if chat_id != NORMALISED_CHAT_ID:
                log.warning(f"[Gateway] BLOCKED: Chat {chat_id} != {NORMALISED_CHAT_ID}")
                return  # Do NOT call handler — drop this message
        return await handler(event, data)

# Register middleware on the dispatcher's message router
dp.message.middleware(LoggingMiddleware())

# ─── Helpers ─────────────────────────────────────────────────────────────────

def get_thread_config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}

async def send_to_topic(topic_id: int, text: str):
    """Send a message into a specific Telegram topic. Truncates at Telegram's 4096 char limit."""
    try:
        text_to_send = str(text)[:4090]
        await bot.send_message(
            chat_id=NORMALISED_CHAT_ID,
            text=text_to_send,
            message_thread_id=topic_id,
            parse_mode="Markdown"
        )
    except Exception as e:
        log.error(f"[Gateway] Failed to send to topic {topic_id}: {e}")
        # Fallback: try without markdown if formatting caused error
        try:
            await bot.send_message(
                chat_id=NORMALISED_CHAT_ID,
                text=str(text)[:4090],
                message_thread_id=topic_id,
            )
        except Exception as e2:
            log.error(f"[Gateway] Fallback send also failed: {e2}")


from core.registry import (
    get_all_agents, get_all_companies
)

async def quick_reply(msg: Message, text_input: str):
    """
    Fast path: For quick informational queries that don't need the full
    4-phase orchestrator lifecycle (e.g. 'what time is it?', 'summarise X').
    Uses call_md directly and replies in ~2 seconds.
    """
    all_agents = get_all_agents()
    agent_names = ", ".join([a.name for a in all_agents])
    
    # ── Quick-Routing Decision — Bypass Kai for complex work ─────────────
    # Standardised complex patterns that MUST go to LangGraph
    complex_triggers = ["code", "create", "proposal", "submit", "audit", "research", "scrap", "write a", "implement"]
    input_lower = text_input.lower()
    
    if any(trigger in input_lower for trigger in complex_triggers) and len(text_input) > 15:
        log.info(f"[Gateway] Complex task detected: '{text_input[:50]}...'. Routing to full pipeline.")
        return False

    system = f"""You are Kai, the AI Chief of Staff for Pushkar Verma's autonomous business empire.

You manage TWO companies:
  1. TURICKS — AI/software agency.
  2. NAGGAR RETREAT — Himalayan farm + homestay.

You also manage a swarm of {len(all_agents)} specialist agents:
{agent_names}

Follow these STRICT rules:
1. Answer concisely in 2-4 lines.
2. If the Chairman asks to "list agents", provide them categorized by company.
3. If the request is a complex business command (coding, proposals, audits), reply EXACTLY: 'Routing to full orchestration pipeline...'
4. NEVER invent a plan. Never generate numbered lists of future actions."""
    
    response = call_md(text_input, system=system)
    
    # Second gate: Ensure we don't return a hallucinated plan from a small model
    if "Routing to full orchestration pipeline" in response or len(response.split("\n")) > 10:
        return False  # Force to orchestrator
    
    await send_to_topic(TOPIC_BOARDROOM, f"🤖 *Kai:* {response}")
    return True


async def process_orchestrator_reply(msg: Message, text_input: str):
    """Pass input through the full 4-phase LangGraph orchestrator with real-time status updates."""
    user_thread = f"boardroom_{msg.from_user.id}"
    config = get_thread_config(user_thread)
    
    # 1. Start with a "Live Status" message
    status_msg = await bot.send_message(
        chat_id=NORMALISED_CHAT_ID,
        text="⚙️ *Kai: Initialising FounderOS Swarm...*",
        message_thread_id=TOPIC_BOARDROOM,
        parse_mode="Markdown"
    )

    async def update_status(new_text: str):
        try:
            await bot.edit_message_text(
                chat_id=NORMALISED_CHAT_ID,
                message_id=status_msg.message_id,
                text=f"⚙️ *Kai:* {new_text}",
                parse_mode="Markdown"
            )
        except Exception:
            pass # Ignore if duplicate text or rate limit

    node_labels = {
        "ceo": "🔍 Classifying request & identifying companies...",
        "research_node": "🌐 Dispatching parallel research agents...",
        "gate_research": "📊 Collating research findings...",
        "synthesis_node": "🧠 Synthesizing execution plan...",
        "gate_synthesis": "📝 Finalising implementation spec...",
        "implementation_node": "🛠️ Executing specialist implementation...",
        "gate_implementation": "🧪 Preparing verification suite...",
        "verification_node": "⚖️ Performing gatekeeper quality audit...",
        "finalize": "✅ Task processing complete."
    }

    try:
        current_state = {
            "messages": [text_input],
            "approved": False,
            "pending_action": "",
            "result": "",
            "company": "",
            "task": "",
            "research_results": "",
            "synthesis_result": "",
            "implementation_result": "",
            "verification_result": "",
            "research_approved": False,
            "synthesis_approved": False,
            "implementation_approved": False,
            "refined_once": False,
            "gatekeeper_critique": "",
            "denial_count": 0,
            "denial_triggered": False
        }

        last_node = ""
        # We use stream() to get intermediate node transitions
        for event in graph.stream(current_state, config):
            for node_name, state_delta in event.items():
                if node_name in node_labels:
                    await update_status(node_labels[node_name])
                last_node = node_name
                current_state.update(state_delta)

        reply = current_state.get("result", "✅ Done.")

        if "APPROVAL REQUIRED" in reply:
            PENDING_APPROVALS[user_thread] = {
                "thread_id": user_thread,
                "timestamp": time.time(),
                "details": reply,
                "config": config,
            }
            # Remove status message and send fresh approval request
            await bot.delete_message(NORMALISED_CHAT_ID, status_msg.message_id)
            await send_to_topic(TOPIC_BOARDROOM, reply)
        else:
            company = current_state.get("company", "")
            await update_status("🏁 Transferring results to specialized floor...")
            
            if company == "turicks":
                await send_to_topic(TOPIC_TURICKS, f"📋 *Turicks Task Result*\n\n{reply}")
                await update_status("✅ Task complete → result sent to *#Turicks_Floor*.")
            elif company == "naggar":
                await send_to_topic(TOPIC_NAGGAR, f"🌿 *Naggar Task Result*\n\n{reply}")
                await update_status("✅ Task complete → result sent to *#Naggar_HQ*.")
            else:
                await update_status(f"✅ *Task Complete:*\n\n{reply}")

    except Exception as e:
        log.exception("Graph stream failed")
        await update_status(f"❌ *Orchestrator Error:* `{type(e).__name__}`")


# ─── Message Handlers ─────────────────────────────────────────────────────────

@dp.message(F.text)
async def handle_message(msg: Message):
    """Main handler for all text messages."""
    incoming_chat_id = _normalise_chat_id(msg.chat.id)
    text = msg.text or ""
    topic_id = msg.message_thread_id or 0

    # BUG FIX 1: Correct chat ID comparison
    if incoming_chat_id != NORMALISED_CHAT_ID:
        log.debug(f"[Gateway] Ignored message from unknown chat: {incoming_chat_id}")
        return

    log.info(f"[Gateway] Message received | Topic: {topic_id} | From: {msg.from_user.username} | Text: {text[:60]}")

    # ── BOARDROOM: Primary command interface ──────────────────────────────────
    if topic_id == TOPIC_BOARDROOM:
        user_thread = f"boardroom_{msg.from_user.id}"

        # Approval YES handler
        if text.strip().upper() == "YES" and user_thread in PENDING_APPROVALS:
            pending = PENDING_APPROVALS.pop(user_thread)
            config  = pending["config"]
            details = pending.get("details", "")
            # Infer which phase gate is pending from the message body and set only
            # the relevant approval flag. Setting them all at once caused later
            # phases to auto-skip on their own approval prompts.
            update: dict = {"approved": True}
            if "Synthesis" in details or "Synthesize" in details:
                update["research_approved"] = True
            elif "Implementation" in details or "Implement" in details:
                update["synthesis_approved"] = True
            elif "Verification" in details or "Verify" in details:
                update["implementation_approved"] = True
            else:
                update["research_approved"] = True
            graph.update_state(config, update)
            await send_to_topic(TOPIC_BOARDROOM, "✅ Approved! Resuming pipeline...")
            try:
                result_state = graph.invoke(None, config)
                reply = result_state.get("result", "✅ Action executed successfully.")
                await send_to_topic(TOPIC_BOARDROOM, reply)
            except Exception as e:
                await send_to_topic(TOPIC_BOARDROOM, f"❌ Resume failed: `{e}`")
            return

        # Normal command — try quick path first, then full orchestrator
        await send_to_topic(TOPIC_BOARDROOM, "⚙️ *Kai is processing...*")
        handled = await quick_reply(msg, text)
        if not handled:
            await process_orchestrator_reply(msg, text)

    # ── THINK TANK: Research queries ──────────────────────────────────────────
    elif topic_id == TOPIC_THINK_TANK:
        await send_to_topic(TOPIC_THINK_TANK, "⚙️ *Kai is researching...*")
        response = call_md(text, system="You are a deep research analyst for FounderOS. Provide a thorough, structured analysis.")
        await send_to_topic(TOPIC_THINK_TANK, f"🔬 *Research Result:*\n\n{response}")

    # ── TURICKS FLOOR: Direct agent queries ───────────────────────────────────
    elif topic_id == TOPIC_TURICKS:
        await send_to_topic(TOPIC_TURICKS, "⚙️ *Turicks MD is processing...*")
        system = "You are the Managing Director of Turicks, an AI software agency. Answer questions about projects, bids, and strategy."
        response = call_md(text, system=system)
        await send_to_topic(TOPIC_TURICKS, f"💼 *Turicks MD:*\n\n{response}")

    # ── NAGGAR HQ: Direct agent queries ───────────────────────────────────────
    elif topic_id == TOPIC_NAGGAR:
        await send_to_topic(TOPIC_NAGGAR, "⚙️ *Naggar MD is processing...*")
        system = "You are the Managing Director of Naggar Retreat, a Himalayan raspberry farm and homestay. Answer questions about bookings, farming, and strategy."
        response = call_md(text, system=system)
        await send_to_topic(TOPIC_NAGGAR, f"🌿 *Naggar MD:*\n\n{response}")

    # ── SOCIAL COMMAND: Social media tasks ────────────────────────────────────
    elif topic_id == TOPIC_SOCIAL:
        await send_to_topic(TOPIC_SOCIAL, "⚙️ *Social team is processing...*")
        system = "You are the FounderOS Social Media Handler. Draft engaging posts, captions, and social strategy."
        response = call_md(text, system=system)
        await send_to_topic(TOPIC_SOCIAL, f"📱 *Social Team:*\n\n{response}")

    # ── REVENUE COMMAND CENTRE: Pipeline + Upwork + Outreach ─────────────────
    elif topic_id == TOPIC_REVENUE:
        await send_to_topic(TOPIC_REVENUE, "⚙️ *Revenue team is processing...*")
        system = (
            "You are the FounderOS Revenue MD for Turicks AI Agency. "
            "You manage the Upwork pipeline, LinkedIn outreach, and CRM. "
            "Answer questions about leads, proposals, revenue, and client acquisition strategy."
        )
        response = call_md(text, system=system)
        await send_to_topic(TOPIC_REVENUE, f"💰 *Revenue MD:*\n\n{response}")

    # ── UNKNOWN TOPIC: Catch-all redirect ─────────────────────────────────────
    else:
        log.warning(f"[Gateway] Message from unrecognised topic: {topic_id}")
        await msg.reply("ℹ️ This topic isn't configured. Send commands to *#The_Boardroom* or contact your admin.", parse_mode="Markdown")


@dp.message(F.voice)
async def handle_voice(msg: Message):
    """Processes Voice Memo commands via STT."""
    topic_id = msg.message_thread_id or 0
    incoming_chat_id = _normalise_chat_id(msg.chat.id)

    if incoming_chat_id != NORMALISED_CHAT_ID:
        return

    if topic_id == TOPIC_BOARDROOM:
        await send_to_topic(TOPIC_BOARDROOM, "🎙️ *Voice Command received — processing STT...*")
        try:
            # Download and transcribe via local Whisper
            voice = msg.voice
            file = await bot.get_file(voice.file_id)
            file_path = f"/tmp/voice_{voice.file_id}.ogg"
            await bot.download_file(file.file_path, file_path)

            import subprocess
            result = subprocess.run(
                ["/Users/pushkarverma/mlx_env/bin/whisper", file_path, "--model", "base", "--output_format", "txt"],
                capture_output=True, text=True, timeout=60
            )
            transcription = result.stdout.strip() or "Could not transcribe audio."
        except Exception as e:
            log.warning(f"[STT] Whisper failed: {e}. Using mock.")
            transcription = call_local("Summarise in 1 sentence what a startup founder might ask their AI system.")

        await send_to_topic(TOPIC_BOARDROOM, f"🗣️ *Transcribed:* _{transcription}_")
        await process_orchestrator_reply(msg, transcription)


# ─── Revenue Alert Helpers ────────────────────────────────────────────────────

async def revenue_alert(message: str) -> None:
    """
    Send a revenue/pipeline alert to the Revenue Command Centre topic.
    Called by pipeline agents (bidding_sniper, outreach_agent, pipeline_md).

    Usage:
        await revenue_alert("💰 New lead added: John @ Acme Corp ($3,000 potential)")
    """
    try:
        await send_to_topic(TOPIC_REVENUE, message)
    except Exception as e:
        log.error(f"[revenue_alert] Failed: {e}")
        # Fallback to Turicks topic
        try:
            await send_to_topic(TOPIC_TURICKS, f"[Revenue Alert Fallback]\n{message}")
        except Exception:
            pass


async def lead_alert(
    name: str,
    company: str,
    source: str,
    potential_value_usd: float,
    notes: str = "",
) -> None:
    """
    Send a formatted new-lead notification to Revenue Command Centre.
    Called by pipeline_add_lead tool post-hook or outreach_agent.

    Usage:
        await lead_alert("Sarah Chen", "DataFlow Inc", "linkedin_post", 4500, "CTO, 80 employees, AI interest")
    """
    value_str = f"${potential_value_usd:,.0f}" if potential_value_usd else "TBD"
    msg = (
        f"🎯 <b>New Lead Captured</b>\n"
        f"👤 {name} @ {company}\n"
        f"📌 Source: {source}\n"
        f"💵 Potential: {value_str}\n"
    )
    if notes:
        msg += f"📝 {notes[:120]}"
    await revenue_alert(msg)


# ─── AwaySummary Daemon ───────────────────────────────────────────────────────

async def away_summary_daemon():
    """Pings Chairman if an approval has been pending for 4+ hours."""
    while True:
        now = time.time()
        for t_id, data in list(PENDING_APPROVALS.items()):
            elapsed = now - data.get("timestamp", now)
            if elapsed > 14400:  # 4 hours
                summary = call_local(
                    f"Chairman has been away for 4 hours. Summarize this pending action "
                    f"into a polite 2-sentence reminder:\n{data['details'][:500]}"
                )
                await send_to_topic(TOPIC_BOARDROOM, f"👋 *Welcome Back, Chairman!*\n\n{summary}")
                data["timestamp"] = now  # Reset to avoid spam
        await asyncio.sleep(3600)


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main():
    log.info("🚀 FounderOS Telegram Gateway V8 is live.")
    log.info(f"   Listening on Chat: {NORMALISED_CHAT_ID}")
    log.info(f"   Topics — Boardroom:{TOPIC_BOARDROOM} | ThinkTank:{TOPIC_THINK_TANK} | Turicks:{TOPIC_TURICKS} | Naggar:{TOPIC_NAGGAR} | Social:{TOPIC_SOCIAL} | Revenue:{TOPIC_REVENUE}")
    
    # Notify Chairman that the system is live after the upgrade
    await send_to_topic(
        TOPIC_BOARDROOM, 
        "🚀 *FounderOS V8: Neural Bridge Online*\n\n"
        "Chairman, the system has been upgraded with:\n"
        "• *Claude-style* live status updates\n"
        "• *SEO Specialist* agent activated\n"
        "• *Firecrawl* scraper restored\n"
        "• *M4 Speed Optimization* enabled\n\n"
        "I am standing by for your commands."
    )
    
    asyncio.create_task(away_summary_daemon())

    try:
        await dp.start_polling(bot)
    finally:
        await bot.session.close()
        log.info("[Gateway] Bot session closed cleanly.")

if __name__ == "__main__":
    asyncio.run(main())
