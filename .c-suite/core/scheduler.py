"""
FounderOS — Master Scheduler
==============================
REPLACES all `while True: sleep()` loops across the entire codebase.

Uses APScheduler with:
  - AsyncIOScheduler for non-blocking execution
  - SQLJobStore for persistence (survives restarts)
  - LangSmith integration: each job tagged with trace ID

This is the ONLY scheduler in the system. Import and use `scheduler` 
from here — do NOT create APScheduler instances in individual agent files.

Boot sequence:
  start.sh → python scheduler.py &
  → All 12 agent schedules registered
  → Runs indefinitely, resilient to individual agent failures

Individual agents can still be run directly:
  python scrum_engine.py --now   (bypasses scheduler, for testing)
"""

import asyncio
import logging
import importlib
import traceback
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.executors.asyncio import AsyncIOExecutor

import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core.config import C_SUITE_DIR

log = logging.getLogger("FounderOSScheduler")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s"
)

# ════════════════════════════════════════════════════════════════════════════════
# SCHEDULER SETUP
# ════════════════════════════════════════════════════════════════════════════════

jobstores = {
    "default": SQLAlchemyJobStore(
        url=f"sqlite:///{C_SUITE_DIR / 'scheduler_jobs.db'}"
    )
}

executors = {
    "default": AsyncIOExecutor()
}

job_defaults = {
    "coalesce":       True,   # If missed (server down), run once not many times
    "max_instances":  1,      # Never run the same job twice simultaneously
    "misfire_grace_time": 300, # 5 min grace window for missed jobs
}

scheduler = AsyncIOScheduler(
    jobstores=jobstores,
    executors=executors,
    job_defaults=job_defaults,
    timezone="Asia/Kolkata"   # IST — Pushkar's timezone
)


# ════════════════════════════════════════════════════════════════════════════════
# JOB WRAPPER — catches errors so one bad job doesn't kill the scheduler
# ════════════════════════════════════════════════════════════════════════════════

async def safe_run(module_name: str, func_name: str, **kwargs):
    """
    Import module and call async function safely.
    If it fails, log the error and continue — never crash the scheduler.
    """
    job_label = f"{module_name}.{func_name}"
    try:
        log.info(f"▶ Starting job: {job_label}")
        module = importlib.import_module(module_name)
        fn = getattr(module, func_name)
        if asyncio.iscoroutinefunction(fn):
            await fn(**kwargs)
        else:
            fn(**kwargs)
        log.info(f"✅ Completed: {job_label}")
    except Exception as e:
        log.error(f"❌ Job failed: {job_label}\n{traceback.format_exc()}")
        # Don't re-raise — scheduler continues running other jobs


async def _warm_up_resources():
    """
    Claude Code Pattern: prefetch_warmup
    Runs a few minutes before major scheduled task clusters to pre-warm connections.
    Includes ChromaDB connection and basic config load.
    """
    log.info("🔥 Pre-warming system resources for upcoming burst activity...")
    try:
        from memory.memory import client, get_collection
        from core.registry import get_all_companies
        
        # Ping ChromaDB to ensure socket is open and hot
        client.heartbeat()
        
        # Pre-cache registry load
        _ = get_all_companies()
        
        log.info("✅ Resources hot and ready.")
    except Exception as e:
        log.warning(f"⚠️ Pre-warm warning: {e}")


# ════════════════════════════════════════════════════════════════════════════════
# JOB REGISTRY — All scheduled agent tasks
# Format: scheduler.add_job(safe_run, trigger, args=[module, func], id, name)
# ════════════════════════════════════════════════════════════════════════════════

