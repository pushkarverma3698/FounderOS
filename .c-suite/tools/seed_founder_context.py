"""
FounderOS — Founder Context Seeder
=====================================
Seeds RICH context about Pushkar Verma into ChromaDB collections.
The more precise this is, the better every agent performs.

Run this ONCE, then update whenever your situation changes.

Usage:
    cd .c-suite && python tools/seed_founder_context.py

Seeds into:
    turicks_mem  — agency context, services, ICP, pricing, case studies
    social_mem   — personal brand, content strategy, voice, platforms
    career_mem   — resume, skills, work history, job search context
"""
import sys, os, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

try:
    import chromadb
    chroma_path = str(Path(__file__).parent.parent / "memory" / "chroma_data")
    client = chromadb.PersistentClient(path=chroma_path)
except Exception as e:
    print(f"❌ ChromaDB not available: {e}")
    sys.exit(1)


def store(collection, doc_id: str, text: str, metadata: dict):
    collection.upsert(
        documents=[text],
        ids=[doc_id],
        metadatas=[{**metadata, "seeded_at": time.strftime("%Y-%m-%d")}]
    )
    print(f"  ✅ {doc_id}")


# ════════════════════════════════════════════════════════════════════════════════
# TURICKS_MEM — Agency context
# ════════════════════════════════════════════════════════════════════════════════

