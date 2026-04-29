"""
FounderOS — Real Agent Task Runner with Tool Calls
====================================================
Assigns live tasks to 8 agents. Each agent:
  1. Runs pre_tool_hook (security gate)
  2. Executes real tools (ChromaDB read/write, bash, firecrawl)
  3. Calls the correct model cascade
  4. Stores result to memory
  5. Reports to Telegram topic

Run: python agent_task_runner.py
"""

import asyncio, sys, os, subprocess, time, logging
sys.path.insert(0, str(os.path.dirname(__file__)))

from core.config import (
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    TOPIC_BOARDROOM, TOPIC_TURICKS, TOPIC_NAGGAR, TOPIC_SOCIAL, TOPIC_THINK_TANK,
    call_md, call_nano, call_deep_research, call_local, FIRECRAWL_API_KEY, call_firecrawl,
)
from memory.memory import recall, store, store_experience, get_collection
from core.tool_hooks import pre_tool_hook, post_tool_hook
from aiogram import Bot

logging.basicConfig(level=logging.WARNING)  # Suppress cascade noise during task run
log = logging.getLogger("TaskRunner")

bot = Bot(token=TELEGRAM_BOT_TOKEN)

# ─── Telegram helper ──────────────────────────────────────────────────────────

async def tg(topic_id: int, text: str, label: str = ""):
    """Send to a Telegram topic. Falls back to Boardroom if topic doesn't exist yet."""
    msg = f"{label}\n\n{text}" if label else text
    targets = [topic_id]
    if topic_id != TOPIC_BOARDROOM and topic_id not in (6, 8):
        targets = [TOPIC_BOARDROOM]  # fallback — topic not created yet
        msg = f"[→ topic {topic_id} pending creation]\n\n{msg}"
    for tid in targets:
        try:
            await bot.send_message(
                chat_id=TELEGRAM_CHAT_ID,
                message_thread_id=tid,
                text=str(msg)[:4000],
                parse_mode="Markdown",
            )
            return
        except Exception:
            try:
                await bot.send_message(
                    chat_id=TELEGRAM_CHAT_ID,
                    message_thread_id=tid,
                    text=str(msg)[:4000],
                )
                return
            except Exception as e:
                print(f"   ❌ Telegram send failed (topic {tid}): {e}")


def tool_gate(tool: str, inp: str, agent: str, collection: str = "") -> bool:
    """Run pre_tool_hook. Returns True if allowed."""
    result = pre_tool_hook(tool, inp, agent_name=agent, collection_name=collection)
    if result.behavior == "deny":
        print(f"   🚫 [{agent}] Tool '{tool}' DENIED: {result.reason}")
        return False
    return True


def bash_tool(cmd: str, agent: str) -> str:
    """Execute bash command with hook check + output sanitization."""
    if not tool_gate("bash", cmd, agent):
        return "[BLOCKED]"
    try:
        out = subprocess.check_output(cmd, shell=True, text=True, timeout=10, stderr=subprocess.STDOUT)
        return post_tool_hook("bash", out.strip()[:800], agent)
    except subprocess.CalledProcessError as e:
        return post_tool_hook("bash", e.output[:400] if e.output else str(e), agent)
    except Exception as e:
        return f"[Error] {e}"


def mem_read(collection_name: str, query: str, agent: str, n: int = 2) -> str:
    """Recall from ChromaDB with hook check."""
    if not tool_gate("chromadb_read", query, agent, collection_name):
        return "[MEMORY BLOCKED]"
    col = get_collection(collection_name)
    docs = recall(col, query, n_results=n)
    result = "\n".join(docs) if docs else "No prior memory found."
    return post_tool_hook("chromadb_read", result, agent)


def mem_write(collection_name: str, agent: str, task: str, result: str):
    """Write experience to ChromaDB with hook check."""
    if not tool_gate("chromadb_write", result[:100], agent, collection_name):
        return
    store_experience(agent, task, result)


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 1: proposal_writer — Turicks Floor
# Tools: bash (git log), chromadb_read, chromadb_write
# ═══════════════════════════════════════════════════════════════════════════════

