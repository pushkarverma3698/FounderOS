# FounderOS Study Materials

> Learning path for understanding the architecture, implementation, and lessons from building FounderOS.

---

## 📖 Core learning sequence

### 1. Foundations (1–2 hours)
Start here if multi-agent systems are new:

- **[01-what-is-multi-agent-orchestration.md](01-what-is-multi-agent-orchestration.md)** (7 min read)
  - Agents, tools, supervision, routing
  - Why agents are useful for complex workflows
  - Common pitfalls

- **[02-langgraph-patterns.md](02-langgraph-patterns.md)** (15 min read)
  - LangGraph primitives: `createSupervisor`, `createReactAgent`, state, `interrupt()`, checkpointing
  - How FounderOS uses each pattern
  - Why we chose LangGraph JS

### 2. System deep dive (30 min)

- **[04-how-founderos-works.md](04-how-founderos-works.md)** (15 min read)
  - Complete request walkthrough: Telegram → supervisor → department routing → tool execution → HITL → action
  - State management and thread isolation
  - Error handling and recovery

### 3. Real-world lessons (20 min)

- **[POSTMORTEM-eval-outputMode.md](POSTMORTEM-eval-outputMode.md)** (10 min read)
  - How a subtle bug in eval tool detection went unnoticed
  - Why unit tests alone don't catch integration failures
  - Systematic debugging methodology

- **[CASE-STUDY-LOG.md](CASE-STUDY-LOG.md)** (10 min read)
  - Build-in-public record: shipping history, decisions, outcomes
  - What worked, what didn't, why
  - Portfolio value of building transparently

---

## 🎯 Quick reference

**I want to understand…**

- **Why agents matter** → [01-what-is-multi-agent-orchestration.md](01-what-is-multi-agent-orchestration.md)
- **How LangGraph works** → [02-langgraph-patterns.md](02-langgraph-patterns.md)
- **How FounderOS executes a request** → [04-how-founderos-works.md](04-how-founderos-works.md)
- **How production bugs sneak through** → [POSTMORTEM-eval-outputMode.md](POSTMORTEM-eval-outputMode.md)
- **What happened during the build** → [CASE-STUDY-LOG.md](CASE-STUDY-LOG.md)

---

## 📦 Archive

Older materials (reference only, not recommended reading):

- [archive/03-v1-to-v2-migration.md](archive/03-v1-to-v2-migration.md) — v1 → v2 rewrite (architecture complete, for historians)
- [archive/](archive/) — Strategic planning, LinkedIn logs, old sprint notes (context-dependent)

---

## 👉 Next: Read the code

This study folder teaches the *why* and *how*. To see it in action:

1. Read [../../docs/guides/ARCHITECTURE.md](../../docs/guides/ARCHITECTURE.md) (visual + plain English)
2. Read the source: [../../src/agents/office.ts](../../src/agents/office.ts) (the whole system in 300 lines)
3. Read the tests: [../../tests/](../../tests/) (proof of correctness)

**To build:** Follow [../../docs/rules/PROGRAMMING-RULES.md](../../docs/rules/PROGRAMMING-RULES.md) wiring maps.
