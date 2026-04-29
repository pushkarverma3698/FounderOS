# FounderOS V6: Technical Reference

This document provides a low-level summary of configuration options, environment variables, scheduler jobs, and core CLI execution commands.

---

## 1. Environment & API Configurations (`.env`)

For FounderOS to function securely, the following variables must be configured properly in `.c-suite/.env`:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Connects Claude 3.5 Sonnet (CEO Level reasoning model). |
| `GOOGLE_API_KEY` | Connects Gemini 3.1 Pro/Flash (Workhorse & Compaction). |
| `OPENROUTER_API_KEY` | The primary resilient fallback layer for API rate limit bypass via `config.py`. |
| `TELEGRAM_BOT_TOKEN` | Your Aiogram instance key for two-way communication. |
| `TELEGRAM_CHAT_ID` | Your specific Admin ID restricting all bot control explicitly to your phone. |

### Model Cascade IDs
Defined inside `config.py`, routing is tied to exact hardware execution tiers:
- **TIER_0:** `mlx-community/Qwen2.5-7B-Instruct-4bit` (Local Hardware)
- **TIER_1:** `gemini-1.5-flash-latest` (Nano Tier)
- **TIER_2:** `gemini-1.5-pro-latest` (Core Workhorse)
- **TIER_3:** `claude-3-5-sonnet-20241022` (Reasoning & Code)
- **TIER_4:** `o3-mini` (Deep Search)
- **TIER_5:** `gemini-pro-vision` (Multimodal)

---

## 2. CLI Execution Commands

Operating FounderOS can be fully automated or heavily manual using specific command line flags on `.c-suite/` scripts.

- `bash start.sh` : The primary initialization spinning up the Local MLX server, Telegram Gateway, and APScheduler on port 8000.
- `bash stop.sh` : Gracefully shuts down all 3 persistent master layers, capturing zombie processes.
- `python .c-suite/scheduler.py --list` : Triggers an immediate printout of all currently queued CRON cycles mapped correctly to the IST timezone.
- `python .c-suite/scrum_pm.py --now` : Overrides the standard 18:45 execution generating a total Daily Standup plan instantaneously.
- `python .c-suite/auto_researcher.py --now` : Skips the 01:00 schedule and immediately searches the internet globally for agent-skill upgrades.
- `python .c-suite/revenue_team.py --now` : Compiles the 3-agent revenue/pipeline report instantaneously.

---

## 3. Operations & APScheduler Background Jobs

Historically, FounderOS launched over a dozen `while True` background jobs. V6 uses an elegant, persistent `APScheduler` loop containing 18 distinct agent chronologies.

| Schedule (IST) | Script Execution | Output Channel / Action |
|---|---|---|
| 01:00 (Daily) | `auto_researcher.py` | Auto-improves agent knowledge capabilities persistently. |
| 03:00 (Daily) | `kairos_background.py` (AutoDream) | Consolidates noisy database fragments reducing RAM / Cost. |
| 05:45 (Daily) | `Naggar` Farm Weather Brief | `#Naggar_HQ` |
| 07:00 (Mon) | `hr_agent.py` | `#Boardroom` Roster Review |
| 08:00 (Mon) | `social_media_team.py` | `#Turicks_Floor` Marketing Sync |
| 09:00 (Daily) | `booking_concierge` | Validates property inquiries |
| 09:00 (Wed) | `revenue_team.py` | Revenue Pipeline Analysis |
| 09:30 (Daily) | `social_handler` | Standup & Scheduling |
| 17:30 (Fri) | `team_therapist.py` | `#Boardroom` Agent Health Report |
| 18:30 (Daily) | `scrum_engine.py` | Standup Data Aggregation |
| 18:45 (Daily) | `scrum_pm.py` | Tomorrow's Task Allocation & Auto-Approval Gate |
| 22:00 (Sun) | `cost_watchdog.py` | OPEX Reduction & API limits |
| (Idle Time) | `kairos_background.py` (MagicDocs) | Modifies / Updates codebase docs automatically. |

---

## 4. Database Topologies

FounderOS separates temporary working memory from long-term memory aggressively:
1. **The Shared Scratchpad (`/.scratchpad`)**: Contains thousands of raw files `.json` / `.md`. This is the asynchronous exchange server where massive parallel workers copy/paste data to interact without slowing the network.
2. **Persistent Memory Clusters (`chroma_data`)**: The isolated collection of Vector databases accessed strictly through proper tool routing:
   - `turicks_mem`
   - `naggar_mem`
   - `social_mem` 