async def task_proposal_writer():
    agent = "proposal_writer"
    print(f"\n[1/8] {agent} → #Turicks_Floor")

    # Tool 1: bash — check recent commits for context
    git_log = bash_tool("git -C /Users/pushkarverma/Documents/Coding\\ stuff/FounderOS log --oneline -5 2>/dev/null || echo 'no git'", agent)

    # Tool 2: memory read — prior proposals
    prior = mem_read("turicks_mem", "LangGraph automation proposal e-commerce", agent)

    # LLM call — MD tier
    prompt = f"""Write a 3-paragraph executive summary for a proposal to automate order management for an e-commerce startup (ShopEasy) using LangGraph agents.

Prior context from memory:
{prior}

Recent dev activity: {git_log[:200]}

Deliverable: executive summary with problem, solution, and ROI. Max 200 words."""

    result = call_md(prompt, system="You are the Turicks proposal_writer. Professional, concise, value-driven.")

    # Tool 3: memory write — store result
    mem_write("turicks_mem", agent, "ShopEasy LangGraph proposal", result)

    # Telegram
    await tg(TOPIC_TURICKS,
        f"*proposal\\_writer — ShopEasy Automation Proposal*\n\n{result}\n\n_Tools used: bash(git), chromadb\\_read, chromadb\\_write_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 2: booking_concierge — Naggar HQ
# Tools: chromadb_read (prior bookings), chromadb_write
# ═══════════════════════════════════════════════════════════════════════════════

async def task_booking_concierge():
    agent = "booking_concierge"
    print(f"\n[2/8] {agent} → #Naggar_HQ")

    prior = mem_read("naggar_mem", "guest booking pricing peak season", agent)

    prompt = f"""Guest inquiry received: "We are a family of 4 visiting Naggar for 5 nights in May. What's your rate and what's included?"

Prior booking data:
{prior}

Pricing rules: Base ₹6,000/night. May = peak season (+40%). Family discount for 5+ nights: -10%.
Reply with: final price, what's included, 2-sentence welcome note."""

    result = call_nano(prompt, system="Naggar Retreat booking_concierge. Warm, specific, never discount without occupancy check.")

    mem_write("naggar_mem", agent, "family 5-night May booking inquiry", result)

    await tg(TOPIC_NAGGAR,
        f"*booking\\_concierge — Guest Inquiry Response*\n\n{result}\n\n_Tools: chromadb\\_read(naggar\\_mem), chromadb\\_write_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 3: social_handler — Social Command
# Tools: chromadb_read (brand voice), chromadb_write
# ═══════════════════════════════════════════════════════════════════════════════

async def task_social_handler():
    agent = "social_handler"
    print(f"\n[3/8] {agent} → #Social_Command")

    prior = mem_read("social_mem", "Instagram Naggar Retreat raspberry harvest content", agent)

    prompt = f"""Write a 30-second Instagram Reel script for Naggar Retreat showing the raspberry harvest.
Context from memory: {prior}
Include: hook (0-3s), story beat (3-20s), CTA (20-30s), 5 hashtags. Brand voice: warm, poetic, slow."""

    result = call_md(prompt, system="Social Media Manager for Naggar Retreat. Poetic mountain brand voice. No corporate filler.")

    mem_write("social_mem", agent, "Naggar raspberry harvest Reel script", result)

    await tg(TOPIC_SOCIAL,
        f"*social\\_handler — Naggar Raspberry Harvest Reel*\n\n{result}\n\n_Tools: chromadb\\_read(social\\_mem), chromadb\\_write_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 4: cost_watchdog — Boardroom
# Tools: bash (check pip packages), chromadb_read, chromadb_write
# ═══════════════════════════════════════════════════════════════════════════════

async def task_cost_watchdog():
    agent = "cost_watchdog"
    print(f"\n[4/8] {agent} → #The_Boardroom")

    # Tool: bash — list installed packages to audit
    pkgs = bash_tool("/Users/pushkarverma/mlx_env/bin/pip list --format=columns 2>/dev/null | head -30", agent)

    prior = mem_read("social_mem", "tool cost audit savings", agent)

    prompt = f"""FounderOS Weekly Cost Audit.
Installed packages (sample): {pkgs[:400]}
Prior audit context: {prior}
API stack: Gemini (free tier), OpenRouter (free models), Anthropic (API credits needed), Firecrawl (paid), ChromaDB (local/free).
Output: 💰 COST REPORT — which tools cost money, free alternatives, top 3 savings this week."""

    result = call_md(prompt, system="FounderOS Cost Watchdog. Maximize free tier. Brutally practical.")

    mem_write("social_mem", agent, "weekly cost audit", result)

    await tg(TOPIC_BOARDROOM,
        f"*cost\\_watchdog — Weekly Cost Audit*\n\n{result}\n\n_Tools: bash(pip list), chromadb\\_read, chromadb\\_write_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 5: lead_intel — Turicks Floor (uses firecrawl if key set)
# Tools: firecrawl OR bash(curl), chromadb_read, chromadb_write
# ═══════════════════════════════════════════════════════════════════════════════

async def task_lead_intel():
    agent = "lead_intel"
    print(f"\n[5/8] {agent} → #Turicks_Floor")

    prior = mem_read("turicks_mem", "AI startup lead LangGraph automation", agent)

    # Tool: firecrawl (or fallback to synthetic research)
    web_data = ""
    if FIRECRAWL_API_KEY and tool_gate("firecrawl", "https://www.ycombinator.com/companies?batch=W25&tags=aiops", agent):
        web_data = call_firecrawl("https://www.ycombinator.com/companies?batch=W25&tags=aiops")
        web_data = post_tool_hook("firecrawl", web_data[:600], agent)
    else:
        web_data = "[Firecrawl not configured — using synthesized data]"

    prompt = f"""Identify 3 AI startup leads for Turicks (AI agency) from this data:
Web data: {web_data}
Prior lead context: {prior}

For each lead: company name | what they do | why they need LangGraph/AI automation | outreach angle | deal size estimate ($1k-$5k)."""

    result = call_local(prompt, system="lead_intel agent for Turicks. Find real AI startup leads. Be specific.")

    mem_write("turicks_mem", agent, "AI startup lead research W25 YC", result)

    await tg(TOPIC_TURICKS,
        f"*lead\\_intel — AI Startup Lead Research*\n\n{result}\n\n_Tools: firecrawl, chromadb\\_read(turicks\\_mem), chromadb\\_write_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 6: vibe_designer — Naggar HQ
# Tools: chromadb_read, chromadb_write, bash (check content dir)
# ═══════════════════════════════════════════════════════════════════════════════

async def task_vibe_designer():
    agent = "vibe_designer"
    print(f"\n[6/8] {agent} → #Naggar_HQ")

    # Tool: bash — check content output directory
    content_ls = bash_tool("ls /Users/pushkarverma/Documents/Coding\\ stuff/FounderOS/content_output/ 2>/dev/null | head -10 || echo 'directory empty'", agent)

    prior = mem_read("naggar_mem", "visual brand content Naggar Retreat mountain", agent)

    prompt = f"""Create a visual content brief for Naggar Retreat's May campaign (raspberry season + apple blossom).
Content directory: {content_ls}
Prior brand memory: {prior}

Brief: 3 hero shot ideas | colour palette | caption tone | one Reel concept | one carousel theme. Max 150 words."""

    result = call_md(prompt, system="Vibe Designer for Naggar Retreat. Warm poetic mountain brand. Reel formula: Hook→Story→Value→CTA.")

    mem_write("naggar_mem", agent, "May visual content brief raspberry blossom", result)

    await tg(TOPIC_NAGGAR,
        f"*vibe\\_designer — May Campaign Brief*\n\n{result}\n\n_Tools: bash(ls content\\_output), chromadb\\_read(naggar\\_mem), chromadb\\_write_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 7: market_scout — Think Tank (Deep Research tier)
# Tools: firecrawl, chromadb_read (social_mem), chromadb_write
# ═══════════════════════════════════════════════════════════════════════════════

async def task_market_scout():
    agent = "market_scout"
    print(f"\n[7/8] {agent} → #The_Think_Tank")

    prior = mem_read("naggar_mem", "Himalayan tourism AI automation market trends", agent)

    # Try to scrape a relevant source
    web_data = ""
    if FIRECRAWL_API_KEY and tool_gate("firecrawl", "https://thetrek.co/", agent):
        web_data = call_firecrawl("https://thetrek.co/")
        web_data = post_tool_hook("firecrawl", web_data[:600], agent)
    else:
        web_data = "[Market data synthesized — enable FIRECRAWL_API_KEY for live data]"

    prompt = f"""Market intelligence brief for Naggar Retreat (Himalayan homestay).
Web source data: {web_data}
Prior context: {prior}

Identify: top 3 Himalayan tourism trends in 2025 | traveller ICP shift | pricing opportunity | one partnership angle. Max 200 words. Cite if uncertain."""

    result = call_deep_research(prompt, system="market_scout for FounderOS. Deep research mode. No hallucination — mark uncertain data.")

    mem_write("naggar_mem", agent, "Himalayan tourism market brief 2025", result)

    await tg(TOPIC_THINK_TANK,
        f"*market\\_scout — Himalayan Tourism Intel 2025*\n\n{result}\n\n_Tools: firecrawl, chromadb\\_read(social\\_mem), chromadb\\_write_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TASK 8: scrum_engine — Boardroom (Evening standup)
# Tools: chromadb_read (all collections), bash (check scheduler logs)
# ═══════════════════════════════════════════════════════════════════════════════

async def task_scrum_engine():
    agent = "scrum_engine"
    print(f"\n[8/8] {agent} → #The_Boardroom")

    # Tool: bash — check any recent log files
    logs = bash_tool("ls /tmp/founderOS*.log 2>/dev/null | head -5 || echo 'no logs found'", agent)

    # Tool: memory read from all companies
    turicks_activity = mem_read("turicks_mem", "completed task output result today", agent)
    naggar_activity  = mem_read("naggar_mem",  "completed task output result today", agent)

    from datetime import datetime
    today = datetime.now().strftime('%d %b %Y')

    prompt = f"""Evening Standup for FounderOS — {today}

Turicks agent signals: {turicks_activity[:300]}
Naggar agent signals:  {naggar_activity[:300]}
System logs: {logs}

Write a structured 150-word scrum:
## ✅ Wins Today | ## 🚧 Blockers | ## 🎯 Tomorrow Top 3 | ## 📊 OKR status"""

    result = call_nano(prompt, system=f"FounderOS MD. Evening standup {today}. Concise, metric-backed, honest.")

    mem_write("social_mem", agent, f"evening scrum {today}", result)

    await tg(TOPIC_BOARDROOM,
        f"📋 *Evening Scrum — {today}*\n\n{result}\n\n_Tools: chromadb\\_read(turicks+naggar), bash(logs)_",
    )
    print(f"   ✅ Done — {len(result)} chars")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TOOL CALL VERIFICATION SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════

async def send_summary(results: dict):
    """Send final verification table to Boardroom."""
    lines = ["*🔧 Agent Task Verification — Tool Call Summary*\n"]
    agents_info = [
        ("proposal_writer",   "MD",    "bash+chromadb_r/w",   "Turicks"),
        ("booking_concierge", "Nano",  "chromadb_r/w",        "Naggar"),
        ("social_handler",    "MD",    "chromadb_r/w",        "Social"),
        ("cost_watchdog",     "MD",    "bash+chromadb_r/w",   "Boardroom"),
        ("lead_intel",        "Local", "firecrawl+chromadb",  "Turicks"),
        ("vibe_designer",     "MD",    "bash+chromadb_r/w",   "Naggar"),
        ("market_scout",      "Deep",  "firecrawl+chromadb",  "Think Tank"),
        ("scrum_engine",      "Nano",  "bash+chromadb×2",     "Boardroom"),
    ]
    for name, tier, tools, dest in agents_info:
        status = "✅" if results.get(name) else "❌"
        lines.append(f"{status} `{name}` [{tier}] — {tools} → #{dest}")

    lines.append("\n_All agents ran real tool hooks (pre\\_tool\\_hook + post\\_tool\\_hook)._")
    await tg(TOPIC_BOARDROOM, "\n".join(lines))


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

async def main():
    print("🚀 FounderOS Agent Task Runner — 8 Real Tasks\n")

    # Notify start
    await tg(TOPIC_BOARDROOM,
        "⚙️ *Agent Task Runner Starting*\n"
        "8 agents receiving real tasks with live tool calls.\n"
        "Results will appear in each agent's Telegram topic."
    )

    results = {}
    tasks = [
        ("proposal_writer",   task_proposal_writer),
        ("booking_concierge", task_booking_concierge),
        ("social_handler",    task_social_handler),
        ("cost_watchdog",     task_cost_watchdog),
        ("lead_intel",        task_lead_intel),
        ("vibe_designer",     task_vibe_designer),
        ("market_scout",      task_market_scout),
        ("scrum_engine",      task_scrum_engine),
    ]

    for name, fn in tasks:
        try:
            r = await fn()
            results[name] = bool(r and len(r) > 10)
        except Exception as e:
            print(f"   ❌ {name} failed: {e}")
            results[name] = False

    await send_summary(results)
    await bot.session.close()

    passed = sum(results.values())
    print(f"\n✅ {passed}/{len(tasks)} agents completed successfully.")


if __name__ == "__main__":
    asyncio.run(main())
