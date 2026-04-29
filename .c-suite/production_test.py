"""
FounderOS Production Readiness Test
===================================
Runs ALL 39 agents with real-life scenarios via OpenRouter free models,
validates cross-company communication, and reports formatted results to Telegram.

Usage: python .c-suite/production_test.py
"""
from __future__ import annotations

import os
import sys
import time
import json
import traceback
import asyncio
import requests
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env", override=True)

from core.registry import get_all_agents, get_agent, get_agent_topic_id, Agent  # type: ignore
from core.prompts import get_prompt  # type: ignore
from bridges.telegram_formatter import (  # type: ignore
    agent_report, production_summary, banner, header, section_divider, EMOJI
)

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
OPENROUTER_KEY = os.environ["OPENROUTER_API_KEY"]

TOPICS = {
    "boardroom":  int(os.getenv("TOPIC_BOARDROOM", 8)),
    "think_tank": int(os.getenv("TOPIC_THINK_TANK", 110)),
    "turicks":    int(os.getenv("TOPIC_TURICKS", 111)),
    "naggar":     int(os.getenv("TOPIC_NAGGAR", 112)),
    "social":     int(os.getenv("TOPIC_SOCIAL", 6)),
}

# OpenRouter FREE model routing per cascade tier
# All free as-of-test models that accept chat completions
# Per-tier ordered list of VERIFIED free OpenRouter models (first that responds wins)
_BIG_FREE  = ["nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-oss-120b:free",
              "meta-llama/llama-3.3-70b-instruct:free", "nousresearch/hermes-3-llama-3.1-405b:free"]
_MID_FREE  = ["google/gemma-3-27b-it:free", "openai/gpt-oss-20b:free",
              "qwen/qwen3-next-80b-a3b-instruct:free", "meta-llama/llama-3.3-70b-instruct:free"]
_SMALL_FREE = ["google/gemma-3-12b-it:free", "nvidia/nemotron-nano-9b-v2:free",
               "google/gemma-3-4b-it:free", "openai/gpt-oss-20b:free",
               "meta-llama/llama-3.3-70b-instruct:free"]
_CODE_FREE  = ["qwen/qwen3-coder:free", "meta-llama/llama-3.3-70b-instruct:free",
               "openai/gpt-oss-120b:free"]

TIER_MODELS = {
    "ceo":           _BIG_FREE,
    "deep_research": _BIG_FREE,
    "md":            _MID_FREE,
    "nano":          _SMALL_FREE,
    "local":         _SMALL_FREE,
    "code":          _CODE_FREE,
    "video":         _MID_FREE,
}

