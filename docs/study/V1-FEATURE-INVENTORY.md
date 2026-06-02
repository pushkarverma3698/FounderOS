# V1 Feature Inventory — what the old 17k-LOC codebase planned

> **Purpose:** The v1 FounderOS grew to ~17,000 LOC across 36 source files and was
> deleted in the v2 rebuild (commit `f5ecdcc`, "delete 17k LOC of dead v1 code").
> v2 is ~500 LOC of spine. This doc inventories what v1 actually built/planned so
> we can decide, deliberately, what to re-add to v2 — instead of either losing
> good ideas or blindly re-bloating.
>
> **Source:** reconstructed from git history at `b985665^` (the last pre-v2 commit).
> **Status legend:** ✅ in v2 · ⚠️ partial in v2 · ❌ dropped · 🔮 was planned, never finished

---

## Side-by-side: v1 vs v2

| Capability | v1 | v2 today | Verdict |
|---|---|---|---|
| Supervisor + departments | ✅ custom pod graphs | ✅ prebuilt `createSupervisor` | v2 cleaner |
| Departments | sales, engineering, marketing, **social**, prospecting | research, comms, engineering, marketing, sales, prospecting | ⚠️ social folded into marketing |
| Research (web) | ✅ | ✅ | even |
| Email send / read | ✅ send | ✅ send + read | v2 ahead |
| LinkedIn post | ✅ | ✅ | even |
| GitHub read/write | ✅ | ✅ | even |
| Context memory | ✅ context-manager | ✅ founder_context + read/update | even |
| Knowledge / RAG | ✅ chroma + brain sync | ⚠️ keyword `search_knowledge` | v1 richer (vector) |
| Scheduler / cron | ✅ | ✅ Monday brief + outbound + HITL sweep | even |

---

## ❌ Dropped from v1 — the real backlog

These are the distinctive v1 systems v2 does **not** have. Each is a candidate to
re-add — ranked by leverage.

### 1. Critic / Quality Gate ⭐ HIGH LEVERAGE
- **What v1 did:** `src/agents/critic.ts` — a NODE that ran after every generator
  agent. Generator used Gemini; critic used **Claude (different family)** to avoid
  sycophancy. Output: `APPROVED` / `NEEDS_REVISION`. A pure-function edge then
  looped back to the generator (with a revision limit) or escalated to HITL.
- **Why it matters now:** directly addresses "the replies are very bad." A critic
  pass on outbound content (emails, LinkedIn posts) and on summaries would raise
  quality before the founder ever sees it.
- **Re-add cost:** medium. One extra node + a revision-count guard. Risk: latency +
  cost per turn — gate it to *content generation* only, not every message.
- **Recommendation:** **Re-add, scoped.** Critic only on marketing/sales drafts.

### 2. Pre-Router (3-layer cost classifier) ⭐ MED–HIGH LEVERAGE
- **What v1 did:** `src/agents/pre-router.ts` — Layer 0 deterministic keyword/regex
  routing ($0), Layer 1 nano-LLM classification (~$0.00003), Layer 2 escalate to the
  expensive supervisor only when ambiguous. Also answered small-talk directly with no routing.
- **Why it matters now:** every message currently hits the full Gemini supervisor.
  A deterministic Layer 0 for obvious cases (`/`-style intents, "check emails") cuts
  cost and latency and removes a class of mis-routing.
- **Re-add cost:** low–medium. Pure-function Layer 0 is trivial + testable.
- **Recommendation:** **Re-add Layer 0** (deterministic) first; defer the nano layer.

### 3. Token Optimizer + Context Manager — MED LEVERAGE
- **What v1 did:** `token-optimizer.ts` (estimateTokens, stripMarkdown,
  compressWhitespace, truncateToTokenBudget) + `context-manager.ts` (trim message
  history to a token budget, compact state, assemble system prompts).
- **Why it matters now:** the `/reset` bug was a symptom of **unbounded thread
  history**. A context manager that trims old turns to a budget would have prevented
  the poisoning *and* capped token cost — a more durable fix than manual `/reset`.
