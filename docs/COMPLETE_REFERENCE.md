# FounderOS: The Complete Architecture Reference
**Version:** V6 (Autonomous Empire Edition)
**Update:** April 2026

This document is the exhaustive technical reference for all 25 subsystems within the FounderOS 27-agent architecture. It covers the full lifecycle of execution, data routing, memory extraction, and security enforcements.

---

## 1. System Overview & Architecture Philosophy

FounderOS is a multi-agent orchestrated system designed around the **"4-Phase Coordinator Protocol"** (Research → Synthesis → Implementation → Verification). It leverages an asynchronous `LangGraph` backbone combined with a central `APScheduler` for autonomous operation without continuous human input.

Key principles:
1. **Model Cascade Economics:** Route tasks through a cost-tiered model cascade. Use local hardware (Qwen 2.5 7B via MLX) for volume/private data, Gemini 3.1 Pro for complex reasoning, and Claude 3.5 Sonnet as the ultimate fallback.
2. **Data Silos via Code (Not Prompts):** Enforce strict memory boundaries between companies (`turicks_mem` vs `naggar_mem`) using Python tool hooks, refusing access programmatically rather than relying on LLM obedience.
3. **Parallel Scratchpad Execution:** Agents work dynamically in Git-style worktrees and parallel semaphores, merging data via shared persistent scratchpads instead of bloating the conversation context.

---

## 2. Boot Sequence: 3-Process Architecture
FounderOS has moved away from 11+ fragile `while-True` background loops in favor of a robust 3-process architecture initiated via `start.sh`:

1. **Local MLX Worker (`mlx_lm.server`):** Hosts Qwen 2.5 7B locally on port 8000 for high-volume and privacy-critical processing (e.g., guest CRM scrubbing).
2. **Telegram Gateway (`telegram_gateway.py`):** The persistent AIogram bot that listens to human input across company topics.
3. **APScheduler Registry (`scheduler.py`):** Consolidates all 16 autonomous agent cron jobs into a single Python process with SQLite persistence.

---

## 3. The Model Cascade & Circuit Breakers (`config.py`)

All LLM calls are routed through `.c-suite/config.py` which defines the cost-optimization logic and resilience patterns.

### The 6 Cascade Tiers
- **TIER_0_LOCAL:** Qwen 2.5 7B (via MLX). Zero cost. Used for `guest_crm`, bulk text summarization, and private PII.
- **TIER_1_NANO:** Gemini 3.1 Flash. Deeply cheap, fast. Used for high-frequency routers and background tasks (Smart Task Router, AwaySummary, Context Compaction).
- **TIER_2_CORE:** Gemini 3.1 Pro. The workhorse for 80% of agent tasks (proposal writing, developer assistance, content drafting).
- **TIER_3_REASONING:** Claude 3.5 Sonnet (via Anthropic SDK). The CEO/Coordinator model. Used for complex orchestration, planning, and highly contextual tasks.
- **TIER_4_DEEP_RESEARCH:** OpenAI o3-mini (or similar OpenRouter fallback). Used for prolonged web research or complex debugging where reflection steps are necessary.
- **TIER_5_MULTIMODAL:** Veo / Gemini Pro Vision. Used for parsing UI/UX mocks, extracting content from images, and video frame analysis.

### Circuit Breaker Pattern
The `call_with_fallback()` function prevents cascading failures. If an API provider (e.g., Google API) rate-limits or returns `503`, the circuit breaker traps the error, increments a counter, and transparently routes the payload to the next cost-equivalent provider via OpenRouter to ensure 99.99% uptime.

---

## 4. The Agent Registry (`registry.py`)
Centralized definition of all 27 agents. Each agent is a dataclass specifying:
- `name`: E.g., "bidding_sniper"
- `company_assignment`: "turicks", "naggar", or "cross"
- `cascade_tier`: The default LLM tier this agent uses.
- `memory_collection`: Which ChromaDB collection it belongs to.
- `allowed_collections`: Strict list of databases it can read.

This registry is imported by all downstream modules, replacing old hardcoded strings. It allows dynamic rendering of the `AGENTS.md` file and dynamic `task_router.py` logic.

---

## 5. The Prompt Registry (`prompts.py`)
All system intelligence is localized. No prompts exist inline in other scripts.
- **17 System Prompts:** `PM_SYSTEM`, `CEO_SYSTEM`, `ROUTER_SYSTEM`, etc.
- **11 Task Prompts:** Parameterized strings with `str.format()` capabilities.

> **Why?** Centralized prompts ensure consistency. When we tune the CEO's persona, its effect propagates to all subsystems simultaneously.

---

## 6. The 4-Phase Coordinator Protocol (`orchestrator.py`)
Built on LangGraph, defining standard agentic cycles:
1. **Research Phase:** Agents spawn parallel `grep` and `search` tool loops. Output goes to `.scratchpad/`.
2. **Synthesis Phase:** The Coordinator reads the scratchpad, evaluates the problem, and writes a unified implementation spec.
3. **Implementation Phase:** Focused edit loops (`file_edit`, `bash`) within an isolated worktree via `sandbox.py`.
4. **Verification Phase:** Secondary agents execute tests (`pytest`, `mypy`). Failure loops back to Implementation.

---

