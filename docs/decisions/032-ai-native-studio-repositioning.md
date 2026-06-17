# ADR-032: AI-Native Studio Repositioning

**Date:** 2026-06-17  
**Status:** Accepted  
**Supersedes (in part):** Stale ICP/pricing in `.claude/brand/TURICKS.md`, `docs/FOUNDER-PROFILE.md`  
**Context:** [2026-06-17-LATEST-SESSION-PLAN](../plans/2026-06-17-LATEST-SESSION-PLAN.md), [docs/strategy/](../strategy/)

---

## Context

Turicks is pre-revenue, solo (~10h/week). FounderOS is production-grade (1,000+ tests, HITL, eval). Two strategic directions conflicted:

1. **Phase D Revenue Flywheel** — cinematic-web DFY, optional new depts, Gumroad
2. **Autonomous Studio plan** — positioning + proof first; defer FounderOS builds until paying client

Brand docs still reflected generic SME ICP ($50–500K ARR) and $500 starter tier.

---

## Decision

1. **Positioning:** "The Autonomous Studio" — AI-native delivery (Pillar A) + cinematic design finish (Pillar B). Design is anti-slop layer, not headline.

2. **ICP:** AI / dev-tool startups (seed–Series A). Deprioritize generic SME automation ICP.

3. **Pricing:** $8K project floor; $5K/mo retainer. **Retire $500 starter.**

4. **Web design service SKU:** "Cinematic Launch Experience" powered by `cinematic-web` — routed through existing `marketing` + `engineering` + `sales` departments. No `web_designer` agent in v2.

5. **FounderOS build appetite:** **Hybrid minimal** — prompt/routing + signal wiring only. No new departments, MCP bridge, or `studio` dept until SCALE gate ($5K+ banked or first paying client).

6. **GTM:** Proof Drops + build-in-public + 3 showcases on `proof.turicks.com`. Gumroad packs remain passive tier.

---

## Rationale

- YC Spring-2026 RFS validates AI-native agency model (finished work, software margins).
- AI commoditizes building; trust/governance/taste/distribution are the moat — FounderOS already has trust layer.
- Solo operator cannot sustain 70% building / 3 new depts; 70% positioning/proof fits reality.
- Triple-filter (ADR-014): Steps 2–3 (prompts + signals) pass; Step 5 (MCP/studio) deferred.

---

## Consequences

- Update brand guidelines, FOUNDER-PROFILE, ROADMAP, BRAND.md pointer.
- `docs/strategy/*` becomes authoritative for GTM; brain-sync required.
- Phase D optional `outreach`/`payments` depts deferred to SCALE gate.
- STRATEGIC-VISION MCP product-team path documented as Step 5, not now.

---

## References

- [00-VISION-AUTONOMOUS-STUDIO.md](../strategy/00-VISION-AUTONOMOUS-STUDIO.md)
- [ADR-008](008-ship-website-builder-gumroad-defer-linkedin.md)
- [PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md](../phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md)
