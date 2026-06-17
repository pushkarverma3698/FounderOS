# GTM Acquisition Engine

> **Type:** strategy · **Status:** Active (2026-06-17)

---

## Channel Priority (solo operator)

| Priority | Channel | Why | Cadence |
|----------|---------|-----|---------|
| 1 | Founder-led LinkedIn build-in-public | 14.6% inbound vs 1.7% outbound; personal profile 5–10× company page | 3–5 posts/week |
| 2 | Proof Drops | Trigger-based custom artifacts to 30-account target list | 2–3/week |
| 3 | Referrals | 3–5× conversion vs cold | Systematize after client #1 (10% bonus) |
| 4 | Awards (Awwwards/Godly/Land-book) | Cheapest credential for solo studio | Submit after 3 showcases live |
| 5 | Gumroad packs | Passive + lead magnet | List once; promote in LinkedIn |

**Deprioritized:** High-volume cold outbound, LinkedIn automation (ADR-009 ban risk), paid ads ($0 budget).

---

## Proof Drop Playbook

1. **Research** (`research` dept): Identify AI/dev-tool startup from target list; `publish_signal` `lead_discovered` with `fit: cinematic-web`
2. **Build** (`marketing` → `engineering`): Hero + cinematic preset mock for *their* product name
3. **Outreach** (`sales` dept): Email ≤150 words, pain-first, attach link to artifact — HITL approve
4. **Follow-up**: If reply → book call; if no reply → one follow-up at day 7

**FounderOS commands (examples):**
- "Find AI dev-tool startups that raised seed in last 6 months"
- "Draft Proof Drop outreach for [Company] with link to [demo URL]"
- "Write LinkedIn post about building [showcase] with FounderOS metrics"

---

## LinkedIn Content Pillars

| Pillar | Example topics |
|--------|----------------|
| FounderOS build log | HITL, eval scores, real token/$ metrics |
| Showcase builds | Before/after, preset used, deploy URL |
| Industry POV | Why governed AI delivery beats vibe coding |
| Client wins | Case study (after client #1) |

---

## Target List

- **Size:** 30 accounts (Phase 0)
- **Criteria:** AI/dev-tool, seed–Series A, recent launch or funding, weak/generic current site
- **Storage:** `turicks-brain` + founder context; update via `record_event`

---

## Awards Strategy

After 3 showcases on `proof.turicks.com`:
1. Submit best piece to Godly (fastest feedback loop)
2. Awwwards SOTD attempt on strongest 3D/motion piece
3. Land-book for static gallery credit

Document submission dates in CASE-STUDY-LOG.

---

## Metrics

| Leading (30–45 days) | Target |
|----------------------|--------|
| Showcases live | 3 on proof.turicks.com |
| Award submissions | ≥1 |
| LinkedIn cadence | 3–5/wk for 4+ weeks |
| Target list | 30 accounts |

| Lagging (60–90 days) | Target |
|----------------------|--------|
| Qualified conversations/month | 3–5 |
| Closed clients/month | 1 at ≥$8K |
