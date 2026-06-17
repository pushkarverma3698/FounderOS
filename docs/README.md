# FounderOS — Documentation Index

> **Start here.** Every doc in FounderOS is linked below, organized by role.

> 🟢 **PRODUCTION LIVE** since 2026-06-14 on Hetzner VPS. Architecture locked (7 ReAct departments, LangGraph supervisor, Phases 1-6 hardening shipped). **Next phase:** add tools and hierarchy only — architecture is stable.

---

## 🚀 New here? Read in this order

1. **[Root README.md](../README.md)** — What FounderOS does, architecture overview, eval results
2. **[diagrams/](diagrams/)** — 8 mermaid flows (architecture, request lifecycle, HITL, data model, deployment)
3. **[guides/ARCHITECTURE.md](guides/ARCHITECTURE.md)** — Plain-English system design
4. **[guides/LOCAL-DEV.md](guides/LOCAL-DEV.md)** — Local setup + env vars
5. **[guides/DEPLOYMENT.md](guides/DEPLOYMENT.md)** — Production runbook (we're live, use this for troubleshooting)
6. **[LIMITATIONS.md](LIMITATIONS.md)** — Honest tech-debt and deferred work

---

## 📖 Guides — How it works & how to run

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](guides/ARCHITECTURE.md) | System design: supervisor, 7 departments, tools, HITL pattern, data flow |
| [LOCAL-DEV.md](guides/LOCAL-DEV.md) | Local setup, env vars, troubleshooting, running tests |
| [DEPLOYMENT.md](guides/DEPLOYMENT.md) | Production runbook (Hetzner VPS, systemd, GitHub Actions CD, Day-1 gotchas) |
| [OPERATIONS.md](guides/OPERATIONS.md) | Day-to-day: start/stop, Telegram commands, halt/resume, scheduler, monitoring |
| [HITL-MATRIX.md](guides/HITL-MATRIX.md) | All 11 HITL-gated tools, gate patterns, observability |
| [SIGNALS-AND-CONTRACTS.md](guides/SIGNALS-AND-CONTRACTS.md) | Department signals, event types, publishing/consuming, adding new types |
| [JUDGE-AND-CRITIC.md](guides/JUDGE-AND-CRITIC.md) | Claude critic quality gate, two-gate system, brand voice validation |
| [MEMORY-OPERATIONS.md](guides/MEMORY-OPERATIONS.md) | turicks-brain + personal-rag, populate, query, troubleshoot |
| [SECURITY-RULES-20-21.md](guides/SECURITY-RULES-20-21.md) | Context isolation + typed handoffs, verification, monitoring |
| [PHASE-HARDENING-GUIDE.md](guides/PHASE-HARDENING-GUIDE.md) | **Phases 1-6 hardening** (context isolation, typed contracts, judge, signals, hierarchy, rules) |

---

## 📏 Rules — The laws of the codebase

| Doc | Purpose |
|-----|---------|
| [PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) | **Wiring maps:** exact files to touch for adding a tool / department / workflow / command |
| [TOOL-STANDARDS.md](rules/TOOL-STANDARDS.md) | 8-point checklist every new tool must pass |
| [TESTING-RULES.md](rules/TESTING-RULES.md) | 8 testing rules from real bugs + test template |
| [TOOL-INTEGRATION-PLAYBOOK.md](rules/TOOL-INTEGRATION-PLAYBOOK.md) | Verifying external API contracts before implementation |

---

## 🧭 Decisions — Architecture Decision Records (ADRs)

Every significant decision documented in [decisions/](decisions/). **Key ones for next phase:**

| ADR | Decision |
|-----|----------|
| [001](decisions/001-why-langgraph.md) | LangGraph JS — stateful graphs, native HITL, Postgres checkpointing |
| [013](decisions/013-keep-personal-and-engineering-separate.md) | Separate departments — least privilege |
| [021](decisions/021-multi-agent-transition-and-token-measurement.md) | Context isolation + per-turn token tracking |
| [022](decisions/022-typed-interdept-contracts.md) | Typed inter-department handoffs (dept_signals) |
| [027](decisions/027-tool-count-and-handoff-rules.md) | **Current rules:** ~10 tools/agent, sync handoffs for nested HITL visibility |
| [032](decisions/032-deterministic-anti-hallucination-guards.md) | Memory-tool guard + structured tool-failure envelopes |
| [033](decisions/033-ai-native-studio-repositioning.md) | Autonomous Studio repositioning + AI/dev-tool niche |

