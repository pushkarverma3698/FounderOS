# 2026-09-15 — Browser + vision QA as a binding CI gate

## What we did

Shipped M1 of the UI QA loop: `pnpm qa:ui` renders the pages a client actually sees, reports what is
measurably broken, and blocks merge on a path-filtered CI check.

- `src/tools/browser/` — a new subsystem, five modules, each well under the 400-LOC budget:
  - `chromium.ts` — ONE shared headless Chromium, extracted from `browser-playwright.ts`. Exposes
    the stateful singleton page the `browser` tool needs AND `withFreshPage()` for isolated
    per-target measurement.
  - `static-server.ts` — throwaway loopback HTTP server that applies `{{PLACEHOLDER}}`
    substitutions, with a unit-tested path-traversal guard.
  - `ui-facts.ts` — I/O: drives the browser, gathers raw measurements.
  - `ui-analyze.ts` — PURE: facts → defects. Fixture-tested without Chromium.
  - `ui-check.ts` — orchestration + the `ui_check` UnifiedTool.
  - `ui-vision.ts` — the opt-in paid Gemini stage, capped at 8 images.
  - `evidence-pack.ts` — PURE renderer: rows + verdicts → the markdown/JSON a reviewer reads.
- `scripts/qa-ui.ts` (`pnpm qa:ui`) — CLI and CI entrypoint; also the script root that keeps R7
  (orphan-subsystem) green.
- `.github/workflows/ui-qa.yml` — path-filtered gate; posts the pack as ONE PR comment updated in
  place, uploads it as an artifact, fails on blocking defects.
- `ui_check` registered for the `engineering` department and the `qa` sub-agent, HITL-gated, so
  *"check the neon preset still renders"* works from Telegram.
- `docs/antigravity/UI-QA-CONTRACT.md` — the binding process doc.

**Antigravity was evaluated as the substrate and rejected on evidence**: its Browser Subagent is
not available in the `agy` CLI (IDE/2.0 desktop only) and does not support headless operation, so it
cannot run on a headless VPS or in CI. It remains the *fixer* via the existing issue loop. The split
is now explicit: Playwright drives, Gemini judges, Antigravity fixes, Claude reviews.

## What we fixed

Three defects, all found by running the thing rather than by unit tests — the whole argument for
rule #24:

1. **Phantom JavaScript errors on every preset.** `navigate()` did `goto(directory)` then
   `setContent()`. Chromium answers a `file://` directory with its own listing page, whose inline
   script throws `start is not defined` / `addRow is not defined`; those landed in the `pageerror`
   listener before `setContent` replaced the document. Every preset reported four uncaught errors it
   did not have.
2. **Phantom missing stylesheets.** The fix attempt — `setContent` + `<base href="file://…">` — gave
   the document an `about:blank` origin, so Chromium refused its `file://` subresources ("Not
   allowed to load local resource"). Every preset then reported a missing stylesheet sitting right
   next to it. Resolved by serving local targets over loopback HTTP, which is also more faithful: a
   deployed showcase is served over HTTP, not opened off a disk.
3. **Every 404 counted twice.** Playwright emits both an HTTP status (`response`) and a
   `net::ERR_ABORTED` (`requestfailed`) for one failed request, so a single missing stylesheet read
   as two blocking problems. `dedupeAssets` collapses them.

Also caught by the true-negative run: deleting a preset's `<h1>` did **not** trip the gate, because
the surviving `<h2>` satisfied "has headings". Added an explicit `missing-h1` check.

Incidentally reduced `fail-open-catch` debt 11 → 9 (the two untagged `.catch(() => undefined)` calls
in `browser-playwright.ts`'s teardown are now tagged in `chromium.ts`), and pinned the win.

## Why

`deploy_static_site` copies files and returns a URL. Nothing in the Proof Drop pipeline ever looked
at the page, so a broken hero or a literal `{{TAGLINE}}` reached a prospect with nothing in between
— and `apply_cinematic_preset` substitutes `{{CLIENT}}` **only** (`cinematic-preset.ts:98`), so any
other placeholder a preset gains ships verbatim. `pnpm gate` proved the TypeScript compiled and said
nothing about whether the page had a headline on it.

The gate binds in CI rather than in a prompt because rule #27 measured the asymmetry: CI-enforced
rules drifted zero times in a month, markdown rules three times in a day.

The measured stage deliberately imports no `src/core/config.ts`, so it runs in CI with **no
secrets** — not even `DATABASE_URL`. A gate that demands production secrets to render static HTML is
a gate that gets switched off.

## Metrics

| | |
|---|---|
| `pnpm gate` | **green** — 386 test files, 4254 tests, exit 0 |
| New unit tests | 68 (analyzer 23, tool+CLI 17, vision 14, pack 14) |
| Paid calls in the dev loop | **0** — Gemini fully mocked in tests; vision opt-in only |
| Live run, 4 presets × 2 viewports | 8/8 PASS, exit 0, 8 real PNGs (1440×913 / 390×844) |
| True negative (placeholder + dead stylesheet + no `<h1>`) | 2 blocking + 2 non-blocking, exit 1 |
| Architecture | all fitness rules green; `fail-open-catch` 11 → 9 |
| Source files | 371 → 379 (doc claims updated) |

## Outstanding

- **Live `--vision` run: NOT VERIFIED** — no `GOOGLE_GENERATIVE_AI_API_KEY` in this environment and
  no `.env`. The *skip* path was verified end-to-end: it prints `SKIPPED` with the reason, records
  `{"ran": false, "skipped_reason": …}` in the JSON, and exits 0 rather than rendering a clean pass.
  The Gemini call itself is covered by mocked unit tests only.
- `ui-qa` must be added as a required status check in branch protection before red actually blocks.
- **M2** — a `ui-defect` finding kind in `src/evolution/` would ride the existing
  `dispatch-findings.ts` rails to Antigravity with no new dispatch code. Deferred: a `FindingKind`
  nothing produces is dead code the dead-code analyzer would flag.
- **M3** — make `deploy_static_site` refuse a page `ui_check` calls broken. Gates what the client
  opens rather than the scaffold it descends from.
- **Everyday browser automation** still needs 3–5 named chores before it is worth building.
