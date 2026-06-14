# FounderOS — Roadmap & Strategic Plan

*For Pushkar Verma, Turicks AI Agency. Updated: 2026-06-14.*

> 🟢 **DEPLOYED — LIVE in production since 2026-06-14.** Running 24/7 on a Hetzner
> VPS; `main` auto-deploys via GitHub Actions (CI → CD → `/health`). Pipeline +
> runbook: [guides/DEPLOYMENT.md](guides/DEPLOYMENT.md). The short list to make it
> fully unattended-trustworthy: [PRODUCTION-WRAP-UP.md](PRODUCTION-WRAP-UP.md).

---

## What FounderOS Is (and Isn't)

**What it is:** Your personal AI operating system. You message it in Telegram, it routes the request to the right department, the relevant agent does the real work (searches, drafts, sends), and asks for your approval before anything leaves the building.

**What it isn't (yet):** A multi-tenant SaaS. It will be — but single-user reliability comes first. You cannot sell a system that drafts emails and never sends them.

**Design rule:** Never add complexity that doesn't serve today's real use. If you haven't needed a feature in the last two weeks of using it, defer it.

---

## Current State

> **Authoritative snapshot: see [`docs/STATUS-2026-06-04.md`](./STATUS-2026-06-04.md) and [`docs/superpowers/specs/2026-06-05-company-os-power-user-design.md`](./superpowers/specs/2026-06-05-company-os-power-user-design.md).**
> As of 2026-06-05: **Phase 0 COMPLETE** — 8 departments, deterministic eval, crash-safe HITL, budget guard,
> path-guarded laptop operator, send_file, Postgres-first memory, single-instance lock, 435 tests green.
> Architecture cleaned: hitlGate() helper, commands.ts extracted, pre-router.ts, dead code removed.
> Prompts compressed: SUPERVISOR_PROMPT ~40% smaller (decision-table routing).
> **Phase 1 next: Workflow/SOP engine** — named, parameterized multi-step procedures over the existing office.
> See the design spec above for the full plan.

### v2 baseline (2026-06-01)

✅ **Working:**
- Supervisor + 3 departments (research, comms, engineering)
- Web research via Firecrawl
- Email send via Composio Gmail (with approval gate)
- LinkedIn post via Composio (with approval gate)
- GitHub read/write via Octokit (with approval gate)
- Approval cards in Telegram with Approve/Reject buttons
- Crash-safe HITL: pending approvals survive process restart
- Conversation memory per chat (Postgres checkpointer)
- All errors surface to Telegram — never silent

⚠️ **Needs your setup:**
- Composio Gmail connection for entity `turicks` (for email to actually land)
- Composio LinkedIn connection for entity `turicks`
- `GITHUB_TOKEN` in `.env` for GitHub writes

---

## Phase A — Stability & Daily Use (Now → 2 weeks)

The goal: make the 3 current departments genuinely reliable so you use FounderOS every day.

### A1. Composio connections
Set up the OAuth connections in your Composio dashboard:
- Gmail connection for entity `turicks`
- LinkedIn connection for entity `turicks`

When done: `Email pushkarai3698@gmail.com test` should land in your inbox.

### A2. GitHub token
Add `GITHUB_TOKEN=ghp_...` to `.env` (classic PAT with repo scope).  
When done: `Open a GitHub issue on my FounderOS repo about X` should create the issue.

### A3. Smoke test all 3 departments daily
- Research: "What's the latest news about LangGraph?"
- Comms: "Email myself a one-line test" → Approve
- Engineering: "List my GitHub repos"

### A4. System prompt tuning
After using it for a week, the prompts will need refinement:
- Is the supervisor routing correctly? If not, update `SUPERVISOR_PROMPT`
- Are the agent outputs in your voice? If not, update the department prompts
- Are approvals triggered at the right moments? Adjust the HITL logic in `agent-tools.ts`

---

## Phase B — Add More Departments (2–4 weeks)

Each department is ~10–15 lines of code once the tools exist.

### B1. Sales Department
**Why:** Turicks's primary revenue source is outbound sales. Having an agent that researches leads and drafts personalised emails on demand will save hours per week.

**Tools:**
- `search_web` (already exists) — research the prospect
- `send_email` (already exists) — HITL-gated outreach
- `check_do_not_contact` — before any outreach