def register_all_jobs():
    """Register all FounderOS agent jobs with APScheduler."""

    # ── DAILY: Farm Weather — every day at 05:45 IST ──────────────────────────
    scheduler.add_job(
        safe_run, "cron", hour=5, minute=45,
        args=["auto_researcher", "run_morning_weather"],
        id="farm_weather_daily", name="Farm Weather Brief",
        replace_existing=True
    )

    # ── PRE-WARM: Morning Cluster — 06:55 and 08:55 IST ───────────────────────
    scheduler.add_job(
        _warm_up_resources, "cron", hour="6,8", minute=55,
        id="warmup_morning", name="Resource Pre-warming (Morning)",
        replace_existing=True
    )

    # ── DAILY: Hourly Ideator — top of every hour ─────────────────────────────
    scheduler.add_job(
        safe_run, "cron", minute=0,
        args=["hourly_ideator", "run_ideator"],
        id="hourly_ideator", name="Hourly Business Ideator",
        replace_existing=True
    )

    # ── DAILY: Booking Concierge — daily 09:00 IST ────────────────────────────
    scheduler.add_job(
        safe_run, "cron", hour=9, minute=0,
        args=["notebooklm_bridge", "daily_booking_check"],
        id="booking_concierge_daily", name="Booking Concierge Check",
        replace_existing=True
    )

    # ── DAILY: Social Handler standup — daily 09:30 IST ──────────────────────
    scheduler.add_job(
        safe_run, "cron", hour=9, minute=30,
        args=["marketing_swarm", "run_daily_standup"],
        id="social_standup_daily", name="Social Handler Daily Standup",
        replace_existing=True
    )

    # ── PRE-WARM: Evening Cluster — 17:25 and 18:25 IST ───────────────────────
    scheduler.add_job(
        _warm_up_resources, "cron", hour="17,18", minute=25,
        id="warmup_evening", name="Resource Pre-warming (Evening)",
        replace_existing=True
    )

    # ── DAILY: Evening Scrum — 18:30 IST ─────────────────────────────────────
    scheduler.add_job(
        safe_run, "cron", hour=18, minute=30,
        args=["scrum_engine", "run_evening_scrum"],
        id="scrum_evening", name="Evening MD Scrum",
        replace_existing=True
    )

    # ── NIGHTLY: Auto Researcher — 01:00 IST (self-improvement loop) ──────────
    scheduler.add_job(
        safe_run, "cron", hour=1, minute=0,
        args=["auto_researcher", "run_nightly_research"],
        id="auto_researcher_nightly", name="Auto Research Self-Improvement",
        replace_existing=True
    )

    # ── NIGHTLY: Turicks KB Agent — 02:00 IST ────────────────────────────────
    scheduler.add_job(
        safe_run, "cron", hour=2, minute=0,
        args=["auto_researcher", "index_turicks_outputs"],
        id="turicks_kb_nightly", name="Turicks KB Indexing",
        replace_existing=True
    )

    # ── NIGHTLY: Naggar KB Agent — 23:00 IST ─────────────────────────────────
    scheduler.add_job(
        safe_run, "cron", hour=23, minute=0,
        args=["auto_researcher", "index_naggar_outputs"],
        id="naggar_kb_nightly", name="Naggar KB Indexing",
        replace_existing=True
    )

    # ── WEEKLY: Social Researcher — Monday 08:00 IST ──────────────────────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="mon", hour=8, minute=0,
        args=["marketing_swarm", "run_weekly_research"],
        id="social_research_weekly", name="Social Media Weekly Research",
        replace_existing=True
    )

    # ── WEEKLY: HR Agent roster review — Monday 07:00 IST ────────────────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="mon", hour=7, minute=0,
        args=["hr_agent", "run_weekly_roster_review"],
        id="hr_roster_review_weekly", name="HR Agent Monday Roster Review",
        replace_existing=True
    )

    # ── WEEKLY: Yield Scout — Monday + Thursday 07:00 IST ────────────────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="mon,thu", hour=7, minute=0,
        args=["auto_researcher", "run_yield_scout"],
        id="yield_scout_weekly", name="Yield Scout P&L Report",
        replace_existing=True
    )

    # ── WEEKLY: Vibe Designer (Naggar content) — MWF 10:00 IST ──────────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="mon,wed,fri", hour=10, minute=0,
        args=["marketing_swarm", "run_vibe_designer"],
        id="vibe_designer_mwf", name="Naggar Vibe Designer Content",
        replace_existing=True
    )

    # ── WEEKLY: Revenue Team brief — Wednesday 09:00 IST ─────────────────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="wed", hour=9, minute=0,
        args=["revenue_team", "run_weekly_revenue_brief"],
        id="revenue_brief_weekly", name="Revenue Team Wednesday Brief",
        replace_existing=True
    )

    # ── WEEKLY: Team Therapist — Friday 17:30 IST ─────────────────────────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="fri", hour=17, minute=30,
        args=["team_therapist", "run_friday_checkin"],
        id="therapist_friday", name="Team Therapist Friday Wellbeing",
        replace_existing=True
    )

    # ── WEEKLY: Cost Watchdog — Sunday 22:00 IST ──────────────────────────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="sun", hour=22, minute=0,
        args=["cost_watchdog", "run_weekly_audit"],
        id="cost_audit_weekly", name="Cost Watchdog Sunday Audit",
        replace_existing=True
    )

    # ── FORTNIGHTLY: Market Scout (Naggar) — bi-weekly Monday 09:00 IST ───────
    scheduler.add_job(
        safe_run, "cron", day_of_week="mon", hour=9, minute=0,
        args=["notebooklm_bridge", "run_market_scout"],
        id="naggar_market_scout", name="Naggar Market Scout",
        replace_existing=True
    )

    # ── DAILY: JobOS V2 Personal Job Swarm — Mon–Fri at 08:00 IST ──────────
    scheduler.add_job(
        safe_run, "cron", day_of_week="mon-fri", hour=8, minute=0,
        args=["job_search_os", "run_daily_job_swarm"],
        id="jobos_v2_daily", name="JobOS V2 Personal Job Swarm",
        replace_existing=True
    )

    # ── PERIODIC: Lead Monitor (JobOS V3) — every 4 hours ─────────────────────
    scheduler.add_job(
        safe_run, "interval", hours=4,
        args=["lead_tracker", "run_lead_check"],
        id="lead_monitor_periodic", name="JobOS V3 Lead Monitor",
        replace_existing=True
    )

    # ── NIGHTLY: Memory Janitor — 04:00 IST (Context density optimization) ──
    scheduler.add_job(
        safe_run, "cron", hour=4, minute=0,
        args=["memory_janitor", "run_janitor_sweep"],
        id="memory_janitor_nightly", name="Memory Janitor Nightly Sweep",
        replace_existing=True
    )

    # ── REVENUE PIPELINE JOBS ─────────────────────────────────────────────────
    setup_revenue_jobs()

    # ── PLATFORM GROWTH JOBS ──────────────────────────────────────────────────
    setup_growth_jobs()

    log.info(f"✅ Registered {len(scheduler.get_jobs())} jobs")


