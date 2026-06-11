# FounderOS — The Complete Picture

> A multi-agent AI operating system that runs a founder's entire business through Telegram — safely, reliably, and with human approval for every real-world action.

---

## What This Folder Is

This `client/` folder is the definitive human-readable documentation for FounderOS. It covers every architectural decision — including the small ones — and explains the thinking behind each choice. It is written for three audiences:

- **New contributors** who need to understand the system before touching code
- **The founder** who needs a clear record of what was built and why
- **Anyone evaluating FounderOS** as a portfolio project or engineering case study

If you want to understand the code, start with [ARCHITECTURE.md](./ARCHITECTURE.md).  
If you want to understand the decisions, start with [DECISIONS.md](./DECISIONS.md).  
If you want to understand reliability guarantees, start with [RELIABILITY.md](./RELIABILITY.md).

---

## What FounderOS Does

You send a message in Telegram. A supervisor reads it, routes it to the right department, and the department executes using real tools — web search, Gmail, GitHub, LinkedIn, your laptop's file system. If the action is anything that touches the outside world, the system pauses and asks you to approve before executing.

```
You → Telegram:  "Research Linear's product and draft a cold email to their founder"

FounderOS:       [sales agent searches web, identifies hook, drafts personalised email]

                 📧 Send email to karri@linear.app?
                 Subject: Turicks × Linear — 3-day AI workflow build
                 ─────────────────────────────────────────────────────
                 Hey Karri, saw Linear's agent API announcement last week...
                 [full 147-word email]

                 ✅ Approve   ❌ Reject

You:             ✅ Approve

FounderOS:       ✅ Email sent (idempotent — won't re-send on retry)
```

That's the whole loop. No hidden actions. No automatic sends. Every side effect is gated by you.

---

## The Core Philosophy

FounderOS was built on three convictions:

**1. Safety first, features second.**  
Every agent framework demo shows beautiful capabilities. Production breaks on edge cases: a process crash mid-approval, a duplicate send because you hit Approve twice, a loop caused by stale conversation history. FounderOS solves these before adding new departments. The production hardening layer is the moat.

**2. Determinism over cleverness.**  
LLM temperature is set to zero. Routing decisions are enforced by pure code, not prompt instructions the model might ignore. Idempotency keys prevent duplicate actions regardless of what the model does. The system behaves identically on Monday and Friday.

**3. Minimum viable architecture.**  
FounderOS v1 had 10,678 lines of code and 0 real-world actions working. v2 has ~500 lines of core logic and every department executes correctly. The v1 lesson: complexity compounds bugs. Build the smallest thing that works end-to-end before adding abstraction.

---

## Current Status (2026-06-09)

| Metric | Value |
|---|---|
| Unit tests passing | **799/799** |
| TypeScript errors | **0** |
| Routing accuracy (eval) | **96%** (23/24 golden tasks) |
| Tool selection accuracy | **100%** (20/20) |
| HITL coverage | **91%** (21/23) |
| Active departments | **8** |
| Production bugs (open) | **0** |

Live bot is running. All 8 departments operational.

---

## Document Index

| Document | What It Covers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Full system design — every layer, every component, the thinking behind each |
| [DEPARTMENTS.md](./DEPARTMENTS.md) | All 8 departments — tools, HITL gates, scope, design rationale |
| [DECISIONS.md](./DECISIONS.md) | All 17 architectural decisions in plain English |
| [SECURITY.md](./SECURITY.md) | Path guards, secret blocking, HITL gates, idempotency, least-privilege design |
| [RELIABILITY.md](./RELIABILITY.md) | Test coverage, production hardening, known edge cases, what we verified live |

---

## Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript 5.5 strict | Type safety at every boundary; ES modules throughout |
| Agent framework | LangGraph JS | Built-in Postgres checkpointing, native `interrupt()` for HITL, graph-based state management |
| Model | Gemini 2.5 Flash | Cost-effective; temperature=0 is reliable; Flash is fast enough for Telegram latency |
| Database | PostgreSQL via Drizzle ORM | Durable storage for HITL state, audit log, conversation history |
| Transport | Telegram via grammy | Mobile-first, 2-tap approvals, real-time push on phone |
| Integrations | Composio | Managed OAuth for Gmail, LinkedIn, Calendar — no credential storage in-app |
| Eval | Custom golden-task harness | Reproducible routing/tool/HITL coverage scores on every merge |

---

*Last updated: 2026-06-09. Generated from production codebase on main.*
