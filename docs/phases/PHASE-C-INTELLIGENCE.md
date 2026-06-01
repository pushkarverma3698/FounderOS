# Phase C — Intelligence Upgrades

**Goal:** Give FounderOS persistent business awareness — it remembers the founder's context across sessions, can recall internal company knowledge, and proactively surfaces what needs attention — without adding per-request LLM cost.

Date: 2026-06-01 · Branch: `feat/phase-c-memory-scheduler` · Status: **Code complete, green; turicks-brain population + live Telegram verification pending.**

---

## Deliverables

- [x] **C1 — Founder context memory.** `founder_context` table (JSONB blob per tenant, migration `0003_founder_context.sql`) + `read_context` / `update_context` tools (`src/tools/context.ts`). Wired as **supervisor-only** tools so priorities set in one conversation persist into the next. Zero LLM cost (pure Postgres read/write).
- [x] **C2 — Internal knowledge search.** `search_knowledge` tool (`src/tools/knowledge.ts`) over the `knowledge_entries` (turicks-brain) table — ILIKE keyword match, no embedding cost. Wired into `research`, `marketing`, `sales`, `prospecting` departments. Optional `entry_type` filter (adr / brand / case_study / strategic_pillar / phase / decision).
- [x] **C3 — Proactive scheduler.** Re-added `src/infra/scheduler.ts` (node-cron), started once in `index.ts` after the office compiles:
  - Monday 08:00 — LLM-generated weekly brief from `founder_context` (one model call/week).
  - Daily 09:00 — stale HITL approval reminder (pending > 12h), DB-direct, no LLM.
- [x] Supervisor + department prompts updated (`system-prompts.ts`) to teach context-usage discipline and external-vs-internal search choice. Added `SCHEDULER_BRIEF_PROMPT`.
- [x] DB queries added (`src/db/queries.ts`): `getFounderContext`, `upsertFounderContext`, `searchKnowledgeEntries`, `getKnowledgeByType`.
- [x] 7 new unit tests (`tests/unit/tools/context-knowledge.test.ts`) — empty-state, merge/persist, type-routing. **47 total green.**
- [x] `CLAUDE.md` — added "Content & Asset Delivery Rules" (present content inline, never reference .md-only).
- [ ] **C2-follow-up — populate turicks-brain.** `search_knowledge` returns its empty-state ("run `pnpm brain:sync`") until `knowledge_entries` is seeded from `docs/decisions/` + `CASE-STUDY-LOG.md` + brand guidelines. Tool is correct; the store is empty.
- [ ] **C3-follow-up — live Telegram round-trip verification.** Confirm a real message → department → reply lands in the chat, and the Monday brief fires, before trusting daily use.

## Architecture decisions made this phase

1. **Context tools are supervisor-only.** Only the Chief-of-Staff supervisor reads/writes founder state; departments never touch it. This keeps a single source of truth and avoids departments racing on the same JSONB blob.
2. **Context is one JSONB blob per tenant, not normalized tables.** Active clients / deals / priorities / next actions are low-volume, read-whole/write-whole, and schema-fluid. A normalized model would be premature (`STRATEGIC-VISION` Pillar 0: cheapest viable path). Migrate only if querying individual fields becomes a real need.
3. **`search_knowledge` is keyword (ILIKE), not semantic.** No embedding cost, deterministic, good for known-term lookup ("Composio", "ADR", "FinTech"). Semantic recall stays the job of `search_web`. pgvector is deferred until keyword recall demonstrably misses real queries.
4. **Scheduler bypasses the office graph for routine pushes.** Stale-approval reminders are a direct DB query → `sendToChat()` (zero LLM). Only the Monday brief invokes the office (one call/week) — and via a fresh `MemorySaver`, not the durable checkpointer, so scheduler runs never pollute conversation threads.
5. **The scheduler is re-added, not the v1 design.** v2 deleted the old multi-job cron deliberately; this is the minimal proactive layer the roadmap actually called for (Monday brief + stale reminder), nothing more.

## Success criteria (measured)

- [x] `pnpm test` green: **47 passed / 9 files** (was 40; +7 context/knowledge tests).
- [x] `read_context` returns a sensible empty-state and formats stored context as bullets.
- [x] `update_context` merges + persists, confirms updated keys.
- [x] `search_knowledge` returns an informative empty-state pointing at `brain:sync`, and formats found entries with type/title/tags/preview.
- [x] Office compiles with the new tools wired (supervisor + 4 departments); HITL integration test still passes.
- [ ] One full week of daily use with no "let me re-explain my context" moment (C3 gate — needs live run).

## Open questions

- *Should context auto-update, or only on explicit founder statements?* → **Resolved:** explicit only. The supervisor prompt instructs `update_context` on clear signals ("new client", "we closed X", "this week I'm focused on…"), not silently. Avoids drift from misread intent.
- *Keyword vs semantic knowledge search?* → **Resolved:** keyword now (zero cost, deterministic); revisit pgvector only if real queries miss (decision 3).
- *Is turicks-brain populated?* → **Open (C2-follow-up).** Tool is correct; `knowledge_entries` is empty until `brain:sync` runs against a live DB.

## Verification results

- Unit + integration suite: **47/47 green** (`tests/unit/tools/context-knowledge.test.ts` + full regression, incl. live-model office-HITL loop).
- Pending live verification (C3-follow-up): Telegram round-trip + Monday brief fire. To be recorded here once run against the live bot + DB.
- turicks-brain population (C2-follow-up): record entry count after first `pnpm brain:sync` here.

---

*Phase C is the last "single-user intelligence" phase before the Revenue Flywheel (Phase D). It does not block Phase D — the two run in parallel (D = revenue/GTM, C-followups = depth).*
