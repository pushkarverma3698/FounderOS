# FounderOS — Documentation Index

> **Start here.** FounderOS is a **deterministic, contract-first agent kernel** with a Telegram gateway. Every doc below reflects the **v3 architecture** (typed Plan → pure-code dispatch → isolated worker → receipt-validated collect → results-only synthesis). The v2 supervisor + 7-department system was audited and replaced on 2026-07-08 — see the case studies for the full story.

---

## 🚀 New here? Read in this order

1. **[Root README.md](../README.md)** — What FounderOS does + the v3 architecture at a glance
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — How the whole system works, in plain English (one message, end to end)
3. **[FEATURES.md](FEATURES.md)** — Every feature and how it works, worker by worker
4. **[CONCEPTS.md](CONCEPTS.md)** — Glossary of the domain vocabulary
5. **[CLAUDE.md](../CLAUDE.md)** — The canonical contract-first design, file map, and non-negotiable rules
6. **[JARVIS-ARCHITECTURE.md](../JARVIS-ARCHITECTURE.md)** — Why v2 failed within 3 steps and how the typed StateGraph fixes it
7. **[guides/LOCAL-DEV.md](guides/LOCAL-DEV.md)** — Local setup + env vars
8. **[LIMITATIONS.md](LIMITATIONS.md)** — Honest tech-debt and deferred work

New to the story? The **[case studies](turicks-case-studies/)** and **[blog](turicks-blog/)** tell the v1→v2→v3 journey; the **[diagrams](diagrams/)** show the whole system visually.

---

## 🧭 Architecture — the current truth

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **How the whole system works** — plain-English walkthrough + the five core ideas |
| [FEATURES.md](FEATURES.md) | **What it does** — the 8 workers, their tools, and every cross-cutting feature E2E |
| [CONCEPTS.md](CONCEPTS.md) | **Glossary** — kernel, TaskEnvelope, ToolReceipt, HITL, and the rest |
| [diagrams/](diagrams/) | **10 Mermaid diagrams** — architecture, orchestration path, contracts, receipts, CI gates, v2↔v3, capability map |
| [../CLAUDE.md](../CLAUDE.md) | The canonical rules — contract-first kernel, anti-slop CI invariants, model policy, file map |
| [../JARVIS-ARCHITECTURE.md](../JARVIS-ARCHITECTURE.md) | The contract-first design in full — typed boundaries, StateGraph, resumability |
| [../ZERO-BASE-AUDIT.md](../ZERO-BASE-AUDIT.md) | The v2 autopsy (4 traced live failures) that mandated v3 |
| [../ARCHITECTURE_LEDGER.md](../ARCHITECTURE_LEDGER.md) | Running ledger of production-readiness passes (v2 and v3) |
| [PROOF.md](PROOF.md) | **Living scoreboard** — deterministic suite, kernel guarantees, debt ratchet (`pnpm proof:scoreboard`) |
| [EVAL-AUDIT-2026-08-28.md](EVAL-AUDIT-2026-08-28.md) | **Root-cause audit of the golden-set eval** — separating harness defects from agent defects, with a ranked fix list |

---

## 📖 Guides — how to run & operate

| Doc | Purpose |
|-----|---------|
| [LOCAL-DEV.md](guides/LOCAL-DEV.md) | Local setup, env vars, troubleshooting, running tests |
| [DEPLOYMENT.md](guides/DEPLOYMENT.md) | Production runbook (Hetzner VPS, systemd, GitHub Actions CD) |
| [OPERATIONS.md](guides/OPERATIONS.md) | Day-to-day: start/stop, Telegram commands, halt/resume, scheduler, monitoring |
| [HITL-MATRIX.md](guides/HITL-MATRIX.md) | Every HITL-gated tool, gate patterns, observability |
| [MEMORY-OPERATIONS.md](guides/MEMORY-OPERATIONS.md) | turicks-brain + personal-rag: populate, query, troubleshoot |
| [MCP-SERVERS.md](guides/MCP-SERVERS.md) | MCP client bridge + read-only MCP server surface |
| [../docs/JOBHUNT.md](JOBHUNT.md) | **The largest production consumer of the kernel** — board discovery, screening, CV tailoring, founder-click-to-submit apply flow |
| [../docs/VPS-MCP-SETUP.md](VPS-MCP-SETUP.md) | Wiring MCP servers on the production VPS |
| [FAQ.md](FAQ.md) | Recurring questions, answered plainly |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common failures and where to look (reading a typed `FailureReport`) |