def setup_revenue_jobs():
    """
    Revenue pipeline cron jobs — LinkedIn + Upwork + Outreach + Analytics.
    Called by register_all_jobs(). Safe to call independently for testing.
    """

    # ── LinkedIn post: Tuesday 09:00 IST — BUILD_LOG pillar ──────────────────
    scheduler.add_job(
        _run_linkedin_post, "cron",
        day_of_week="tue", hour=9, minute=0,
        args=["BUILD_LOG"],
        id="linkedin_post_tuesday", name="LinkedIn Post — Tuesday BUILD_LOG",
        replace_existing=True
    )

    # ── LinkedIn post: Thursday 11:00 IST — AI_EDUCATION pillar ──────────────
    scheduler.add_job(
        _run_linkedin_post, "cron",
        day_of_week="thu", hour=11, minute=0,
        args=["AI_EDUCATION"],
        id="linkedin_post_thursday", name="LinkedIn Post — Thursday AI_EDUCATION",
        replace_existing=True
    )

    # ── LinkedIn post: Saturday 10:00 IST — FOUNDER_STORY pillar ─────────────
    scheduler.add_job(
        _run_linkedin_post, "cron",
        day_of_week="sat", hour=10, minute=0,
        args=["FOUNDER_STORY"],
        id="linkedin_post_saturday", name="LinkedIn Post — Saturday FOUNDER_STORY",
        replace_existing=True
    )

    # ── Upwork bidding: daily 08:00 IST Mon–Fri ───────────────────────────────
    scheduler.add_job(
        _run_upwork_daily, "cron",
        day_of_week="mon-fri", hour=8, minute=0,
        id="upwork_daily", name="Upwork Bidding — Daily 08:00 IST",
        replace_existing=True
    )

    # ── Cold outreach: daily 09:30 IST Mon–Fri ────────────────────────────────
    scheduler.add_job(
        _run_cold_outreach, "cron",
        day_of_week="mon-fri", hour=9, minute=30,
        id="cold_outreach_daily", name="LinkedIn Cold Outreach — Daily 09:30 IST",
        replace_existing=True
    )

    # ── Analytics feedback loop: daily 09:00 IST ─────────────────────────────
    scheduler.add_job(
        _run_analytics_check, "cron",
        hour=9, minute=0,
        id="analytics_loop_daily", name="LinkedIn Analytics Loop — Daily 09:00 IST",
        replace_existing=True
    )

    # ── Pipeline MD report: daily 08:30 IST Mon–Fri ───────────────────────────
    scheduler.add_job(
        _run_pipeline_report, "cron",
        day_of_week="mon-fri", hour=8, minute=30,
        id="pipeline_report_daily", name="Pipeline MD Report — Daily 08:30 IST",
        replace_existing=True
    )

    log.info("💰 Revenue pipeline jobs registered (LinkedIn x3 + Upwork + Outreach + Analytics + Pipeline)")


