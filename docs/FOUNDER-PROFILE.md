# Founder Profile — Pushkar Verma

> Operational context for FounderOS agents. This document tells agents who the founder
> is and what he's working on, so they can answer "who is Pushkar?" or "what does Turicks
> do?" without asking him. Read by `search_knowledge` queries.
>
> Boundary (ADR-013/015): Personal career/portfolio data lives in personal-rag, NOT here.

---

## Who Is Pushkar?

**Pushkar Verma** is a solo founder building two businesses simultaneously:

1. **Turicks** — an AI automation agency that builds AI agents for SME founders
2. **Naggar Retreat** — a boutique guesthouse/hospitality business in Naggar (Himachal Pradesh, India)

He runs both via FounderOS — a multi-agent AI operating system that handles research,
outreach, content, engineering, and operations through Telegram.

---

## Turicks — The AI Agency

**What it does:** Builds custom AI agent systems for SME founders who want to automate
their operations — lead generation, content, customer support, internal workflows.

**ICP (Ideal Customer Profile):**
- Solo founders or lean teams (1–5 people)
- Revenue: $50K–$500K ARR
- Geography: EU and US primarily
- Pain: Repetitive ops work eating into founder time
- They want: automation that works today, not a 6-month project

**Services + Pricing:**
- Starter: $500 one-time (simple automation / first agent)
- Retainer: $5,000/month (ongoing agency work, multiple agents, iteration)
- Done-For-You: custom (cinematic-web / full-stack AI builds)

**Brand voice:** Direct, confident, founder-to-founder. No corporate jargon. No fluff.
Never uses "leverage", "synergies", "delve", "transformative", or "cutting-edge".
Writes like a peer, not a pitch deck.

**Current status (2026):** Active — outbound and LinkedIn launch sequence in progress.
Using FounderOS itself as the flagship case study / portfolio piece.

---

## Naggar Retreat — The Hospitality Business

- Boutique guesthouse in Naggar, Himachal Pradesh, India
- Operated by local staff; Pushkar manages remotely
- Key operational tasks: guest communications, OTA listings (Airbnb/Booking.com), reviews

---

## FounderOS — The Operating System

FounderOS is both:
1. The tool Pushkar uses daily to run Turicks + Naggar Retreat
2. The product/portfolio piece he is building and intends to open-source / monetize

**8 active departments:**
- **research** — web search, competitive intel, market research
- **comms** — email send, LinkedIn post, Google Calendar events
- **engineering** — GitHub read/write, project workflow (HITL-gated)
- **marketing** — content strategy, LinkedIn posts, Gumroad listings
- **sales** — ICP scoring, lead qualification, outreach sequences
- **personal** — laptop file operations, shell commands (HITL-gated, path-guarded)
- **jobhunt** — CV read, job search, application drafts
- **memory** — episodic recall, knowledge search, context reading

**Where it runs:** Telegram bot, single-tenant (Pushkar only, as of 2026).

---

## 2026 Goals

1. **Revenue Flywheel (Phase D):** Gumroad live + LinkedIn launch sequence + 5 outbound/week
2. **Portfolio Signal:** FounderOS ships production-grade features that close AI/agent hiring gaps
3. **Operational Reliability:** Bot is the daily OS — zero-downtime, deterministic, no hallucination
4. **Phase E (gated):** SaaS pivot (web gateway, multi-tenancy, billing) — only after 4–6 weeks reliable solo use

---

## Working Style & Preferences

- **Communication:** Telegram messages; prefers direct answers with no preamble
- **Decision mode:** Fast and iterative — ship, learn, improve. No long planning cycles.
- **Tone preference:** Peer-to-peer. Treat him as the expert he is.
- **Key constraint:** Solo operator — every hour counts. Automate, don't explain.
- **Trust model:** HITL gates on all external sends (email, LinkedIn, GitHub push). He approves before anything goes out.

---

## Key Contacts / Integrations

- **Email:** Google Workspace / Gmail via Composio
- **LinkedIn:** Connected via Composio (Pushkar's personal + Turicks page)
- **GitHub:** `pushkarverma3698/FounderOS` — main engineering repo
- **Calendar:** Google Calendar via Composio

---

## What Agents Should Know

When a user (always Pushkar) asks about:
- "Who am I?" / "What's my background?" → Use this document + `read_context` for live state
- "What does Turicks do?" → Services, ICP, pricing above
- "What are my goals?" → 2026 goals section above
- "What is FounderOS?" → The operating system he built; runs 8 AI departments via Telegram
- "Who are my clients?" → Call `read_context` — that has live pipeline data
- "What's my brand voice?" → Direct, founder-to-founder, banned phrases in brand guidelines

**Never fabricate specifics** (client names, deal values, revenue) — call `read_context` or ask if not in KB.
