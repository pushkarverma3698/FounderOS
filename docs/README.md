# FounderOS — Documentation Index

> Start here. Every doc in the project is linked below, grouped by purpose.

> 🟢 **LIVE in production since 2026-06-14** — `main` auto-deploys to the Hetzner VPS
> via GitHub Actions (CI → CD → `/health`). Runbook: [guides/DEPLOYMENT.md](guides/DEPLOYMENT.md).
> What's left to fully wrap production: [PRODUCTION-WRAP-UP.md](PRODUCTION-WRAP-UP.md).

---

## 🚀 New here? Read in this order

1. [diagrams/](diagrams/) — **8 mermaid flows** (architecture, request lifecycle, HITL, tool map, deploy, data, layering, thread states) — the fastest on-ramp
2. [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) — how the system works (plain English + diagram)
3. [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) — the wiring maps (where to add what)
4. [guides/OPERATIONS.md](guides/OPERATIONS.md) — how to run it day-to-day
5. [guides/LOCAL-DEV.md](guides/LOCAL-DEV.md) — local setup + env vars
6. [guides/DEPLOYMENT.md](guides/DEPLOYMENT.md) — the production runbook + CI/CD pipeline (we're live)
7. [LIMITATIONS.md](LIMITATIONS.md) — honest tech-debt, scaling ceilings & deferred work

---

## 📐 guides/ — how it works & how to run

| Doc | What it covers |
|-----|---------------|
| [ARCHITECTURE.md](guides/ARCHITECTURE.md) | Supervisor + 7 departments, tool layers, HITL pattern, file map |
| [PHASE-HARDENING-GUIDE.md](guides/PHASE-HARDENING-GUIDE.md) | **Phases 1-6 hardening** (context isolation, typed contracts, judge, signals, hierarchy, rules) |
| [HITL-MATRIX.md](guides/HITL-MATRIX.md) | All 11 HITL-gated tools, gate patterns, observability |
| [SIGNALS-AND-CONTRACTS.md](guides/SIGNALS-AND-CONTRACTS.md) | Department signals, event types, how to publish/consume, adding new types |
| [JUDGE-AND-CRITIC.md](guides/JUDGE-AND-CRITIC.md) | Claude critic quality gate, two-gate system, brand voice validation |
| [MEMORY-OPERATIONS.md](guides/MEMORY-OPERATIONS.md) | turicks-brain + personal-rag, populate, query, troubleshoot |
| [SECURITY-RULES-20-21.md](guides/SECURITY-RULES-20-21.md) | Context isolation + typed handoffs, verification, monitoring |
| [DEPLOYMENT.md](guides/DEPLOYMENT.md) | **Production runbook + CI/CD pipeline** (Hetzner VPS, systemd, GitHub Actions CD, env-without-SSH, Day-1 gotchas) |
| [OPERATIONS.md](guides/OPERATIONS.md) | Start/stop, Telegram commands, halt/resume, scheduler, quota, signals monitoring, troubleshooting |
| [LOCAL-DEV.md](guides/LOCAL-DEV.md) | Local setup, env vars, troubleshooting |

## 📏 rules/ — the laws of the codebase

| Doc | What it covers |
|-----|---------------|
| [PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) | **Wiring maps**: exact files to touch for adding a tool / department / workflow / command, with "forget X → error Y" tables |
| [TOOL-STANDARDS.md](rules/TOOL-STANDARDS.md) | The 8-point checklist every new tool must pass |
| [TESTING-RULES.md](rules/TESTING-RULES.md) | 8 testing rules learned from real bugs + a test template |
| [TOOL-INTEGRATION-PLAYBOOK.md](rules/TOOL-INTEGRATION-PLAYBOOK.md) | Verifying external API (Composio) contracts before writing the tool |

## 🧭 decisions/ — Architecture Decision Records (ADRs)

Numbered records of every significant decision and why. See [decisions/](decisions/).
Key ones: 010 (v2 ReAct rebuild), 013 (personal/engineering separation),
014 (job-first public-ready), 015 (jobhunt + personal-rag boundary),
016 (memory single source of truth).

## 📚 study/ — learning & strategy

| Doc | What it covers |
|-----|---------------|
| [study/04-how-founderos-works.md](study/04-how-founderos-works.md) | Deep dive on the runtime |
| [study/02-langgraph-patterns.md](study/02-langgraph-patterns.md) | LangGraph patterns used here |
| [study/POSTMORTEM-eval-outputMode.md](study/POSTMORTEM-eval-outputMode.md) | The eval tool-detection bug post-mortem |
| [study/CASE-STUDY-LOG.md](study/CASE-STUDY-LOG.md) | Build-in-public case study log |
| `study/archive/` | Superseded status/progress docs (kept for history) |

## 🗺️ phases/ — phase delivery docs

**Key phases:**
- [PHASE-1-CONTEXT-ISOLATION.md](phases/PHASE-1-CONTEXT-ISOLATION.md) — Per-turn token tracking, no context leakage
- [PHASE-2-TYPED-CONTRACTS.md](phases/PHASE-2-TYPED-CONTRACTS.md) — Deterministic signal validation
- [PHASE-3-CLAUDE-JUDGE.md](phases/PHASE-3-CLAUDE-JUDGE.md) — Quality gate on outbound copy
- [PHASE-4-DEPT-SIGNALS.md](phases/PHASE-4-DEPT-SIGNALS.md) — Durable cross-dept messaging
- [PHASE-5-HIERARCHY-PROOF.md](phases/PHASE-5-HIERARCHY-PROOF.md) — Nested HITL (proven, not yet in production)
- [PHASE-6-RULES.md](phases/PHASE-6-RULES.md) — Rules #20-21 operationalized
- [PHASE-C-INTELLIGENCE.md](phases/PHASE-C-INTELLIGENCE.md) — Context memory + knowledge search + scheduler
- [PHASE-D-REVENUE-FLYWHEEL.md](phases/PHASE-D-REVENUE-FLYWHEEL.md) — Gumroad + LinkedIn launch + cinematic-web

For complete Phase 1-6 hardening details, see [PHASE-HARDENING-GUIDE.md](guides/PHASE-HARDENING-GUIDE.md).

## 🎨 Other

| Doc | What it covers |
|-----|---------------|
| [ROADMAP.md](ROADMAP.md) | What's next and what NOT to build |
| [BRAND.md](BRAND.md) | Turicks brand voice pointer |
| `superpowers/specs/` | Design specs from brainstorming sessions |
| `diagrams/` | System + pipeline diagrams |

---

## The 5 rules you must never break

1. **TDD always** — failing test first.
2. **HITL before every external action** — `hitlGate()`, side-effect after approval.
3. **Idempotency before every send** — audit only after confirmed success id.
4. **Soft-failure detection** — check for the id; 200 + message ≠ success.
5. **Determinism** — temperature 0; logic in pure functions, not prompts.

Full detail: [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md).