def seed_turicks(col):
    print("\n── Seeding turicks_mem ──")

    store(col, "turicks_identity", """
TURICKS — AI Automation Agency
Founder: Pushkar Verma
Website: turicks.com
Email: pushkar@turicks.com
Location: Amsterdam, Netherlands

MISSION: Help SaaS founders (10-200 employees) automate the operations they're doing manually.
TAGLINE: "Working systems, not prototypes. Delivered in 3-5 days."

WHAT MAKES TURICKS DIFFERENT:
- Speed: 3-5 day delivery (not 3-5 months like agencies)
- Quality: Working code only — no Figma mockups, no POCs, no "let me check with the team"
- Specialisation: LangGraph-first. We don't do generic automation, we do agentic systems
- Founder-built: Pushkar uses the same tech on his own companies (FounderOS) — so it's battle-tested
- No sales team: Direct access to the builder
""", {"type": "identity", "company": "turicks"})

    store(col, "turicks_services", """
TURICKS SERVICES & PRICING

TIER 1 — Starter ($500-1,200):
- Single AI agent or automation workflow
- Use cases: lead scoring, email drafting, Slack bot, simple RAG
- Timeline: 3-5 days
- Best for: Validating AI in one specific workflow

TIER 2 — System ($2,000-4,000):
- Multi-agent LangGraph system
- Use cases: outreach pipeline, content generation system, ops automation swarm
- Timeline: 1-2 weeks
- Best for: Replacing a part-time employee with AI

TIER 3 — Retainer ($1,500-3,000/month):
- Ongoing AI engineering + weekly iterations
- Monthly new automations + maintenance
- Best for: Growing companies that want continuous AI leverage

TIER 4 — Full Stack AI SaaS ($3,000-8,000):
- Complete product: Next.js frontend + FastAPI backend + AI agents
- Timeline: 2-4 weeks
- Best for: Founders building an AI-powered product

ADD-ONS:
- LinkedIn/Upwork profile automation: $300
- Analytics dashboard (Next.js): $800
- API integrations: $200-500 each
""", {"type": "services_pricing", "company": "turicks"})

    store(col, "turicks_icp", """
TURICKS IDEAL CLIENT PROFILE (ICP)

Primary ICP:
- Role: SaaS founder, CTO, Head of Ops
- Company size: 10-200 employees
- Revenue: $500K-$10M ARR
- Verticals: EdTech, HR Tech, FinTech, PropTech, HealthTech
- Geography: EU (Amsterdam, Berlin, London, Stockholm) + US
- Pain: Spending 10+ hours/week on manual, repetitive operations
- Tech sophistication: Knows what APIs and automation are, doesn't want to build themselves
- Decision speed: Can decide in 1 call, budget authority $5K-20K/year on tools

Secondary ICP (Upwork):
- Individual founders with funded startups
- Need: Quick AI MVP to show investors
- Budget: $1K-5K project
- Timeline pressure: "Needs to be done by end of month"

ANTI-ICP (do not waste time on):
- Pure e-commerce with no SaaS element
- Budget under $300 ("can you do it for equity?")
- Wants to learn, not buy (time-wasters)
- Non-English speaking (no bandwidth)
- Enterprise with procurement process >3 months
""", {"type": "icp", "company": "turicks"})

    store(col, "turicks_tech_stack", """
TURICKS TECHNICAL CAPABILITIES

AI / AGENTS (PRIMARY):
- LangGraph: Multi-agent orchestration, stateful workflows, supervisor patterns
- LangChain: Tool use, RAG pipelines, memory systems, chains
- OpenAI API: GPT-4o, GPT-4-turbo, embeddings, function calling
- Anthropic: Claude 3.5 Sonnet/Haiku for reasoning tasks
- Google Gemini: 2.0 Flash for high-volume tasks, free tier
- MLX: On-device inference on Apple Silicon (Qwen3-8B, Llama3)
- ChromaDB: Vector storage, semantic search, agent memory
- Pinecone: Production vector DB for client deployments
- RAG: Retrieval-Augmented Generation, document ingestion, hybrid search

FULL STACK WEB (STRONG):
- Next.js 14/15: App Router, Server Components, Server Actions
- React: Hooks, Context, Zustand, React Query
- TypeScript: Strict mode, generics, utility types
- Tailwind CSS + Shadcn/UI: Rapid production UI
- Node.js + Express.js: REST APIs, middleware, auth
- MongoDB + Mongoose: Document DB, aggregations
- PostgreSQL + Prisma: Relational DB, migrations
- MERN Stack: Full MongoDB-Express-React-Node projects

BACKEND / PYTHON:
- FastAPI: High-performance async APIs, Pydantic models
- Flask: Lightweight APIs, webhooks
- SQLAlchemy: ORM, migrations, complex queries
- APScheduler: Cron jobs, background tasks
- WebSockets: Real-time features
- Redis: Caching, pub/sub, rate limiting

DEVOPS / INFRA:
- Docker + Docker Compose: Containerisation
- GitHub Actions: CI/CD pipelines
- Vercel: Next.js deployment
- Railway: Backend deployment
- Supabase: PostgreSQL + Auth as a service

INTEGRATIONS BUILT:
- LinkedIn API (OAuth, posting, DMs, analytics)
- Upwork RSS + API (job search, proposals)
- Telegram Bot API (aiogram v3, webhooks)
- Stripe (payments, subscriptions)
- Airbnb API (booking data)
- OpenWeatherMap (farm weather)
- Firecrawl (web scraping)
- GitHub API (repos, PRs, profile)
""", {"type": "tech_stack", "company": "turicks"})

    store(col, "turicks_sales_objections", """
TURICKS SALES OBJECTIONS & RESPONSES

OBJECTION: "We already use Zapier/Make"
RESPONSE: "Zapier handles linear workflows. LangGraph handles decisions — when you need the system to think about what to do next, not just trigger the next step. I'll show you an example in 5 mins."

OBJECTION: "We have a developer in-house"
RESPONSE: "LangGraph has a steep learning curve — most devs haven't shipped a production multi-agent system. I've done it repeatedly. Your dev can own it after I build the foundation. That's usually 2-4 weeks faster."

OBJECTION: "3-5 days seems too fast, will quality suffer?"
RESPONSE: "FounderOS — my own AI OS with 39 agents — was built this way. Fast delivery means focused scope, not cut corners. I ship an MVP in 3-5 days, then we iterate."

OBJECTION: "We need to think about it / talk to the team"
RESPONSE: "Of course. While you do that — can I show you a quick 10-minute demo of a similar system I built? Seeing it running tends to make the decision clearer."

OBJECTION: "Your price is higher than other freelancers"
RESPONSE: "I'm not a $20/hr freelancer — I'm a founder who uses this technology daily. The difference is I'll deliver a system that actually works in production, not one that looks good in a demo and breaks in week 2."

OBJECTION: "Can you do it for equity/revenue share?"
RESPONSE: "Not on project work. I offer deferred payment for retainer clients with strong traction. Otherwise it's full payment."
""", {"type": "sales_playbook", "company": "turicks"})

    store(col, "turicks_case_studies", """
TURICKS PROOF POINTS & CASE STUDIES

CASE STUDY 1: FounderOS (Self-built)
- Problem: Running 2 companies manually was taking 40+ hours/week of ops work
- Solution: 39-agent LangGraph system running on Apple M4
- Agents: CEO orchestrator, 4 department subgraphs, 35+ specialist agents
- Tools: LinkedIn posting, Upwork bidding, Telegram alerts, ChromaDB memory
- Result: Ops time reduced to ~2 hours/week. System runs autonomously 24/7
- Stack: LangGraph, Python, ChromaDB, MLX, APScheduler, aiogram, FastAPI

CASE STUDY 2: Turicks Website
- Built turicks.com with Next.js 14, TypeScript, Tailwind
- SEO-optimised, mobile-first, Vercel deployment
- Timeline: 3 days

PIPELINE (Prospective):
- EdTech SaaS: AI-powered student progress tracking agent system
- HR Tech: CV screening + candidate outreach automation
- FinTech: Transaction anomaly detection with LangGraph

KEY NUMBERS:
- 39 agents built and running in production
- 3-5 day delivery track record
- 2 companies operated autonomously via AI
- $500 → $5,000 per project range
""", {"type": "case_studies", "company": "turicks"})

    store(col, "turicks_upwork_strategy", """
TURICKS UPWORK BIDDING STRATEGY

PROFILE POSITIONING:
- Headline: "LangGraph AI Agent Systems | 3-5 Day Delivery | No Prototypes"
- Rate: $75-100/hr (expert tier — do NOT go below $60)
- Availability: More than 30 hrs/week
- Specialisation badge: AI & Machine Learning

TOP ICP QUERIES TO MONITOR:
1. "LangGraph" — high value, low competition
2. "AI agent system" — broad but good quality
3. "LangChain automation" — good conversion
4. "RAG pipeline" OR "RAG chatbot" — technical clients
5. "OpenAI API integration" — mid-market
6. "AI automation" + "Python" — volume play
7. "Next.js AI" OR "Next.js chatbot" — full-stack angle
8. "multi-agent" OR "agentic" — most qualified

BID FILTERING CRITERIA:
✅ Budget ≥ $500 OR hourly ≥ $40/hr
✅ Posted within 48 hours (older = already flooded)
✅ Client spent >$1K on platform
✅ Client hire rate ≥ 70%
✅ Requires LangGraph/LangChain/OpenAI/AI automation

❌ SKIP IF:
- "WordPress", "Shopify", "SEO" in title
- Budget <$300
- Client has never hired before AND <3 reviews
- "AI chatbot for my website" without technical details (low budget)

PROPOSAL FORMULA (120 words max):
Line 1: Mirror their exact pain point
Line 2-3: One concrete result from FounderOS or similar
Line 4: Specific technical approach for their project
Line 5: Timeline + price anchor
NEVER: "I am expert developer with 10 years experience"
""", {"type": "upwork_strategy", "company": "turicks"})