---

## 📚 Study — Learning resources

**Learning path for understanding FounderOS:**

| Doc | What it covers |
|-----|----------------|
| [study/01-what-is-multi-agent-orchestration.md](study/01-what-is-multi-agent-orchestration.md) | Foundations: agents, tools, supervision, routing |
| [study/02-langgraph-patterns.md](study/02-langgraph-patterns.md) | LangGraph primitives used in FounderOS (createSupervisor, createReactAgent, state, interrupt) |
| [study/04-how-founderos-works.md](study/04-how-founderos-works.md) | **Deep dive:** runtime walkthrough (request → supervisor → department → tool → HITL → action) |
| [study/POSTMORTEM-eval-outputMode.md](study/POSTMORTEM-eval-outputMode.md) | Bug post-mortem: eval tool detection + learning |
| [study/CASE-STUDY-LOG.md](study/CASE-STUDY-LOG.md) | Build-in-public case study (shipping history, decisions, outcomes) |

---

## 🎯 Strategy — Turicks GTM (2026-06)

| Doc | Purpose |
|-----|---------|
| [strategy/README.md](strategy/README.md) | Index — Autonomous Studio repositioning |
| [strategy/00-VISION-AUTONOMOUS-STUDIO.md](strategy/00-VISION-AUTONOMOUS-STUDIO.md) | North star, category, moat narrative |
| [strategy/01-POSITIONING-AND-NICHE.md](strategy/01-POSITIONING-AND-NICHE.md) | AI-native studio + AI/dev-tool startup wedge |
| [strategy/02-OFFER-AND-PRICING.md](strategy/02-OFFER-AND-PRICING.md) | $8K floor, retainer ladder |
| [strategy/03-GTM-ACQUISITION-ENGINE.md](strategy/03-GTM-ACQUISITION-ENGINE.md) | Build-in-public, Proof Drops, referrals |
| [strategy/04-EXECUTION-ROADMAP.md](strategy/04-EXECUTION-ROADMAP.md) | Phased roadmap + weekly cadence |
| [strategy/05-SHOWCASE-BRIEF.md](strategy/05-SHOWCASE-BRIEF.md) | 3 showcase pieces for proof.turicks.com |

---

## 🎯 Next phase — Adding tools & hierarchy

**Architecture is locked.** Next work focuses on:

1. **Adding tools** → Follow [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md#add-a-tool) wiring map (6 file touches)
2. **Adding hierarchy** → Nested HITL proof is documented in [decisions/025-hierarchy-proof-on-prebuilts.md](decisions/025-hierarchy-proof-on-prebuilts.md); proof-of-concept code in `feat/hierarchy-*` branch if revival needed

**Do NOT:**
- Rearchitect the supervisor or department structure
- Change the 7-department boundary
- Add new integration layers
- Rewrite tool wrappers without wiring-map guidance

**If unsure:** Check [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) first.

---

## 🗺️ Other docs (reference)

| Folder | Purpose |
|--------|---------|
| [decisions/](decisions/) | All ADRs (001–032+), full decision history |
| [phases/](phases/) | Phase delivery docs (Phases 1-6 shipped and locked) |
| [diagrams/](diagrams/) | System diagrams (mermaid) |
| [process/](process/) | Development process docs |
| [strategy/](strategy/) | Turicks GTM strategy doc set (2026-06) |

---

## The 5 core rules (never break)

1. **TDD always** — write failing test first
2. **HITL before external actions** — `hitlGate()`, side effects after approval
3. **Idempotency before sends** — audit only after confirmed success ID
4. **Soft-failure detection** — 200 + message ≠ success, check for ID
5. **Determinism** — temperature 0; logic in pure functions, not prompts

Full detail: [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md).
