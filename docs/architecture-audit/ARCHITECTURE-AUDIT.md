# FounderOS — Architecture Audit
**Date:** 2026-06-05  
**Branch audited:** `feat/qa-production-hardening`  
**Auditor:** Senior Backend Architect (spawned agent + manual verification)  
**Verdict:** Core is right-sized. Periphery has SaaS-era speculative infra that costs cognitive load without serving current use.

---

## TL;DR

| Subsystem | Status | Action |
|---|---|---|
| 7 departments + supervisor | ✅ Justified | Keep |
| Postgres checkpointer | ✅ Justified | Keep |
| HITL interrupt() + DB registry | ✅ Justified | Keep |
| 503 model fallback | ✅ Justified | Keep |
| Single-instance PID lock | ✅ Justified | Keep |
| Workflow/SOP engine | ✅ Justified (freeze scope) | Keep, don't expand |
| Redis | ❌ Not wired — dead boot dep | Gated (removed from health + compose) |
| DB tables (4 unused) | ⚠️ SaaS-phase, no write path | Annotated as NOT-ACTIVE |
| CLAUDE.md model cascade table | ❌ Describes deleted system | Fixed |
| CLAUDE.md rule #14 safety claim | ❌ Not wired in any send path | Fixed |

---

## What the System Does (Functionally)

- Single-tenant Telegram bot for one founder
- Routes natural-language messages to 7 departments (research, comms, engineering, personal, marketing, sales, jobhunt) via a LangGraph supervisor
- Each department = `createReactAgent` with 1–4 tools
- HITL pauses before destructive/external actions
- Persists state via LangGraph checkpointer → Postgres

---

## Findings

### 1. 7 Departments + Supervisor — JUSTIFIED

The pattern is correct and the portfolio signal is real. Each department owns distinct tools with no cross-ownership (fixed in the 8→7 merge). The supervisor is a routing workflow — exactly what Anthropic's *Building Effective Agents* recommends for "complex tasks with distinct categories handled separately."

**Security argument (ADR-013):** keeping `personal`'s `run_shell` away from `engineering`'s `github_write` is a genuine least-privilege boundary, not decoration.

**Cost:** one extra LLM hop on every turn. Acceptable given the disjoint tool sets and portfolio value.

---

### 2. Postgres Checkpointer — JUSTIFIED

The killer reason: HITL crash-safety. A pending `interrupt()` survives process restarts because graph state is persisted. `MemorySaver` would lose a parked approval on every deploy — catastrophic for a bot whose safety model depends on "pause before destructive action."

Postgres was already a boot dependency (audit log, budget tracking). Marginal cost = one connection.

---

### 3. Model — ALREADY CORRECT (docs were lying)

`src/agents/model.ts` has ONE primary model (Gemini 2.5 Flash) with a narrow 503-only fallback chain. The multi-provider 6-tier cascade described in `CLAUDE.md` was deleted. **Fixed in this audit.**

---

### 4. Redis — NOT WIRED (highest impact finding)

**grep proof:** `cacheGet`, `cacheSet`, `incrQuota`, `getQuota` — zero callers in `src/` outside `redis.ts` itself. The only non-test consumer was `health.ts` pinging Redis to verify Redis was up (circular).

**What this meant before the fix:**
- Redis ran as a hard `depends_on` boot dep in docker-compose
- The health report showed `redis: "up"|"down"` despite Redis serving nothing
- 205 LOC + a stateful service for zero function

**Fix applied:** removed `pingRedis` from `health.ts`, removed Redis service from `docker/docker-compose.yml`, added `// SaaS-PHASE` header to `redis.ts`. File + tests kept intact for when it gets wired.

---

### 5. CLAUDE.md Rule #14 — SAFETY CLAIM NOT WIRED

Rule #14 stated `suppression_check` and `quota_check` are "non-negotiable safety rails" in the sales pod flow. In reality:
- `incrQuota` / `getQuota` are defined in `redis.ts` — not called from any send path
- `doNotContact` table exists in schema/queries — not checked before any send
- The send paths (email, LinkedIn) go straight to idempotency check → Composio

**This is a documentation-vs-reality gap, not a code bug.** The sends are still idempotency-guarded (no duplicates). But the suppression/quota layer is aspirational, not live. **Fixed in CLAUDE.md.**

---

### 6. Unused DB Tables — SaaS-Phase Debt

Four tables have no active write path from production `src/`:

| Table | Purpose | Status |
|---|---|---|
| `outbound_leads` | Prospect state machine | Query helpers exist, no production writer |
| `do_not_contact` | GDPR suppression list | Schema + query, never checked before sends |
| `agent_results` | Few-shot training data | No writer anywhere in src/ |
| `dept_signals` | Cross-department events | No writer anywhere in src/ |

`aiCallCosts` is queried by health endpoint (`getTodayCostUsd`) but has no writer in production — always returns 0.

**Fix:** annotated with `// SaaS-PHASE: no active write path` in schema.ts. Tables stay (DB schema is cheap; migration is not).

---

### 7. Wiring Map (6-Layer Tool Add) — Documented Friction

Adding one tool touches 6 files. This is high ceremony, but 4 of 6 layers are load-bearing (HITL wrapper, prompt routing, test, tool impl). The `PROGRAMMING-RULES.md` wiring map mitigates the friction by making it explicit.

Not fixing now — would require restructuring the agent-tools architecture.

---

### 8. Single-Instance PID Lock — JUSTIFIED

Fixed the #1 real production bug: stacked processes → 409 Conflict → HITL approvals landing on wrong process. 100 clean lines. The right-sized solution for Telegram long-polling's single-consumer constraint.

---

## What NOT to Touch

- Supervisor + 7 ReAct departments
- Postgres checkpointer
- 503 model fallback
- PID lock
- HITL `interrupt()` + DB-backed approval registry
- Workflow/SOP engine (freeze scope, don't expand)

---

## LangGraph Best Practices Reference

Grounding from Anthropic's *Building Effective Agents* (authoritative source):
- "Find the simplest solution possible, and only increase complexity when needed"
- "Routing works well for complex tasks where there are distinct categories better handled separately" ← our supervisor pattern
- "Consider adding complexity only when it demonstrably improves outcomes"
- Recommended: workflows over agents for predictable, multi-step tasks ← our `/run` SOP engine

FounderOS follows all three. The complexity that remains is load-bearing.