# ════════════════════════════════════════════════════════════════════════════════
# CAREER_MEM — Resume + Job Search Context
# ════════════════════════════════════════════════════════════════════════════════

def seed_career(col):
    print("\n── Seeding career_mem ──")

    store(col, "pushkar_resume_summary", """
PUSHKAR VERMA — Full Stack & AI Systems Engineer
Location: Amsterdam, Netherlands
Email: pushkar@turicks.com
LinkedIn: linkedin.com/in/pushkarverma
GitHub: github.com/pushkarverma3698
Website: turicks.com

PROFESSIONAL SUMMARY:
Solo founder and full-stack engineer specialising in AI agent systems, LangGraph orchestration, and production web applications. Founded Turicks (AI automation agency) and built FounderOS — a 39-agent autonomous business OS running two companies. 3-5 day delivery track record. Strong across the full stack: LangGraph for AI agents, Next.js/MERN for web, FastAPI/Python for backend.

CORE STRENGTHS:
- Multi-agent systems architecture (LangGraph, LangChain)
- Full-stack development (Next.js, MERN, TypeScript)
- Python backend engineering (FastAPI, Python, SQLAlchemy)
- AI/LLM integration (OpenAI, Anthropic, Google Gemini)
- Product thinking: builds systems, not just features
- Speed: ships MVPs in days, not months
""", {"type": "resume_summary", "collection": "career"})

    store(col, "pushkar_work_experience", """
WORK EXPERIENCE

[CURRENT] Founder & AI Engineer — Turicks (AI Automation Agency)
Location: Amsterdam, Netherlands
Period: 2024 – Present

Key work:
- Founded Turicks to help SaaS founders automate operations using AI agent systems
- Built FounderOS: 39-agent LangGraph system running 2 companies autonomously
- Delivered LangGraph/LangChain agent systems for clients in 3-5 days
- Built and deployed turicks.com (Next.js 14, TypeScript, Tailwind, Vercel)
- Manages full pipeline: outreach → proposal → delivery → support
- Stack: LangGraph, Python, FastAPI, Next.js, ChromaDB, OpenAI, Anthropic

[CURRENT] Founder — Naggar Retreat (Himalayan Farm + Homestay)
Location: Naggar, Himachal Pradesh, India
Period: 2023 – Present

Key work:
- Built AI automation for farm operations (weather forecasting, yield tracking)
- Implemented dynamic pricing system for Airbnb/Booking.com
- Ahata brand: farm-to-table culinary experiences
- Stack: Python, OpenWeatherMap API, Airbnb API, Telegram bot

[FREELANCE] Full Stack Developer — Various clients
Period: 2022 – 2024

Key projects:
- House of Hulda: Full website build (JavaScript, responsive design)
- Website Builder Tool: AI-powered site generation tool (Next.js, OpenAI)
- Multiple MERN stack applications for startups

NOTE TO JOBOS AGENTS: Pushkar is open to:
- Senior Full Stack Engineer roles (Next.js/React/Node.js)
- AI Engineer / ML Engineer roles (LangGraph, LangChain, Python)
- Tech Lead / Engineering Manager at AI-first startups
- Contract/freelance via Turicks for agencies and studios
""", {"type": "work_experience", "collection": "career"})

    store(col, "pushkar_technical_skills", """
PUSHKAR VERMA — TECHNICAL SKILLS (FULL DETAIL)

EXPERT LEVEL:
- LangGraph: Stateful multi-agent workflows, supervisor patterns, subgraph composition, tool nodes
- LangChain: Chains, agents, RAG, memory, tool use, LCEL
- Python: 5+ years, async/await, dataclasses, type hints, decorators
- Next.js: App Router, Server Components, Server Actions, ISR/SSR/SSG
- React: Hooks, custom hooks, Context, Zustand, performance optimisation
- TypeScript: Strict mode, generics, discriminated unions, utility types
- Tailwind CSS: Custom configs, responsive design, dark mode
- FastAPI: Async endpoints, Pydantic v2, dependency injection, OpenAPI

STRONG:
- Node.js + Express.js: REST APIs, middleware, JWT auth, rate limiting
- MongoDB + Mongoose: Schema design, aggregation pipelines, indexing
- PostgreSQL + Prisma: Relations, migrations, complex queries
- ChromaDB: Collections, embeddings, semantic search, metadata filtering
- OpenAI API: Chat completions, embeddings, function calling, vision
- Anthropic API: Claude integration, streaming, tool use
- Docker: Multi-stage builds, compose, volumes, networking

PROFICIENT:
- Redis: Caching, pub/sub, rate limiting, sessions
- GraphQL: Schema design, resolvers, Apollo Client
- GitHub Actions: CI/CD, automated testing, deployment
- WebSockets: Socket.io, real-time features
- Supabase: Auth, PostgreSQL, storage, real-time
- Stripe: Payments, subscriptions, webhooks
- Railway + Vercel: Cloud deployment

FAMILIAR:
- React Native: Cross-platform mobile (basic)
- AWS: EC2, S3, Lambda (basic deployments)
- Kubernetes: Basic understanding
- Swift/iOS: Legacy Android project experience

LANGUAGES: Python (expert), JavaScript/TypeScript (expert), SQL (strong), Bash (proficient)
""", {"type": "technical_skills", "collection": "career"})

    store(col, "pushkar_job_preferences", """
PUSHKAR VERMA — JOB SEARCH PREFERENCES (JobOS Context)

TARGET ROLES (in priority order):
1. Senior AI Engineer / AI Systems Engineer
2. Senior Full Stack Engineer (AI-first companies)
3. Tech Lead / Engineering Lead (Series A-B startups)
4. ML Engineer (LLM/Agent systems focus)
5. Founding Engineer (AI startup, equity stake)

TARGET COMPANIES:
- AI-first startups (Series A-C, 20-200 employees)
- Developer tools companies
- Vertical SaaS in EdTech, HR Tech, FinTech, PropTech
- Amsterdam-based or fully remote EU
- NOT: Big corp, consulting, outsourcing firms

LOCATION:
- Primary: Amsterdam, Netherlands (on-site or hybrid)
- Open to: Full remote anywhere in EU/US
- Relocation: Not preferred (based in Amsterdam)

SALARY EXPECTATIONS:
- Full-time: €80,000 - €140,000/year gross (Amsterdam market)
- Contract/freelance: €600-900/day OR $75-100/hr (Turicks rates)
- Equity: Yes, if Series A+ with clear path to exit

WORKING STYLE:
- Async-first, outcomes over hours
- Deep work blocks, no unnecessary meetings
- Can work independently with minimal supervision
- Prefers fast-moving environments, dislikes big corp bureaucracy

DEAL BREAKERS:
- Pure frontend/CSS work only
- No AI/automation component in the role
- Fully on-premise / no remote flexibility
- Micromanagement
- Visa sponsorship needed: HAS VALID EU work permit (Amsterdam resident)
""", {"type": "job_preferences", "collection": "career"})

    store(col, "pushkar_achievements", """
PUSHKAR VERMA — KEY ACHIEVEMENTS & PROJECTS

FOUNDEROS (2024-2026):
✅ Built 39-agent autonomous business OS from scratch
✅ LangGraph hierarchical departments: 4 subgraphs, ~35 workers
✅ Runs Turicks + Naggar Retreat operations autonomously 24/7
✅ Tools: LinkedIn OAuth, Upwork RSS, SQLite CRM, ChromaDB memory
✅ On-device inference: Qwen3-8B via MLX on Apple M4
✅ 11/11 agents passed live task test with 36 tool calls
✅ APScheduler: 32 cron jobs across revenue, growth, and ops

GITHUB PROFILE:
✅ github.com/pushkarverma3698
✅ Repos: turicks-web, FounderOS components, Website Builder Tool
✅ Stars: langchain-ai/langgraph, microsoft/autogen, run-llama/llama_index

LINKEDIN:
✅ LinkedIn API connected: urn:li:person:BYO5LyaX7A
✅ Scheduled posts: BUILD_LOG · AI_EDUCATION · FOUNDER_STORY
✅ Growth agents active daily

PLATFORM RECOGNITION TARGETS:
- LinkedIn: 500 followers by June 2026
- GitHub: 50+ stars on first public repo by August 2026
- Upwork: Top Rated status by September 2026
""", {"type": "achievements", "collection": "career"})


