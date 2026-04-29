# AGENTS.md — FounderOS Machine-Readable Project Guide
# Version: 8.0 | Updated: 2026-04-13
# This file is read by Antigravity before EVERY session.
# Keep it authoritative, current, and under 200 lines. Reference V8_UPGRADE_NOTES.md.

## Project Identity
FounderOS is an **autonomous AI empire architecture** orchestrating a 27-agent multi-agent system via advanced Swarm modeling, cost-tiered cascades, and sovereign negotiation protocols.
- **Chairman:** Pushkar Verma
- **Core Architecture:** Hierarchical Coordinator Swarms (V8 Engine).
- **Stack:** LangGraph + MCP + Claude 4.5 / Gemini 2.5 / **M4-Native MLX Qwen 2.5 (4-bit)**

## Project Root
```
~/Documents/Coding stuff/FounderOS/
├── .c-suite/          # Modular Python backend for FounderOS
│   ├── core/          # V8 Engine, Registry, Prompts, Orchestrator
│   ├── agents/        # Dedicated MDs, Swarm logic, specialized agents
│   ├── tests/         # System unit and E2E test suites
│   ├── bridges/       # MCP, Telegram, NotebookLM Gateways
│   ├── memory/        # SQLite States, SQLite Jobs, ChromaDB
│   ├── utils/         # Sync scripts, libraries, standalone utilities
│   └── tools/         # [V8] Sovereign Native Tool Wrappers
│       ├── manager_upwork.py
│       └── manager_github.py
├── V8_UPGRADE_NOTES.md      # Strategic V8 History & Hardware Specs
├── .founder/skills/   # Declarative Markdown Agent Profiles (SKILL.md)
├── .scratchpad/       # Ephemeral workspace for JSON/Document team handoffs
├── docs/              # Comprehensive Documentation
└── requirements.txt   # Complete python environment tracking
```

## Agent Architecture (The V7 Swarm Protocol)
FounderOS V7 integrates hardware-level optimization and autonomous doc-maintenance.

### 1. Hardware-Sovereign Execution (M4 16GB Optimization)
The `local` tier uses native `mlx-lm` kernels optimized for M4 Apple Silicon with aggressive 4-bit quantization and manual VRAM flushing (`unload_model()`) to ensure stability on 16GB RAM devices.

### 2. Autonomous Documentation Sync
Drift is eliminated by `doc_sync.py`. After high-impact turns, it analyzes architectural changes and automatically updates relevant `.md` files.

### 3. Knowledge Wiki & Sovereign Memory
Memory is evolved from JSON fragments into an interlinked **Knowledge Wiki** in `docs/memories/wiki/`. The `WikiManager` builds knowledge graphs using `[[Topic]]` patterns for strategic synthesis.

### 4. Zero-Trust Security Harness
All tools are wrapped in a **Hardware-Level Policy layer** (`tool_hooks.py`) enforcing **Per-Agent Tool Manifests**. No agent can use a tool (bash, etc.) unless explicitly authorized in the registry.

### 1. Coordinator Mode & The 4-Phase Lifecycle
`orchestrator.py` NEVER executes tasks. It acts solely as the Coordinator, mapping tasks through 4 strict phases:
1. **Research:** N read-only workers fetch data concurrently using `parallel_dispatch.py`.
2. **Synthesis:** Coordinator aggregates discoveries into a strict Specification.
3. **Implementation:** Write-heavy local LLM implements the spec via injected MCP tools.
4. **Verification:** Gatekeeper agent reviews the exact output for quality assurance.

### 2. The Skills & Prompt Registry
New agents/personas are NO LONGER scattered. 
- All programmatic system prompts live in `prompts.py`.
- Dynamic persona variables and skill configs live in `.founder/skills/`.
- Every agent is mapped rigidly in `registry.py` to its respective `company_assignment`, `cascade_tier`, and `memory_collection`.

### 3. Shared Worker Scratchpads
Agent memory arrays in LangGraph get bloated fast.
- Cross-agent operations happen inside `FounderOS/.scratchpad/`.
- Parallel agents concurrently push their `.json` or `.md` outputs to the scratchpad task folder, minimizing hallucination and token limits.

