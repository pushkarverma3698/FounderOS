# Turicks / FounderOS — Case Study Log

> Append-only record of milestones, decisions, and metrics.
> After 1 year, compile into a public case study.
> All entries go in reverse-chronological order (newest first).

---

## 2026-06-01 — One-Week Sprint: All 4 Gumroad Products Assembled + turicks-web Updated

**Milestone**: Sprint complete — 4 revenue-ready digital products packaged + live website updated.

**Products shipped (ready for Gumroad listing):**
- `cinematic-web` Cinematic Premium Pack ($29) — 3 exclusive presets + AI build prompts + launch guide
- Prospecting & ICP Scoring Pack ($19) — 4 prompts, ICP rubric, n8n + LangGraph workflow guide
- Brand-Voice Critique Kit ($14) — TS + Python validators (zero deps) + LLM critique prompt + channel rules
- LangGraph Multi-Agent Starter ($34) — sanitized FounderOS skeleton, 13 tests, all architecture decisions documented

**turicks-web**: Digital Products section added to `/products` page — 4 cards with pricing, buy buttons (placeholder URLs, replace with live Gumroad after listing).

**ADR-009**: LinkedIn automation deferred — ban risk analysis complete, criteria defined for re-evaluation.

**FounderOS**: `gumroad-packs/` dir gitignored; 3 individual zips ready at project root.

**Next step (yours):** Create 4 Gumroad products, upload the 4 zip files, set prices, replace `turicks.com` placeholder URLs in `app/products/page.tsx` with real Gumroad links.

---

## 2026-06-01 — One-Week Ship Sprint Kicked Off (agency → SaaS start)

**Milestone**: First revenue motion decided + foundation bug fixed.

**Decisions** (ADR-008): Ship `cinematic-web` premium presets + FounderOS automation packs via Gumroad this week. Defer LinkedIn automation (ban risk → ADR-009 research). Defer full Cinematic Cloud SaaS (12-wk phase). Stabilize lightly.

**Done**:
- Architecture review completed (verdict: stabilize; spine solid; breadth not depth is the issue).
- Fixed tenant-leaking LLM cache key (`KEYS.llmCache` → `llm:{tenant}:{hash}`), TDD, +6 isolation tests (186 total green).
- Strategy doc + ADR-008 written; synced to turicks-brain.

**Method note**: brainstorming + architecture review + deep-research (analyst synthesis; live web re-run queued post session-reset).

---

## 2026-06-01 — Brand Guidelines + Strategic Vision Established

**Milestone**: First formal brand guidelines document created for Turicks.

**What was done**:
- Created `~/.claude/brand-guidelines/TURICKS.md` — global brand doc (voice, tone, ICP, channel rules, banned phrases, token economy rules)
- Created `docs/architecture/STRATEGIC-VISION.md` — 6-pillar strategic vision synthesising all founding instructions
- Added Brand Voice section to `governance/critique-rules.md` — agents now enforce brand rules at runtime
- Wrote ADR-006 (auth strategy: Composio internal + Google OAuth SaaS)
- Wrote ADR-007 (gateway-agnostic architecture: Telegram now, web app next)
- Started Phase 3 tracking doc: social pod + senior engineering agent

**Key decisions**:
- turicks-brain = brand/ops DB (Postgres in founderos) — kept strictly separate from personal-rag
- Token economy as Pillar 0: every agent defaults to nano tier, batch social content, Ollama for extraction
- Gateway-agnostic architecture: business logic in pods, gateways are pure transport
- Personal → SaaS pipeline: build for self first, extract when validated

**Metrics at this point**:
- Phases complete: 1A, 1B, 1C, 1D, 2A, 2B, 2C, 2D, 2E
- Agents in registry: (to fill from registry)
- Active departments: sales, engineering, marketing, prospecting
- Infrastructure: Postgres + Redis + Telegram + LangSmith

---

## Earlier Milestones

_(retroactively add from PROGRESS.md and phase docs)_

- Phase 2E (2026-05-31): Engineer agents per department — eng_engineer, sales_engineer, mktg_engineer live
- Phase 5 critical fixes (2026-05-31): Migration drift, CEO routing, graph crash, anti-sycophancy all fixed
- Phase 2D: Observability + docs
- Phase 2C: Suppression + quota safety rails, LinkedIn tools, scheduler
- Phase 2B: ProspectingPod + /prospect command
- Phase 2A: Redis + caching layer
- Phase 1D: Tests + evals
- Phase 1C: Telegram bot, HITL callbacks
- Phase 1B: Supervisor, sales pod, critic
- Phase 1A: Foundation — config, types, DB schema, infra layer
