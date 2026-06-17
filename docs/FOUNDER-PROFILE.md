# Founder Profile — Pushkar Verma

> Operational context for FounderOS agents. This document tells agents who the founder
> is and what he's working on, so they can answer "who is Pushkar?" or "what does Turicks
> do?" without asking him. Read by `search_knowledge` queries.
>
> Boundary (ADR-013/015): Personal career/portfolio data lives in personal-rag, NOT here.

---

## Who Is Pushkar?

**Pushkar Verma** is a solo founder building two businesses simultaneously:

1. **Turicks** — The Autonomous Studio: cinematic launch experiences for AI/dev-tool startups, delivered via FounderOS
2. **Naggar Retreat** — a boutique guesthouse/hospitality business in Naggar (Himachal Pradesh, India)

He runs both via FounderOS — a multi-agent AI operating system that handles research,
outreach, content, engineering, and operations through Telegram.

---

## Turicks — The AI Agency

**What it does:** Ships cinematic launch experiences and governed AI delivery for AI-native and dev-tool startups — landing pages, copy, deploy — using FounderOS as the trust/audit layer.

**ICP (Ideal Customer Profile):**
- Founders of AI/dev-tool startups (seed–Series A)
- Team size 2–20
- Pain: generic launch site; need credibility for funding or product launch
- They want: beautiful, governed delivery — not vibe-coded slop

**Services + Pricing:**
- Cinematic Launch Experience: $8,000+ (DFY landing + copy + deploy via cinematic-web)
- Retainer: $5,000/month (ongoing iterations)
- Gumroad packs: $14–34 (passive digital products)
- Proof Drops: custom artifacts for pipeline (founder time investment)

**Retired:** $500 starter tier (ADR-032).

**Brand voice:** Direct, confident, founder-to-founder. No corporate jargon. No fluff.
Never uses "leverage", "synergies", "delve", "transformative", or "cutting-edge".
Writes like a peer, not a pitch deck.

**Current status (2026):** Repositioned as The Autonomous Studio (ADR-032). Proof showcases + Proof Drop outreach in progress. FounderOS is the delivery OS and portfolio demo.

**Strategy docs:** `docs/strategy/00`–`05` · Phase: `PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md`

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

**7 active ReAct departments:**
- **research** — web search, knowledge base search, competitive intel
- **comms** — email send, read emails, Google Calendar
- **engineering** — GitHub read/write, Claude Code execution
- **marketing** — LinkedIn posts, content strategy
- **sales** — prospect research, outreach email drafting
- **personal** — file operations, shell commands, browser (all HITL-gated, path-guarded)
- **jobhunt** — CV management, job search, application drafting

Plus shared tools: context read/write, knowledge search (available to all departments)

**Where it runs:** Telegram bot, single-tenant (Pushkar only, as of 2026).

---

## 2026 Goals

1. **Proof & Distribution (Phase D-Bis):** 3 showcases on proof.turicks.com + LinkedIn build-in-public + Proof Drops
2. **Revenue:** 1 closed client/month at ≥$8K (Cinematic Launch Experience)
3. **Portfolio Signal:** FounderOS + governed delivery as hiring/credibility moat
4. **SCALE gate (deferred):** MCP bridge, studio dept — only after $5K+ banked or first client

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
