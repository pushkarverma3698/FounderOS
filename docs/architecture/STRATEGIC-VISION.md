# FounderOS — Strategic Vision

> Last updated: 2026-06-01
> Status: Active — reference before adding any new feature

This document organises the 16 founding strategic instructions into 6 pillars. Every new feature, agent, or workflow must be evaluated against these pillars before implementation.

---

## Pillar 0: Token Economy — Always Cheapest Viable Path

This is a cross-cutting constraint that applies to every agent, tool, and workflow.

### Decision Ladder (follow in order)

```
1. No AI at all?        → Can a deterministic function, regex, or DB query answer this? Use it.
2. Local model (free)?  → Ollama qwen2.5:7b via mcp__ollama__generate for:
                           - JSON extraction from text or config files
                           - Commit message generation from diffs
                           - Simple classification / routing decisions
                           - Template variable filling
3. Redis cache hit?     → Return cached output — skip cloud call entirely
4. nano tier?           → gemini-flash-lite for: content formatting, social posts, summaries
5. md tier?             → gemini-flash for: full drafts, research, multi-step reasoning
6. CEO/critic tier?     → claude-sonnet for: final decisions, critique, architecture only
```

### Enforcement Rules

- **Default cascade tier = `nano`** for any new agent — upgrade only with explicit justification in code comment
- **Batch over real-time**: Generate a week of social posts in 1 LLM call; scheduler pulls from Redis
- **Prompt caching**: Any system prompt > 1024 tokens gets `cache_control: { type: "ephemeral" }` prefix
- **Structured output**: Always use Ollama for JSON extraction — never waste a cloud LLM on parsing
- **Redis TTL discipline**: Research cache 24h | LLM output 6h | Content templates 7 days | Quota counters daily reset
- **Agent collapse**: Combine sequential nodes with no branching — fewer graph hops = fewer context resets
- **Web app (future)**: Server-side rendering + edge caching — zero client-side AI calls
- **Embeddings**: Use `nomic-embed-text` via Ollama for deduplication/similarity — zero cloud cost

### API Capacity Estimates

```
Light use (1 person, 10 tasks/day):    50–100 calls/day   → $2–5/day
Moderate (20 active tasks/day):        500 calls/day      → $10–20/day
Heavy (social + sales automation):     2,000 calls/day    → $40–80/day
SaaS (10 tenants, heavy):              20,000 calls/day   → $200–400/day (with caching)

Redis LLM cache cuts repeat calls ~40% at steady state.
Budget guard in src/infra/llm.ts already caps per-tenant spend.
```

---

## Pillar 1: Personal → SaaS Pipeline

**Instructions covered**: 1, 7

### Principle

Every workflow is built for personal use first. When stable and validated in production for Turicks operations, it gets extracted into a standalone SaaS product deployed on turicks.com.

### Implementation Pattern

```
Phase 1: Personal — TENANT_MODE=personal, single tenant, Telegram gateway
Phase 2: Harden  — battle-tested, edge cases resolved, costs understood
Phase 3: Extract — separate Next.js/React project, multi-tenant, web app gateway
Phase 4: Launch  — turicks.com marketplace listing or own domain
```

### Gateway Evolution

Current: Telegram bot (`src/gateway/telegram.ts`)
Next: Own web app (React/Next.js)

**Architecture rule**: FounderOS graph is gateway-agnostic. All business logic lives in agent pods. The gateway is purely transport — it receives input and returns output. Both Telegram and web app can run simultaneously against the same compiled graph.

See ADR-007 for gateway-agnostic architecture decisions.

---

## Pillar 2: Product Hierarchy & Social Pod

**Instructions covered**: 2, 5

### Hierarchy

```
Turicks
├── FounderOS (AI OS)
│   ├── Departments
│   │   ├── sales        → lead_intel, outreach_agent, bdr, sales_engineer
│   │   ├── engineering  → eng_engineer, senior_engineer
│   │   ├── marketing    → mktg_engineer
│   │   ├── social       → social_linkedin, social_instagram (new)
│   │   └── prospecting  → (existing pod)
│   └── Cross agents     → supervisor, critic
├── Tools (composio-backed)
│   ├── LinkedIn API     → social pod
│   ├── Instagram API    → social pod
│   ├── GitHub API       → senior_engineer
│   └── Gmail API        → sales pod
└── Skills / Agents monetised via Gumroad or LemonSqueezy
```

### Social Pod Rules

- LinkedIn + Instagram automation go into the `social` department only — never inline in marketing or sales pods
- Social posts always go through critic node before HITL
- Content batched weekly (1 LLM call → 7 posts → Redis 7-day TTL → scheduler drains)
- Composio handles all OAuth token management for social platforms

---

## Pillar 3: Auth Strategy

**Instructions covered**: 3, 6

### Internal (Current)

