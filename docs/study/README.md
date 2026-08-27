# FounderOS Study Materials

> Learning resources and the build log for FounderOS.
> The old v2 learning path (multi-agent supervisor, 7 ReAct departments, Phases 1–6 hardening) was retired with the v2 architecture on 2026-07-08. To understand the **current v3 kernel**, read the architecture docs; to understand **how we got here**, read the case studies.

---

## 🎯 Hiring & market study (2026-08)

A four-part study of the 2026 AI-engineering market, measured from **911 real job postings that
FounderOS's own pipeline collected** — then mapped back onto what this repository can prove.
The measuring instrument is the portfolio piece.

| Doc | What it is |
|---|---|
| **[MARKET-2026-AI-ENGINEER.md](MARKET-2026-AI-ENGINEER.md)** | The research. 911 postings / 4 weeks / 623 boards: what AI roles actually demand, by frequency; seniority reality; NL vs India; triangulated against published data |
| **[EVIDENCE-MAP.md](EVIDENCE-MAP.md)** | Requirement → mechanism → file path → production number. Every demand marked ✅ / 🟡 / ❌, gaps included |
| **[PORTFOLIO-GAPS-AND-ACTIONS.md](PORTFOLIO-GAPS-AND-ACTIONS.md)** | Ranked actions. Leads with the finding that the binding constraint is **not** the portfolio |
| **[INTERVIEW-BRIEF.md](INTERVIEW-BRIEF.md)** | Six headline numbers, five incident-led stories, the hard questions with honest answers |

Headline findings: **20%** of AI postings want agents + evaluation + production together (the
exact intersection this repo occupies) · only **2.4%** target juniors, independently matching a
published 2.5% figure · the Netherlands over-indexes on every differentiator we hold, including
**2.5× more human-in-the-loop** than India · Python appears in **70.1%** of postings and this
codebase is TypeScript, which is the largest measured gap.

Reproduce any table: `scripts/sql/market-skill-frequency.sql`, `market-cuts.sql`, `prod-metrics.sql`.

---

## Understand the current architecture (v3)

The v2 study sequence described an architecture that no longer exists. The authoritative, up-to-date material now lives at the root and in the docs index:

1. **[../../CLAUDE.md](../../CLAUDE.md)** — the contract-first kernel, one orchestration path, anti-slop CI invariants
2. **[../../JARVIS-ARCHITECTURE.md](../../JARVIS-ARCHITECTURE.md)** — why v2 failed within 3 steps; the typed StateGraph that replaced it
3. **[../../ZERO-BASE-AUDIT.md](../../ZERO-BASE-AUDIT.md)** — 4 live failure traces that justified the rebuild
4. **[../PROOF.md](../PROOF.md)** — the executable guarantees (each is a scenario, not a claim)
5. **[../README.md](../README.md)** — the full documentation index

---

## The story: v1 → v2 → v3

**[../turicks-case-studies/](../turicks-case-studies/)** — candid engineering case studies on where we fell for AI slop, over-engineered, and simplified for production. Written for the Turicks community and website.

---

## Build log & postmortems (kept)

- **[CASE-STUDY-LOG.md](CASE-STUDY-LOG.md)** — append-only build-in-public record: milestones, decisions, metrics. Newest first.
- **[POSTMORTEM-eval-outputMode.md](POSTMORTEM-eval-outputMode.md)** — a real bug postmortem: why `outputMode: "last_message"` hid ToolMessages, and `handleToolStart` as the correct eval-observation pattern. (Historical — from the v2 eval harness — but the lesson generalizes.)

---

## 👉 Then read the code

1. [../../src/kernel/contracts.ts](../../src/kernel/contracts.ts) — the contracts *are* the architecture (`TaskEnvelope`, `Plan`, `StepResult`, `FailureReport`, `ToolReceipt`)
2. [../../src/kernel/graph.ts](../../src/kernel/graph.ts) — the one orchestration path as a StateGraph
3. [../../src/gateway/kernel-boot.ts](../../src/gateway/kernel-boot.ts) — the only composition root
4. [../../tests/unit/kernel/kernel-e2e.test.ts](../../tests/unit/kernel/kernel-e2e.test.ts) — the full graph running offline at $0

To build or extend: follow [../rules/PROGRAMMING-RULES.md](../rules/PROGRAMMING-RULES.md).
