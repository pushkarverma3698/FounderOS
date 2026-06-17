# Phase D-Bis — Proof & Distribution

**Status:** Active (started 2026-06-17)  
**Predecessor:** [PHASE-D-REVENUE-FLYWHEEL.md](PHASE-D-REVENUE-FLYWHEEL.md)  
**Strategy:** [docs/strategy/](../strategy/) · [ADR-032](../decisions/032-ai-native-studio-repositioning.md)

---

## Goal

Land **1 client/month at ≥$8K** by proving cinematic launch craft + governed AI delivery — without building new FounderOS departments until SCALE gate.

---

## Phases 0–3 (actionable now)

### Phase 0 — Foundations (Wk 1–2)

- [x] Strategy doc set (`docs/strategy/00`–`05`)
- [x] ADR-032 repositioning
- [x] Brand / FOUNDER-PROFILE / ROADMAP reconcile
- [x] FounderOS prompt + signal wiring (Steps 2–3)
- [ ] 30-account AI/dev-tool target list (founder)
- [ ] `pnpm brain:sync`

**Gate:** Docs consistent; brain synced.

### Phase 1 — Proof (Wk 2–6)

- [ ] Showcase 1: AgentOps Dashboard → `proof.turicks.com/showcase-1`
- [ ] Showcase 2: DevTool CLI → `/showcase-2`
- [ ] Showcase 3: FounderOS Live → `/showcase-3`
- [ ] ≥1 award submission (Godly/Awwwards/Land-book)

**Gate:** 3 showcases live.

### Phase 2 — Distribution (Wk 3+ ongoing)

- [ ] LinkedIn cadence 3–5 posts/week (via `marketing` + HITL)
- [ ] Document real FounderOS metrics in posts
- [ ] Gumroad: 4 packs listed (founder manual)

**Gate:** 4+ weeks consistent cadence.

### Phase 3 — Outreach (Wk 6+)

- [ ] Proof Drops 2–3/week (`research` → build → `sales` HITL)
- [ ] Track `lead_discovered`, `design_brief_ready`, `site_deployed` signals

**Gate:** 3–5 qualified conversations/month.

---

## FounderOS Integration (minimal)

| Capability | Implementation |
|------------|----------------|
| Lead research | `research` + `lead_discovered` signal |
| Copy | `marketing` + turicks-brain brand docs |
| Build | `engineering` + `claude_code` (HITL) |
| Outreach | `sales` + `send_email` (HITL) |
| Brief handoff | `design_brief_ready` signal → engineering |
| Deploy notify | `site_deployed` signal → sales |

---

## Deferred to SCALE Gate

See [04-EXECUTION-ROADMAP.md](../strategy/04-EXECUTION-ROADMAP.md) Step 5:

- `gen_asset` tool
- MCP client to `cinematic-web` repo
- `studio` / `discovery` / `portal` departments
- `outreach` / `payments` departments (Stripe/Gumroad webhooks)

**Trigger:** $5K+ banked OR first paying client closed.

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Showcases live | 3 |
| Qualified convos/month | 3–5 |
| Closed clients/month | 1 at ≥$8K |
| Gumroad MRR (passive) | Nice-to-have; not primary |

---

## References

- [05-SHOWCASE-BRIEF.md](../strategy/05-SHOWCASE-BRIEF.md)
- [03-GTM-ACQUISITION-ENGINE.md](../strategy/03-GTM-ACQUISITION-ENGINE.md)
- [PHASE-D-REVENUE-FLYWHEEL.md](PHASE-D-REVENUE-FLYWHEEL.md) (parent phase)
