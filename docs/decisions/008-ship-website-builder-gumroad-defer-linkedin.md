# ADR-008: Ship Website-Builder + Gumroad Packs; Defer LinkedIn

**Date**: 2026-06-01
**Status**: Accepted

## Context

Turicks is starting the agency → SaaS transition. Three product candidates were evaluated: (A) LinkedIn automation SaaS, (B) `cinematic-web` website builder, (C) Gumroad automation packs. The owner set a **one-week** sprint horizon and wants real revenue + light stabilization, not a rewrite.

## Decision

1. **Ship B + C this week via Gumroad.** Sell `cinematic-web` premium presets as digital products, alongside 2–3 FounderOS automation packs. Gumroad is the single, fast monetization vehicle.
2. **Defer A (LinkedIn automation).** Outreach via LinkedIn APIs carries account-ban risk. No build until a dedicated research pass (ADR-009) clarifies a safe, compliant approach.
3. **Do NOT build the full Cinematic Cloud SaaS now.** Its own `PHASE-3-SAAS.md` estimates 144h / 12 weeks — out of scope for a week. Monetize the existing CLI/presets instead.
4. **Stabilize lightly.** Fix the tenant-leaking LLM cache key (done). Defer cascade-tier collapse, agent cleanup, and agent activation to backlog.

## Rationale

- Fastest path to first revenue + market validation with lowest risk and effort (packaging existing assets).
- Avoids the ban risk of LinkedIn outreach automation until it's understood.
- Avoids a 12-week SaaS build inside a 1-week window.
- Keeps FounderOS stable without a disruptive refactor that competes with shipping.

## Consequences

- Revenue is one-time (Gumroad) initially, not recurring — acceptable for validation; recurring SaaS is a later phase.
- Two repos (`website-builder-tool`, `founderos`) + `turicks-web` get touched; each on a feature branch.
- The LinkedIn opportunity is paused, not abandoned (ADR-009 decides its fate).
- The full Cinematic Cloud SaaS remains a planned future phase.