# ════════════════════════════════════════════════════════════════════════════════
# SOCIAL_MEM — Personal brand + platform context
# ════════════════════════════════════════════════════════════════════════════════

def seed_social(col):
    print("\n── Seeding social_mem ──")

    store(col, "pushkar_personal_brand", """
PUSHKAR VERMA — PERSONAL BRAND CONTEXT

WHO HE IS:
Solo founder, AI systems engineer, based in Amsterdam with roots in Naggar, HP (India).
Not a "hustler" persona — more of a thoughtful builder who ships real things.
Two companies: Turicks (AI agency) + Naggar Retreat (Himalayan farm/homestay).

BRAND POSITIONING:
"The builder who uses AI on his own business first, then helps others do the same."

CONTENT VOICE (non-negotiable):
- Direct, no corporate speak
- Shows real numbers, real code, real problems
- No: "excited to announce", "game-changer", "synergy"
- Yes: "here's what I built", "here's what failed", "here's the number"
- Short paragraphs (mobile-first)
- Ends with question or honest observation

CONTENT PILLARS (5):
1. BUILD_LOG: FounderOS agent builds, bugs, wins. "Day X of building in public"
2. FOUNDER_STORY: Naggar + Amsterdam life, running 2 companies, solo founder reality
3. AI_EDUCATION: LangGraph tutorials, agent architecture, practical AI for non-technical founders
4. REVENUE: Honest pipeline updates, Upwork wins, pricing decisions
5. AMSTERDAM: Life in the Netherlands, EU tech scene, immigrant founder angle

AUDIENCE PERSONAS:
- SaaS founders (30-45) who are interested in AI but don't know where to start
- AI engineers who want to see real production implementations
- Indie hackers who want to build autonomous systems
- Recruiters at AI-first startups

PLATFORMS:
- LinkedIn: Primary (professional, highest ROI for clients)
- GitHub: Secondary (technical credibility)
- Twitter/X: Tertiary (build log thread format)
- Upwork: Business (client acquisition)
""", {"type": "personal_brand", "collection": "social"})

    store(col, "pushkar_linkedin_growth_tactics", """
LINKEDIN GROWTH TACTICS (Research-backed for AI founders)

HIGHEST ROI TACTICS:
1. BUILD IN PUBLIC posts — "day X" series gets 3-5x more engagement than generic AI posts
2. Comment on posts by: Greg Brockman, Andrej Karpathy, Sam Altman, Jensen Huang
   (Their posts get 10K+ views — being in comments = free visibility)
3. Post about FAILURES, not just wins (authenticity = shares)
4. Tag 1-2 people in posts (increases reach to their network)
5. Use SPECIFIC numbers: "built in 4 hours" beats "built quickly"
6. First comment on your own post within 5 minutes (algorithm signal)
7. Post between 8-10 AM IST or 6-8 PM IST (highest engagement windows)

CONTENT THAT GOES VIRAL IN AI SPACE:
- "I replaced X with an AI agent" (practical, relatable)
- "Here's the LangGraph code that does Y" (technical, shareable)
- "Day X of building [project] in public" (series format builds followers)
- "What I learned from X failed attempts" (honesty spreads)

CONNECTION STRATEGY:
- Target: AI founders, SaaS CTOs, EdTech/HRTech product leads
- Note: Reference ONE specific thing about them
- Goal: 10 new connections/day = 300/month = 3,600/year
- Follow up: Like their next 3 posts after connecting

HASHTAGS TO USE (tested, AI space):
#LangGraph #AIAgents #BuildInPublic #SoloFounder #AIAutomation
#LangChain #LLM #MachineLearning #GenerativeAI #SaaS
""", {"type": "linkedin_tactics", "collection": "social"})

    store(col, "pushkar_github_growth_tactics", """
GITHUB GROWTH TACTICS

PROFILE OPTIMIZATION (done):
✅ Profile README at pushkarverma3698/pushkarverma3698
✅ Bio: AI Agents, LangGraph, Full Stack, MERN
✅ Blog: turicks.com
✅ Location: Amsterdam, Netherlands

FOLLOWER GROWTH:
1. Star repos from LangGraph, LangChain orgs (authors notice and often follow back)
2. Follow active contributors to langgraph, langchain, autogen
3. Open issues with good questions/bug reports (gets attention)
4. Fork + improve popular repos (contributes to community)
5. README quality: well-documented repos get starred

REPOS TO CREATE (planned):
- langraph-starter-template: Simple LangGraph multi-agent boilerplate (will get stars)
- agent-memory-patterns: ChromaDB patterns for agent memory (educational)
- nextjs-ai-dashboard: Next.js dashboard template with AI sidebar (practical)

TRENDING TOPICS TO STAR REGULARLY:
- langgraph, langchain, autogen, crewai, llm-tools
- ai-agents, autonomous-agents, multi-agent
- nextjs, react, typescript (for full-stack credibility)

TARGET USERS TO FOLLOW:
- LangGraph core team: eyurtsev, baskaryan, hwchase17
- AI builder community: simonw, karpathy (if on GitHub)
- Active open source contributors in Python/AI space
""", {"type": "github_tactics", "collection": "social"})