## 7. Parallel Dispatch Engine (`parallel_dispatch.py`)
Implements Claude Code's `coordinatorMode.ts` pattern. Uses `asyncio.Semaphore` to limit concurrency.
- `dispatch_parallel(tasks, max_workers=5)`: Accepts a list of task prompts.
- Employs asyncio queues to fan-out sub-tasks and gather results efficiently into the shared memory space.

---

## 8. Smart Task Router (`task_router.py`)
Monitors every message in the Telegram group via `telegram_gateway.py`.
- **Classification:** Auto-detects if a message is a `task`, `context_update`, `question`, `approval`, or `chat`.
- **Auto-Routing:** Directs specific requests (e.g., "Post on Instagram") to the right agent (`vibe_designer`) without the user specifying who to ping.
- **Context Updates:** When the user shares knowledge ("We use tailwind now"), the router extracts structured JSON and writes it directly to the relevant company's ChromaDB profile.

---

## 9. Memory Extractor & Context Lifecycle
- **Context Manager (`context_manager.py`)**: Inspired by Claude Code's compaction. Monitors token usage. At 80% capacity, it uses a NANO model with a strict 9-section prompt (State Intent, Key Decisions, Code State, Next Steps, etc.) to summarize history down to 2,000 tokens, preventing `context_length_exceeded` crashes.
- **Memory Extractor (`memory_extractor.py`)**: Runs asynchronously as a background thread after an agent finishes. It reads the turn's output, extracts novel facts, and stores them in `<appDataDir>/FounderOS/docs/memories/` as JSON records.

---

## 10. Security & Enforcement Layers
### Tool Hooks (`tool_hooks.py`)
Replaces prompt-based rules with code-enforced rules.
- **Pre-execution Phase:** Intercepts `bash` and database commands. Checks `ALWAYS_DENY_PATTERNS` (e.g., `rm -rf /`). Validates that `naggar` agents are not touching `turicks_mem`.
- **Post-execution Phase:** Scrubs all API keys (`[REDACTED]`) and truncates overly verbose outputs before returning them to the LLM.

### Sandboxing & Worktrees (`sandbox.py`)
- `safe_run(cmd)`: Shell execution wrapper verifying against `DENY_LIST`.
- `@run_in_worktree`: Context manager that copies the codebase to `/tmp/`, lets destructive QA agents break the build safely, and returns diff patches to the coordinator for approval rather than modifying production directly.

---

## 11. Autonomous Operations
### Scrum PM (`scrum_pm.py`)
The ultimate project manager. Runs daily at 18:45 IST via APScheduler.
- Gathers data from ChromaDB on what all 27 agents did today vs their daily capacities.
- Synthesizes 8-12 high-priority tasks.
- Telegrams the plan to the Chairman.
- *Failsafe:* If unapproved in 30 minutes, it automatically executes safe (P3) tasks.

### The Revenue Team (`revenue_team.py`)
A 3-agent autonomous pod inside Turicks:
1. **Revenue Scout:** Scrapes LinkedIn/communities for project opportunities.
2. **Outreach Agent:** drafts personalized 3-touch messages.
3. **Pipeline MD:** Tracks deals in ChromaDB, generating weekly status charts.

### Background Daemons (`kairos_background.py`)
- **AutoDream:** Runs consolidation at 3 AM. Compresses redundant vector memory points.
- **MagicDocs:** Scans filesystem for out-of-date READMEs and auto-updates them based on recent commit history.
- **KAIROS Nudges:** Proactive system agent pinging Telegram when anomalies (or cost spikes) occur.

---

## 12. Full Command & Tool Reference
### CLI Core
- `bash start.sh` : Initiate 3-process architecture.
- `python .c-suite/scheduler.py --list` : View next run times.
- `python .c-suite/scrum_pm.py --now` : Override schedule / force run.

### MCP (Model Context Protocol) Bridge (`mcp_bridge.py`)
Allows the LLM to call native code tools cross-language via JSON-RPC. Currently configured to support internal `github_mcp` for searching public repos and `filesystem_mcp` for structured file manipulations.

### Key Tools List (Exposed to Subagents)
- `run_bash_command` (Filtered via `tool_hooks.py`)
- `read_scratchpad` / `write_scratchpad`
- `query_vector_db` / `store_insight`
- `delegate_task` (Trigger async parallel dispatch)

---

## 13. System Map
```text
FounderOS/
├── .c-suite/
│   ├── config.py             # Model cascade, environment config, thresholds
│   ├── orchestrator.py       # LangGraph 4-Phase execution loop
│   ├── parallel_dispatch.py  # Semaphore-based concurrency
│   ├── task_router.py        # Centralized message classifier
│   ├── registry.py           # Single source of truth for 27 agents
│   ├── prompts.py            # The central System/Task prompt repository
│   ├── tool_hooks.py         # Code-level policy enforcement & scrubbing
│   ├── context_manager.py    # Prevents token bloat via Claude Code compaction
│   ├── memory_extractor.py   # Asynchronous facts learning
│   ├── scrum_pm.py           # Daily autonomous planning
│   ├── sandbox.py            # Code execution containment
│   └── scheduler.py          # Unified cron-style runner
├── .founder/                 # Agent Declarative configurations (YAML/Markdown)
├── docs/                     # Human-readable documentation core
└── start.sh                  # Bootstrap executable
```
