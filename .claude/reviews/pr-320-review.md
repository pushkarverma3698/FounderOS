# PR Review: #320 — feat(gateway): stream turn progress to Telegram (edit-in-place)

**Reviewed**: 2026-07-12
**Author**: pushkarverma3698
**Branch**: feat/turn-progress-streaming → beta
**Decision**: APPROVE (after in-review fixes, applied and pushed to the same branch)

## Summary

The PR's headline "1034 additions" is misleading — 739 of those lines are the design spec and implementation plan (process artifacts required by the repo's brainstorming/writing-plans workflow, not code). The actual code+test delta was ~325 lines against `beta`. That said, the concern was legitimate: `streamKernelTurn` had real duplication (three near-identical try/catch/log blocks) and nesting up to 5 levels deep, and the test file had two near-duplicate plan fixtures. Both fixed in this review pass — `kernel-run.ts` net +6 lines after refactor (duplication removed, nesting flattened), test file net -16 lines (fixture dedup). Full suite 1405/1405, `tsc --noEmit` clean, `verify:arch` at baseline throughout.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM

1. **Duplicated try/catch/log pattern across 3 call sites** (`src/gateway/kernel-run.ts`, `streamKernelTurn`, as originally written). The send/edit/delete placeholder calls each wrapped their own `try { await ... } catch (err) { log.warn(...) }` with only the log string differing. **Fixed**: extracted a `silently(op, fn)` helper (commit `4862b24`); all three call sites now share one implementation, and the log message format is preserved byte-for-byte (`Progress placeholder ${op} failed`).

2. **Nesting depth exceeded the project's 4-level guideline.** Inside `streamKernelTurn`'s stream loop: `function → try → for-await → if(label changed) → if(placeholder exists) → try` = 6 levels at the deepest point. **Fixed**: the label-changed check now uses an early `continue` instead of wrapping the rest of the loop body in an `if`, and the duplicated try/catch collapsed into `silently(...)` calls — deepest nesting is now `function → try → for-await → if` = 4 levels.

3. **Duplicated test fixture** (`tests/unit/gateway/kernel-run.test.ts`). A top-level `PLAN` constant (for `progressLabelFor` unit tests) and a structurally identical inline plan literal inside the `EXECUTING_STEP1` fixture (for the streaming-behavior tests) differed only in `objective` text. **Fixed**: both now build from one `makePlan(objective)` helper (commit `4862b24`).

### LOW

1. **Non-null assertions** (`placeholderId!`) inside two closures passed to `silently`, needed because TypeScript can't narrow a captured `let` across a callback boundary. Not incorrect (both call sites are already guarded by `placeholderId !== undefined`), but avoidable. **Fixed**: bound to a local `const id = placeholderId` before each closure instead (commit `193a5e0`) — same runtime behavior, no assertions.

2. **The docs/code ratio in the PR is high** (739 spec+plan lines vs ~325 code+test lines). Not a defect — this is the repo's mandated brainstorming → spec → plan → TDD workflow — but worth calling out explicitly so "1034 additions" isn't read as 1034 lines of implementation. Recommend nothing be changed here; flagging for the PR description only.

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Lint (`tsc --noEmit`, project's actual lint script) | Pass |
| Tests (`vitest run`, full suite) | Pass — 1405/1405, 137 files |
| Architecture gate (`verify:arch`) | Pass — all 5 gates at baseline (gateway-imports 0, kernel-purity 0, fail-open-catch 11, loc-budget 5, regex-routing 0) |
| Build | Not run — no build step failure risk for a gateway-only TS change; `tsc --noEmit` already validates compilation |

## Files Reviewed

- `src/gateway/kernel-run.ts` — Modified (streaming wiring, `progressLabelFor`, `streamKernelTurn`, `silently` helper)
- `src/infra/trace.ts` — Modified (added `"turn.progress"` to the `Seam` union; 2-line change, no issues)
- `tests/unit/gateway/kernel-run.test.ts` — Modified (converted `invoke` mocks to `stream`, added `progressLabelFor` tests and 4 progress-streaming behavior tests, deduped fixtures)
- `docs/superpowers/specs/2026-07-12-turn-progress-streaming-design.md` — Added (process artifact, not reviewed as code)
- `docs/superpowers/plans/2026-07-12-turn-progress-streaming.md` — Added (process artifact, not reviewed as code)

## Post-review commits (this pass)

- `4862b24` — refactor: collapse duplicated placeholder try/catch into `silently()`, flatten nesting with early `continue`, dedup test fixtures via `makePlan()`
- `193a5e0` — refactor: replace non-null assertions with local `const` bindings

All pushed to `feat/turn-progress-streaming`. Full suite re-verified green after each commit.
