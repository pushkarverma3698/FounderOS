# FounderOS Study Materials

> Learning path for understanding the architecture, implementation, and lessons from building FounderOS.
> Last updated: 2026-06-23. Reflects v2 production state (8 departments, Phases 1–6 hardening complete).

---

## 📖 Core learning sequence

### 1. Foundations (1–2 hours)
Start here if multi-agent systems are new:

- **[01-what-is-multi-agent-orchestration.md](01-what-is-multi-agent-orchestration.md)** (7 min read)
  - Agents, tools, supervision, routing
  - Why specialists beat one giant agent
  - HITL pattern + 3-layer quality gate overview
  - 4 orchestration patterns (single → supervisor → hierarchical → parallel)
  - Memory types (short-term, checkpointer, RAG, episodic)

- **[02-langgraph-patterns.md](02-langgraph-patterns.md)** (20 min read)
  - `createAgent` + `createSupervisor` + `interrupt()` + checkpointers
  - Middleware stack: 503-fallback + token trimming + tool-call caps
  - Context isolation (`outputMode: "last_message"`, `assertContextIsolation`)
  - Nested supervisor hierarchy — how HITL works through 3 levels
  - Eval pattern: `handleToolStart` callbacks
  - Typed handoffs: `validateSignalPayload`

### 2. System deep dive (30 min)

- **[04-how-founderos-works.md](04-how-founderos-works.md)** (15 min read)
  - Complete request walkthrough: Telegram → supervisor → department → tool → HITL → send
  - File-by-file architecture (all 8 departments, all infra files)
  - Env vars quick reference

### 3. Production hardening (30 min)

- **[03-production-hardening.md](03-production-hardening.md)** (25 min read)
  - 6 phases from working prototype to production-grade system
  - Phase 1: Context isolation + token measurement (ADR-021)
  - Phase 2: Typed inter-dept contracts (ADR-022)
  - Phase 3: Claude-as-judge — why different model families (ADR-023)
  - Phase 4: Durable Postgres signals vs BullMQ (ADR-024)
  - Phase 5: Hierarchy proof — nested HITL through 3 levels (ADR-025)
  - 5 key lessons for LangGraph engineers

- **[05-safety-and-quality-gates.md](05-safety-and-quality-gates.md)** (15 min read)
  - All safety mechanisms in one place
  - 3-layer quality gate: brand validator → Claude judge → HITL
  - Anti-hallucination execution guard (ADR-032)
  - Tool failure envelope + stage tagging
  - Idempotency, suppression, budget, path-guard, single-instance, history window

### 4. Real-world lessons (20 min)

- **[POSTMORTEM-eval-outputMode.md](POSTMORTEM-eval-outputMode.md)** (10 min read)
  - Eval tool-select 0/7 → 7/7 fix
  - Why `outputMode: "last_message"` hides ToolMessages
  - `handleToolStart` callback as the correct eval observation pattern

- **[CASE-STUDY-LOG.md](CASE-STUDY-LOG.md)** (10 min read)
  - Build-in-public record: shipping history, decisions, outcomes
  - Major milestones: v2 rebuild, Phase B, personal dept, hardening, ADR-032

---

## 🎯 Quick reference

**I want to understand…**

| Topic | Go to |
|-------|-------|
| Why agents matter | [01-what-is-multi-agent-orchestration.md](01-what-is-multi-agent-orchestration.md) |
| LangGraph primitives | [02-langgraph-patterns.md](02-langgraph-patterns.md) |
| How a request executes end-to-end | [04-how-founderos-works.md](04-how-founderos-works.md) |
| Context isolation / outputMode | [03-production-hardening.md](03-production-hardening.md#phase-1) |
| Typed department contracts | [03-production-hardening.md](03-production-hardening.md#phase-2) |
| Why generator ≠ critic | [03-production-hardening.md](03-production-hardening.md#phase-3) |
| Cross-dept signals (no BullMQ) | [03-production-hardening.md](03-production-hardening.md#phase-4) |
| Nested HITL through 3 levels | [03-production-hardening.md](03-production-hardening.md#phase-5) |
| Anti-hallucination guard | [05-safety-and-quality-gates.md](05-safety-and-quality-gates.md) |
| Tool failure envelope | [05-safety-and-quality-gates.md](05-safety-and-quality-gates.md) |
| Budget + path + suppression guards | [05-safety-and-quality-gates.md](05-safety-and-quality-gates.md) |
| Eval tool-select bug & fix | [POSTMORTEM-eval-outputMode.md](POSTMORTEM-eval-outputMode.md) |
| Build timeline + decisions | [CASE-STUDY-LOG.md](CASE-STUDY-LOG.md) |

---

## 📦 Archive

Older materials (reference only, not recommended reading):

- [archive/03-v1-to-v2-migration.md](archive/03-v1-to-v2-migration.md) — v1 → v2 rewrite (for historians)
- [archive/](archive/) — Strategic planning, LinkedIn logs, old sprint notes

---

## 👉 Next: Read the code

This study folder teaches the *why* and *how*. To see it in action:

1. Read [../../docs/guides/ARCHITECTURE.md](../../docs/guides/ARCHITECTURE.md) — visual + plain English
2. Read [../../src/agents/capabilities.ts](../../src/agents/capabilities.ts) — tool ownership (single source of truth)
3. Read [../../src/agents/office.ts](../../src/agents/office.ts) — the whole system in 277 lines
4. Read [../../tests/](../../tests/) — 1008+ tests proving correctness

**To build or extend:** Follow [../../docs/rules/PROGRAMMING-RULES.md](../../docs/rules/PROGRAMMING-RULES.md) wiring maps.