**Prompt:** Sales agent knows the Turicks ICP (SME founders, EU/US, $50K–500K ARR, pain = no tech co-founder). It formats cold emails using Turicks brand voice (lead with prospect's pain, not Turicks capabilities, max 150 words).

**Trigger phrase:** "Draft an outreach to [company/name]"

### B2. Marketing Department
**Why:** SEO audits, content strategy, blog outlines, campaign briefs — all tasks you currently do manually.

**Tools:**
- `search_web` — competitive research, keyword research
- `linkedin_post` (already exists) — publish approved content

**Prompt:** Knows Turicks's content pillars (BUILD_LOG, FOUNDER_STORY, AI_EDUCATION, REVENUE, AMSTERDAM). Formats LinkedIn posts in brand voice. Can do SEO briefs for turicks.com.

**Trigger phrase:** "Draft a LinkedIn post about X" / "SEO brief for [topic]"

### B3. Prospecting Department
**Why:** Qualifying companies before outreach saves wasted sales time. The v1 prospecting pod had the right idea — it was just wired wrong.

**Tools:**
- `search_web` — research the company
- A simple ICP scorer (prompt-based, no ML needed)

**Prompt:** Researches a company URL or name, scores it against the Turicks ICP (1–10), and returns a verdict with rationale. Qualified leads get routed to Sales.

**Trigger phrase:** `/prospect stripe.com` or "Research and score [company] as a Turicks prospect"

---

## Phase C — Intelligence Upgrades (1–2 months)

### C1. Conversation Memory Across Sessions
Right now: memory persists per-chat via the checkpointer, but there's no structured "long-term memory" of your business context.

**Add:** A `turicks_context` tool that can read/write a running summary of: active clients, active deals, recent decisions, current priorities. The supervisor injects this at the start of each session.

### C2. Proactive Scheduling
Right now: FounderOS only responds when you message it.

**Add back the scheduler** (removed in v2 to keep things simple — now re-add it properly):
- Monday morning: brief on what needs attention this week
- Daily: any pending approvals that expired? 
- On trigger: when a LinkedIn post is due (based on a content calendar you set)

Implementation: `node-cron` in `src/infra/scheduler.ts`, calling `sendToChat()` with the right message to kick off an office run.

### C3. turicks-brain Integration
The `turicks-brain` knowledge base (Postgres + pgvector) holds case studies, brand decisions, client notes. Currently separate.

**Add:** A `search_knowledge` tool for the Research and Sales agents — so "what have we done for FinTech clients?" returns actual case studies from the DB, not a web search.

### C4. GitHub Token → Claude Sonnet
When you have a valid Anthropic API key, switch `AGENT_MODEL=claude-sonnet-4-5`. Claude is better at nuanced business writing (emails, LinkedIn posts) than Gemini Flash. One env var change, no code.

---

## Phase D — SaaS Pivot (3–6 months)

**Prerequisite:** FounderOS must be running reliably for your own businesses for at least 6 weeks. You cannot sell reliability you haven't experienced yourself.

### D1. Multi-tenancy (already designed for it)
`tenant_id` is already a column in `audit_log` and `do_not_contact`. The `FOUNDER_TENANT` env var already scopes the default. Making it multi-tenant means:
- Auth layer (Clerk or Auth.js)
- Per-user `FOUNDER_TENANT` derived from authenticated user
- Per-user Composio entity (each user connects their own Gmail/LinkedIn)
- Billing (LemonSqueezy or Stripe)

**Estimated scope:** 4–6 weeks of real work. Not a sprint.

### D2. Web Interface
Telegram works, but limiting. The next gateway is a Next.js app on `app.turicks.com`:
- Same office graph, different `startBot` equivalent
- Real-time streaming via SSE or WebSockets
- File uploads (for context, briefs, etc.)
- Dashboard showing recent actions, pending approvals, audit log

### D3. More Tools
Each new integration is a tool file + wiring into an agent. Backlog:
- Notion: read/write pages (client notes, briefs)
- Slack: send messages to channels
- Stripe: check revenue, customer lookup
- Calendar: see upcoming meetings context

---

## What NOT to Build

These things looked necessary during v1. They're not:

| ❌ Don't build | ✅ Already handled by |
|--------------|----------------------|
| Custom multi-provider LLM cascade (826 LOC) | One good model (Gemini Flash) |
| Custom HITL database + lifecycle | LangGraph native `interrupt()` |
| Critic/anti-sycophancy node | A good system prompt |
| Circuit breakers (opossum) | Gemini's built-in retry + one fallback model |
| 3-layer pre-router classifier | Supervisor's native tool-calling |
| Department keyword resolver | Agent names in supervisor prompt |
| Schema versioning per state type | Add when you have real users to migrate |
| Brain sync cron on every change | Sync intentionally when decisions are made |

---

## The One Metric That Matters

**Actions taken per week** — emails sent, GitHub issues created, posts published, searches returned with cited results.

Not: test coverage, LOC, cascade tiers, model families. Only: real work done.

When that number is > 0 consistently, FounderOS is working. When it's growing week over week, it's becoming useful enough to sell.

---

## Business Context (For Reference)

### Turicks
- AI automation agency, solo founder (Pushkar Verma)
- ICP: SME founders, EU/US, $50K–500K ARR, need a tech co-founder
- Pricing: $500 starter, $5,000/mo retainer
- Stack: LangGraph, LangChain, Next.js, Node.js, TypeScript
- Website: turicks.com

### Naggar Retreat
- Himalayan farm homestay in Himachal Pradesh
- FounderOS scope: booking management, guest comms, seasonal marketing
- Tools needed: email, maybe WhatsApp API

### Products
- FounderOS (internal → SaaS)
- Website Builder / Cinematic Web (separate repo, Gumroad → SaaS)
- Gumroad digital packs: ICP prompt pack, brand-voice kit, LangGraph starter

---

*See also:*
- `docs/study/` — learn how the system works
- `docs/decisions/` — all architecture decisions with rationale
- `~/.claude/brand-guidelines/TURICKS.md` — brand voice and ICP reference
