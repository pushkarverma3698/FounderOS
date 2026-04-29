# FounderOS — Claude Code Intelligence Guide

> Read this once per session. Do NOT re-read unless explicitly told the architecture changed.

## What Is This?

FounderOS is a **39-agent autonomous business OS** for Pushkar Verma. It runs two companies:
- **Turicks** — AI/software agency (LangGraph, Next.js, MERN, AI automation)
- **Naggar Retreat** — Himalayan farm + homestay (raspberries, Airbnb, bookings)

Plus a **JobOS V3** module (10 agents for job search automation).

## Critical Files — Read In This Order

```
.c-suite/config.py      ← Master config, model cascades, API keys, call_* functions
.c-suite/registry.py    ← All 39 agents, companies, topic IDs
.c-suite/prompts.py     ← All system prompts keyed by agent name
.c-suite/memory.py      ← ChromaDB store/recall (3 siloed collections)
.c-suite/orchestrator.py ← 4-phase LangGraph state machine
.c-suite/parallel_dispatch.py ← Multi-agent concurrent execution
.c-suite/telegram_gateway.py  ← Telegram bot routing (aiogram v3)
.c-suite/scheduler.py   ← Cron jobs (evening scrum 18:30 IST, hourly ideator)
```

**Never read these unless specifically debugging them:**
- `scratch/`, `generate_shortcut.py`, `mcp_bridge.py`, `pdf_engine_fallback.py`

## Model Cascade — Use Gemini First

```
CEO tier:     Anthropic claude-sonnet-4-6 → gemini-2.5-pro → gemini-2.0-flash → OpenRouter llama-3.3-70b → Local MLX
Deep Research: gemini-2.5-pro → gemini-2.0-flash → Local MLX
MD tier:      gemini-2.0-flash → Local MLX → gemini-2.0-flash-lite
Nano tier:    gemini-2.0-flash-lite → Local MLX
```

**Default API key**: Use `GOOGLE_API_KEY` (Gemini) for most tasks — it has free tier.  
**Anthropic key**: Needs paid API credits (NOT included in Claude Pro/Max subscription).  
**OpenRouter**: Free models as fallback only.

### Claude Pro Plan vs Anthropic API
The user has **Claude.ai Pro subscription** (claude.ai web app). This does NOT give Anthropic API access.
FounderOS needs **Anthropic API credits** from console.anthropic.com (separate billing).
Until credits are added, the cascade auto-falls to Gemini → OpenRouter → Local.

## Key Functions in config.py

```python
call_ceo(prompt, system="")      # CEO cascade — use for complex routing/JSON
call_md(prompt, system="")       # MD cascade  — use for most business tasks
call_local(prompt, system="")    # Local MLX   — fast, free, limited JSON ability
call_with_fallback(cascade, prompt, system, max_tokens)  # Generic cascade
```

## Data Silo Rule — NEVER BREAK THIS

```
turicks agents → only access turicks_mem collection
naggar agents  → only access naggar_mem collection
cross agents   → access social_mem (shared)
```
Breaking this leaks private business data between companies. Enforced in `tool_hooks.py`.

## Telegram Setup

```
Group: test (-1003926275810)
Bot: @Jarvis_pushkar_v8_bot (token in .env)

CONFIRMED thread IDs:
  TOPIC_BOARDROOM = 8    (The_Boardroom)
  TOPIC_SOCIAL    = 6    (Social_Command)

PENDING creation (need bot admin with "Manage Topics"):
  TOPIC_THINK_TANK = 3   (The_Think_Tank)
  TOPIC_TURICKS    = 4   (Turicks_Floor)
  TOPIC_NAGGAR     = 5   (Naggar_HQ)
```

To create missing topics: `python .c-suite/telegram_setup_and_test.py`  
Bot must be admin with "Manage Topics" permission first.

## Running Tests

```bash
# Quick sanity check (no API calls)
/Users/pushkarverma/mlx_env/bin/pytest tests/test_config.py tests/test_memory.py tests/test_tool_hooks.py -v

# Live agent tests (uses Gemini API)
/Users/pushkarverma/mlx_env/bin/pytest tests/test_live_agents.py -v --timeout=300

# Telegram connectivity
cd .c-suite && /Users/pushkarverma/mlx_env/bin/python test_telegram.py

# Telegram agent test (sends real outputs to groups)
cd .c-suite && /Users/pushkarverma/mlx_env/bin/python telegram_setup_and_test.py

# Start the Telegram gateway (interactive)
cd .c-suite && /Users/pushkarverma/mlx_env/bin/python telegram_gateway.py

# Start local MLX server
bash start.sh
```

## Quota Management

**Gemini free-tier resets daily at midnight UTC.**
- gemini-2.5-pro: 50 RPD (requests per day)
- gemini-2.0-flash: 1500 RPD
- gemini-2.0-flash-lite: 1500 RPD