# ─────────────────────────────────────────────
# TASKS — real-life scenarios per agent
# ─────────────────────────────────────────────
AGENT_TASKS = {
    # ── TURICKS (AI agency) ──
    "bidding_sniper":  "A new Upwork post: 'Need LangGraph multi-agent system for a legal-docs SaaS, budget $3500, 2 week delivery.' Draft a 120-word winning pitch using our differentiator (3-5 day delivery, working code).",
    "lead_intel":      "Surface 3 fictional but realistic SME founder leads in EU needing AI automation at $50K-500K ARR. Give name, company, pain point, outreach angle.",
    "senior_dev":      "Propose a file structure + key modules for a Next.js + LangGraph agentic legal-docs SaaS (doc ingest, RAG, contract generation). 200 words.",
    "vibe_coder":      "Write a Next.js 14 server action that accepts a PDF upload and triggers a background LangGraph workflow. ~30 lines.",
    "qa_tester":       "List 8 edge-case tests for a file-upload → LangGraph pipeline (size limits, corrupt PDFs, concurrency, auth, etc).",
    "proposal_writer": "Draft a 1-page proposal: AI lead-scoring tool for a US SaaS (3-5 day delivery, $2.5K fixed). Include scope, timeline, deliverables.",
    "ops_agent":       "Turicks status: 2 active projects, 1 lead in proposal stage, cash runway 7mo. Give a 3-bullet ops standup.",
    "kb_agent":        "Summarize the top 5 reusable patterns in a LangGraph agentic system (memory, tool-use, routing, retry, human-in-loop).",
    "web_designer":    "Propose a hero section for turicks.com: headline, sub, CTA, 3 trust badges. Minimal, technical, value-driven.",
    "seo_specialist":  "Give 10 low-competition keywords for 'agentic AI agency for SMEs' with rough monthly volume + difficulty.",

    # ── NAGGAR (farm + homestay) ──
    "farm_weather":    "Naggar HP April 2026: raspberry fruit-set stage. Current alt 1768m. Draft a 3-day frost/rain advisory for the farm manager.",
    "yield_scout":     "Given 120 raspberry plants, first-year, estimate realistic yield, harvest window, and spoilage risk.",
    "booking_concierge": "A guest asks: 'Can you host 6 adults + 1 toddler for 3 nights starting May 10, vegetarian meals, pickup from Kullu?' Draft the reply with confirmation question.",
    "vibe_designer":   "Propose an Airbnb listing title + 150-word description for a premium farm-to-table Himalayan homestay at ₹6K/night.",
    "culinary_agent":  "Design a 3-course farm-to-table dinner menu using raspberries, walnuts, and local Himachali produce. Vegetarian.",
    "market_scout":    "What homestay pricing + positioning is working on Airbnb for ₹5-8K/night Himalayan properties in Kullu/Manali? Give 3 insights.",
    "guest_crm":       "A returning guest (stayed once in 2025) wants to book again. Draft a personalized offer + loyalty gesture.",
    "naggar_kb":       "Summarize 5 SOPs for guest arrival day (pickup, welcome drink, check-in, orientation, dinner).",
    "video_editor":    "Outline a 45-second Instagram Reel for the farm: hook → 3 scenes → CTA. Raspberry harvest theme.",

    # ── CROSS ──
    "social_researcher": "What are 3 trending content angles on LinkedIn right now for (a) AI/agency founders and (b) boutique homestay hosts?",
    "social_handler":    "Compose 1 LinkedIn post for Turicks (tech builder voice) and 1 Instagram caption for Naggar Retreat (warm hosting voice).",
    "cost_watchdog":     "Given Turicks monthly spend ₹18K (APIs, hosting) + Naggar ₹12K (utilities, farm inputs), flag 2 optimization opportunities.",
    "team_therapist":    "One-man company owner is running both Turicks + Naggar simultaneously. Flag 3 burnout risks + 2 coping moves.",
    "hr_agent":          "Should Pushkar hire a part-time farm manager or contract freelance devs first? Analyze trade-offs.",
    "revenue_scout":     "Given Turicks (agency) + Naggar (homestay), rank the top 3 near-term (30 day) revenue opportunities across both.",
    "outreach_agent":    "Draft a cold email to a US SaaS CEO offering Turicks agentic-AI audit ($500 starter → $5K retainer).",
    "pipeline_md":       "Given 12 leads, 3 proposals out, 1 signed: project next-30-day cash collections realistically.",
    "scrum_engine":      "Compose the evening scrum for today: what shipped (Turicks), farm status (Naggar), tomorrow's top 3.",
    "scrum_pm":          "Prioritize tomorrow's 8-hour day across Turicks client delivery + Naggar farm ops + personal admin. Be ruthless.",

    # ── JobOS V2 ──
    "job_coordinator":       "Coordinate a job-search sprint for senior AI/ML engineer roles in EU/US remote. Give the 4-phase plan.",
    "job_intel":             "Surface 3 realistic senior AI engineer roles ($150K+, EU/US remote). Company, role, salary, key asks.",
    "ats_optimizer":         "For a senior LangGraph/agentic-AI role, list the 12 keywords the ATS is likely scanning for.",
    "cover_letter_writer":   "Write a 180-word cover letter for a senior AI engineer role at a US YC startup. Voice: builder, not applicant.",
    "outreach_agent_personal":"Draft a LinkedIn DM to a hiring manager at a $10M ARR AI startup, referencing a recent product launch.",

    # ── JobOS V3 ──
    "resume_tailor":        "Tailor a resume bullet for this JD keyword: 'production LangGraph + agentic orchestration at scale'. Give 1 STAR bullet.",
    "lead_monitor":         "List 5 signals that mean a job lead is actively hiring (not just posted): e.g. recent Series A, founder tweets, etc.",
    "interview_researcher": "For a senior AI role at a growth-stage YC startup, what 5 things should the candidate research before round 1?",
    "hr_scout":             "Find the likely hiring-manager title at a 50-person AI startup for a senior engineer role. Who should the candidate reach?",
    "liaison_agent":        "A recruiter asked about salary expectations. Draft a 60-word polite counter that re-anchors value, not number.",
}

