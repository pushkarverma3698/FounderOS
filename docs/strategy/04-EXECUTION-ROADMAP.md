# Execution Roadmap

> **Type:** strategy · **Status:** Active (2026-06-17)  
> **Constraints:** Solo, ~10h/week, ~$0 budget

---

## Phased Roadmap

| Phase | Window | Focus | Gate |
|-------|--------|-------|------|
| **0 — Foundations** | Wk 1–2 | Strategy docs, brand reconcile, 30-account target list | Docs + list done |
| **1 — Proof** | Wk 2–6 | 3 showcase launch experiences → `proof.turicks.com` | 3 live + ≥1 award submission |
| **2 — Distribution** | Wk 3+ ongoing | LinkedIn build-in-public (3–5/wk) | 4+ weeks cadence |
| **3 — Outreach** | Wk 6+ | Proof Drops (2–3/wk) via FounderOS sales path | 3–5 qualified convos/mo |
| **4 — Close** | After client #1 | Deliver, case study, referral system | 1 closed ≥$8K |
| **SCALE** | $5K+ banked | `gen_asset`, MCP bridge, optional `studio` dept | Money in |

---

## Weekly Cadence (Phase 2–3)

| Day | Activity |
|-----|----------|
| Monday | Plan week; optional Gumroad/marketing email via `marketing` dept |
| Tue–Thu | Build showcase or Proof Drop (`engineering` + `marketing`) |
| Wed/Fri | LinkedIn post (build log or showcase) — HITL `linkedin_post` |
| Friday | Review signals (`list_pending_signals`); queue next week's targets |

---

## FounderOS Wiring (this integration)

| Step | Status | What |
|------|--------|------|
| 1 | Done in this PR | Strategy docs + brand reconcile |
| 2 | Done in this PR | Supervisor/marketing/sales prompts + eval golden tasks |
| 3 | Done in this PR | `design_brief_ready` + `site_deployed` signals |
| 4 | Founder manual | Gumroad list, showcases deploy, Proof Drop cadence |
| 5 | Deferred | MCP, `gen_asset`, `studio` dept — SCALE gate |

---

## FounderOS Department Map (web design service)

```
Request type                    → Department
─────────────────────────────────────────────
Find leads / ICP research       → research (+ lead_discovered signal)
Landing copy / brand post       → marketing
Build / deploy site             → engineering (claude_code, HITL)
Cold outreach / follow-up       → sales (send_email, HITL)
Design brief handoff            → design_brief_ready signal → engineering
Site live notification          → site_deployed signal → sales
```

No new department until SCALE gate (ADR-032).

---

## Success Criteria Summary

| Metric | Target | By |
|--------|--------|-----|
| Strategy docs + brain sync | Complete | Wk 2 |
| Showcases live | 3 | Wk 6 |
| Gumroad listed | 4 packs | Wk 2 |
| Qualified convos/month | 3–5 | Wk 10+ |
| Closed client | 1 at ≥$8K | Wk 12+ |

---

## References

- [00-VISION-AUTONOMOUS-STUDIO.md](00-VISION-AUTONOMOUS-STUDIO.md)
- [05-SHOWCASE-BRIEF.md](05-SHOWCASE-BRIEF.md)
- [PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md](../phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md)
- [ADR-032](../decisions/032-ai-native-studio-repositioning.md)