**To avoid burning quota:**
1. Use `call_md()` (flash) not `call_ceo()` (pro) for testing
2. Run `test_config.py` and `test_memory.py` first (no API calls)
3. Run live tests sequentially, not parallel, when quotas are low
4. Check quota: `grep -r "call_with_fallback\|call_ceo\|call_md" .c-suite/*.py | wc -l`

## Common Bugs Fixed (Don't Reintroduce)

| Bug | Fix | File |
|-----|-----|------|
| `load_dotenv` skips keys pre-set as `""` by Claude Code | `override=True` | config.py line 51 |
| Metal GPU SIGABRT in parallel workers | `threading.Lock` on MLXModelManager | config.py line 175 |
| `google.generativeai` deprecated | Migrated to `google.genai` Client API | config.py line ~380 |
| CEO cascade skips cloud fallback | Added gemini-2.0-flash + OpenRouter | config.py CEO_CASCADE |

## Architecture Patterns

### Adding a New Agent
1. Add to `registry.py` `_AGENTS_DB` list with correct cascade tier + collections
2. Add system prompt to `prompts.py` with matching key
3. Wire routing in `orchestrator.py` if it needs a new phase
4. Add Telegram topic routing in `telegram_gateway.py` if needed

### Debugging a Failing Agent
```python
# Test single agent directly
cd .c-suite && python -c "
from config import call_md
result = call_md('test prompt', system='You are the agent_name agent.')
print(result)
"
```

### Checking Memory
```python
cd .c-suite && python -c "
from memory import client, recall
col = client.get_or_create_collection('turicks_mem')
results = recall(col, 'your query', n_results=3)
print(results)
"
```

## Token Efficiency Rules for Claude Code

1. **Don't re-read config.py** unless debugging model cascade logic — it's 600+ lines
2. **Read only the relevant agent file** — not the whole .c-suite/ directory
3. **Trust the summary above** for architecture decisions
4. **Use Grep before Read** — search for function names before reading full files
5. **Batch API calls** — run multiple bash commands in parallel when independent
6. **Never re-read .env** — keys are in the summary above (use Read only to verify)

## Project Intelligence — Learn After Every Session

Keep this section updated as you learn more:
- **Last tested**: 2026-04-28 — **11/11 real-task test** with **36 tool calls** → ✅ **11/11 passed**. Qwen3-8B on-device handles nano/local/md tiers; ceo/deep_research/code use OpenRouter free cloud.
- **Telegram topics (ALL LIVE)**: Boardroom=8 ✅ Social=6 ✅ Think_Tank=110 ✅ Turicks=111 ✅ Naggar=112 ✅
- **Formatter**: `.c-suite/bridges/telegram_formatter.py` — HTML parse_mode with headers/dividers/agent_report/production_summary
- **Test harness**: `.c-suite/production_test.py` (39 agents, 6-way parallel, OR free cascade) + `production_retry.py` + `production_final_report.py`
- **Agent roster**: `docs/AGENT_ROSTER.md` — per-agent description/features/tools/memory/topic
- **OR free models verified**: llama-3.3-70b:free, nemotron-3-super-120b:free, gpt-oss-120b/20b:free, hermes-3-llama-405b:free, gemma-3-27b/12b/4b:free, qwen3-coder:free, qwen3-next-80b:free, deepseek-r1:free
- **Token reductions done**: CEO 512, MD 1024, NANO 256, LOCAL 512; all system prompts trimmed ~60%; synthesis capped 500 chars/worker; memory default n_results=3
- **Registry fix 2026-04-23**: All agents now have `chromadb_read` + `chromadb_write` in allowed_tools; cost_watchdog + scrum_engine + market_scout have cross-company collection access
- **Tool hooks working correctly**: DENY = real violation (fixed); REQUIRE_APPROVAL = memory write gate (correct — chairman approves in production)
- **Key script**: `python .c-suite/agent_task_runner.py` — runs 8 real tasks with tool calls, reports to Telegram
- **Local model**: `mlx-community/Qwen3-8B-4bit` (downloaded, 4.1GB, M4 GPU) — replaces broken 0.5B config. Used for nano/local/md tiers. `LOCAL_MODEL` in `config.py` auto-detects at startup.
- **LOCAL_TIERS** in `core/departments/llm.py`: `{"nano", "local", "md"}` → all run Qwen3-8B first; only ceo/deep_research/code use OpenRouter cloud.
- **Cascade path**: nano/local/md → Qwen3-8B (free, private) → OpenRouter fallback; ceo/deep_research/code → OpenRouter BIG/CODE pools → MLX fallback
- **ChromaDB**: Was corrupt (empty sqlite3 file) — cleared and rebuilt fresh. Data accumulates again with each run.
- **bash ALWAYS_ALLOW**: Pattern updated to handle `git -C /path log` form; pip list/show/freeze added as safe
