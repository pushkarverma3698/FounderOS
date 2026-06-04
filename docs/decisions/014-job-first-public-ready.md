# ADR-014: Job-First Sequencing + Public-Ready Now

**Date:** 2026-06-04  
**Status:** Accepted  
**Replaces:** The "validate-then-public" sequencing in SCALING-AND-PORTFOLIO-STRATEGY.md

---

## Context

FounderOS v2 is stabilized with 7 departments, Postgres checkpointing, HITL, idempotency, path-guard,
eval harness (13/13), and 271 passing tests. The founder has ~1 quarter of runway, needs both a job
and revenue. The prior strategy (ADR-011) chose "portfolio-as-product" but deferred going public
until after further validation.

Three parallel deep-research agents (competitive landscape, monetization, job signal — 2026-06-04)
found that:

1. **Bottleneck is legibility + distribution, not features.** The gap between "strong system" and
   "first dollar / interview" is entirely a visibility problem.
2. **AI engineer salaries:** $145K–245K (LangGraph now in 22.1% of agentic job listings). A single
   offer closes the runway problem permanently.
3. **No open-source project replicates the exact combination** FounderOS ships (TS + supervisor +
   crash-safe HITL + idempotency + eval + path-guarded laptop operator on Telegram).
4. **Eval harness design is "the hardest hiring signal to fake"** — FounderOS has it, committed,
   with EVAL.md showing 100% across three dimensions.

---

## Decision

**Job-first.** Revenue is a by-product, not the lead for the next 4–6 weeks.

**Go public now** (after a secrets/PII audit), rather than after further feature work. The repo is
stronger today than most "launched" multi-agent projects. Waiting adds no value.

**Features pass the triple filter** before shipping: must simultaneously be (1) an outcome,
(2) a named 2026 hiring signal, and (3) mostly reuse of existing parts. Deferred to build-in-public
follow-on: budget guard, MCP server, Job-Hunt department, real RAG.

---

## Consequences

- `feat/public-ready` branch: secrets audit, world-class README, post-mortem, docs reconciliation,
  CLAUDE.md rule #17, brand update → PR → public.
- Applications start immediately using: FounderOS public repo + EVAL.md + the 90-sec Loom demo as
  artifacts.
- Features become the build-in-public series: each ships on its own branch + PR with TDD and eval,
  generating LinkedIn content along the way.

---

## New project rule (CLAUDE.md #17)

**"Reuse & simplicity-first (adopt before build):"** before writing new code, reuse an existing
tool / MCP / agent / pattern; prefer the simplest external tool that benefits us; one engine, many
workflows — never fork a parallel product when a department + prompt will do.

**Feature triple-filter:** a feature ships only if it simultaneously (1) produces a real outcome,
(2) closes a named 2026 AI/agent engineering hiring gap, AND (3) is mostly reuse of existing parts.

---

## See also

- ADR-011: portfolio-as-product + eval harness (original decision)
- `docs/study/IDEATION-AND-MARKET-RESEARCH.md` — full competitive + monetization research
- `docs/study/POSTMORTEM-eval-outputMode.md` — the hardest-to-fake portfolio artifact