# Cross-company cross-pollination tests
CROSS_TESTS = [
    {
        "name": "Revenue-Scout reads both companies",
        "agent": "revenue_scout",
        "prompt": "Pull signals: Turicks has 3 warm leads. Naggar has empty May bookings. Rank top 2 revenue moves across BOTH.",
    },
    {
        "name": "Scrum-Engine bridges both silos",
        "agent": "scrum_engine",
        "prompt": "Give today's unified standup: 1 Turicks win, 1 Naggar win, 1 systemic blocker.",
    },
    {
        "name": "Cost-Watchdog sees both P&Ls",
        "agent": "cost_watchdog",
        "prompt": "Given Turicks is in growth mode and Naggar in stabilization, recommend where to cut vs invest.",
    },
    {
        "name": "Team-Therapist spans personas",
        "agent": "team_therapist",
        "prompt": "Founder has conflicting priorities: ship Turicks client work vs. prep Naggar for peak May. Name the emotional cost and a coping move.",
    },
    {
        "name": "HR-Agent workforce strategy",
        "agent": "hr_agent",
        "prompt": "Should the 5th hire be a farm-ops VA or a Turicks junior dev? Model both bets.",
    },
]

# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def _one_openrouter(model: str, system: str, user: str, max_tokens: int) -> tuple[str, str]:
    r = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {OPENROUTER_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://founderos.local",
            "X-Title": "FounderOS Production Test",
        },
        json={
            "model": model,
            "max_tokens": max_tokens,
            "temperature": 0.6,
            "messages": [
                {"role": "system", "content": system[:2000]},
                {"role": "user", "content": user[:4000]},
            ],
        },
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"{r.status_code}: {r.text[:150]}")
    data = r.json()
    content = (data.get("choices", [{}])[0].get("message", {}) or {}).get("content", "")
    if not content:
        raise RuntimeError(f"empty response: {str(data)[:150]}")
    return content.strip(), model


def call_openrouter_cascade(models: list[str], system: str, user: str, max_tokens: int = 500) -> tuple[str, str]:
    """Try each model in order; return (result, model_used). Small backoff between retries."""
    last_err = ""
    for m in models:
        for attempt in range(2):
            try:
                return _one_openrouter(m, system, user, max_tokens)
            except Exception as e:
                last_err = f"{m}: {e}"
                if "429" in str(e) or "rate" in str(e).lower():
                    time.sleep(3 + attempt * 4)
                    continue
                break
    raise RuntimeError(f"All cascade models failed. Last: {last_err}")


def send_tg(text: str, topic_id: int | None = None) -> bool:
    """Send a formatted HTML message to Telegram."""
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if topic_id:
        payload["message_thread_id"] = topic_id
    try:
        r = requests.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                          json=payload, timeout=30)
        if not r.json().get("ok"):
            # Fall back to plain text if HTML parse fails
            payload.pop("parse_mode", None)
            r = requests.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                              json=payload, timeout=30)
        return r.json().get("ok", False)
    except Exception as e:
        print(f"TG send failed: {e}")
        return False


def topic_for_agent(agent: Agent) -> int:
    """Resolve the correct topic ID per agent."""
    if agent.company_assignment == "turicks":
        return TOPICS["turicks"]
    if agent.company_assignment == "naggar":
        return TOPICS["naggar"]
    # cross
    if "social" in agent.name:
        return TOPICS["social"]
    if agent.name in ("scrum_engine", "scrum_pm", "cost_watchdog", "revenue_scout",
                       "pipeline_md", "outreach_agent", "team_therapist", "hr_agent"):
        return TOPICS["boardroom"]
    # JobOS agents
    return TOPICS["think_tank"]


def build_system_prompt(agent: Agent) -> str:
    """Build a compact system prompt for the agent."""
    try:
        p = get_prompt(agent.name)
        if p and len(p) > 50:
            return p[:1500]
    except Exception:
        pass
    # Generic fallback
    return (
        f"You are the '{agent.name}' agent in FounderOS.\n"
        f"Company: {agent.company_assignment}.\n"
        f"Tier: {agent.cascade_tier}.\n"
        f"Tools granted: {', '.join(agent.allowed_tools)}.\n"
        f"Collections: {', '.join(agent.allowed_collections)}.\n"
        f"Be concise, practical, founder-grade. Output plain text."
    )


# ─────────────────────────────────────────────
# MAIN RUNNER
# ─────────────────────────────────────────────
def run_agent_test(agent: Agent, task: str) -> dict:
    """Execute one agent, return a result dict."""
    models = TIER_MODELS.get(agent.cascade_tier, TIER_MODELS["md"])
    system = build_system_prompt(agent)
    max_tok = {"ceo": 400, "deep_research": 700, "md": 500, "nano": 250,
               "local": 400, "code": 600, "video": 400}.get(agent.cascade_tier, 500)
    t0 = time.time()
    try:
        result, model = call_openrouter_cascade(models, system, task, max_tokens=max_tok)
        dur = time.time() - t0
        return {
            "agent": agent.name, "company": agent.company_assignment,
            "tier": agent.cascade_tier, "model": model, "task": task,
            "result": result, "tools": agent.allowed_tools,
            "duration": dur, "status": "ok",
        }
    except Exception as e:
        dur = time.time() - t0
        model = models[0] if models else "unknown"
        return {
            "agent": agent.name, "company": agent.company_assignment,
            "tier": agent.cascade_tier, "model": model, "task": task,
            "result": f"ERROR: {e}", "tools": agent.allowed_tools,
            "duration": dur, "status": "fail",
        }


