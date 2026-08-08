# The Reactor — FounderOS 3D Control Surface

**Date:** 2026-08-08
**Status:** Built and live-verified on `gemini/antigravityChanges`
**Scope:** Sub-project A of four. B (voice→browser control), C (self-operating loop) and
D (visual research, folded into A) are separate specs.

## The idea

The headless LangGraph kernel — one pure-code supervisor dispatching to seven ReAct
departments — is rendered as a single GPU particle volume. The seven departments are
attractors inside that volume; dispatched work is particles physically streaming from the
core out to an attractor.

**The spectacle is the telemetry.** A generic Jarvis dashboard has an orb that spins at a
fixed rate regardless of what the system is doing. Here every visual property is bound to
kernel state:

| Visual property | Bound to |
|---|---|
| Stream from core → attractor | department `status` is `EXECUTING` or `TOOL_CALL` |
| Particle tint (cyan → amber) | department is `HITL_PAUSE` |
| Field brightness | today's spend against `BUDGET_DAILY_USD` |
| Turbulence amplitude | share of departments in `ERROR` |
| Core tone | any pending HITL gate |

If ignoring the screen costs nothing and emits no signal, the design is wrong. A gate
pending turns the core amber; a failure visibly shakes the field.

## The tension this design resolves

Research (Awwwards 2026 winners, WebGPU/TSL showcases, agent-UI literature) surfaced a
conflict worth stating: **every viral 3D reference is a portfolio**, optimised for a
30-second first impression. This is a control surface looked at daily, for hours, to make
decisions. Dashboard research found *zero* participants using 3D — occlusion and depth
ambiguity are a per-session tax, while the wow is amortised over one visit. The honest
test: *does the third axis encode a variable?*

Resolution: the depth encodes routing topology, and a **flat HUD layer** carries every
number that has to be read precisely. Spectacle for state, flat type for values.

## Architecture

```
src/gpu/ring.ts               pure math, NO three import — ring geometry + projection
                              constants shared with the DOM layer
src/gpu/renderer.ts           backend probe (WebGPU → WebGL2) + memoized renderer factory
src/gpu/reactorMaterial.ts    TSL point material + geometry seeding

src/components/reactor/
  ReactorStage.tsx            Canvas, fixed camera + pointer parallax, frame monitor
  ReactorField.tsx            the points mesh; department state → 8x1 RGBA float texture
  ReactorCoreGlow.tsx         billboarded additive core disc
  Projector.tsx               projects attractors → screen space into a shared buffer
  DepartmentOverlay.tsx       DOM cards pinned to projected attractor positions
  ReactorErrorBoundary.tsx    isolates GPU failure from the data layer
```

### Load-bearing decisions

**Motion is analytic, not a compute simulation.** Every particle's position is a pure
function of `(seed, clock, department state)`. No ping-pong state buffer, no compute pass.
This gives identical behaviour on the WebGPU and WebGL2 backends from one code path, and
the simulation cannot accumulate error or blow up. The cost — no history-dependent physics
— buys nothing for "work streams outward, turbulence is the failure rate".

**Department state travels through a texture, not uniforms.** An 8×1 RGBA float texture
(slot 7 is the core reservoir, permanently idle). Updating costs 32 floats and adding a
channel later costs nothing.

**Projection uses a shared buffer, not React state.** The projector runs at 60fps; routing
it through state would re-render seven cards every frame. The DOM layer reads the buffer on
its own rAF and mutates `style.transform` directly.

**The ring faces the camera (XY plane).** A ring in the XZ plane projects to a narrow
ellipse from any near-horizontal camera, which collapsed all seven labels onto each other.
`ring.ts` and the TSL shader compute the same expression and must stay in sync.

**Fixed camera, not orbiting.** Cards are pinned to projected attractors, so a drifting
camera would drag every label around the screen continuously. Pointer parallax keeps the
volume dimensional without moving anything you need to read.

**The particle budget is measured, not chosen.** A ladder (40k → 900k) walks to whatever
the GPU sustains, downshifting on the first bad second and locking once stable. It ignores
throttled frames — browsers clamp rAF hard for backgrounded pages, and counting those
samples made it latch at the bottom rung permanently.

## Error handling

- `ReactorErrorBoundary` isolates GPU failure. Measured incident: mounting r3f@9 on React 18
  threw during render and blanked the *entire* page. The volume is decoration over data and
  must never take the data with it.
- Backend probe falls back WebGPU → WebGL2; the analytic shader runs on both.
- `prefers-reduced-motion` drops to the lowest rung and disables parallax.
- **Gateway honesty:** health state starts at `connecting`, never `online`. A failed poll
  sets `offline` and blanks the readings rather than holding the last good value. When
  offline the header reads `UNREACHABLE`, a banner names the refused port and states the
  data is seeded, the metric cards read `NO SIGNAL`, and dispatch is disabled.

## Verification

- `tsc --noEmit` exit 0; `vite build` exit 0
- Entry chunk 74.5 KB gzip; reactor 427.6 KB gzip lazy-loaded (was 502 KB blocking)
- Live: WebGPU backend on Apple M4, settled at 320k particles
- 13/13 offline-path assertions, 9/9 online-path assertions (simulated healthy gateway)
- Zero card collisions at 1600×1000 and 1180×820
- Zero banned tokens (indigo/purple/sky/emerald, Inter/Roboto) in the render path

## Known limits

- **Frame rate is unverified on the founder's own display.** The Browser pane throttles rAF
  to ~2fps regardless of content (confirmed with the canvas unmounted), so the settled
  budget of 320k reflects a throttle-free sample count, not a sustained real-world 60fps
  measurement. Needs confirming in normal Chrome.
- The SSE trace path has never run against a live kernel gateway.
- Department data is seeded; only `/health` spend is wired to real telemetry.
