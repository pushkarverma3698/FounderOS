# Testing Audit — Ground Truth (2026-06-12)

Phase 1 of the Testing Pipeline mission. Every number here was measured, not assumed.

## 1. Test Runner (decided)

**Vitest 2.1.8** is already configured and standardised on. We extend it — no new runner.

- `type: module` (Node 22 ESM), TS via `tsx`. Vitest is the correct ESM-native choice.
- No `vitest.config.*` file exists — the suite runs on Vitest defaults (globals off, parallel
  file execution, `node` environment). **This default parallelism is the root of the
  non-determinism found below.**

## 2. Real Suite Numbers (measured, not claimed)

Three consecutive `pnpm test` runs on the same commit, no code change between them:

| Run | Test Files | Tests | Passed | Failed | Duration |
|-----|-----------|-------|--------|--------|----------|
| 1   | 69        | 913   | 892    | **21** | 136.6s   |
| 2   | 69        | 907   | 903    | **4**  | ~135s    |
| 3 (memory.test alone) | 1 | 11 | 11 | 0 | <2s |

**The suite is non-deterministic.** Same commit, different pass/fail counts (21 vs 4) and even
different *total* test counts (913 vs 907) across runs. A suite whose green/red flips run-to-run
cannot gate anything — this is exactly the "README said 100% while reality was 50%" failure mode,
reproduced at the infra layer.

## 3. Root Cause of the Flakiness — Parallel Mock Pollution / No Isolation

`tests/unit/tools/memory.test.ts`:
- **Passes 11/11 when run alone** (`vitest run tests/unit/tools/memory.test.ts`).
- **Fails 4 tests in the full parallel suite.**
- The failing assertions show the **real local-RAG filesystem index** leaking into the result
  (real paths like `/Users/pushkarverma/.claude/plans/...`, live similarity scores) even though
  the test mocks `callRagApi` (`src/tools/memory.ts:63`).

Mechanism: Vitest runs test files in parallel worker pools. `vi.mock("../../../src/tools/rag.js")`
in one file does not reliably isolate the module graph from sibling files that import the **real**
`rag.js` / `rag-service.ts`, and `rag-service` performs **real filesystem embedding search** with no
network/FS guard. Under parallelism the real implementation services the call. The run-to-run total
count drift (913 vs 907) is the same class: tests that touch live Postgres/RAG/network are
collected/skipped differently depending on what's reachable at run time.

**This is the #1 thing the new pipeline must fix:** no unit/integration test may touch real network,
real Postgres, or the real RAG/filesystem index. Determinism is a precondition for the suite having
teeth.

## 4. Test Pyramid Inventory (70 files)

| Layer | Location | Count | State |
|-------|----------|-------|-------|
| Unit (pure logic) | `tests/unit/**` (most) | ~66 files | Largely good; some leak real I/O |
| Integration (live) | `tests/integration/office-hitl.test.ts` | 1 | Hits **live Gemini + Postgres** — not mocked, not deterministic |
| Load | `tests/load/quota-race.test.ts` | 1 | Redis race test |
| Eval | `src/eval/**` + `scripts/run-eval.ts` | harness | Single-pass, not consistency-measured |
| Regression | — | **0** | **Does not exist** — the core gap |
| E2E / smoke | `scripts/e2e-telegram-qa.ts`, `telegram-tester.ts` | scripts | Exist as MTProto scripts, **not wired as `test:smoke`** |
| Fixtures / cassettes | — | **0** | **No MSW, no recorded responses** |
| Helpers | `tests/helpers/{mock-db,mock-redis}.ts` | 2 | DB+Redis mocks exist; no model/HTTP mock factory |

## 5. Historical Bugs — Which Fixes Actually Exist in Code

| # | Bug | Fix present? | Where |
|---|-----|-------------|-------|
| 1 | 503 → silent `none` route | ✅ retry + fallback cascade | `src/agents/model.ts` (`is503Error`, fallback models) |
| 2 | eval conflates INFRA vs WRONG_ROUTE | ✅ distinct scorer | `src/eval/scoring.ts:isInfraError`, `types.ts` |
| 3 | HITL never executed in eval | ⚠️ scored (`scoreHitl`) but only *observed*, not approve→resume→audit | `src/eval/scoring.ts` |
| 4 | OGG/Opus → WAV/MP3 conversion | ✅ exists | `src/infra/media-convert.ts`, `src/tools/transcription.ts` |
| 5 | voice bypasses HITL/guards | ⚠️ needs verification | `src/gateway/media.ts` → office path |
| 6 | idempotency double-fire | ✅ SHA-1 key + audit | `hasBeenAudited`/`writeAuditEntry` (per tool) |
| 7 | path-guard (.ssh/.env/*.pem/etc) | ✅ exists | `src/infra/path-guard.ts` + tests |
| 8 | brand validator strips banned phrases | ✅ exists | `src/infra/brand-validator.ts` |

**None of these have a dedicated, append-only regression test** that fails on the reverted fix.
They are protected only by general unit tests (or, for #3/#5, not directly at all). That is the
Phase 3 build.

## 6. Biggest Untested / Under-tested Surfaces

1. **Test isolation itself** — real I/O leaks make the whole suite untrustworthy (Phase 4 fixtures).
2. **HITL approve→resume→side-effect→audit** end-to-end (bug #3) — never executed, only observed.
3. **Voice → guard/refusal path** (bug #5) — spoken hostile command must hit the same refusal as typed.
4. **The integration test hits live Gemini** — flaky, quota-burning, can't run in CI offline.
5. **No consistency measurement** on the non-deterministic LLM routing layer (Phase 5).
6. **No regression layer at all** (Phase 3).

## 7. CI / Process State

- `.github/workflows/ci.yml` exists: `quality` (tsc lint), `unit-tests`, `integration-tests`
  (gated on secret), `eval-and-update-readme` (main only). **No `static`/regression/smoke split,
  no service containers for Postgres/Redis, integration relies on live Gemini not fixtures.**
- **No pre-commit hook** (no husky, no lint-staged). Nothing stops a red commit locally.
- No `RELEASE_CHECKLIST.md`, no `TESTING.md`, no regression/eval consistency docs.

## 8. Gate Decision

- **Runner:** Vitest (keep).
- **First build priority:** a `vitest.config.ts` that makes the suite deterministic + isolated
  (no real network/FS/DB in unit), because **a flaky suite cannot gate anything** — it is the
  precondition for every later phase having teeth.
- Then: regression layer (Phase 3), fixtures/MSW (Phase 4), consistency harness (Phase 5),
  smoke wiring (Phase 6), pre-commit + CI split (Phase 7), sabotage proofs (Phase 8), docs (Phase 9).
