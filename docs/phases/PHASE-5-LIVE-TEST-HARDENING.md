# Phase 5 — Live Test + Reliability Hardening

**Goal:** Drive FounderOS as a product with real CEO tasks against the live cloud cascade, prove (and fix) reliability under a hard budget cap, and close the gaps blocking a sellable / open-sourced release.

Date: 2026-05-31 · Budget spent on live testing: **< $0.04** of the $0.50 cap.

## Deliverables

- [x] Cheap+safe live harness: dedicated test Postgres (5433) + Redis, `scripts/qa-cloud.env` budget profile ($0.50 cap), kill-switch at $0.45.
- [x] Baseline full test pyramid green locally (fixed 4 pre-existing e2e test bugs).
- [x] Local capability battery via `scripts/qa-manual.ts` (real Ollama, $0).
- [x] Cloud CEO scenario battery `scripts/ceo-live-battery.ts` (6 capabilities + dedup, dry-run, cost-tracked).
- [x] **Fixed: migration journal drift** (0001 never applied → cost tracking + budget guard dead on fresh installs).
- [x] **Fixed: CEO routing** (reasoning model + 512-token cap → empty routing). Compact prompt + flash + headroom.
- [x] **Fixed: graph crash** on unresolved department (missing `END` mapping) → graceful end.
- [x] **Fixed: anti-sycophancy** critic ordering when no Anthropic key (R1).
- [x] **Fixed: cost-map coverage** + deepseek model-id (R3) with a guard test.
- [x] Added `/health` + `/metrics` HTTP server (dependency-free, tested).
- [x] Added `LICENSE` (MIT) + `CONTRIBUTING.md` + `package.json` license field.
- [x] Fixed `qa-manual.ts` clean-exit (was hanging on dangling handles after its verdict).
- [ ] One real LinkedIn send (proof-of-life) — gated on user content approval (final step).
- [ ] OSS data sanitization (extract private Turicks/Naggar specifics) — documented as pre-publish checklist.

## Architecture decisions made this phase

1. **CEO/routing tier must not use a reasoning model.** `gemini-2.5-pro` spends its
   token budget on hidden thinking and returns empty text under a tight cap. Routing
   is classification → `gemini-2.5-flash`. Token cap raised 512 → 1024 for headroom.
2. **CEO verdict is compact.** The prompt no longer echoes the task into JSON (that
   overflowed the cap and truncated mid-string). Supervisor falls back to `state.task`.
3. **Graph degrades, never crashes.** `routeDepartment → END` is now a valid mapping;
   an unroutable tenant agent (e.g. naggar `booking_concierge`) ends cleanly.
4. **Critic stays cross-family even without an Anthropic key:** Claude → Llama(free) →
   Gemini. The non-Gemini free model precedes Gemini so a Gemini generator is never its
   own critic.
5. **Budget enforcement requires the DB.** `checkBudget` fails OPEN without Postgres, so
   the cap is only real when cost rows are being written — which the migration fix restored.

## Success criteria (measured)

- [x] `pnpm test` (non-live) green: **210 passed / 28 files** (was 195; +15 new tests).
- [x] `src/**` typechecks clean (remaining tsc errors are pre-existing QA-script debt).
- [x] Cloud battery: every NL task routes to the correct department and reaches HITL/finalize.
- [x] No crashes, **0 JSON parse failures** after the routing fix.
- [x] Concurrency-safe (5× concurrent prospecting → 0 errors).
- [x] Total live spend **$0.036 < $0.50** cap; cost tracking populates `ai_call_costs`.

## Open questions (resolved)

- *Why did routing return empty?* → reasoning model + tight token cap (resolved, see decisions 1–2).
- *Why does a fresh DB break cost tracking?* → migration 0001 not in the journal (resolved).
- *Is the bare-URL dedup inconsistency a bug?* → No; `/prospect` bypasses the CEO supervisor
  in production, so bare URLs route deterministically via the command, not the classifier.

## Verification results

See `docs/PRODUCTION-READINESS.md` for the full evidence table, and
`docs/livetest/ceo-battery-report.{json,md}` for the raw battery output.