# ════════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 60)
    print("FounderOS — Founder Context Seeder")
    print("=" * 60)

    turicks_col = client.get_or_create_collection("turicks_mem")
    career_col  = client.get_or_create_collection("career_mem")
    social_col  = client.get_or_create_collection("social_mem")

    seed_turicks(turicks_col)
    seed_career(career_col)
    seed_social(social_col)

    print("\n" + "=" * 60)
    print(f"✅ turicks_mem: {turicks_col.count()} documents")
    print(f"✅ career_mem:  {career_col.count()} documents")
    print(f"✅ social_mem:  {social_col.count()} documents")
    print("\n📝 Next step: Paste your resume below to add it to career_mem")
    print("   Edit the 'pushkar_work_experience' section with real dates + companies")
    print("=" * 60)

    # Telegram confirmation
    try:
        import requests
        tok  = os.environ.get("TELEGRAM_BOT_TOKEN","")
        chat = os.environ.get("TELEGRAM_CHAT_ID","")
        if tok and chat:
            requests.post(f"https://api.telegram.org/bot{tok}/sendMessage", json={
                "chat_id": chat, "message_thread_id": 8,
                "text": f"🧠 <b>Context seeded into ChromaDB</b>\n\nturicks_mem: {turicks_col.count()} docs\ncareer_mem: {career_col.count()} docs\nsocial_mem: {social_col.count()} docs\n\nAll agents now have full context about Pushkar, Turicks, skills, ICP, pricing, and growth tactics.",
                "parse_mode": "HTML"
            }, timeout=10)
    except Exception:
        pass