def setup_growth_jobs():
    """
    Platform growth cron jobs — LinkedIn + GitHub + Upwork profile.
    Called by register_all_jobs(). Runs engagement + follower growth automatically.
    """

    # ── LinkedIn Growth: daily Mon–Fri 10:30 IST ─────────────────────────────
    scheduler.add_job(
        _run_linkedin_growth, "cron",
        day_of_week="mon-fri", hour=10, minute=30,
        id="linkedin_growth_daily", name="LinkedIn Growth — Daily 10:30 IST",
        replace_existing=True
    )

    # ── GitHub Growth: weekly Monday 07:30 IST ───────────────────────────────
    scheduler.add_job(
        _run_github_growth, "cron",
        day_of_week="mon", hour=7, minute=30,
        id="github_growth_weekly", name="GitHub Growth — Monday 07:30 IST",
        replace_existing=True
    )

    # ── Platform Research: daily 08:00 IST + 20:00 IST ──────────────────────
    scheduler.add_job(
        _run_platform_research, "cron",
        hour=8, minute=0,
        id="platform_research_morning", name="Platform Growth Research — Daily 08:00 IST",
        replace_existing=True
    )
    scheduler.add_job(
        _run_platform_research, "cron",
        hour=20, minute=0,
        id="platform_research_evening", name="Platform Growth Research — Daily 20:00 IST",
        replace_existing=True
    )

    # ── Upwork profile refresh: weekly Sunday 20:00 IST ──────────────────────
    scheduler.add_job(
        _run_upwork_profile_refresh, "cron",
        day_of_week="sun", hour=20, minute=0,
        id="upwork_profile_weekly", name="Upwork Profile Refresh — Sunday 20:00 IST",
        replace_existing=True
    )

    log.info("📈 Growth jobs registered (LinkedIn daily + GitHub weekly + Platform research + Upwork refresh)")


# ════════════════════════════════════════════════════════════════════════════════
# REVENUE JOB RUNNERS — each wraps run_founderos for a specific agent task
# ════════════════════════════════════════════════════════════════════════════════

async def _run_linkedin_post(pillar: str = "BUILD_LOG"):
    """Trigger social_handler to write and publish a LinkedIn post."""
    try:
        from datetime import date
        from core.departments import run_founderos
        task = (
            f"Post a LinkedIn {pillar} post today. "
            f"Use the SOCIAL_HANDLER tool sequence: recall → draft → post → log → notify. "
            f"Today: {date.today().isoformat()}"
        )
        log.info(f"📝 Triggering LinkedIn post — pillar: {pillar}")
        result = await asyncio.get_event_loop().run_in_executor(
            None, run_founderos, task
        )
        log.info(f"✅ LinkedIn post ({pillar}) complete: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ LinkedIn post failed ({pillar}): {e}")


async def _run_upwork_daily():
    """Trigger bidding_sniper for daily Upwork job search and bidding."""
    try:
        from datetime import date
        from core.departments import run_founderos
        from core.prompts import get_prompt
        task = get_prompt("BIDDING_SNIPER_TASK", date=date.today().isoformat())
        log.info("🎯 Triggering daily Upwork bidding mission")
        result = await asyncio.get_event_loop().run_in_executor(
            None, run_founderos, task
        )
        log.info(f"✅ Upwork daily complete: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ Upwork daily failed: {e}")


async def _run_cold_outreach():
    """Trigger outreach_agent for daily LinkedIn cold outreach."""
    try:
        from datetime import date
        from core.departments import run_founderos
        task = (
            f"Run today's cold outreach mission for Turicks. "
            f"Find 10 SaaS founders matching ICP, send personalized LinkedIn DMs, "
            f"log all contacts to pipeline CRM. Today: {date.today().isoformat()}"
        )
        log.info("📨 Triggering daily cold outreach")
        result = await asyncio.get_event_loop().run_in_executor(
            None, run_founderos, task
        )
        log.info(f"✅ Cold outreach complete: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ Cold outreach failed: {e}")


async def _run_analytics_check():
    """Run LinkedIn analytics feedback loop."""
    try:
        from utils.analytics_loop import run_analytics_check
        log.info("📊 Running LinkedIn analytics feedback loop")
        result = await run_analytics_check()
        log.info(f"✅ Analytics: {result[:200]}")
    except Exception as e:
        log.error(f"❌ Analytics loop failed: {e}")


