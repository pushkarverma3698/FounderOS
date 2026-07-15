# Video Factory — FounderOS Social-Video Production Engine

**What**: brand-config-driven video production for client social-media retainers.
FounderOS owns the pipeline end-to-end; clients are rows in a registry, not
bespoke projects. First client: The Health Place (Bangalore wellness). First
deliverable rendered 2026-07-14 (55s hero, 16:9 + 9:16 + 1:1, $0 API spend).

## Architecture (contract-first, same discipline as the kernel)

```
founder ("make THP a reel about X")
  → planner → marketing worker
      → list_video_brands            (read: registry enumeration)
      → compile_video_brief          (PURE CODE: brand.json + request → brief)
  → engineering worker
      → claude_code                  (HITL-gated: author composition in video-factory/,
                                      hyperframes lint+check, render MP4 locally at $0)
  → founder reviews render → publish via existing comms/marketing gates (HITL)
```

- **`video-factory/brands/<slug>/brand.json`** — the client contract. Zod-validated
  by `src/tools/video-brand.ts`; malformed profile = typed failure, never a guess.
- **`src/tools/video-brief.ts`** — deterministic brief compiler. Same brand + same
  request → byte-identical brief (word-count VO budget, scene plan with hook-first-3s
  and CTA-last, palette/tone tokens, execution steps). No LLM in the loop.
- **`video-factory/projects/<project>/`** — one dir per deliverable: three
  composition files (`index.html` 16:9, `index-vertical.html` 9:16,
  `index-square.html` 1:1 — HyperFrames cannot responsive-render across aspect
  ratios; separate files is the architecture), `renders/`, `assets/`.
- **Renderer**: HyperFrames CLI (local, deterministic, seek-safe GSAP). Gates
  before every render: `hyperframes lint && hyperframes check` (runtime errors,
  layout/overflow, motion, WCAG AA contrast).

### Why not the hosted HeyGen MCP?
The hosted `compose`/`render_video` tools reject CLI/server agents by policy
(verified 2026-07-14). Local authoring is also strictly better for the business:
compositions are diffable IP in our repo, renders are $0, and nothing about a
client deliverable depends on a third party's render queue.

## Seek-safe composition contract (the #1 source of bugs — enforce always)
- ONE `gsap.timeline({ paused: true })` per composition, registered on
  `window.__timelines["<composition-id>"]`, built synchronously.
- No wall-clock JS: no `setTimeout`/`setInterval`/`requestAnimationFrame`/
  `Date.now()`/`Math.random()`. No `repeat: -1` (compute finite repeats).
- Every timed element: `class="clip"` + `data-start` + `data-duration` +
  `data-track-index` (same-track clips must not overlap).
- Elements animate IN via `gsap.from()`; exit animations only in the final scene.
- No full-frame linear gradients on dark backgrounds (H.264 banding) — use
  radial + localized glow. Vendor GSAP locally (`assets/vendor/gsap.min.js`).

## Cost model (per 55–75s video)
| Stage | Components | API cost |
|---|---|---|
| **Stage 1 (live now)** | Motion-graphics compositions, local render | **$0** |
| Stage 2 VO + music | ElevenLabs multilingual v2 (~950 chars) + Eleven Music | ~$0.35 |
| Stage 2 b-roll (Fast) | ~10 × 8s Veo 3.1 Fast clips @ $0.15/s | ~$12 |
| Stage 2 b-roll (Lite) | same @ ~$0.05/s | ~$4 |

Three aspect ratios reuse the same assets — incremental cost per extra format ≈ $0
(local render time only, ~3 min/format on 4 cores).

## Retainer economics (own the engine, sell the output)
- Market: Indian freelance/boutique video retainers ₹25k–₹1.5L+/mo; AI pipeline
  cost is ₹0–₹1,400/video → 95%+ gross margin on production.
- **Launch offer**: paid pilot ₹15k–₹25k (one hero, 3 formats) →
  **₹60k–₹90k/mo retainer** (10–12 shorts + 1 hero/mo, all 3 aspect ratios).
- The value story is volume + consistency + multi-format, not per-clip labor.
- Onboarding a new client = one `brand.json` (15 min) — see
  `video-factory/brands/README.md`. The whole pipeline scales per client from
  that single file.

## Stage roadmap
1. **Now**: brand registry + brief compiler + local HyperFrames render (this PR).
2. **Keys provisioned** (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY` on the VPS):
   `scripts/gen-broll.mjs` (Veo 3.1, async poll, 2-day retention → download
   immediately) + `scripts/gen-voiceover.mjs` (audio FIRST, then time scenes to
   measured duration). Budget-gate through the existing `daily-budget` infra.
3. **Scale**: schedule weekly reels per client via the existing scheduler;
   publish through `schedule_social_post` (already HITL-gated); move batch/4K
   renders to `hyperframes lambda` if volume exceeds local capacity.

## Compliance flags (client contracts)
- Veo is a paid-tier **preview** offering: commercial use permitted under current
  Google terms, but re-verify at contract signing and before each campaign.
  Output carries SynthID watermark — never strip; disclose AI use.
- ElevenLabs: commercial license on paid plans; broadcast/OTT music needs
  Enterprise. No streaming-platform distribution of generated music.
- The Health Place: canonical name unconfirmed (site metadata says "VitaMinta");
  `brand.json` carries `canonical_name_confirmed: false` until client sign-off —
  the brief compiler surfaces this warning automatically.
