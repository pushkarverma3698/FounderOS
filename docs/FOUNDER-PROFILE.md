# Founder Profile — Pushkar Verma

> Operational context for FounderOS agents. This document tells agents who the founder
> is and what he's working on, so they can answer "who is Pushkar?" or "what does Turicks
> do?" without asking him. Read by `search_knowledge` queries.
>
> **Updated 2026-06-17** per ADR-033 — The Autonomous Studio repositioning.
>
> Boundary (ADR-013/015): Personal career/portfolio data lives in personal-rag, NOT here.

---

## Who Is Pushkar?

**Pushkar Verma** is a solo founder building two businesses simultaneously:

1. **Turicks** — The Autonomous Studio: AI-native creative + delivery for funded AI/dev-tool startups
2. **Naggar Retreat** — a boutique guesthouse/hospitality business in Naggar (Himachal Pradesh, India)

He runs both via FounderOS — a production multi-agent AI operating system (HITL + eval + audit) through Telegram.

---

## Turicks — The Autonomous Studio

**Category:** AI-native studio for AI/dev-tool startups.

**What it does:** Designs and delivers cinematic launch experiences for funded AI and dev-tool startups — governed by FounderOS (HITL, eval, audit on every external action).

**ICP (Ideal Customer Profile):**
- Funded AI / dev-tool startups (Seed–Series A)
- Launching or re-launching a product
- Need a launch experience proving cutting-edge (not a template page)
- Budget: $8K+ project or $5K/mo retainer
- Understand AI agents; value governance over vibe code

**Services + Pricing:**
- **Project:** $8K minimum (launch experience / brand build)
- **Retainer:** $5K/mo minimum (ongoing delivery + iteration)
- **Full build:** $15K–50K+ scoped
- **Retired:** $500 starter (commodity signal — do not quote)

**Moat narrative:** *"Beautiful product, shipped by an AI studio you can trust and watch."*

**Brand voice:** Direct, confident, founder-to-founder. No corporate jargon. No fluff.
Never uses "leverage", "synergies", "delve", "transformative", or "cutting-edge".
Writes like a peer, not a pitch deck.

**Current status (2026):** Phase D-Bis — building 3 showcase pieces, founder-led LinkedIn build-in-public, Proof Drops to target list. FounderOS is internal delivery infrastructure + build-in-public proof.

**The one metric:** 1 closed client/month at ≥$8K.

---

## Naggar Retreat — The Hospitality Business

- Boutique guesthouse in Naggar, Himachal Pradesh, India
- Operated by local staff; Pushkar manages remotely
- Key operational tasks: guest communications, OTA listings (Airbnb/Booking.com), reviews

---

## FounderOS — The Operating System

FounderOS is:
1. The tool Pushkar uses daily to run Turicks + Naggar Retreat
2. The **delivery moat** — governed AI delivery proof for studio positioning
3. **Deferred as SaaS product** until SCALE gate ($5K+ banked from client work)

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

## 2026 Goals (Phase D-Bis)

1. **Proof:** 3 showcase pieces on proof.turicks.com + ≥1 award submission
2. **Distribution:** Founder-led LinkedIn build-in-public (3–5 posts/week)
3. **Outreach:** Proof Drops → 3–5 qualified conversations/month
4. **Close:** 1 client/month at ≥$8K
5. **Operational Reliability:** FounderOS daily OS — zero-downtime, deterministic
6. **Phase E (gated):** SaaS pivot — only after SCALE gate + 4–6 weeks reliable solo use

---

## Working Style & Preferences

- **Communication:** Telegram messages; prefers direct answers with no preamble
- **Decision mode:** Fast and iterative — ship, learn, improve. No long planning cycles.
- **Tone preference:** Peer-to-peer. Treat him as the expert he is.
- **Key constraint:** Solo operator (~10h/week) — every hour counts. Automate, don't explain.
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
- "What does Turicks do?" → The Autonomous Studio — AI-native delivery for AI/dev-tool startups
- "What are my goals?" → Phase D-Bis goals above; 1 client/month @ ≥$8K
- "What is FounderOS?" → Production multi-agent OS; delivery moat + internal OS
- "Who are my clients?" → Call `read_context` — that has live pipeline data
- "What's my brand voice?" → Direct, founder-to-founder; see docs/strategy/ and BRAND.md
- "What's our strategy?" → docs/strategy/README.md — The Autonomous Studio

**Never fabricate specifics** (client names, deal values, revenue) — call `read_context` or ask if not in KB.
