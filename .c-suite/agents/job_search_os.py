"""
FounderOS — JobOS V3: Personal Career Intelligence Operating System
====================================================================
A 7-Phase Specialist Swarm upgraded with MCP unified search,
automated PDF resume tailoring, and persistent Career Memory.
"""

import asyncio
import logging
import sys
import os
import json
from datetime import datetime

sys.path.insert(0, str(os.path.dirname(__file__)))

from aiogram import Bot
from core.config import (
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    call_ceo, call_md, call_deep_research
)
from core.parallel_dispatch import dispatch_parallel_sync, WorkerTask
from memory.memory import career_mem, store, recall
from resume_modifier import tailor_resume
from utils.pdf_engine import generate_pdf
from agents.hr_scout import find_hr_contacts

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("JobOS-V3")

# ── Telegram Config ──────────────────────────────────────────────────────────
TOPIC_JOB_OS = int(os.getenv("TOPIC_JOB_OS", os.getenv("TOPIC_JOB_SEARCH", "0")))
bot = Bot(token=TELEGRAM_BOT_TOKEN)

# ── Pushkar's Ideal Candidate Profile (ICP) ─────────────────────────────────
PUSHKAR_ICP = """
CANDIDATE: Pushkar Verma
ROLE TARGETS: AI Product Manager, Head of AI, Founding Engineer (AI), CTO (Series A/B), AI Startup Founder-in-Residence
COMPENSATION: $80,000+ USD / ₹60L+ INR
LOCATION: Remote / India / EU / US
STRENGTHS: 
  - Built and shipped 27-agent autonomous multi-company AI operating system (FounderOS)
  - Expert in LangGraph, LangChain, ChromaDB, Multi-Agent Architecture
  - Next.js, MERN, FastAPI full-stack delivery in 3–5 days
  - AI Automation for SMBs, Agentic Product Strategy, Startup Ops
AVOID:
  - Pure Frontend/UI-only roles
  - Roles under $60K USD
  - Companies with <10 headcount AND no product traction
"""

def get_scratchpad(task_id: str) -> str:
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".scratchpad", task_id))
    os.makedirs(path, exist_ok=True)
    return path

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1: Unified Deep Research (JobSpy Pattern)
# ─────────────────────────────────────────────────────────────────────────────

def phase1_unified_search(pad_dir: str) -> str:
    log.info("🔍 Phase 1: Executing unified multi-platform research (JobSpy pattern)...")
    
    # We use deep_research to simulate the broad sweep of JobSpy across multiple platforms
    search_query = (
        "Find the top 10 AI Product Manager or Head of AI roles posted in the last 48 hours. "
        "Sources: LinkedIn, Y Combinator (Work at a Startup), Wellfound, and X. "
        "Prioritize roles with $100k+ compensation. Return structured list: Company, Role, URL, Salary."
    )
    
    results = call_deep_research(search_query)
    
    with open(os.path.join(pad_dir, "phase1_discovery.txt"), "w") as f:
        f.write(results)
        
    store(career_mem, f"search_{datetime.now().strftime('%Y%m%d')}", results, {"type": "search_discovery"})
    
    log.info("✅ Phase 1 complete: Unified discovery indexed.")
    return results

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2: AI Coordinator — Filter & Contextual Scoring
# ─────────────────────────────────────────────────────────────────────────────

def phase2_coordinator(discovery_text: str, pad_dir: str) -> list:
    log.info("🧠 Phase 2: AI Coordinator scoring against ICP and historical context...")

    # Recall past discarded roles to avoid re-suggesting
    past_context = recall(career_mem, "AI PM roles", n_results=5)

    score_prompt = f"""You are the Career Coordinator for Pushkar Verma.
    
    ICP: {PUSHKAR_ICP}
    
    PAST CONTEXT: {past_context}
    
    NEW DISCOVERY:
    {discovery_text}
    
    TASK:
    Score and filter to the TOP 5 most elite matches. 
    Return a valid JSON list of objects with: company, role, url, salary, fit_score, fit_reason.
    """
    
    raw = call_ceo(score_prompt)

    try:
        from json_repair import repair_json
        leads = repair_json(raw, return_objects=True) or []
    except ImportError:
        import re as _re
        cleaned = _re.sub(r"```(?:json)?", "", raw, flags=_re.IGNORECASE).strip("` \n")
        try:
            leads = json.loads(cleaned) or []
        except Exception:
            log.error("Phase 2: json_repair missing and fallback JSON parse failed")
            leads = []
    if not isinstance(leads, list):
        leads = []
    
    with open(os.path.join(pad_dir, "phase2_leads.json"), "w") as f:
        json.dump(leads, f, indent=2)
        
    return leads

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 4-5 UPGRADE: Automatic Tailoring Engine
# ─────────────────────────────────────────────────────────────────────────────

def phase4_tailored_assets(leads: list, pad_dir: str):
    log.info("📄 Phase 4: Launching automated Resume Tailoring & PDF Generation...")
    
    for lead in leads:
        company = lead.get("company", "Unknown")
        jd_context = f"Role: {lead.get('role')} at {company}. Reason: {lead.get('fit_reason')}"
        
        # 1. Tailor Markdown
        safe_name = company.replace(" ", "_")
        md_path = os.path.join(pad_dir, f"resume_{safe_name}.md")
        pdf_path = os.path.join(pad_dir, f"resume_{safe_name}.pdf")
        
        tailored_md = tailor_resume(jd_context, md_path)
        
        # 2. Generate PDF
        if tailored_md:
            generate_pdf(tailored_md, pdf_path)
            lead["resume_pdf"] = pdf_path
            
    log.info("✅ Phase 4 complete: All resumes tailored and rendered.")

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3, 5, 6, 7: Restored from V2 (Modernized)
# ─────────────────────────────────────────────────────────────────────────────