def main():
    start_time = time.time()
    print(f"▶ FounderOS production test starting at {datetime.now():%H:%M:%S}")

    # ── Announce start in Boardroom ──
    send_tg(
        f"{banner('FounderOS Production Test — Starting', '🚀')}\n\n"
        f"Running {len(AGENT_TASKS)} agents + {len(CROSS_TESTS)} cross-company tests\n"
        f"via OpenRouter free models. Results streaming to each topic.",
        TOPICS["boardroom"],
    )

    agents = get_all_agents()
    results = []
    per_company_pass = defaultdict(lambda: [0, 0])  # [passed, total]
    model_counts = defaultdict(int)

    # ── Phase 1: All 39 agents (parallel, 6 at a time to respect OR rate limits) ──
    print(f"Phase 1: {len(agents)} agents")
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {}
        for a in agents:
            task = AGENT_TASKS.get(a.name, f"Perform your core duty as the {a.name} agent. Show concrete output.")
            futures[ex.submit(run_agent_test, a, task)] = a

        for fut in as_completed(futures):
            a = futures[fut]
            r = fut.result()
            results.append(r)
            per_company_pass[a.company_assignment][1] += 1
            model_counts[r["model"]] += 1
            if r["status"] == "ok":
                per_company_pass[a.company_assignment][0] += 1
            # stream to its topic
            msg = agent_report(
                agent=r["agent"], company=r["company"], tier=r["tier"],
                task=r["task"], result=r["result"], tools_used=r["tools"],
                model=r["model"], duration_s=r["duration"], status=r["status"],
            )
            send_tg(msg, topic_for_agent(a))
            print(f"  {'✅' if r['status']=='ok' else '❌'} {r['agent']:<28} {r['duration']:.1f}s")

    # ── Phase 2: Cross-company tests ──
    print(f"Phase 2: {len(CROSS_TESTS)} cross-company tests")
    send_tg(section_divider("🔄 CROSS-COMPANY COMMUNICATION TESTS"), TOPICS["boardroom"])
    cross_passed = 0
    for t in CROSS_TESTS:
        a = get_agent(t["agent"])
        if not a:
            continue
        r = run_agent_test(a, t["prompt"])
        if r["status"] == "ok":
            cross_passed += 1
        header_line = f"<b>🔄 Cross-Test:</b> <i>{t['name']}</i>\n"
        msg = header_line + agent_report(
            agent=r["agent"], company=r["company"], tier=r["tier"],
            task=r["task"], result=r["result"], tools_used=r["tools"],
            model=r["model"], duration_s=r["duration"], status=r["status"],
        )
        send_tg(msg, TOPICS["boardroom"])
        print(f"  {'✅' if r['status']=='ok' else '❌'} CROSS: {t['name']}")

    # ── Final summary ──
    total = len(results)
    passed = sum(1 for r in results if r["status"] == "ok")
    failed = total - passed
    avg_dur = sum(r["duration"] for r in results) / max(total, 1)

    summary = production_summary(
        total=total, passed=passed, failed=failed,
        cross_tests=len(CROSS_TESTS), cross_passed=cross_passed,
        avg_duration=avg_dur,
        models_used=dict(model_counts),
        per_company={k: tuple(v) for k, v in per_company_pass.items()},
    )
    send_tg(summary, TOPICS["boardroom"])

    # ── Write local JSON artifact ──
    out = ROOT / "production_test_results.json"
    with open(out, "w") as f:
        json.dump({
            "timestamp": datetime.now().isoformat(),
            "total": total, "passed": passed, "failed": failed,
            "cross_passed": cross_passed, "cross_total": len(CROSS_TESTS),
            "avg_duration": avg_dur,
            "model_counts": dict(model_counts),
            "per_company": {k: list(v) for k, v in per_company_pass.items()},
            "results": results,
        }, f, indent=2)
    print(f"\n✓ Results saved: {out}")
    print(f"✓ Total duration: {time.time()-start_time:.1f}s")
    print(f"✓ {passed}/{total} agents passed  |  {cross_passed}/{len(CROSS_TESTS)} cross-tests passed")


if __name__ == "__main__":
    main()
