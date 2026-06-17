# Turicks — One-Week Ship Sprint Strategy

> Date: 2026-06-01 · Status: Active · Source for turicks-brain sync

## The Decision

A one-week sprint to start the agency → SaaS transition by **monetizing what already exists**, not building new SaaS infrastructure.

- **Ship this week:** `cinematic-web` (website builder) premium presets + FounderOS automation packs — both via **Gumroad** (one vehicle, fast cash, validation).
- **Defer:** LinkedIn automation product — outreach via LinkedIn APIs risks account bans; gated on dedicated research (ADR-009).
- **Stabilize lightly:** fix the one real FounderOS bug (tenant-leaking LLM cache key); everything else (tier collapse, agent cleanup/activation) is deferred backlog.

## Why this, not the alternatives

Architecture review (code-grounded) verdict: the FounderOS spine is solid; the system's issue is breadth (35 declared agents, ~16 wired), not depth. The only real *bug* was a non-tenant-namespaced LLM cache key (now fixed). So heavy refactoring was deliberately deferred — it competes with shipping, and the user goal is revenue + stabilize, not a rewrite.

`cinematic-web`'s own `PHASE-3-SAAS.md` prices the full "Cinematic Cloud" SaaS at **144h / 12 weeks** — impossible in a week. But the tool already works (CLI + 6 presets + npm). The week-sized play is selling premium presets as digital products. This merges with the "Gumroad packs" option into a single coherent sprint.

## Research synthesis (analyst — live web data to be appended post session-reset)

### Product ranking (original 3 candidates)
| Candidate | Verdict |
|---|---|
| A — LinkedIn automation SaaS | **Deferred.** Engine mostly built + fast to revenue, BUT outreach automation = LinkedIn ToS/ban risk. Needs research (ADR-009) before any build. |
| B — Website builder (`cinematic-web`) | **Ship (monetize presets now).** Mature tool; full SaaS is a separate 12-week phase. Hard SaaS market vs v0/Lovable/Framer, but premium-preset packs are a fast, low-risk first revenue. |
| C — Gumroad automation packs | **Ship.** Lowest effort, fastest cash, validation + audience. Same vehicle as B's presets. |

### Monetization
- One-time (Gumroad) = fast validation + audience + cash; recurring SaaS = the real business later. Use the former to fund/validate the latter.
- Website-builder pricing (premium preset pack): one-time $29–49; consider a "done-for-you landing page" service tier.
- Honest year-1 reality for solo micro-SaaS: most $0–2K MRR; 1–5% free→paid; this is a grind. Start with one-time products to learn demand cheaply.

### Client generation (agency cash funds everything)
- Highest-ROI channels: dogfood build-in-public on LinkedIn (manual, no ban risk), productized fixed-price offers, targeted personal outbound (audit/loom), Contra/Upwork inbound, agency partnerships.
- Sharpen positioning with a niche + proof (case studies, build logs). "AI-native, 3–5 day delivery, working code not decks" + vertical.

### Agency → SaaS playbook
- Pattern: services → productized service → SaaS. Find the repeated painful workflow, productize, then SaaS-ify.
- Traps: split focus kills both; unvalidated SaaS; agency buyers ≠ SaaS buyers; underpricing.
- Funding: keep agency ~60–70% of time for cash until SaaS MRR covers costs.

## This week (day-by-day)
- **Day 1:** FounderOS cache-leak fix (done) + this strategy doc + ADR-008 + brain:sync.
- **Day 2–3:** Package `cinematic-web` premium presets → Gumroad (critical path).
- **Day 3–4:** Assemble 2–3 FounderOS automation packs → Gumroad.
- **Day 5:** turicks-web Products section; ADR-009 LinkedIn ban-risk research; wrap.

## Deferred (explicit)
Full Cinematic Cloud SaaS (12-wk plan exists) · LinkedIn product (ADR-009) · FounderOS tier collapse + agent cleanup/activation · self-correcting senior_engineer self-PR (needs 5 guardrails).
