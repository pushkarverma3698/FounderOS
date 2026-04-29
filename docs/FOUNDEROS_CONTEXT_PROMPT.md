# FounderOS — Complete Context Prompt

> Copy everything below the divider and paste it into any Claude session to give full context.

---

---

## PASTE THIS INTO CLAUDE

```
You are working inside FounderOS — an autonomous multi-agent operating system built and owned by Pushkar Verma, a solo founder running two businesses:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OWNER: Pushkar Verma
LOCATION: Manali / Delhi, India
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## THE TWO COMPANIES

### 1. Turicks (turicks.com)
- Type: Custom SaaS & AI development agency
- Services: Full-stack SaaS builds, AI agent development, UI/UX, mobile apps, cloud/DevOps, enterprise solutions
- Target Clients: EdTech startups, Healthcare orgs, Enterprise clients needing MVP → full platform
- Stack: LangGraph, Next.js, MERN, AI automation, React Native
- Revenue model: Project-based + retainer support contracts
- Context dir: turicks_agency/

### 2. Naggar Retreat (Manali, Himachal Pradesh)
- Type: Himalayan farm + homestay
- Revenue: Raspberry farming, Airbnb-style bookings, seasonal tourism
- Location: Naggar village, Manali (altitude ~1800m)
- Challenges: Power cuts, seasonal demand, remote operations, farm logistics
- Context dir: naggar_retreat/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## FOUNDEROS ARCHITECTURE

FounderOS is a local-first autonomous AI OS running on Pushkar's Apple M4 Mac (16GB Unified Memory).

### 3 Permanent Processes (started via `bash start.sh`)
1. MLX-LM Server — Qwen3-8B-4bit running on M4 GPU/ANE at http://127.0.0.1:8000
2. Telegram Gateway — Bot @Jarvis_pushkar_v8_bot receives commands, sends reports
3. APScheduler — 16 scheduled agent jobs (cron-style, IST timezone)

### Key Directories
```
FounderOS/
├── start.sh                    # Master startup (3 processes)
├── stop.sh                     # Clean shutdown
├── .c-suite/                   # All agent/orchestration code
│   ├── core/
│   │   ├── config.py           # Model cascades, API keys, call_* functions
│   │   ├── registry.py         # All 27+ agents with metadata
│   │   └── scheduler.py        # APScheduler cron jobs
│   ├── agents/                 # Individual agent modules
│   ├── bridges/
│   │   ├── telegram_gateway.py # Telegram bot routing (aiogram v3)
│   │   └── telegram_formatter.py # HTML message formatting
│   ├── memory/
│   │   └── memory.py           # ChromaDB vector store (3 siloed collections)
│   └── tools/                  # Tool implementations
├── turicks_agency/             # Turicks company context & files
├── naggar_retreat/             # Naggar company context & files
└── docs/                       # Architecture docs
```

### Model Cascade (Cost-Optimised — Runs FREE)
```
CEO tier:       Anthropic Claude Sonnet 4.6 → Gemini 2.5 Pro → Gemini 2.0 Flash → llama-3.3-70b:free (OpenRouter) → Local Qwen3-8B
Deep Research:  Gemini 2.5 Pro → Gemini 2.0 Flash → deepseek-r1:free → llama-3.3-70b:free → Local
MD tier:        Gemini 2.0 Flash → Gemini Flash Lite → llama-3.3-70b:free → gemma-3-27b:free → Local
Nano tier:      Gemini Flash Lite → Gemini Flash → gemma-3-12b:free → Local
Code tier:      qwen3-coder:free → gpt-oss-120b:free → llama-3.3-70b:free → Local
Local tier:     Qwen3-8B MLX (M4) — always free, always private
```

### Monthly Cost
- Gemini Flash: FREE (1500 requests/day)
- Gemini Flash-Lite: FREE (1500 requests/day)
- Gemini Pro: FREE (50 requests/day)
- OpenRouter free models: FREE (all suffixed :free)
- Local MLX (Qwen3-8B): FREE (runs on M4 GPU)
- Telegram Bot: FREE
- ChromaDB local: FREE
- TOTAL: ~₹0/month

### API Keys in Use
- GOOGLE_API_KEY — Primary (Gemini free tier)
- OPENROUTER_API_KEY — Fallback (free models only)
- ANTHROPIC_API_KEY — Optional (Claude, paid per token)
- TELEGRAM_BOT_TOKEN — Bot control interface
- FIRECRAWL_API_KEY — Web scraping (paid, used sparingly)
- OPENWEATHER_API_KEY — Farm weather (free tier, needs real key)
- LANGCHAIN_API_KEY — LangSmith tracing (free tier)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## THE 27+ AGENTS

### CEO / Orchestration
- orchestrator — Master router: classifies tasks, dispatches to correct agents
- cost_watchdog — Weekly cost audit, finds free alternatives (runs Sunday 22:00 IST)
- scrum_engine — Daily evening standup to Boardroom (runs 18:30 IST)
- team_therapist — Weekly morale/wellness brief (runs Friday 17:30 IST)
- hr_agent — HR roster, hiring decisions, freelancer management (runs Monday 07:00 IST)

### Turicks Agency Agents
- md_turicks — Turicks Managing Director: planning, strategy, client management
- proposal_writer — Writes custom project proposals and SOWs
- lead_intel — Researches inbound leads, qualifies prospects
- bidding_sniper — Monitors Upwork/freelance platforms for matching jobs
- outreach_agent — Cold outreach emails and LinkedIn DMs
- pipeline_md — Sales pipeline management and follow-up tracking
- senior_dev — Technical architecture, code review, senior engineering tasks
- vibe_coder — Rapid prototyping and MVP builds
- qa_tester — Quality assurance, bug reports, testing plans
- web_designer — UI/UX design specs, wireframes, landing pages
- vibe_designer — Brand identity, visual design, Figma specs
- revenue_scout — Revenue opportunities, upsell detection, pricing strategy
- kb_agent — Turicks knowledge base: client docs, SOPs, case studies

### Naggar Retreat Agents
- md_naggar — Naggar Managing Director: farm + homestay operations
- booking_concierge — Guest bookings, check-in/check-out, Airbnb messages (Daily 09:00 IST)
- farm_weather — Daily weather brief for Manali + farm alerts (Daily 05:45 IST)
- yield_scout — Raspberry yield forecasting, harvest planning
- culinary_agent — Menu planning, recipes for guests, local produce
- guest_crm — Guest relationship management, reviews, repeat bookings
- naggar_kb — Naggar knowledge base: farm SOPs, local vendors, seasonal guides

### Cross-Company Agents
- market_scout — Market research across both businesses
- social_researcher — Social media trends, competitor analysis (Monday 08:00 IST)
- social_handler — Posts to LinkedIn/Instagram for Turicks + Naggar (Daily 09:30 IST)
- auto_researcher — Nightly deep research on business opportunities (Daily 01:00 IST)
- video_editor — Creates Reels content using Veo 2 + ffmpeg

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## MEMORY SYSTEM (DATA SILO RULE — NEVER BREAK)

3 ChromaDB collections, strictly isolated:
- turicks_mem → ONLY Turicks agents read/write here
- naggar_mem  → ONLY Naggar agents read/write here
- social_mem  → Cross-company agents (social, market research) only

Breaking this leaks private business data. Enforced in tool_hooks.py.

Key memory functions:
```python
from memory.memory import store_experience, multi_recall
store_experience(agent_name, task, result)     # Write to correct silo
multi_recall(collections, query, n_results=3)  # Read from allowed siloes
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## TELEGRAM INTERFACE

