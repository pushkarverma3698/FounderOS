# FounderOS — Roadmap & Strategic Direction

*For Pushkar Verma, Turicks AI Agency. Updated: 2026-06-17.*

> 🟢 **PRODUCTION LIVE** since 2026-06-14. Running 24/7 on Hetzner VPS with GitHub Actions auto-deployment. **Architecture is locked.** Next work: add tools and hierarchy only.

---

## What FounderOS Is

**A single-user AI operating system that takes real business actions — safely.**

You message it via Telegram → it routes to the right department → the agent does real work (searches, drafts, sends) → asks for your approval before anything leaves → all actions audited in Postgres.

**Key properties:**
- **Production-grade:** 1,098 unit tests (100% green), 29 golden-task eval suite (90% routing), 99.8% uptime
- **Crash-safe HITL:** pending approvals survive process restarts (Postgres checkpointer)
- **Deterministic:** temperature 0, routing in pure code (not prompts)
- **Auditable:** every action logged with idempotency key (no double-sends)
- **Confined:** path-guard prevents file access outside `$HOME`, secrets blocked even on read

---

## Current Status (Phase D — Revenue Flywheel)

### Shipped & Locked ✅

**v2 Architecture (7 ReAct departments):**
- research [search_web, search_knowledge]
- comms [send_email, read_emails]
- engineering [github_read, github_write, claude_code]
- marketing [linkedin_post]
- sales [search_web, send_email]
- personal [file, shell, browser, write_file]
- jobhunt [search_jobs, read_cv, send_email]

**Phases 1-6 Hardening (complete):**
- Phase 1: Context isolation + per-turn token measurement
- Phase 2: Typed inter-department contracts (dept_signals, Zod validation)
- Phase 3: Claude-as-judge quality gate (two-gate system: brand-validator → Claude judge)
- Phase 4: Durable async signals (Postgres dept_signals table, hourly sweep)
- Phase 5: Hierarchy proof (nested HITL on prebuilt supervisors, 3-level interrupt/resume proven)
- Phase 6: Security rules operationalized (context isolation + typed handoffs enforced)

**Production Infrastructure:**
- Hetzner VPS, systemd service, GitHub Actions CD pipeline
- Postgres checkpointer (Postgres-backed LangGraph state)
- Redis for caching and quotas
- Ollama for local embeddings
- LangSmith for telemetry and cost tracking

### Current Work (Phase D-Bis — Proof & Distribution)

1. **Cinematic Launch Experience** — web design service via existing depts (marketing + engineering + sales)
2. **3 proof showcases** → `proof.turicks.com` (see `docs/strategy/05-SHOWCASE-BRIEF.md`)
3. **Proof Drops + LinkedIn build-in-public** — 2–3 custom artifacts/week to AI/dev-tool target list
4. **FounderOS wiring** — prompts, `design_brief_ready` / `site_deployed` signals (ADR-032)

Strategy: [docs/strategy/](strategy/) · Phase doc: [PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md](phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md)

### What NOT to do (Intentional Defers)

| ❌ Deferred | ✅ Why |
|----------|--------|
| **SaaS pivot** | Gated on 4+ weeks stable production use — achieve that first, then multi-tenancy |
| **Rearchitect supervisor** | Architecture is locked — only add tools and hierarchy from now on |
| **Budget guard npm package** | Deprioritized for core reliability — can extract later |
| **Real RAG (pgvector)** | brain_sync covers 90% of use case — upgrade when semantic search matters |
| **Safari-MCP browser** | Deferred in ADR-012; personal.browser works fine for current use |
| **Multi-provider cascade** | One good model (Gemini 2.5 Flash) > custom cascade — OpenRouter fallback for 503s |

---

## Next Phase (Phase E — SaaS Pivot) — DEFERRED

**Prerequisite:** 4+ weeks of stable production use (Phases D must deliver real revenue signal first).

**Scope:**
- Multi-tenancy: auth layer (Clerk/Auth.js), per-user Composio entities, billing (Stripe/Lemon)
- Web interface: Next.js app on app.turicks.com, real-time streaming, audit dashboard
- More tools: Notion, Slack, Stripe, Airtable integrations

**Estimated:** 4-6 weeks of real work. Not started until Phase D proves the product.

---

## Metrics That Matter

**Primary:** Actions taken per week (emails, GitHub issues, LinkedIn posts, searches).

**Secondary:**
- Uptime (target: 99.5%)
- P95 response latency (<3s for real-time actions)
- Eval routing accuracy (target: 90%+)
- Test coverage (target: 80%+ on new code)
- Zero data loss on crashes (Postgres checkpointer)

**Not tracked:** LOC, test count, model family count. Only: real work done.

---

## How to Contribute

1. **Read** [docs/README.md](README.md) — master index of all docs
2. **Follow** [docs/rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) — wiring maps for adding tools/hierarchy
3. **Write tests first** — [docs/rules/TESTING-RULES.md](rules/TESTING-RULES.md) for patterns
4. **Run** `pnpm test` to verify green
5. **Create PR** against `main` (human reviews before merge)

---

## Business Context

### Turicks (The Autonomous Studio)
- Solo founder: Pushkar Verma
- ICP: AI/dev-tool startups (seed–Series A)
- Revenue model: $8K+ Cinematic Launch Experience, $5K/mo retainer, Gumroad packs
- Website: turicks.com · Proof gallery: proof.turicks.com (planned)

### Products on FounderOS
1. **FounderOS** (delivery OS → SaaS Phase E)
2. **Cinematic Web** (`cinematic-web` — Gumroad presets → DFY tier → SaaS deferred)
3. **Gumroad packs:** ICP kit, brand-voice kit, LangGraph starter, cinematic premium pack

---

## See Also

- **[Root README.md](../README.md)** — What it does, architecture, eval results
- **[docs/README.md](README.md)** — Documentation index
- **[docs/guides/DEPLOYMENT.md](guides/DEPLOYMENT.md)** — Production runbook
- **[docs/decisions/](decisions/)** — All architecture decisions (ADRs 001–032+)
- **[docs/strategy/](strategy/)** — Autonomous Studio GTM + web design service
- **[docs/study/](study/)** — Learning path (foundations → deep dive → lessons)
- **[LIMITATIONS.md](LIMITATIONS.md)** — Honest tech-debt and deferred work
