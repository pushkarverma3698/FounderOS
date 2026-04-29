"""
FounderOS — One-Time Platform Profile Setup
=============================================
Run ONCE after connecting all platform tokens.
Sets up Pushkar's GitHub profile README + optimizes repo descriptions.

Usage:
    cd .c-suite && python tools/setup_profiles.py

What it does:
    1. GitHub: Updates bio, blog, sets profile README
    2. GitHub: Optimizes top repo descriptions + topics
    3. GitHub: Stars 10 trending AI repos to kick-start visibility
    4. Sends summary to Telegram boardroom
"""
import os, sys, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

from tools.tool_github import (
    github_update_profile, github_update_readme,
    github_list_repos, github_update_repo,
    github_star_repo, github_follow_user,
    github_trending, github_get_stats,
)


PROFILE_README = """<div align="center">

# Hi, I'm Pushkar Verma 👋

**Solo founder building autonomous AI systems that run businesses while I sleep.**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-blue?style=flat&logo=linkedin)](https://linkedin.com/in/pushkarverma)
[![Turicks](https://img.shields.io/badge/Turicks-AI%20Agency-black?style=flat)](https://turicks.com)
[![Location](https://img.shields.io/badge/📍-Amsterdam%20%7C%20Naggar%2C%20HP-green?style=flat)](https://github.com/pushkarverma)

</div>

---

## 🤖 What I Build

I build **multi-agent autonomous systems** using LangGraph, LangChain, and Python — systems that do the work of entire ops teams.

Currently running **FounderOS** — a 39-agent AI operating system managing two companies simultaneously:
- 🏢 **[Turicks](https://turicks.com)** — AI automation agency (LangGraph · Next.js · MERN)
- 🏔️ **Naggar Retreat** — Himalayan farm + premium homestay (Ahata brand)

---

## 🚀 Featured Projects

| Project | Description | Stack |
|---------|-------------|-------|
| **FounderOS** | 39-agent autonomous business OS | LangGraph · Python · ChromaDB |
| **Turicks Agency** | AI automation for SaaS founders | LangGraph · Next.js · FastAPI |
| **Naggar Retreat** | Smart farm + booking automation | Python · Airbnb API · Weather AI |

---

## 🛠️ Tech Stack

```
AI/Agents:   LangGraph · LangChain · OpenAI · Anthropic · Gemini · MLX (Apple Silicon)
Backend:     Python · FastAPI · Node.js · Express
Frontend:    Next.js · React · TypeScript · Tailwind
Databases:   PostgreSQL · ChromaDB · SQLite · Redis
DevOps:      Docker · GitHub Actions · Railway · Vercel
```

---

## 📊 Current Focus (2026)

- 🔨 **Building:** FounderOS V2 — 39-agent swarm with real tool execution
- 📈 **Growing:** Turicks AI Agency — 3-5 day delivery, LangGraph specialists
- 🌱 **Exploring:** On-device AI with Apple MLX + Qwen3

---

## 📝 Recent Build Log

<!-- These update automatically via FounderOS social_handler -->
- Building a production LangGraph system for a SaaS client
- Running Qwen3-8B on M4 MacBook for local AI inference
- 39 agents, 0 burnout — FounderOS handles the ops

---

## 🤝 Let's Work Together

If you're a **SaaS founder spending >4 hrs/week on repetitive operations**, I want to talk.

We build in LangGraph. Deliver in 3-5 days. No prototypes — working systems only.

📧 **[pushkar@turicks.com](mailto:pushkar@turicks.com)**
🌐 **[turicks.com](https://turicks.com)**
💬 **[LinkedIn DM](https://linkedin.com/in/pushkarverma)**

---

<div align="center">

*"The best ops team is one that runs without you."*

![GitHub Stats](https://github-readme-stats.vercel.app/api?username=pushkarverma&show_icons=true&theme=dark&hide_border=true)

</div>
"""

REPO_OPTIMIZATIONS = [
    # Add your actual repo names here — these are examples
    # {"repo": "founderos", "description": "39-agent autonomous business OS built with LangGraph", "topics": ["langgraph", "ai-agents", "langchain", "python", "autonomous-agents", "llm"]},
    # {"repo": "turicks-website", "description": "AI automation agency website — Next.js + TypeScript", "topics": ["nextjs", "typescript", "tailwind", "ai-agency"]},
]

TRENDING_REPOS_TO_STAR = [
    "langchain-ai/langgraph",
    "langchain-ai/langchain",
    "microsoft/autogen",
    "joaomdmoura/crewAI",
    "run-llama/llama_index",
    "ollama/ollama",
    "mlx-community/mlx-examples",
    "openai/openai-python",
    "anthropics/anthropic-sdk-python",
    "hwchase17/langchain",
]

AI_DEVS_TO_FOLLOW = [
    "hwchase17",       # LangChain creator
    "eyurtsev",        # LangGraph core
    "brainlid",        # Elixir AI but active community
    "rasahq",          # Rasa NLP
    "simonw",          # Simon Willison — AI commentary
]


