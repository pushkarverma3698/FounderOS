# 2026-09-16 — UI QA vision-gate CI fix + retarget to beta

## What we did

Closed out [PR #676](https://github.com/pushkarverma3698/FounderOS/pull/676) (the browser + vision
QA gate, M1), which shipped with a green local `pnpm gate` but a red `UI QA` check in CI, plus a
reviewer REQUEST CHANGES on the base branch.

1. Root-caused the CI-only failure: `--vision`'s dynamic import of `ui-vision.js` reaches
   `gemini-rest.js` → `infra/logger.js` → `core/config.ts`, whose `parseEnv()` throws when
   `DATABASE_URL`/`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are absent — exactly the state the
   `ui-qa.yml` workflow deliberately runs in (the contract promises "needs NO secrets"). Local
   verification of `--vision` had only ever exercised the no-key early return, never the real
   import, because no API key exists in this environment.
2. Fixed `src/infra/logger.ts` to read `NODE_ENV`/`LOG_LEVEL` from `process.env` directly instead
   of importing the validated `env` — logging must not require a database.
3. Fixed `scripts/qa-ui.ts`'s `runVision()` to catch any exception in its body and resolve to a
   `{ ran: false, skippedReason }` `VisionStage` instead of letting it escape — the contract
   already promised a failing vision stage is SKIPPED, not fatal; the code didn't honour that.
4. Fixed `.github/workflows/ui-qa.yml`'s final step to distinguish a crash (no `report.json`)
   from a clean run that found blocking defects, instead of labelling both "blocking defects
   found."
5. Verified the reviewer's base-branch claim rather than taking it on trust: `origin/beta` was
   `0` behind / `6` ahead of `main` (not stale, as an older doc — `AG-012` — had claimed on
   2026-09-07). Merged `beta` in (a merge commit, not a rebase), resolved 3 mechanical conflicts
   (`src/agents/capabilities.ts` — union both departments' new tools; `docs/ROADMAP.md` and
   `docs/study/INTERVIEW-BRIEF.md` — both had stale source-file-count claims from before the
   merge), then ran `pnpm verify:doc-claims --fix` to compute the true post-merge count (384,
   which neither pre-merge branch had on its own).
6. Checked a second reviewer's claim that the PR body's "gate green, 4254 tests" was inaccurate
   (they saw 2 failures locally: `free-boards.test.ts` and `artifact-delivery`). Did not
   reproduce: GitHub Actions' own "Unit + regression tests" check passed on the exact head this
   was reported against, and both named files pass clean in this session's full gate run. Did not
   edit the PR body — replacing a true statement with a false one would have been the actual
   defect. Flagged the underlying `free-boards.test.ts` board-count assertion as a likely
   time/data-dependent flaky test, out of scope for this PR.

## What we fixed

- `src/infra/logger.ts` — no longer imports `core/config.ts`; reads `process.env` directly with
  the same `NODE_ENV`/`LOG_LEVEL` defaults `config.ts` declares.
- `scripts/qa-ui.ts` — `runVision()` exported (for testability) and its body wrapped in try/catch.
- `.github/workflows/ui-qa.yml` — final step checks for `report.json` before calling something
  "blocking defects found."
- `src/agents/capabilities.ts`, `docs/ROADMAP.md`, `docs/study/INTERVIEW-BRIEF.md` — beta-merge
  conflicts resolved.
- New tests: `tests/unit/infra/logger-no-config.test.ts` (pins the actual CI failure — logger
  import with no DB/Telegram config), and a `runVision` regression in
  `tests/unit/tools/browser/ui-check.test.ts` (a real ENOENT inside the vision stage's body
  becomes a SKIPPED stage, not an uncaught rejection).

## Why

A gate that needs production secrets to check a static web page is a gate that gets switched off
— that was the explicit design intent in `UI-QA-CONTRACT.md` and the workflow's own comments; the
code just didn't deliver it. Separately, one stage failing was silently discarding the
already-computed, free, deterministic 8/8 pass — the artifact upload proved it (screenshots
present, `report.md` absent), which is worse than a clean failure because it looks like the
pipeline half-worked when the visible symptom was actually total data loss for that run.

## Metrics

- `pnpm gate` on the fully-merged tree (post `beta` merge): exit 0. `verify:branch` OK on
  `claude/feat-browser-vision-qa`; lint/build/wiring/arch/doc-claims all clean; architecture
  ratchet `fail-open-catch: 9` (unchanged baseline). **392 test files, 4359 tests, all passed.**
- Reproduced the exact CI condition locally and proved the fix:
  `env -u DATABASE_URL -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CHAT_ID GOOGLE_GENERATIVE_AI_API_KEY=dummy-key-for-import-test pnpm qa:ui --vision --out /tmp/ui-qa-repro-1`
  → exit 0, 8/8 deterministic PASS, vision stage SKIPPED naming the real transport error
  (`API key not valid`, a 4xx as predicted — never a silent clean pass).
- Deterministic-only path unaffected: `pnpm qa:ui --out /tmp/ui-qa-repro-plain` → 8/8 PASS, exit 0.
- `free-boards.test.ts` 24/24, `artifact-delivery.test.ts` 7/7 — both clean on this tree, closing
  out the second reviewer's non-reproducing claim with fresh evidence.

## Outstanding

- A real Gemini vision call with a valid key is still NOT VERIFIED — the dummy-key repro proves
  the import chain and the skip path, not the model round-trip. Needs
  `GOOGLE_GENERATIVE_AI_API_KEY` as a real Actions secret (already requested in the PR body) and
  one live `pnpm qa:ui --vision` run.
- `free-boards.test.ts`'s board-count assertion looks time/data-dependent (one session saw 2705,
  another 2706) — a latent flaky test on `main`, not touched here; worth its own issue.
- `pnpm brain:sync` still owed for this `docs/` change — needs a machine with the real
  `DATABASE_URL` (not available in this worktree).
