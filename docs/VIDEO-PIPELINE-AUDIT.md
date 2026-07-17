# Video Pipeline — Zero-Base Architectural Audit (2026-07-15)

Scope: the Video Factory as merged in PR #358 (`src/tools/video-brand.ts`,
`src/tools/video-brief.ts`, `src/agents/agent-tools/video.ts`,
`video-factory/`). Method: full trace of state flow, asset routing, and the
tool-execution chain, the same way ZERO-BASE-AUDIT.md traced the v2 kernel.

Verdict: the brand registry and brief compiler are sound (typed, pure,
deterministic — keep). Everything downstream of the brief is **not a
pipeline**: it is a markdown document handed to an open-ended LLM session,
plus two fire-and-forget scripts. Nothing between "brief compiled" and "MP4
delivered" is contracted, persisted, verified, or bounded.

## Fail-point inventory

| # | Component | Failure class | Evidence |
|---|---|---|---|
| F1 | brief → `claude_code` handoff | **Unbounded LLM retry loop** | The brief's "Execution" section says "author `index.html` … lint … render". Authoring a seek-safe GSAP composition by hand is the #1 bug source the docs themselves call out. When `hyperframes check` fails, the only recovery is the agent trying again — the exact try-again loop v3 was built to kill. No attempt counter, no typed failure, no checkpoint. |
| F2 | `gen-broll.mjs` poll loop | **Infinite loop** | `while (!op.done) { sleep 10s; poll }` — no timeout, no max iterations. A stuck Veo operation hangs the executor forever. |
| F3 | `gen-broll.mjs` poll error | **Paid asset lost** | A single failed poll `process.exit(1)`s and discards `op.name`. Money already spent; operation unrecoverable (Google retains output ~2 days, but we kept no handle). |
| F4 | re-running any gen script | **Double spend** | No idempotency: same `--prompt --out` re-bills Veo (~$1.20/clip) and ElevenLabs every run. No receipt, no content-hash key, no skip-if-exists. |
| F5 | whole factory | **Zero state persistence** | No manifest. A crash mid-production (10-clip reel ≈ $12) loses which clips exist, which were verified, which failed. Resume = start over = re-spend. |
| F6 | downloaded assets | **No verification** | Bytes are written to disk unprobed. A truncated download or wrong-duration clip flows into (nonexistent) compositing and fails at the last, most expensive step. |
| F7 | model choice | **Manual, unmodeled** | `--model` is a CLI flag a human picks. No per-scene selection (hero shot vs filler b-roll), no cost estimate, no budget gate — `daily-budget` integration is a docs promise, not code. |
| F8 | creative layer | **No shot grammar** | A scene's "direction" is one free-text sentence. No shot-by-shot breakdown, no camera-angle rotation, no transition spec, no pacing model beyond a word, no consistency tokens (seed/style anchor) across clips — which is why outputs read as basic/green-screen-grade. |
| F9 | compositing | **Stage missing entirely** | There is no code path that assembles clips + VO + music + captions into a deliverable. The "pipeline" cannot produce a footage-based reel end-to-end. |
| F10 | VO timing rule | **Human-enforced** | "Time scenes to measured audio" is a comment in `gen-voiceover.mjs`; nothing measures audio (no ffprobe step), so the rule survives only if a human remembers it. |
| F11 | 1:1 format | **Claimed, not implemented** | `gen-broll.mjs` comments "1:1 is cropped in post" — there is no post. |

## Root cause

The factory kept v2's shape for its most complex stage: *prose instructions
interpreted by an LLM at runtime*, exactly what CLAUDE.md's determinism rule
bans for routing/parsing/guards. The fix is the same fix v3 applied to the
kernel: **compile the entire production to typed data up front (pure code,
$0), then execute it with a dumb, checkpointed, idempotent runner.**

## Target architecture (implemented in this change)

```
marketing prompt
  → compileShotList        (PURE: brand + topic → seeded shot grammar —
                            camera rotation, transitions, pacing, overlays,
                            consistency anchor; src/tools/video-shotlist.ts)
  → planModels             (PURE: per-shot engine matrix + cost estimate +
                            budget verdict; src/tools/video-models.ts)
  → compileCompositePlan   (PURE: exact ffmpeg argv — xfade chain, audio mix,
                            caption burn, 1:1 crop; src/tools/video-compose.ts)
  → compileProductionPlan  (PURE: everything above → ordered step DAG with
                            receipts contract; src/tools/video-production.ts)
  → production.json        (checkpoint 0 — the immutable plan on disk)
  → produce.mjs            (executor: replays receipts, runs only missing
                            steps, ffprobe-verifies every artifact, bounded
                            attempts, atomic receipt per step)
```

Loop eradication, by construction:
- **No LLM in the execution path.** The CTA title card is generated from a
  deterministic template (`video-title-card.ts`), not hand-authored.
- **State = receipts.** The plan is immutable; progress is the set of valid
  receipts (`receipts/<step>.json`, argv-hash + sha256 + probe). Crash-safe
  and resumable without a mutable state file that can corrupt.
- **Every retry is bounded** (`max_attempts` per step, default 2) and every
  failure is typed with the component named — after that, the run stops loud.
- **Idempotent by keying**, not by hope: a step re-runs only if its receipt
  is missing or its argv hash changed. Paid steps can never double-bill.
- **Verification is a step**, not a habit: ffprobe duration/dimension checks
  gate every generated asset before compositing sees it.
