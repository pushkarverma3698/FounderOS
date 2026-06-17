# FounderOS — Roadmap & Strategic Direction

*For Pushkar Verma, Turicks — The Autonomous Studio. Updated: 2026-06-17.*

> 🟢 **PRODUCTION LIVE** since 2026-06-14. Running 24/7 on Hetzner VPS with GitHub Actions auto-deployment. **Architecture is locked.** FounderOS is **internal delivery infrastructure** — studio GTM is the priority.

---

## What FounderOS Is

**A production multi-agent operating system that takes real business actions — safely.**

You message it via Telegram → it routes to the right department → the agent does real work (searches, drafts, sends) → asks for your approval before anything leaves → all actions audited in Postgres.

**In the current strategy:** FounderOS is the **trust/governance moat** for Turicks studio delivery — not the product being sold (yet).

**Key properties:**
- **Production-grade:** 1,098 unit tests (100% green), 29 golden-task eval suite (90% routing), 99.8% uptime
- **Crash-safe HITL:** pending approvals survive process restarts (Postgres checkpointer)
- **Deterministic:** temperature 0, routing in pure code (not prompts)
- **Auditable:** every action logged with idempotency key (no double-sends)
- **Confined:** path-guard prevents file access outside `$HOME`, secrets blocked even on read

---

## Current Status

### Shipped & Locked ✅

**v2 Architecture (7 ReAct departments):**
- research, comms, engineering, marketing, sales, personal, jobhunt

**Phases 1-6 Hardening (complete):**
- Context isolation, typed contracts, Claude-as-judge, dept_signals, hierarchy proof, security rules

**Production Infrastructure:**
- Hetzner VPS, systemd, GitHub Actions CD, Postgres checkpointer, Ollama embeddings, LangSmith telemetry

### Current Work — Phase D-Bis (Proof & Distribution)

> **Supersedes** old Phase D Gumroad-first plan. See [docs/strategy/README.md](strategy/README.md).

| Phase | Focus | Status |
|-------|-------|--------|
| **0 — Foundations** | Strategy docs, target list, brain:sync | 🔄 In progress |
| **1 — Proof** | 3 showcases → proof.turicks.com | Pending |
| **2 — Distribution** | LinkedIn build-in-public (3–5/wk) | Pending |
| **3 — Outreach** | Proof Drops to target list | Pending |
| **4 — Close** | 1 client/month @ ≥$8K | Target: 60–90 days |

**The one metric:** Qualified conversations/month → **1 closed client/month at ≥$8K**.

### What NOT to do (Intentional Defers)

| ❌ Deferred | ✅ Why |
|----------|--------|
| **FounderOS feature building** | SCALE gate — $5K+ banked from client work first |
| **SaaS pivot (Phase E)** | Studio revenue must prove GTM first |
| **Gumroad info packs** | Deprioritized — premium studio, not info products |
| **$500 starter tier** | Retired — commodity signal (ADR-032) |
| **Rearchitect supervisor** | Architecture locked — add tools/hierarchy only when client needs them |

---

## Turicks Business Context

### The Autonomous Studio
- **Category:** AI-native creative + delivery for funded AI/dev-tool startups
- **Solo founder:** Pushkar Verma (~10h/week)
- **ICP:** AI/dev-tool startups (Seed–Series A), $8K+ budget
- **Pricing:** $8K project floor / $5K-mo retainer floor
- **Website:** turicks.com · **Proof hub:** proof.turicks.com (planned)

### FounderOS role
1. **Internal OS** — daily operations for Turicks + Naggar Retreat
2. **Delivery moat** — HITL + eval + audit narrative for studio positioning
3. **Build-in-public content** — real metrics for LinkedIn

---

## Next Phase (Phase E — SaaS Pivot) — DEFERRED

**Prerequisites (re-sequenced):**
- Phase D-Bis: 1+ client closed @ ≥$8K
- SCALE gate: $5K+ banked
- 4+ weeks stable production use

**Scope (unchanged):**
- Multi-tenancy, web gateway, billing
- More integrations (Notion, Slack, Stripe)

**Decision at gate:** FounderOS SaaS *or* continue scaling studio.

---

## Metrics That Matter

**Primary (studio):** 1 closed client/month @ ≥$8K.

**Secondary (FounderOS ops):**
- Uptime (target: 99.5%)
- Eval routing accuracy (target: 90%+)
- Zero data loss on crashes

**Not tracked:** LOC, test count. Only: real work done + revenue.

---

## See Also

- **[docs/strategy/README.md](strategy/README.md)** — **Current GTM strategy (start here for planning)**
- **[docs/phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md](phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md)** — Active phase doc
- **[docs/decisions/032-ai-native-studio-repositioning.md](decisions/032-ai-native-studio-repositioning.md)** — ADR
- **[docs/README.md](README.md)** — Documentation index
- **[docs/guides/DEPLOYMENT.md](guides/DEPLOYMENT.md)** — Production runbook
