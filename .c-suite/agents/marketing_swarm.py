"""
FounderOS — 7-Agent AI Marketing Swarm
=============================================================
Replaces the old 3-agent social media team with a 7-agent autonomous swarm.
Demonstrates the use of:
1. Parallel Dispatch (Coordinator Mode)
2. Scratchpad memory (.scratchpad/) for exchanging massive JSON files
3. 4-Phase Lifecycle: Research -> Synthesis -> Implementation -> Verification

Agents:
1. CMO: Coordinator / Synthesizer
2. SEO: Keyword & Search Trends
3. Trend Research: Viral formats
4. Analytics: Performance insights
5. Copywriter: Drafting captions
6. Designer/Video: Visual prompts & hooks
7. Distribution: Platform mapping & scheduling
"""

import asyncio, logging, sys, os, json
from datetime import datetime
sys.path.insert(0, str(os.path.dirname(__file__)))

from aiogram import Bot

from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TOPIC_SOCIAL, call_ceo
from core.parallel_dispatch import dispatch_parallel_sync, WorkerTask

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("MarketingSwarm")
bot = Bot(token=TELEGRAM_BOT_TOKEN)

# ─── Scratchpad System ────────────────────────────────────────────────────────
def get_scratchpad(task_id: str) -> str:
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".scratchpad", task_id))
    os.makedirs(path, exist_ok=True)
    return path

def run_weekly_campaign():
    """Executes the full 7-agent lifecycle for the weekly campaign."""
    task_id = f"campaign_{datetime.now().strftime('%Y%m%d')}"
    pad_dir = get_scratchpad(task_id)
    log.info(f"🚀 Launching Marketing Swarm (Scratchpad: {pad_dir})")
    
    # ─── Phase 1: Parallel Research ───────────────────────────────────────────
    log.info("Phase 1: Parallel Research (SEO, Analytics, Trends)")
    research_tasks = [
        WorkerTask("seo_agent", "MD", f"Identify top 5 search intent keywords for AI automation and remote homestays today. Save top 5 to Scratchpad: {pad_dir}"),
        WorkerTask("trend_agent", "MD", f"Find top 3 viral reel audio/formats on IG/LinkedIn today. Save to Scratchpad: {pad_dir}"),
        WorkerTask("analytics_agent", "MD", f"Mock analyze last week's performance. Focus on save ratios. Save to Scratchpad: {pad_dir}")
    ]
    research_results = dispatch_parallel_sync(research_tasks, timeout_secs=60)
    
    # Since we can't reliably have basic LLMs write to the local filesystem without the MCP hook, 
    # we will proxy their outputs into the scratchpad explicitly.
    research_compiled = {}
    for r in research_results:
        research_compiled[r.task_id] = r.result
        with open(os.path.join(pad_dir, f"{r.task_id}.txt"), "w") as f:
            f.write(r.result)

    # ─── Phase 2: Synthesis (CMO) ─────────────────────────────────────────────
    log.info("Phase 2: CMO Synthesis")
    cmo_prompt = f"""You are the Chief Marketing Officer.
Review this week's data from your sub-agents:
{json.dumps(research_compiled, indent=2)}

Create a unified 1-page Creative Brief for the implementation team. 
Must include the main Hook, the SEO angle, and the Content Strategy."""
    
    creative_brief = call_ceo(cmo_prompt)
    with open(os.path.join(pad_dir, "creative_brief.md"), "w") as f:
        f.write(creative_brief)

    # ─── Phase 3: Smart Parallel Implementation ───────────────────────────────
    log.info("Phase 3: Parallel Implementation (Dynamic Tool Routing)")
    impl_tasks = []
    
    # Core Base Tasks
    impl_tasks.append(WorkerTask("copywriter_agent", "MD", f"Write 3 LinkedIn posts based on this brief:\n{creative_brief}"))
    
    creative_upper = creative_brief.upper()
    
    # 1. Video Routing (Veo 2.0)
    if "VIDEO" in creative_upper or "REEL" in creative_upper:
        log.info("🎬 Veo-2.0 Video Triggered")
        impl_tasks.append(WorkerTask("video_editor", "MD", f"Trigger VEO-2.0 to generate a B-roll background for this brief:\n{creative_brief}"))
    
    # 2. UI/UX Routing (Google Stitch / Nano Banana)
    elif "UI" in creative_upper or "PROTOTYPE" in creative_upper or "APP" in creative_upper:
        log.info("💻 Google Stitch UI Generator Triggered")
        impl_tasks.append(WorkerTask("designer_agent", "MD", f"Trigger Google Stitch to build a React UI prototype for:\n{creative_brief}"))
    
    # 3. Deep Research Routing (NotebookLM Bridge)
    elif "WHITEPAPER" in creative_upper or "DEEP" in creative_upper or "REPORT" in creative_upper:
        log.info("📓 NotebookLM Synthesis Triggered")
        impl_tasks.append(WorkerTask("auto_researcher", "MD", f"Trigger NotebookLM style deep-dive audio podcast script for:\n{creative_brief}"))
        
    # Fallback to standard design
    else:
        log.info("🎨 Standard Designer Triggered")
        impl_tasks.append(WorkerTask("designer_agent", "MD", f"Design standard static visual concepts and overlays for:\n{creative_brief}"))
        
    impl_tasks.append(WorkerTask("distribution_agent", "MD", f"Create a posting schedule (Time/Day) for the next 7 days based on this brief:\n{creative_brief}"))

    impl_results = dispatch_parallel_sync(impl_tasks, timeout_secs=60)

    impl_compiled = {}
    for r in impl_results:
        impl_compiled[r.task_id] = r.result
        with open(os.path.join(pad_dir, f"{r.task_id}.txt"), "w", encoding="utf-8") as f:
            f.write(r.result)

    # ─── Phase 4: Verification (CMO) ──────────────────────────────────────────
    log.info("Phase 4: CMO Verification & Finalize")
    verify_prompt = f"""You are the CMO. Review the final copy, design, and schedule:
{json.dumps(impl_compiled, indent=2)}

Format this into a Telegram-ready executive summary for the Chairman. Keep it punchy!"""
    final_output = call_ceo(verify_prompt)
    
    with open(os.path.join(pad_dir, "final_telegam_post.md"), "w") as f:
        f.write(final_output)

    asyncio.run(send_to_telegram(final_output))
    log.info("✅ 4-Phase Swarm complete.")

