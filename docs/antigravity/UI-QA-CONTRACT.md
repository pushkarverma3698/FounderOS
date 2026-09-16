# UI QA gate — BINDING

**How a page that would ship broken to a client gets stopped before merge.** Read this together
with [ISSUE-DRIVEN-CONTRACT.md](ISSUE-DRIVEN-CONTRACT.md) (how a defect becomes a PR) and
[STANDARDS.md](STANDARDS.md) (how the code is written).

## The problem this closes

A client-facing Proof Drop showcase is built by `apply_cinematic_preset` → `claude_code` →
`deploy_static_site`. That last step **copies files and returns a URL**. Nothing in the pipeline
ever looks at the page. Until this gate, the verification ladder (L1–L6) was blind to visual
output: `pnpm gate` proves the TypeScript compiles and the units pass, and says nothing about
whether the page a prospect opens has a headline on it.

`apply_cinematic_preset` substitutes **`{{CLIENT}}` only** (`src/tools/cinematic-preset.ts:98`).
Any other placeholder a preset gains ships to the client verbatim. That is why
`unsubstituted-placeholder` is a blocking finding.

## What runs, and what it costs

| Stage | What it does | Cost | Needs secrets |
|---|---|---|---|
| **Measured** | Renders in headless Chromium; reports placeholders, JS errors, failed assets, blank pages, overflow, invisible sections, missing headline | **$0** — no model call | **None.** Not even `DATABASE_URL` |
| **Visual** | One Gemini call per screenshot: overlapping text, unreadable contrast, broken layout | Paid, capped at `MAX_VISION_IMAGES` (8) | `GOOGLE_GENERATIVE_AI_API_KEY` |

The measured stage is deliberately free of `src/core/config.ts`. A gate that demands production
secrets to render static HTML is a gate that gets switched off.

```bash
pnpm qa:ui                                   # 4 preset scaffolds, deterministic, $0
pnpm qa:ui --out .artifacts/ui-qa            # + report.md, report.json, PNGs
pnpm qa:ui --vision                          # + the paid visual review
pnpm qa:ui --target showcase=/path/index.html --viewport desktop
```

Exit code is the verdict: `0` clean, `1` blocking defects found.

## When vision is required, and when it is not

Vision is **not** a second opinion on what measurement already answered. Asking it to re-check a
missing stylesheet is paying a model to repeat a free, deterministic answer.

- **Measurement is sufficient** when the acceptance criteria are structural: the page renders, its
  assets load, its placeholders are filled, it fits the viewport. This is most PRs.
- **Vision is required** when the change is *visual* — a layout, spacing, colour, typography or
  z-index change — because those break in ways no DOM measurement detects: text on top of text,
  a CTA the same colour as its background, a hero that collapses at 390px.

This mirrors the risk-adaptive policy in ISSUE-DRIVEN-CONTRACT.md § "Reality-test policy": the
check is chosen from what the change actually risks, not run blanket.

## Severity, and what blocks

| | Meaning | Blocks merge |
|---|---|---|
| 🔴 **high** | A visitor would consider the page broken | **Yes** |
| 🟡 **medium** | A real, visible flaw | No — named, not blocking |
| ⚪ **low** | A blemish | No |

Blocking kinds: `unsubstituted-placeholder`, `page-error`, `failed-asset` (stylesheet/script only),
`blank-page`, `render-failed`, and any high-severity visual defect.

**A render that crashed is a blocking `render-failed` row, never a missing row.** A crash that
produced no row is indistinguishable from a clean pass — the same did-not-run-reads-as-clean
failure `src/evolution/run-audit.ts` exists to prevent.

**A skipped vision stage is printed as SKIPPED with its reason and does not fail the build.**
Failing every PR on a missing API key would train everyone to ignore the gate. It is never
rendered as a pass: the pack states plainly that visual defects were not checked.

## Where it binds

`.github/workflows/ui-qa.yml`, path-filtered to `assets/cinematic-presets/**`, `apps/**`,
`video-factory/projects/**`, `src/tools/browser/**`, `scripts/qa-ui.ts`. Red blocks merge once
`ui-qa` is added as a required status check in branch protection.

The evidence pack is posted as **one PR comment, updated in place**, and uploaded as the
`ui-evidence-pack` artifact. `pr-brain` / `pr-adversary` therefore reads evidence rather than being
told to "use vision" — CLAUDE.md rule #27: CI-enforced rules drifted zero times in a month;
markdown rules drifted three times in a day. A single updated comment, not one per push, is
deliberate: the 2026-09-08 audit found `pr-brain`'s unthrottled notifications had taken 21% of the
entire Telegram history.

## From the founder's chat

`ui_check` is registered for the `engineering` department and the `qa` sub-agent, so *"check the
neon preset still renders"* routes to it in natural language. It is **HITL-gated**: it makes the
bot fetch a URL the model chose, which is the same reach — and the same injection surface — that
gates the `browser` tool. CI does not go through that wrapper (`scripts/qa-ui.ts` calls
`runUiCheck()` directly), so the gate pays nothing for the gate.

## Two traps, both measured

Documented because both produced confident, wrong output on the first live run:

1. **Never `goto()` a `file://` directory.** Chromium answers it with its own listing page, whose
   inline script throws `start is not defined` / `addRow is not defined`. Those land in the
   `pageerror` listener and get attributed to the page under test — every preset reported four
   uncaught JavaScript errors it did not have.
2. **Never `setContent()` + `<base href="file://…">`.** That document has an `about:blank` origin
   and Chromium refuses its `file://` subresources: *"Not allowed to load local resource"*. Every
   preset then reported a missing stylesheet sitting right next to it.

Both are why local targets are served over loopback HTTP (`src/tools/browser/static-server.ts`),
which is also more faithful — a deployed showcase is served over HTTP, not opened off a disk.

A third: Playwright emits **two** events for one failed request (an HTTP status and a
`net::ERR_ABORTED`), so the raw list double-counts every 404. `dedupeAssets` collapses them; without
it one missing stylesheet reads as two problems.

## Not in this milestone

- **Filing findings as issues.** A `ui-defect` finding kind in `src/evolution/` would ride the
  existing `dispatch-findings.ts` rails (one issue per run, fingerprint dedup, `agent:ready`) to
  Antigravity with no new dispatch code. Deferred: a `FindingKind` nothing produces is dead code the
  dead-code analyzer would rightly flag.
- **Blocking `deploy_static_site`.** Making the deploy refuse a page `ui_check` calls broken gates
  the thing the client actually opens, rather than the scaffold it descends from. Deferred because
  it changes a HITL-gated production tool, and the checker should first be proven against real
  defects.