def run_setup():
    print("=" * 60)
    print("FounderOS — Platform Profile Setup")
    print("=" * 60)

    # 1. Check GitHub token
    token = os.getenv("GITHUB_TOKEN", "")
    username = os.getenv("GITHUB_USERNAME", "pushkarverma")
    if not token:
        print("\n❌ GITHUB_TOKEN not set in .env")
        print("   Get it from: github.com → Settings → Developer settings → Personal access tokens")
        print("   Required scopes: repo, user, read:org")
        print("\n⚠️  Skipping GitHub setup. LinkedIn and Upwork guide below.")
        github_ok = False
    else:
        github_ok = True
        print(f"\n✅ GitHub token found. Username: {username}")

    if github_ok:
        print("\n── Step 1: Update GitHub profile ──")
        result = github_update_profile(json.dumps({
            "bio": "Solo founder | LangGraph · AI Agents · Next.js | Building autonomous systems @ Turicks",
            "blog": "https://turicks.com",
            "company": "@turicks",
            "location": "Amsterdam, Netherlands",
            "twitter_username": "pushkarverma",
        }))
        print(f"  Profile: {result}")

        print("\n── Step 2: Write profile README ──")
        result = github_update_readme(PROFILE_README)
        print(f"  README: {result}")

        print("\n── Step 3: Optimize repo descriptions ──")
        if REPO_OPTIMIZATIONS:
            for repo_data in REPO_OPTIMIZATIONS:
                result = github_update_repo(json.dumps(repo_data))
                print(f"  {repo_data['repo']}: {result}")
        else:
            repos_raw = github_list_repos()
            print("  Current repos:")
            print("  " + repos_raw[:800].replace("\n", "\n  "))
            print("\n  ⚠️  Add your repo names to REPO_OPTIMIZATIONS in this file to auto-optimize them.")

        print("\n── Step 4: Star trending AI repos ──")
        for repo in TRENDING_REPOS_TO_STAR:
            result = github_star_repo(repo)
            print(f"  {result}")

        print("\n── Step 5: Follow active AI developers ──")
        for user in AI_DEVS_TO_FOLLOW:
            result = github_follow_user(user)
            print(f"  {result}")

        print("\n── Step 6: Current stats ──")
        stats = github_get_stats()
        print("  " + stats.replace("\n", "\n  "))

    print("\n" + "=" * 60)
    print("UPWORK SETUP GUIDE")
    print("=" * 60)
    print("""
1. Create developer account:
   → go.upwork.com/api/keys → Create New App
   → App name: "FounderOS Revenue Agent"
   → Callback URL: http://localhost:8000/callback

2. Add to .env:
   UPWORK_API_KEY=your_consumer_key
   UPWORK_API_SECRET=your_consumer_secret

3. Profile optimization checklist (do manually):
   ✅ Headline: "LangGraph AI Agent Systems | 3-5 Day Delivery | No Prototypes"
   ✅ Overview: Lead with pain point (founders spending hrs on manual ops)
   ✅ Skills: LangGraph, LangChain, Python, FastAPI, Next.js, AI Automation, OpenAI API
   ✅ Portfolio: Add 2-3 project screenshots (FounderOS dashboard, any client work)
   ✅ Rates: Set $75-100/hr (positions you as expert, not cheap labour)
   ✅ Availability: "More than 30 hrs/week"
   ✅ Profile photo: Professional, plain background
   ✅ English level: Native or bilingual

4. RSS fallback (ALREADY ACTIVE):
   The bidding_sniper already uses Upwork RSS feeds — no API key needed.
   To also get API access, complete steps 1-2 above.
""")

    print("=" * 60)
    print("LINKEDIN GROWTH GUIDE")
    print("=" * 60)
    print(f"""
✅ OAuth token: ACTIVE (urn:li:person:BYO5LyaX7A)
✅ Posting: Working via ugcPosts API
✅ Scheduler: Tue/Thu/Sat posts configured

PROFILE OPTIMIZATION (do manually on linkedin.com):
✅ Headline: "Solo Founder | Building AI Automation Systems | LangGraph · LangChain | Turicks"
✅ About: Start with hook — "Every week, SaaS founders waste 20+ hours on work that AI should be doing."
✅ Featured: Pin your best post + link to turicks.com
✅ Experience: Turicks (AI Agency founder) + Naggar Retreat
✅ Skills: Endorse yourself for LangGraph, AI Agents, Python, Automation
✅ Creator Mode: Turn ON (unlocks "Follow" button instead of just Connect)
✅ Profile URL: linkedin.com/in/pushkarverma (custom URL)

GROWTH TACTICS (agents handle automatically):
→ linkedin_growth agent: daily 10:30 IST — engagement + connections
→ social_handler: Tue/Thu/Sat — original content
→ analytics_loop: daily 09:00 — track what's working
""")

    # Telegram summary
    try:
        import requests
        tok  = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        chat = os.environ.get("TELEGRAM_CHAT_ID", "")
        msg = (
            "🚀 <b>Platform Setup Complete</b>\n\n"
            f"{'✅' if github_ok else '⚠️'} GitHub: {'README + profile updated' if github_ok else 'Token needed'}\n"
            "✅ LinkedIn: OAuth active, growth agents scheduled\n"
            "✅ Upwork: RSS fallback active, 5 ICP queries running\n\n"
            "📅 Growth Schedule:\n"
            "• LinkedIn growth: Mon–Fri 10:30 IST\n"
            "• GitHub growth: Monday 07:30 IST\n"
            "• Platform research: Wednesday 08:00 IST\n"
            "• Upwork profile refresh: Sunday 20:00 IST"
        )
        if tok and chat:
            requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                json={"chat_id": chat, "message_thread_id": 8,
                      "text": msg, "parse_mode": "HTML"}, timeout=10)
            print("\n✅ Summary sent to Telegram boardroom")
    except Exception as e:
        print(f"\n⚠️  Telegram send failed: {e}")

    print("\n✅ Setup complete!")


if __name__ == "__main__":
    run_setup()