async def _run_linkedin_growth():
    """Daily LinkedIn engagement — comments, connections, hashtag monitoring."""
    try:
        from datetime import date
        from core.departments import run_founderos
        task = (
            f"Run today's LinkedIn growth mission. Find trending AI/automation posts to engage with. "
            f"Send 5 targeted connection requests to SaaS founders or AI engineers. "
            f"Log activity. Today: {date.today().isoformat()}"
        )
        log.info("📈 Triggering LinkedIn growth agent")
        result = await asyncio.get_event_loop().run_in_executor(None, run_founderos, task)
        log.info(f"✅ LinkedIn growth: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ LinkedIn growth failed: {e}")


async def _run_github_growth():
    """Weekly GitHub profile optimization and follower growth."""
    try:
        from datetime import date
        from core.departments import run_founderos
        task = (
            f"Run this week's GitHub growth mission. "
            f"1. Check profile stats. "
            f"2. Star 10 trending LangGraph/AI agent repos. "
            f"3. Follow 10 active AI developers. "
            f"4. Update any repo descriptions that are missing. "
            f"5. Report to Telegram boardroom. Today: {date.today().isoformat()}"
        )
        log.info("🐙 Triggering GitHub growth agent")
        result = await asyncio.get_event_loop().run_in_executor(None, run_founderos, task)
        log.info(f"✅ GitHub growth: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ GitHub growth failed: {e}")


async def _run_platform_research():
    """Weekly platform growth research across LinkedIn + GitHub + Upwork."""
    try:
        from datetime import date
        from core.departments import run_founderos
        task = (
            f"Run platform growth research for this week. Research best tactics for LinkedIn growth, "
            f"GitHub profile optimization, and Upwork Top Rated tips. "
            f"Star trending AI repos. Store insights in social_mem. "
            f"Today: {date.today().isoformat()}"
        )
        log.info("🔬 Triggering platform growth research")
        result = await asyncio.get_event_loop().run_in_executor(None, run_founderos, task)
        log.info(f"✅ Platform research: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ Platform research failed: {e}")


async def _run_upwork_profile_refresh():
    """Weekly Upwork profile optimization check."""
    try:
        from datetime import date
        from core.departments import run_founderos
        task = (
            f"Review and optimize Turicks Upwork profile for this week. "
            f"Research what top-rated AI automation freelancers are doing differently. "
            f"Suggest improvements to the profile bio, skills, and portfolio. "
            f"Today: {date.today().isoformat()}"
        )
        log.info("💼 Triggering Upwork profile refresh")
        result = await asyncio.get_event_loop().run_in_executor(None, run_founderos, task)
        log.info(f"✅ Upwork profile refresh: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ Upwork profile refresh failed: {e}")


async def _run_pipeline_report():
    """Trigger pipeline_md for daily revenue report."""
    try:
        from datetime import date
        from core.departments import run_founderos
        from core.prompts import get_prompt
        task = get_prompt("PIPELINE_REPORT", date=date.today().isoformat())
        log.info("💼 Triggering daily pipeline report")
        result = await asyncio.get_event_loop().run_in_executor(
            None, run_founderos, task
        )
        log.info(f"✅ Pipeline report complete: {str(result)[:200]}")
    except Exception as e:
        log.error(f"❌ Pipeline report failed: {e}")


# ════════════════════════════════════════════════════════════════════════════════
# HEALTH CHECK — prints all jobs and next run times
# ════════════════════════════════════════════════════════════════════════════════

def print_schedule():
    """Print all registered jobs and their next run times."""
    jobs = scheduler.get_jobs()
    print(f"\n{'='*60}")
    print(f"  FounderOS Scheduler — {len(jobs)} Active Jobs")
    print(f"  Timezone: Asia/Kolkata (IST)")
    print(f"{'='*60}")
    for job in sorted(jobs, key=lambda j: getattr(j, 'next_run_time', None) or datetime.max):
        next_run = getattr(job, 'next_run_time', None)
        next_run_str = next_run.strftime("%a %d %b %H:%M") if next_run else "Not scheduled"
        print(f"  [{next_run_str}] {job.name}")
    print(f"{'='*60}\n")


# ════════════════════════════════════════════════════════════════════════════════
# ENTRYPOINT
# ════════════════════════════════════════════════════════════════════════════════

async def main():
    import sys
    register_all_jobs()
    
    if "--list" in sys.argv:
        print_schedule()
        return

    scheduler.start()
    print_schedule()
    log.info("🔄 FounderOS Scheduler running. Press Ctrl+C to stop.")
    
    try:
        await asyncio.Event().wait()  # Run forever
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        log.info("Scheduler shut down cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