async def send_to_telegram(msg: str):
    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=f"🎯 *7-Agent Marketing Swarm Complete*\n\n{msg[:4000]}",
        message_thread_id=TOPIC_SOCIAL,
        parse_mode="Markdown"
    )

# ─── Scheduler Entry Points ──────────────────────────────────────────────────────────
# These are the functions called by scheduler.py jobs.
# Do NOT rename these without updating scheduler.py.

def run_daily_standup():
    """
    Quick daily social media standup (09:30 IST).
    Lightweight check: what to post today, any trending content to act on.
    """
    from core.config import call_nano, TELEGRAM_CHAT_ID, TOPIC_SOCIAL
    import asyncio

    today = datetime.now().strftime("%A, %d %b")
    prompt = f"""
    You are the FounderOS Social Media Coordinator. Today is {today}.
    Generate a 3-point daily social brief for Turicks (AI agency) and Naggar Retreat:
    1. Best platform to post on today and why
    2. One trending topic or format to leverage right now
    3. One specific caption idea for each company (2 total)
    Keep it punchy — this is a morning briefing, not an essay.
    """
    report = call_nano(prompt)
    
    async def _send():
        await bot.send_message(
            chat_id=TELEGRAM_CHAT_ID,
            text=f"📅 *Daily Social Standup — {today}*\n\n{report[:3500]}",
            message_thread_id=TOPIC_SOCIAL,
            parse_mode="Markdown"
        )
    asyncio.run(_send())
    log.info("[MarketingSwarm] Daily standup complete.")


def run_weekly_research():
    """
    Weekly social media research run (Monday 08:00 IST).
    Fires Phase 1 of the marketing swarm (research only) and reports findings.
    """
    from core.config import TELEGRAM_CHAT_ID, TOPIC_SOCIAL
    import asyncio

    task_id = f"weekly_research_{datetime.now().strftime('%Y%m%d')}"
    pad_dir = get_scratchpad(task_id)

    research_tasks = [
        WorkerTask("seo_agent",      "MD", "Find the top 5 high-intent AI automation keywords trending this week. Include search volume signals."),
        WorkerTask("trend_agent",    "MD", "What are the top 3 viral content formats on Instagram Reels and LinkedIn this week? Include specific examples."),
        WorkerTask("competitor_agent", "DEEP", "Scan top AI agencies on LinkedIn. What content themes are getting the most engagement this week?"),
    ]
    results = dispatch_parallel_sync(research_tasks, timeout_secs=90)

    compiled = {}
    for r in results:
        compiled[r.task_id] = r.result[:800]
        with open(os.path.join(pad_dir, f"{r.task_id}.txt"), "w") as f:
            f.write(r.result)

    summary_prompt = f"Summarize these social media research findings into a 200-word Monday brief for the marketing team:\n{json.dumps(compiled, indent=2)}"
    from core.config import call_md
    summary = call_md(summary_prompt)

    async def _send():
        await bot.send_message(
            chat_id=TELEGRAM_CHAT_ID,
            text=f"🔬 *Weekly Social Research — {datetime.now().strftime('%a %d %b')}*\n\n{summary[:3500]}",
            message_thread_id=TOPIC_SOCIAL,
            parse_mode="Markdown"
        )
    asyncio.run(_send())
    log.info("[MarketingSwarm] Weekly research complete.")


def run_vibe_designer():
    """
    Naggar-specific vibe content creation (Mon/Wed/Fri 10:00 IST).
    Creates 2-3 Reel scripts or caption bundles for the retreat's brand.
    """
    from core.config import call_md, TELEGRAM_CHAT_ID, TOPIC_NAGGAR
    import asyncio

    season_month = datetime.now().month
    if season_month in [3, 4, 5]: season = "Spring Blossom"
    elif season_month in [6, 7, 8]: season = "Monsoon Mist"
    elif season_month in [9, 10, 11]: season = "Harvest & Walnut Season"
    else: season = "Winter Snowfall"

    prompt = f"""
    You are the Brand Storyteller for Naggar Retreat, a premium Himalayan farm + homestay.
    Current season: {season}.
    Brand voice: Warm, poetic, slow. Like a letter from a trusted friend in the mountains.
    
    Create TWO pieces of social content:
    1. Instagram Reel Script (30s): Hook → Story → Value → CTA
       Topic: What makes {season} at Naggar special
    2. Instagram Caption: Full caption with hook + 2 lines of story + CTA + 5 hashtags
       Topic: Farm life moment from {season}
    """
    content = call_md(prompt)

    async def _send():
        await bot.send_message(
            chat_id=TELEGRAM_CHAT_ID,
            text=f"🏕️ *Naggar Vibe Content — {season}*\n\n{content[:3500]}",
            message_thread_id=TOPIC_NAGGAR,
            parse_mode="Markdown"
        )
    asyncio.run(_send())
    log.info("[MarketingSwarm] Vibe designer content complete.")


if __name__ == "__main__":
    run_weekly_campaign()