- **Re-add cost:** low. Pure functions, fully unit-testable.
- **Recommendation:** **Re-add the history-trim** as the permanent companion to `/reset`.

### 4. Log Observer / Self-Monitoring — MED LEVERAGE
- **What v1 did:** `log-observer.ts` — parsed the pino stream in real time, counted
  successes/failures/routing, detected anomalies (cascade exhaustion, null-routing),
  and posted a reliability digest to Telegram. Zero LLM, purely deterministic.
- **Why it matters now:** we are debugging by `tail -f /tmp/founderos.log` by hand.
  An observer would surface "tool X is failing repeatedly" proactively.
- **Re-add cost:** medium.
- **Recommendation:** **Defer** until daily-use volume justifies it. Note for Phase E (SaaS).

### 5. LinkedIn Safety: Account Warming + Circuit Breaker — CONDITIONAL
- **What v1 did:** `pods/social.ts` — 4-week posting ramp (1→uncapped), circuit
  breaker (3 consecutive failures → 24h cooldown), ban-risk matrix, HITL before every
  publish. OAuth via Composio (not scraping).
- **Why it matters now:** only relevant once LinkedIn posting is a daily automated
  rhythm. Today posts are manual + HITL-approved, so ban risk is already low.
- **Recommendation:** **Re-add only when** auto-posting cadence increases. Tracked by ADR-009.

### 6. Brand-Voice Runtime Validation — LOW–MED LEVERAGE
- **What v1 did:** `core/brand.ts` — a `BANNED_PHRASES` list checked at runtime to
  reject "excited to share", "game-changer", etc. in generated content.
- **Why it matters now:** v2 enforces brand voice via prompt instructions only (soft).
  A hard validator guarantees it.
- **Re-add cost:** very low (pure function + test).
- **Recommendation:** **Re-add as a cheap validator** used by the critic (item 1).

### 7. Model Cascade Tiers + Budget Guard — MED LEVERAGE
- **What v1 did:** `infra/llm.ts` — tiers (ceo / deep_research / md / code / nano /
  local / video / critic), each trying providers in order, with a per-day budget guard.
  (CLAUDE.md still documents this cascade.)
- **Why it matters now:** v2 uses a single `getModel()` (Gemini Flash) everywhere.
  Fine for now; a cascade matters for cost control + using Claude for the critic.
- **Recommendation:** **Re-add minimally** alongside the critic (need a Claude tier).

---

## 🔮 Planned-but-never-finished in v1 (aspirational)
- Multi-company / multi-tenant registry (Naggar Retreat tenant) — dropped in `7253d1b`. Reserved for Phase E SaaS.
- Video tier in the cascade (`video` tier existed in types) — never wired to a real tool.
- `deep_research` tier — multi-step research agent beyond single `search_web`.

---

## Recommended re-add order (proposal — for founder sign-off)

| Priority | Item | Why first | Cost |
|---|---|---|---|
| **P1** | History-trim context manager (#3) | Permanent fix for the poisoning/cost bug behind `/reset` | low |
| **P1** | Pre-router Layer 0 (#2) | Cuts cost+latency on every message, removes mis-routes | low |
| **P2** | Critic + brand validator + Claude tier (#1, #6, #7) | Directly fixes "replies are bad" for generated content | medium |
| **P3** | Log observer (#4) | Proactive reliability once volume grows | medium |
| **P4** | LinkedIn warming/circuit-breaker (#5) | Only when auto-posting scales | medium |

> **These are recommendations, not commitments.** Decide together which land in the
> roadmap, then each goes through the Tool Integration Playbook (TDD, 5 layers, clean-thread verify).

---

## Related
- `docs/PLAYBOOK-TOOL-INTEGRATION.md` — how to add any of these safely
- `docs/ROADMAP.md` — where the chosen items get scheduled
- `CLAUDE.md` — Critic-as-NODE rule (§3), cascade tiers, registry rules