Client-facing video engine: [VIDEO-FACTORY.md](VIDEO-FACTORY.md) · [VIDEO-PIPELINE-AUDIT.md](VIDEO-PIPELINE-AUDIT.md).

---

## 🔒 Security

| Doc | Purpose |
|-----|---------|
| [../SECURITY.md](../SECURITY.md) | Reporting policy + the built-in security controls (HITL, idempotency, path-guard, least privilege) |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Assets, trust boundaries, attack surface, mitigations, and honest residual risks |

---

## 📏 Rules — the laws of the codebase

| Doc | Purpose |
|-----|---------|
| [PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) | Wiring maps — exact files to touch for adding a tool / command / workflow |
| [TOOL-STANDARDS.md](rules/TOOL-STANDARDS.md) | Checklist every new tool must pass |
| [TESTING-RULES.md](rules/TESTING-RULES.md) | Testing rules distilled from real bugs + test template |
| [TOOL-INTEGRATION-PLAYBOOK.md](rules/TOOL-INTEGRATION-PLAYBOOK.md) | Verifying external API contracts before implementation |
| [CODE-REVIEW-CHECKLIST.md](rules/CODE-REVIEW-CHECKLIST.md) | What every review must confirm |
| [../agent-rules.md](../agent-rules.md) | The numbered engineering rules (rule #24 "done = evidence", etc.) |

---

## 🧭 Decisions — Architecture Decision Records

All 50 decisions live in [decisions/](decisions/README.md), spanning three rewrites. ADRs are
**append-only history** — most record choices about the v1/v2 department-supervisor architecture
that was superseded on 2026-07-08. They are kept as the decision trail, not as current
instructions. Read them for *why*, read CLAUDE.md for *now*.

**[decisions/README.md](decisions/README.md)** tags every ADR Current / Superseded / Historical
context and leads with the 10 most interview-relevant ones — start there rather than reading
chronologically.

---

## 📚 Case studies & build log

| Doc | What it covers |
|-----|----------------|
| [turicks-case-studies/](turicks-case-studies/) | **The v1→v2→v3 journey** — 5 candid case studies on where we fell for AI slop, what it cost us, and how we got out. Written for the Turicks community and website. |
| [turicks-blog/](turicks-blog/) | **Opinion-led posts** riding the AI-slop moment + a ready-to-post [LinkedIn kit](turicks-blog/linkedin-kit.md) for every piece |
| [study/CASE-STUDY-LOG.md](study/CASE-STUDY-LOG.md) | Append-only build-in-public log (milestones, decisions, metrics) |
| [study/POSTMORTEM-eval-outputMode.md](study/POSTMORTEM-eval-outputMode.md) | Bug postmortem: eval tool-detection via `handleToolStart` |
| **[study/](study/README.md#-hiring--market-study-2026-08)** | **2026 AI-engineering market study** — 911 real postings this system collected, mapped onto what the repo proves ([market](study/MARKET-2026-AI-ENGINEER.md) · [evidence map](study/EVIDENCE-MAP.md) · [actions](study/PORTFOLIO-GAPS-AND-ACTIONS.md) · [interview brief](study/INTERVIEW-BRIEF.md)) |

---

## 🗺️ Other folders

| Folder | Purpose |
|--------|---------|
| [decisions/](decisions/) | All ADRs — full decision history |
| [ops/](ops/) | Env vars, prod stabilization memory, "never again" runbook |
| [process/](process/) | Branch model + release process (branch → beta → main) |
| [research/](research/) | Forward-looking research (RAG, MCP ecosystem, multi-model) |
| [plans/](plans/) | Active plans (dated one-shot session plans are pruned) |
| [sessions/](sessions/) | Episodic session records — what was done, fixed, and why |

---

## The 5 core invariants (never break)

1. **Determinism** — temperature 0; routing/parsing/guards are pure functions, never prompt instructions.
2. **HITL before external actions** — DB row before `interrupt()`; side effects only after approval.
3. **Idempotency before sends** — idempotency key checked before every external send; audit row only on real success.
4. **Zero-hallucination** — action claims require a successful receipt; the synthesizer sees only validated results.
5. **Failures name the real component** — `FailureReport = stage + component + evidence + retryable`; threads are never silently wiped.

Full detail: [../CLAUDE.md](../CLAUDE.md) and [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md).
