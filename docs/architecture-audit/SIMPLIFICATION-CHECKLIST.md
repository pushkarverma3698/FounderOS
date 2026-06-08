# Simplification Checklist
**Date:** 2026-06-05 | **Branch:** `feat/qa-production-hardening`

Track of what was identified, what was fixed, and what requires future work.

---

## Fixed in This Session ✅

### 1. Redis boot dependency removed
- [x] `src/infra/health.ts` — removed `pingRedis()`, removed `redis` from `HealthReport.checks`
- [x] `docker/docker-compose.yml` — removed `redis` service, removed `depends_on: redis`
- [x] `src/infra/redis.ts` — added prominent `SaaS-PHASE` header
- **Impact:** No more stateful boot dep serving nothing. Health report is now accurate (DB only).

### 2. CLAUDE.md Model Cascade Tiers — corrected
- [x] Replaced 6-tier table with accurate description (one model + 503 fallback)
- [x] Reference to `src/agents/model.ts` for current truth
- **Impact:** Eliminates the biggest docs-vs-reality gap. Future Claude sessions won't misconfigure.

### 3. CLAUDE.md Rule #14 — corrected
- [x] Removed claim that `suppression_check` and `quota_check` are "non-negotiable safety rails"
- [x] Replaced with accurate description: idempotency-guarded via `action_log`, quota/suppression are Phase 2
- **Impact:** Eliminates false security documentation.

### 4. CLAUDE.md Phase Status — updated
- [x] Updated test count from stale "40 tests, 8 test files" to current "614 tests, 57 test files"
- [x] Marked prospecting dept as merged-into-research

### 5. DB Schema — SaaS-phase tables annotated
- [x] `outboundLeads` — marked `// SaaS-PHASE: query helpers exist, no active writer`
- [x] `doNotContact` — marked `// SaaS-PHASE: defined but not checked before sends`
- [x] `agentResults` — marked `// SaaS-PHASE: no writer in production`
- [x] `deptSignals` — marked `// SaaS-PHASE: no writer in production`
- **Impact:** Reading the schema now gives an accurate picture of what's live vs aspirational.

### 6. Pending uncommitted changes committed
- [x] `src/agents/agent-tools/engineering.ts` — github_read expanded (list_issues, list_branches, list_commits)
- [x] `src/agents/system-prompts.ts` — marketing prompt: RESEARCH ONLY workflow added

---

## Deferred — Requires Future Decision 🔶

### D1. Wire Redis or delete it
**What:** Redis has 205 LOC + 2 test files (redis-resilience, quota-enforcement) but zero production callers.  
**Options:**
- A. Wire `incrQuota` into the email/linkedin send paths (makes rule #14 accurate)
- B. Wire `cacheGet`/`cacheSet` into the research tool (reduces Firecrawl spend)
- C. Delete redis.ts + its tests entirely (cleanest, but removes the portfolio signal)
- **Not blocking.** Default: keep gated, revisit when a real use case arrives.

### D2. Activate or delete suppression check (`doNotContact`)
**What:** GDPR suppression table exists but sends are not checked against it.  
**Fix (15 min):** add `isDoNotContact(recipientEmail)` guard in `src/agents/agent-tools/comms.ts` before `send_email` fires.  
**Priority:** Medium — real compliance risk for outbound if the list grows.

### D3. Wire `recordLlmCost` into `src/infra/llm.ts`
**What:** `aiCallCosts` table + `recordLlmCost()` query exist, but nothing writes to it. The health `/metrics` endpoint always returns `spend_today_usd: {turicks: 0}`.  
**Fix (30 min):** call `recordLlmCost()` after each LLM response in `llm.ts`.  
**Priority:** Medium — needed before the cost watchdog agent is useful.

### D4. Collapse wiring layers (tool-add ceremony)
**What:** Adding a tool currently touches 6 files. Could potentially collapse the `agent-tools/{dept}.ts` wrapper + barrel re-export into a single self-registering tool descriptor.  
**Priority:** Low — 4 of 6 layers are load-bearing. Only worthwhile if adding tools frequently.

### D5. Delete `feat/test-coverage-and-new-tools` branch
**What:** Branch is obsolete — all its content is in `feat/qa-production-hardening`.  
**When:** After `feat/qa-production-hardening` is merged to main.  
```bash
git branch -d feat/test-coverage-and-new-tools
git push origin --delete feat/test-coverage-and-new-tools  # if pushed
```

---

## Confirmed NOT Over-Engineered ✅

| Decision | Evidence |
|---|---|
| Supervisor pattern | Anthropic recommends routing for distinct tool categories |
| 7 departments | Each owns distinct tools; ADR-013 provides security rationale |
| Postgres checkpointer | Crash-safe HITL — only alternative loses pending approvals on restart |
| HITL via `interrupt()` | Strongest portfolio signal; correctly implemented |
| Single-instance PID lock | Fixed the #1 real production bug (stacked procs + lost approvals) |
| 503 fallback | Fixed actual production crashes (Gemini high-demand spikes) |
| Workflow/SOP engine | Endorsed by Anthropic: deterministic workflows for predictable tasks |