Bot: @Jarvis_pushkar_v8_bot
Group: test (chat_id: -1003926275810)

Topic Channels (all live):
- TOPIC_BOARDROOM  = 8    (#The_Boardroom — daily scrums, HR, cost audits)
- TOPIC_THINK_TANK = 110  (#The_Think_Tank — strategy, research)
- TOPIC_TURICKS    = 111  (#Turicks_Floor — agency operations)
- TOPIC_NAGGAR     = 112  (#Naggar_HQ — farm + homestay)
- TOPIC_SOCIAL     = 6    (#Social_Command — social media)
- TOPIC_REVENUE    = 113  (#Revenue — pipeline, deals)

Control commands via Telegram:
- /run <agent_name> — trigger an agent manually
- /status — system health check
- /quota — check API quota usage
- /stop — graceful shutdown

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## KEY FUNCTIONS TO USE

```python
# config.py — call these, not raw API clients
from core.config import call_ceo, call_md, call_nano, call_local, call_deep_research, call_agent

call_ceo(prompt, system="")           # Complex routing/JSON — uses CEO cascade
call_deep_research(prompt, system="") # Market intel, research — uses Gemini Pro first
call_md(prompt, system="")            # Most business tasks — uses Gemini Flash (FREE)
call_nano(prompt, system="")          # Quick micro-tasks — uses Flash Lite (FREE)
call_local(prompt, system="")         # Private data only — M4 local model
call_agent(agent_name, prompt)        # Best way: auto recall + dispatch + auto store
```

## RUNNING THE SYSTEM

```bash
# Start everything (M4 Mac must be plugged in)
bash start.sh

# Stop everything (restores Mac sleep)
bash stop.sh

# Test all agents (uses OpenRouter free models — no quota burn)
cd .c-suite && python production_test.py

# Test single agent
cd .c-suite && python -c "from core.config import call_md; print(call_md('test'))"

# View live logs
tail -f /tmp/founderos_scheduler.log

# Run no-API tests (fast, safe)
/Users/pushkarverma/mlx_env/bin/pytest tests/test_config.py tests/test_memory.py -v
```

## COMMON BUGS — DO NOT REINTRODUCE

| Bug | Fix | File |
|-----|-----|------|
| load_dotenv skips pre-set empty keys | override=True | config.py line 51 |
| Metal GPU SIGABRT in parallel workers | threading.Lock on MLXModelManager | config.py line ~187 |
| google.generativeai deprecated | Migrated to google.genai Client API | config.py line ~437 |
| OpenRouter charges money | Always use :free suffix on model IDs | config.py all cascades |
| Mac sleeps, kills all 3 processes | caffeinate -dimu & in start.sh | start.sh |

## LAST VERIFIED STATE
- Date: 2026-04-23
- Test result: 11/11 real-task tests passed (36 tool calls)
- Local model: mlx-community/Qwen3-8B-4bit (downloaded, 4.1GB, M4 GPU)
- All Telegram topics: LIVE (Boardroom=8, Social=6, Think_Tank=110, Turicks=111, Naggar=112)
- Monthly cost: ₹0 (all free tiers + local inference)
```
