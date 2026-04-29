"""
FounderOS — Real Task Test (Local MLX + Tool Calling)
======================================================
Tests all 4 departments with real tasks using:
  nano/local tiers → Qwen3-8B on-device (or Qwen2.5-7B fallback)
  md/ceo tiers     → OpenRouter free cascade

Tools actually executed: bash, search_web, chromadb_read, chromadb_write, telegram_send
Results streamed to correct Telegram topics in real time.

Run: python .c-suite/test_real_tasks.py
"""
import sys, time
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv; load_dotenv(ROOT / ".env", override=True)

from core.departments.worker import make_worker
from core.departments.tools import execute_tool, tools_for_agent
from core.departments.llm import _resolve_local_model, LOCAL_TIERS
from core.registry import get_agent
from bridges.telegram_formatter import agent_report, section_divider, banner
from production_test import send_tg, TOPICS  # type: ignore

print("=" * 68)
print("FounderOS Real Task Test — Local MLX + Real Tool Calling")
print("=" * 68)
print(f"Local model: {_resolve_local_model()}")
print(f"Local tiers (run on-device): {LOCAL_TIERS}\n")

# ── Real scenarios per agent (need tools to answer properly) ──────────────────
REAL_TASKS = [
    # TURICKS — code tier (OpenRouter)
    ("bidding_sniper",
     "Use bash to count how many Python files are in .c-suite/core, then write a "
     "short Upwork pitch for a LangGraph project: Need AI agent system for HR automation, $3000, 2 weeks."),

    ("proposal_writer",
     "First use chromadb_read on turicks_mem to recall any past proposals, then draft "
     "a 5-line scope for a RAG chatbot project at $2500. Store the result in turicks_mem."),

    ("seo_specialist",
     "Use search_web to find 3 real keyword insights for 'AI agency for SMEs 2026'. "
     "Summarise the findings in bullet points."),

    # NAGGAR — local tier (MLX on-device)
    ("booking_concierge",
     "Use chromadb_read on naggar_mem to check any prior guest notes, then draft a "
     "reply to: 'Hi, can we book 2 rooms for May 15-18, vegetarian food, need early "
     "check-in at 10am.' Store reply in naggar_mem."),

    ("farm_weather",
     "Use search_web to get current weather conditions for Kullu/Manali Himachal "
     "Pradesh. Then write a 3-bullet advisory for raspberry crop (fruit-set stage, "
     "April, 1768m altitude). Store advisory in naggar_mem."),

    ("culinary_agent",
     "Read naggar_mem for any stored menu notes, then design a 3-course vegetarian "
     "farm-to-table dinner using raspberries, walnuts, local Himachali produce."),

    # COMMAND — md tier (OpenRouter)
    ("scrum_pm",
     "Use bash to list files in the .c-suite/agents directory, then compile a "
     "tomorrow's plan: top 3 priorities across Turicks client delivery + Naggar farm."),

    ("cost_watchdog",
     "Use bash to count Python files in the whole project, then read social_mem for "
     "any stored cost data. Give 2 concrete cost-cut recommendations across "
     "Turicks (APIs) + Naggar (farm inputs)."),

    ("social_handler",
     "Use search_web to find one trending AI/agency topic on LinkedIn right now. "
     "Then write 1 LinkedIn post for Turicks and 1 Instagram caption for Naggar. "
     "Send the posts to the social Telegram topic."),

    # CAREER — md tier (OpenRouter)
    ("resume_tailor",
     "Use bash to check if there's a resume file in the project. Then write 2 "
     "strong STAR-format resume bullets for a senior LangGraph engineer role, "
     "targeting a YC startup JD that asks for 'agentic orchestration at scale'."),

    ("interview_researcher",
     "Use search_web to find 3 real things about what top AI startups look for in "
     "senior engineers in 2026. Summarise interview prep points."),
]

# ─────────────────────────────────────────────
results = []
send_tg(banner("Real Task Test — Local MLX + Tool Calling", "🧪"), TOPICS["boardroom"])

for agent_name, task in REAL_TASKS:
    a = get_agent(agent_name)
    if not a:
        print(f"  ⚠️  {agent_name} not in registry")
        continue

    print(f"\n{'─'*60}")
    print(f"▶ {agent_name} ({a.cascade_tier}) | tools: {tools_for_agent(a.name)}")
    print(f"  task: {task[:80]}...")

    worker = make_worker(a)
    t0 = time.time()
    out = worker({"task": task})
    dur = time.time() - t0
    w = out["worker_outputs"][0]

    emoji = "✅" if w["status"] == "ok" else "❌"
    print(f"  {emoji} done in {dur:.1f}s | steps={w.get('steps')} | tools_used={w.get('tools_used')} | model={w['model']}")
    print(f"  answer: {w['result'][:200]}...")

    # Route to correct topic
    topic_map = {"turicks": "turicks", "naggar": "naggar", "cross": "boardroom", "career": "think_tank"}
    tg_topic = TOPICS.get(topic_map.get(a.company_assignment, "boardroom"))

    msg = agent_report(
        agent=w["agent"], company=a.company_assignment, tier=a.cascade_tier,
        task=task, result=w["result"],
        tools_used=w.get("tools_used", []),
        model=w["model"], duration_s=dur, status=w["status"],
    )
    send_tg(msg, tg_topic)
    results.append(w)

# Summary
passed = sum(1 for r in results if r["status"] == "ok")
summary = (
    f"\n{'='*60}\n"
    f"✅ {passed}/{len(results)} agents passed\n"
    f"Tool calls made: {sum(len(r.get('tools_used',[])) for r in results)}\n"
    f"Avg duration: {sum(r['duration'] for r in results)/max(len(results),1):.1f}s\n"
    f"Models used: {', '.join(set(r['model'] for r in results))}"
)
print(summary)
send_tg(
    f"<b>Real Task Test Summary</b>\n"
    f"✅ {passed}/{len(results)} passed\n"
    f"🛠 Tool calls: {sum(len(r.get('tools_used',[])) for r in results)}\n"
    f"🤖 Models: {', '.join(set(r['model'][:40] for r in results))}",
    TOPICS["boardroom"]
)
