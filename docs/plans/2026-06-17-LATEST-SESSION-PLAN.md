# Turicks × FounderOS — Strategic Repositioning & GTM Plan
## "The Autonomous Studio" — an AI-native studio for AI/dev-tool startups

> Plan type: **strategy + documentation** (NOT a code build). The "execution" after
> approval is writing the strategy document set + standing up the go-to-market motion.
> FounderOS feature-building is explicitly **deferred** until a paying client needs it.

---

## Context (why this exists)

Turicks is pre-revenue, **solo (~10h/week, ~$0 budget)**, but already owns a rare asset:
**FounderOS**, a production multi-agent OS (live, ~1,098 tests, HITL + eval + audit). The
founder wants to evolve Turicks into a top-tier creative + dev + AI studio and build a
**repeatable way to land high-ticket clients**. The bar is modest and freeing: **≥1 client
/month = $96–240K/yr solo — more than enough.**

A first strategy pass (Modules 1–4) was produced last session. This plan **corrects its
emphasis** using 2026 market research and **locks the direction**.

### Decisions locked this session
| Fork | Decision |
|---|---|
| **Positioning** | **AI-native studio + design as the anti-commoditization *finish*** (NOT equal-pillar; NOT design-led) |
| **Niche** | **AI / dev-tool startups** (funded; need a launch experience that proves they're cutting-edge) |
| **Team** | **Effectively solo** — founder executes + learns/builds the design craft himself |
| **Revenue goal** | Premium brand build (3–6 mo) + career signal; **1 client/month is sufficient** |

### Research basis (2026, cited in chat)
- **YC Spring-2026 RFS** explicitly backs the "AI-native agency": sell *finished work*, not
  software — software margins, agency results. → Turicks's core thesis is market-validated.
- **AI commoditizes *building*** (41% of code now AI-generated; vibe coding $4.7B). Value
  moved to what AI can't commodify: **trust/governance, taste, distribution, outcomes.**
- **FounderOS already *is* the trust/governance moat** (HITL + eval + audit) — the antidote
  to ungoverned "vibe-coded slop" (AI code: ~45% OWASP-vuln rate). This is the wedge, not 3D.
- **Acquisition channels that fit a solo operator:** referrals (3–5× conversion) →
  systematize after client #1; **founder-led LinkedIn / build-in-public** (inbound 14.6% vs
  1.7% outbound; personal profile beats company page 5–10×) = the #1 channel; **low-volume,
  high-craft trigger-based "Proof Drops"** = pipeline. Niche down. Sell outcomes, not hours.
- **Awards** (Awwwards/Godly/Land-book) = the cheapest credential a solo studio can earn.

---

## The locked strategy (one page)

**Category:** *The Autonomous Studio* — "We design the experience. Our own AI OS runs the
delivery — governed, audited, and watchable."

- **Pillar A — LEAD: AI-native delivery on FounderOS.** Trust/governance moat (HITL, eval,
  idempotent audit). The YC-validated, hard-to-copy core.
- **Pillar B — FINISH: immersive/cinematic design craft.** The anti-slop layer that makes
  output non-generic. **Built via self-initiated showcase pieces — shown, never *claimed*.**
- **Wedge: AI / dev-tool startups.** Buyers who *get* the moat, where the founder's
  build-in-public audience already lives, and where FounderOS itself is the reference demo.
- **Moat narrative:** *"Beautiful product, shipped by an AI studio you can trust and watch."*
- **Pricing:** floor **$8K project / $5K-mo retainer**; sell outcomes; **retire the $500
  starter** as an anchor (it signals commodity).
- **The one metric:** qualified conversations/month → **1 closed client/month.**

---

## Approach correction (vs the first blueprint)

| First blueprint | Corrected |
|---|---|
| Equal-pillar fusion (design = headline) | Design = the *finish*; AI-native studio = the headline |
| ~70% building (3 new depts + scout + portal) | **~70% positioning/proof/distribution, ~30% build** |
| 5 Proof Drops/week (volume) | **Low-volume, high-craft** — a few *exceptional* artifacts |
| Generic ICP ($50–500K ARR, EU/US) | **Sharp niche: AI/dev-tool startups** |
| Build discovery/studio/portal now | **Defer** all FounderOS depts until a paying client needs them |

---

## Phased roadmap (realistic at solo / 10h-wk / $0)

