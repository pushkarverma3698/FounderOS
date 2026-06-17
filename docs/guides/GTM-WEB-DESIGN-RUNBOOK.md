# GTM Runbook — Cinematic Launch Experience

> **Type:** guide · **Status:** Active (2026-06-17)  
> **Strategy:** [docs/strategy/](../strategy/) · **Phase:** [PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md](../phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md)

Operational checklist for executing the web design service GTM via FounderOS (mostly founder actions; bot assists).

---

## 1. Gumroad Listing (founder manual)

Products packaged 2026-06-01 (see CASE-STUDY-LOG):

| Product | Price | Zip location |
|---------|-------|----------------|
| cinematic-web Cinematic Premium Pack | $29 | project root / gumroad-packs |
| Prospecting & ICP Scoring Pack | $19 | same |
| Brand-Voice Critique Kit | $14 | same |
| LangGraph Multi-Agent Starter | $34 | same |

**Steps:**
1. Create 4 Gumroad products at gumroad.com
2. Upload zips, set prices
3. Replace placeholder URLs in `turicks-web` `app/products/page.tsx`
4. Post launch via FounderOS: `/q marketing Draft LinkedIn post announcing Gumroad packs`

---

## 2. Proof Showcases (founder + engineering dept)

See [05-SHOWCASE-BRIEF.md](../strategy/05-SHOWCASE-BRIEF.md).

**Telegram prompts (examples):**
```
/q engineering Build showcase 1 — AgentOps fictional AI observability landing using cinematic-web neon preset. Deploy to proof.turicks.com/showcase-1
/q marketing Write hero copy for AgentOps showcase — cinematic launch experience tone
/q marketing Draft LinkedIn BUILD_LOG post about showcase 1 with deploy URL and FounderOS metrics
```

**Checklist per showcase:**
- [ ] Live URL
- [ ] LinkedIn post (HITL approved)
- [ ] CASE-STUDY-LOG entry
- [ ] Award submission (after all 3 live)

---

## 3. Target List (30 accounts)

**Criteria:** AI/dev-tool, seed–Series A, weak/generic site, recent funding or launch.

**FounderOS assist:**
```
Find 10 AI dev-tool startups that raised seed funding in the last 6 months and might need a cinematic launch page
```

Record in founder context via `record_event` or spreadsheet; sync notes to turicks-brain.

---

## 4. Proof Drop Cadence (2–3/week)

**Workflow:**

| Step | Dept | Telegram example |
|------|------|------------------|
| 1. Research | research | `Find details on [Company] — AI dev-tool, launch site quality` |
| 2. Build artifact | engineering | `Build Proof Drop hero for [Company] forking showcase-1 aesthetic` |
| 3. Outreach | sales | `Draft Proof Drop email to [founder@company] — link https://proof.turicks.com/drops/[company]` |

All sends HITL-gated. Track signals: `lead_discovered`, `site_deployed`.

---

## 5. Weekly Rhythm

| Day | Action |
|-----|--------|
| Monday | Review `list_pending_signals`; plan Proof Drops |
| Tue–Thu | Build showcase or Proof Drop |
| Wed + Fri | LinkedIn post (marketing, HITL) |
| Friday | Metrics check: convos started, replies |

---

## 6. FounderOS Commands Quick Reference

```
/q research Find AI startups needing cinematic launch sites
/q sales Draft Proof Drop outreach to [Company] with demo URL
/q marketing Draft LinkedIn post about [showcase]
/q engineering Build cinematic landing for [Client] using [preset] preset
```

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Gumroad live | 4 products |
| Showcases | 3 on proof.turicks.com |
| Proof Drops/week | 2–3 |
| Qualified convos/month | 3–5 |
| Closed client | 1 at ≥$8K |
