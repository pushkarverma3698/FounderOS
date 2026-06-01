# Phase D — Revenue Flywheel

**Goal:** Turn the shipped assets (Gumroad products, cinematic-web, FounderOS) into a repeatable motion that produces real *actions per week* — the one metric that matters (`docs/ROADMAP.md`) — and funds the business via agency cash before any SaaS pivot.

Date opened: 2026-06-01 · Status: **In progress.** D3 built; D1 blocked on owner (Gumroad); D2 not started.

---

## Deliverables

### D1 — Gumroad launch + LinkedIn sequence  ⏳ blocked on owner
- [ ] Owner: create 4 Gumroad products, upload zips, set prices, send 4 live URLs.
- [ ] Me: swap 5 placeholders (4 in `turicks-web/app/products/page.tsx`, 1 in `website-builder-tool/README.md`).
- [ ] Me: queue the 4 brand-checked LinkedIn launch posts (`~/Projects/prompts/turicks-product-launch-linkedin.md`) — manual posting, zero ban risk (ADR-009).

### D2 — cinematic-web "done-for-you landing page" service tier  ⏳ not started
- [ ] Productized fixed-price offer (page + intake flow) — the upsell from the free CLI (`STRATEGY-WEEK-SPRINT.md`).

### D3 — FounderOS weekly outbound rhythm  ✅ done (this branch)
- [x] **Persistent target list** — `src/outbound/targets.ts`, stored as `outbound_targets` in the `founder_context` JSONB blob (no new table). Case-insensitive dedupe, capped at 50.
- [x] **Batched ICP scoring** — `src/outbound/batch.ts` builds ONE prospecting prompt for up to `MAX_BATCH` (8) companies. Read-only (prospecting has no write tools) → no HITL → safe to batch. Pure, unit-tested prompt builder.
- [x] **Telegram commands** (deterministic, no LLM): `/target`, `/targets` (+ `clear`), `/untarget`, `/outbound [companies]`. `/outbound` routes the batch prompt through the office; scoring returns a ranked digest.
- [x] **Monday 08:05 nudge** — `sendOutboundNudge()` in `src/infra/scheduler.ts` reminds the founder to run `/outbound` (or to start adding targets). No LLM — reads `founder_context`.
- [x] **Drafting/sending reuses the existing sales→HITL flow** — "draft outreach to <winner>" is unchanged; one approval per thread preserved.
- [x] 15 new unit tests (`tests/unit/outbound/`). Full suite **62 green**, tsc clean (bar the known pre-existing `office.ts:132` PostgresSaver typing bug).

## The weekly loop (how it runs)

```
(over the week)  /target Acme Corp, Beta Ltd        → list grows
Monday 08:05     🎯 nudge: "N targets queued — /outbound"
Monday           /outbound  → prospecting scores all (ICP x/10 + next step)  [read-only]
                 → ranked digest + "Shortlist: …" of 7+ scorers
(per winner)     "draft outreach to Acme Corp"      → sales drafts → HITL Approve → send
```

## Architecture decisions made this phase

1. **Deterministic commands for list management, the office for intelligence.** Add/list/remove/trigger are slash commands (zero LLM, reliable). Only scoring + drafting spend tokens. Respects Pillar 0; keeps the "supervisor + NL" core intact.
2. **Single batched scoring call**, not one office run per company — cheapest viable path for a weekly batch. Capped at 8 with overflow reported; ad-hoc `/outbound <names>` allows smaller runs.
3. **Targets in `founder_context` JSONB**, not a new table — matches the Phase C decision. Promote to `outbound_leads` (already in the schema) only when per-target *state* (stage, timestamps) is needed.
4. **Scoring does not auto-write `outbound_leads`.** The prospecting agent returns text; parsing it into rows would be fragile. The founder acts on the digest via the existing sales flow. Persisting scored leads is a documented follow-up, not MVP.

## Success criteria

- [x] `/outbound` on a stored list returns a ranked ICP digest in one office run.
- [x] List survives restarts (founder_context-backed) and dedupes.
- [x] Full suite green; no new tsc errors; HITL contract intact.
- [ ] Live: a real week where `/target` → Monday nudge → `/outbound` → "draft outreach to X" → approve → send produces ≥1 sent email. (Verify with the live bot.)

## Open questions

- *Auto-persist scored leads to `outbound_leads`?* → Deferred (decision 4) — revisit if the founder wants a pipeline view / dedupe across weeks.
- *do_not_contact enforcement at scoring time?* → Enforced at SEND time by the existing sales flow; scoring is read-only so no suppression needed yet.
- *Batch reliability at 8 companies?* → Watch live output; fall back to per-company runs if digests truncate (decision 2).

## Verification results

- Unit + integration: **62/62 green** (`tests/unit/outbound/targets.test.ts` 7, `…/batch.test.ts` 8, + full regression incl. live-model office-HITL).
- Live weekly-loop verification: pending (record here after first real run).