| Phase | Window | Focus | Gate to advance |
|---|---|---|---|
| **0 — Foundations** | Wk 1–2 | Write the doc set; lock positioning/niche; build a 30-account target list | Docs done + target list |
| **1 — Proof** | Wk 2–6 | **3 showcase pieces** = $10K-grade AI/dev-tool launch experiences → `proof.turicks.com` → submit to Awwwards/Godly/Land-book | 3 showcases live + ≥1 award submission |
| **2 — Distribution** | Wk 3+ (ongoing) | **Founder-led build-in-public** on LinkedIn (3–5/wk): document FounderOS + showcase builds + real metrics | Cadence running 4+ wks |
| **3 — Outreach** | Wk 6+ | **Proof Drops**: 2–3 custom artifacts/wk to the target list (built via FounderOS) | 3–5 qualified convos/mo |
| **4 — Close + referrals** | after client #1 | Deliver; systematize referrals (10% bonus); turn delivery into a case study | 1 client closed |
| **SCALE gate** | money in | *Only then* build FounderOS delivery depts + consider paid/contractors | $5K+ banked |

---

## Deliverables — the document set (this phase's actual work)

Created under repo conventions, brain-synced (rule #18). Content drafted in-session, inline.

```
docs/strategy/
  00-VISION-AUTONOMOUS-STUDIO.md     — north star, category, moat narrative
  01-POSITIONING-AND-NICHE.md        — AI-native-studio positioning + AI/dev-tool wedge + messaging
  02-OFFER-AND-PRICING.md            — offer ladder, $8K floor, value-based/hybrid pricing
  03-GTM-ACQUISITION-ENGINE.md       — channels: build-in-public + Proof Drops + referrals + awards
  04-EXECUTION-ROADMAP.md            — the phased roadmap + weekly cadence + success metrics
  05-SHOWCASE-BRIEF.md               — the 3 showcase pieces: concept, scope, award-submission plan
docs/decisions/
  029-ai-native-studio-repositioning.md  — ADR locking positioning/niche/team reality
docs/phases/
  PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md  — first actionable phase doc (Phases 0–3 above)
```

### FounderOS — deferred build list (captured, NOT now; triple-filtered)
Build only when a paying client needs it. Each reuses existing muscle:
- **Proof Drop engine** (`scout` workflow) — reuses `search_web`, sales ICP scorer,
  `claude_code`, `github` (Phase 3 trigger).
- **`gen_asset` tool** (text→image/3D) — unlocks the design pipeline (Phase 1+ helper).
- **discovery / studio / portal departments** — only post-first-client (SCALE gate).

---

## Critical files

- **New:** the 8 docs listed above (`docs/strategy/*`, `docs/decisions/029-*`,
  `docs/phases/PHASE-D-BIS-*`).
- **Update:** `docs/BRAND.md` + `~/.claude/brand-guidelines/TURICKS.md` — replace generic
  "SaaS development partner" positioning with the AI-native-studio line + AI/dev-tool ICP +
  $8K pricing floor; reconcile the stale 7-person "Team" section (now effectively solo).
- **Update:** `docs/FOUNDER-PROFILE.md` + `docs/ROADMAP.md` — reflect the locked direction.
- **Reuse (later, not now):** `src/agents/agent-tools/` (research/sales/engineering), the
  marketing dept content path, `pnpm brain:sync` for memory durability.

---

## Verification / success criteria

- **Docs:** all 8 written, internally consistent, `pnpm brain:sync` run (knowledge_entries
  upserted), committed on a feature branch + PR (never direct to main — repo rule).
- **Leading indicators (30–45 days):** 3 showcases live on `proof.turicks.com`; ≥1 award
  submission; LinkedIn build-in-public cadence live (3–5/wk); 30-account niche target list.
- **Lagging indicator (60–90 days):** 3–5 qualified conversations/month → **1 client closed
  at ≥$8K**. That single number = the strategy working.

---

## Next steps after approval (in order)

1. **Write the 8-document set** (drafted inline so it's copy-paste usable per project rules).
2. **Optional deeper research** (founder's call): best-fit sub-niche *within* AI/dev-tool
   startups + a 20–30 account target list + a showcase reference/mood board.
3. **Stand up the build-in-public cadence** (content calendar via the marketing dept).
4. **NOT now:** any FounderOS feature build — deferred to the SCALE gate.
