# FounderOS (V6)
**The Ultimate Autonomous Multi-Agent AI Empire Architecture**

FounderOS is a state-of-the-art, parallel-execution multi-agent system designed to replace traditional corporate hierarchies with autonomous agent swarms. Influenced by leading agentic architectures like Claude Code and the upcoming A2A standards of 2026, it abstracts AI execution into highly scalable swarms operating across isolated workflows.

## Core Mission
To act as an overarching "Operating System" for the Founder (The Chairman), translating high-level Telegram voice notes or text commands into complex, multi-stage automated workflows that are researched, synthesized, executed, and verified by 27 specialized LLM workers concurrently.

## High-Level Features
- **4-Phase Coordinator Loop**: All complex swarms progress through *Research → Synthesis → Implementation → Verification*.
- **Task Router & Scrum PM**: Fully automated daily planning and dynamic command routing via Telegram.
- **Memory & Context Compaction**: Employs an ongoing `Memory Extractor` for factual retention and an 80%-boundary `Context Manager` with a 9-section summary to ensure long sessions never crash.
- **Stealth Background Daemons**: `AutoDream`, `MagicDocs`, and `HivemindSync` silently compress memory, update skill definitions, and cross-pollinate learnings.
- **Parallel Dispatch & Scratchpads**: Utilizing `asyncio.gather`, massive tasks are split into chunked workers operating in parallel, sharing context seamlessly via physical `.scratchpad/` files.
- **Strict Security Sandboxing**: Built-in `tool_hooks.py` restrictions and `sandbox.py` virtual workspaces actively block dangerous commands and cross-company memory leaks.
- **Model Cascade Economics**: Rapid failover routing leveraging 100% free local models (Qwen 2.5 7B) through zero-latency Nano layers up to advanced deep reasoning arrays.

## Getting Started
1. Boot the environment and verify the credentials within `.c-suite/.env`.
2. Start the core FounderOS 3-process architecture:
```bash
bash start.sh
```
3. Command FounderOS natively through your Telegram instance using text or voice messages.

**Quick Commands:**
```bash
python .c-suite/scheduler.py --list      # Show all upcoming agent jobs
python .c-suite/scrum_pm.py --now        # Force today's scrum planning session now
python .c-suite/auto_researcher.py --now # Run nightly skill research loop now
bash stop.sh                             # Terminate all FounderOS background activity
```

## Documentation Index
- [**⭐ COMPLETE_REFERENCE.md**](COMPLETE_REFERENCE.md): The exhaustive, 2000-line master technical architecture document mapping every single piece of the OS. START HERE.
- `COMPLETE_GUIDE.md`: The file map outlining the core Python execution sequences natively operating your PMs and Swarms.
- `AGENTS.md` (Root Directory): Machine-readable system constraints explicitly for other AI assistants extending this codebase.
- `reference.md`: Database topologies and core variables.
- `architecture.md`: The core execution engine, 4-Phase loops, parallel dispatches, and LangGraph structures.
- `multi_agent_system.md`: The dynamic 27-agent registry, their cascade tiers, and memory collections.
- `security_and_permissions.md`: Tool hooks, sandboxing, data silos, and token compaction.
- `superpowers.md`: Advanced stealth routines (Scrum PM, Task Router, AutoDream).
- `IMPROVEMENT_ROADMAP.md`: Proposed future features mapped out based on Claude Code internals and 2026 AI industry research.
