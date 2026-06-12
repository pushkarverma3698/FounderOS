# FounderOS — Documentation Index

> Start here. Every doc in the project is linked below, grouped by purpose.

---

## 🚀 New here? Read in this order

1. [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) — how the system works (plain English + diagram)
2. [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) — the wiring maps (where to add what)
3. [guides/OPERATIONS.md](guides/OPERATIONS.md) — how to run it day-to-day
4. [guides/LOCAL-DEV.md](guides/LOCAL-DEV.md) — local setup + env vars

---

## 📐 guides/ — how it works & how to run

| Doc | What it covers |
|-----|---------------|
| [ARCHITECTURE.md](guides/ARCHITECTURE.md) | Supervisor + 7 departments, tool layers, HITL pattern, file map |
| [OPERATIONS.md](guides/OPERATIONS.md) | Start/stop, Telegram commands, troubleshooting runbook |
| [LOCAL-DEV.md](guides/LOCAL-DEV.md) | Local setup, env vars, troubleshooting |

## 📏 rules/ — the laws of the codebase

| Doc | What it covers |
|-----|---------------|
| [PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) | **Wiring maps**: exact files to touch for adding a tool / department / workflow / command, with "forget X → error Y" tables |
| [TOOL-STANDARDS.md](rules/TOOL-STANDARDS.md) | The 8-point checklist every new tool must pass |
| [TESTING-RULES.md](rules/TESTING-RULES.md) | 15 testing rules learned from real bugs + a test template. **Rule 15 = the Verification-First Definition of Done: every change must clear a live MTProto/E2E run (bot reply + `action_log` evidence), not just unit tests.** |
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

Per-phase goals, deliverables, and verification. See [phases/](phases/).

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