def phase3_company_intel(leads: list, pad_dir: str) -> list:
    log.info("🏢 Phase 3: Running company intel and decision-maker research...")
    if not leads: return []
    intel_tasks = []
    for lead in leads:
        company = lead.get("company", "Unknown")
        intel_tasks.append(WorkerTask(
            f"intel_{company.replace(' ', '_')[:20]}", "DEEP",
            f"Research '{company}' for a job application for '{lead.get('role')}'. Find news and Hiring Manager."
        ))
    intel_results = dispatch_parallel_sync(intel_tasks, timeout_secs=180)
    intel_map = {r.task_id: r.result for r in intel_results}
    for lead in leads:
        company_key = f"intel_{lead.get('company', '').replace(' ', '_')[:20]}"
        lead["company_intel"] = intel_map.get(company_key, "Intel unavailable.")
    return leads

def phase5_cover_letters(leads: list, pad_dir: str) -> list:
    log.info("✍️  Phase 5: Writing authentic cover letters...")
    cl_tasks = []
    for lead in leads:
        cl_tasks.append(WorkerTask(
            f"cl_{lead.get('company', '').replace(' ', '_')[:20]}", "MD",
            f"Write a 150-word cover letter for Pushkar for {lead.get('role')} at {lead.get('company')}. Use context: {lead.get('company_intel', '')[:300]}"
        ))
    cl_results = dispatch_parallel_sync(cl_tasks, timeout_secs=120)
    cl_map = {r.task_id: r.result for r in cl_results}
    for lead in leads:
        company_key = f"cl_{lead.get('company', '').replace(' ', '_')[:20]}"
        lead["cover_letter"] = cl_map.get(company_key, "")
    return leads

def phase6_outreach(leads: list, pad_dir: str) -> list:
    log.info("📬 Phase 6: Crafting warm outreach messages...")
    outreach_tasks = []
    for lead in leads:
        outreach_tasks.append(WorkerTask(
            f"outreach_{lead.get('company', '').replace(' ', '_')[:20]}", "MD",
            f"Write a LinkedIn note and cold email for the hiring manager at {lead.get('company')}."
        ))
    outreach_results = dispatch_parallel_sync(outreach_tasks, timeout_secs=120)
    outreach_map = {r.task_id: r.result for r in outreach_results}
    for lead in leads:
        company_key = f"outreach_{lead.get('company', '').replace(' ', '_')[:20]}"
        lead["outreach_message"] = outreach_map.get(company_key, "")
    return leads

async def phase7_delivery(leads: list):
    log.info("📱 Phase 7: Delivering full package to Telegram #JobOS...")
    header = f"🎯 *JobOS V4 Daily Report — {datetime.now().strftime('%A, %d %b %Y')}*\n"
    body = ""
    for i, lead in enumerate(leads, 1):
        hr_info = lead.get("hr_contacts", [])
        hr_str = f"\n👥 *HR Contacts found:* {len(hr_info)}"
        body += f"*{i}. {lead.get('role')} @ {lead.get('company')}*\nScore: {lead.get('fit_score')}/10\n🔗 [Link]({lead.get('url')}){hr_str}\n\n"
    
    await bot.send_message(chat_id=TELEGRAM_CHAT_ID, message_thread_id=TOPIC_JOB_OS or None, text=header + body, parse_mode="Markdown")

def phase8_hr_discovery(leads: list, pad_dir: str):
    log.info("👥 Phase 8: Discovering HR contacts for top leads...")
    for lead in leads:
        company = lead.get("company", "Unknown")
        contacts = find_hr_contacts(company)
        lead["hr_contacts"] = contacts
        
        with open(os.path.join(pad_dir, f"phase8_{company.replace(' ', '_')}.json"), "w") as f:
            json.dump(contacts, f, indent=2)
    return leads

# ─────────────────────────────────────────────────────────────────────────────
# ENTRYPOINT
# ─────────────────────────────────────────────────────────────────────────────

async def run_daily_job_swarm():
    is_mock = "--mock" in sys.argv
    task_id = f"jobos_{datetime.now().strftime('%Y%m%d_%H%M')}"
    pad_dir = get_scratchpad(task_id)

    log.info(f"🚀 ===== JobOS V3 Daily Swarm Starting — ID: {task_id} =====")

    if is_mock:
        log.info("🧪 MOCK MODE: (Using synthetic data)")
        # Mock logic would go here
    else:
        discovery = phase1_unified_search(pad_dir)
        top_leads = phase2_coordinator(discovery, pad_dir)
        
        if top_leads:
            phase3_enriched = phase3_company_intel(top_leads, pad_dir)
            phase4_tailored_assets(phase3_enriched, pad_dir)
            phase5_with_cl = phase5_cover_letters(phase3_enriched, pad_dir)
            phase6_with_out = phase6_outreach(phase5_with_cl, pad_dir)
            
            # Phase 8: HR Discovery (Added in V4)
            phase8_with_hr = phase8_hr_discovery(phase6_with_out, pad_dir)
            
            await phase7_delivery(phase8_with_hr)

    log.info(f"🏁 ===== JobOS V3 Swarm Complete — Package at: {pad_dir} =====")

if __name__ == "__main__":
    asyncio.run(run_daily_job_swarm())