### 4. Background Agents & Sleep-Time Compute
FounderOS mirrors Claude Code's async daemons in `kairos_background.py` & Letta's idle architectures:
- **Sleep-Time Compute:** During idle, `AutoDream` distills ChromaDB fragments, extracts entity relationships, and builds a procedural memory cache on local hardware.
- **Context Manager:** Condenses context at the 80% boundary using a 9-section summarization prompt.
- **KAIROS Mode:** Agents run on proactive loops, pushing unprompted nudges to Telegram.

### 5. Universal MCP Hub & A2A Negotiation
Instead of hardcoding APIs, FounderOS routes strictly through standard protocols:
- **MCP Bridge (`mcp_bridge.py`):** Dynamic npm marketplaces allow local models to request and install external tooling JSON-RPC schemas mid-task natively.
- **A2A Gateway (`a2a_gateway.py`):** Uses Google's open standard for Agent-to-Agent interoperability. V8 implements **Sovereign Negotiation** logic for autonomous external task pricing and ETA bargaining.

### 6. Advanced Stealth Mechanics & Engine Safeguards
- **Tool Hooks (`tool_hooks.py`)**: Hardware-level blocks preventing `rm -rf /` and cross-company database pollution regardless of prompt instructions.
- **Sandbox & Worktrees (`sandbox.py`)**: `.tmp/` repo forking for destructive operations.
- **Zero-Cost Stealth Daemons**: `AutoDream` memory compression and `MagicDocs` markdown updates run natively mapping to local M-series Mac hardware.
- **Smart Task Router (`task_router.py`)**: Classifies all inputs instantly instead of manual agent toggling.

## Specialized Active Swarms (27-Agent Core)
- **Scrum PM (`scrum_pm.py`)**: Daily autonomous planning assigning tasks across all 27 agents based on capacity.
- **Revenue Team (`revenue_team.py`)**: Scout, Outreach, and Pipeline MD agents acting asynchronously.
- **Marketing Swarm (7-Agent Team):** Parallel workers executing SEO, Trend Research, Copywriter, and Analytics.
- **JobOS V4 Career Intelligence:** Hybrid swarm utilizing JobSpy MCP for unified search, automated Markdown-to-PDF resume tailoring, persistent ChromaDB career memory, and HR discovery/relationship management.
- **Career Growth Agents:**
    - `lead_monitor`: Background cron scanning IMAP for interview invites.
    - `resume_tailor`: Precision-focused resume bullet rewriting and selection.
    - `interview_researcher`: Deep-dive OSINT for interview prep guide generation.
    - `hr_scout`: Investigative agent finding HR contacts and outreach hooks.
    - `liaison_agent`: Conversational relationship manager maintaining contextual recruiter threads.

## Forbidden Actions
- ❌ **Never** write sequential agent executions (`call_a() then call_b()`). Use `dispatch_parallel()` to spawn workers concurrently.
- ❌ **Never** create an agent without adding it to `registry.py` first.
- ❌ **Never** bypass `tool_hooks.py` for direct bash array executions.
- ❌ **Never** pass massive multi-page documents inside LangGraph contextual messages. Write them to `FounderOS/.scratchpad/` and pass the filepath.

## Self-Maintenance Protocol (Docs & Ref Updates)
All LLM Assistants operating on this repository **MUST** adhere to the following rule:
Whenever you make any changes to the codebase, you must evaluate the impact and **automatically update `AGENTS.md`**, `docs/COMPLETE_REFERENCE.md`, and any relevant files in the `docs/` folder. **Only the strictly relevant sections are to be updated** to preserve operational truth without rewriting entire documents.

> [!CRITICAL_RULE]
> **Strict Documentation Linkage:**
> For every file in `.c-suite/`, there exists a matching markdown document under `docs/components/[filename]_doc.md` containing its functions, steps, and Mermaid flowcharts. 
> Whenever you change a core code file (e.g. `orchestrator.py` or `task_router.py`), you **SHALL TAKE IT AS YOUR RESPONSIBILITY** to immediately update the corresponding `_doc.md` flowchart and step mapping in the same session.