Composio auth for all platform connections. One Composio account connected to:
- LinkedIn
- Instagram
- GitHub
- Gmail

FounderOS calls Composio tools; Composio handles token refresh and session management.

### Multi-Tenant SaaS (Future)

```
User login:          OAuth via Gmail (Google Sign-In)
Platform connections: Each user connects their own Composio account
AI access:           User provides one API key → stored encrypted in turicks-brain
Tenant isolation:    TenantAwareCheckpointer already implemented (src/infra/checkpointer.ts)
```

Single login = Google OAuth → connects to AI via user API key → Composio handles all downstream platform auth.

See ADR-006 for full auth strategy decisions.

---

## Pillar 4: Monetisation

**Instructions covered**: 4, 8, 10

### Channels

1. **Gumroad / LemonSqueezy**: Best standalone agents or workflow packs → one-time purchase or subscription
2. **turicks.com marketplace**: Full SaaS products extracted from FounderOS
3. **Agency retainers**: $500 starter / $5,000 retainer (existing)

### Core Services to Monetise First

Priority order based on demonstrated value + extraction effort:
1. AI automation workflows (multi-agent packs)
2. LinkedIn automation pod (B2B outreach + content)
3. Design + deploy bundles (UI/UX → hosted SaaS)
4. Website Builder Tool (see below)

### Website Builder Tool

- Lives in `~/Projects/website-builder/` (separate project, separate domain)
- Exposed to FounderOS via MCP server → product team agents can route to it
- Two client paths:
  - **(a) Template**: One-click deploy from template library → listed on turicks.com with own section
  - **(b) Custom**: Route to product team agents → Claude Design MCP or Google Stitch for design → build + deploy pipeline
- Also listed as standalone SaaS on its own domain

### Routing Logic (product team)

```
Client website request
  ├── Has template preference?  → website-builder MCP → template picker → one-click deploy
  └── Custom design needed?     → product team agents → Claude Design MCP / Google Stitch
                                   → build → deploy → live site
```

---

## Pillar 5: Engineering Agent + Self-Healing Infrastructure

**Instructions covered**: 15, 16

### Senior Engineering Agent

`senior_engineer` agent in registry with:
- `cascade_tier: "ceo"` — handles architectural reasoning
- `allowed_tools: ["github_create_pr", "github_push_files", "github_read", "code_review", "run_tests"]`
- HITL gate on every `merge_pull_request` call — human must approve before merge
- Composio GitHub integration for real-time repo access and PR creation

### DB Self-Optimization

Every founderOS action already writes to `audit_log`. Additional:

- **Tracking**: Every feature completion, architectural decision, case study milestone → written to turicks-brain (Postgres via drizzle queries)
- **Weekly cron**: Push encrypted DB snapshot to GitHub via `senior_engineer`
- **Monthly cron**: Self-healing query — detect orphaned leads, stale audits, failed HITL interrupts → auto-remediate or raise HITL flag
- **Mermaid diagrams**: Push updated system diagram to GitHub after each phase completes

### GitHub Diagram Workflow

After each phase completion:
1. Update `docs/diagrams/system-architecture.md` with current graph state
2. `senior_engineer` creates PR with updated diagram
3. Human approves merge
4. Diagram stays in sync with codebase

---

## Pillar 6: Knowledge Infrastructure

**Instructions covered**: 11, 12, 13, 14

### turicks-brain (Postgres in FounderOS)

- **Source of truth** for: all brand decisions, case study data, operational context, agent decisions
- Written via drizzle queries — NOT via personal-rag MCP
- personal-rag = Pushkar's personal career/docs DB — entirely separate, never mixed

### Case Study Tracker

`docs/study/CASE-STUDY-LOG.md` — append-only log:
- Milestone reached + date
- Architectural decision made + rationale
- Metrics (API calls, cost, leads processed, posts published)
- Lessons learned
- After 1 year: compile into public case study

### Claude Folder Structure (per project)

```
.claude/
├── settings.local.json
├── memory/
│   └── MEMORY.md
├── brand/
│   └── TURICKS.md     ← copy of global brand guidelines
└── hooks/             ← project-specific hooks
```

### Self-Context Awareness

FounderOS must always know:
- What tasks are in progress (audit_log)
- What decisions have been made (turicks-brain records)
- What the current phase is (docs/phases/)
- What the brand says (docs/BRAND.md → ~/.claude/brand-guidelines/TURICKS.md)

---

## Decision Log

All architectural decisions → `docs/decisions/` as numbered ADRs.

| ADR | Topic |
|---|---|
| 001 | Why LangGraph |
| 002 | Why Drizzle |
| 003 | Critic pattern |
| 004 | Why Telegram for HITL |
| 005 | Why Redis for caching |
| 006 | Auth strategy (Composio + Google OAuth) |
| 007 | Gateway-agnostic architecture |
