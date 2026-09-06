# 2026-09-05 — House of Hulda: Phase 3 Interactive Ecosystem & Adversarial Visual Refinements

## 1. Goal & Context
Transformed house-of-hulda on dedicated branch feature/phase-3-interactive-ecosystem:
1. Resolved all 5 adversarial visual and UX flaws identified during Phase 2 review.
2. Implemented the Phase 3 Interactive Ecosystem:
   - <HeritageSandbox>: Tactile 3D Kath-Kuni architectural joint sandbox.
   - <WebGLGallery>: Liquid distortion image gallery with drag-to-scrub GLSL shader.
3. Provided clear production pipelines for remaining assets (atmospheric video loops, ambient audio, 3D GLB model).

## 2. Changes Made
- Act 2 (L-02) Copy Relocation: Shifted to story-scrim-left, items-start.
- Act 2 (L-03) Center Alignment: Changed section to justify-center.
- Midnight Skybox Lighting Calibration: Directional intensity decayed to 0.02, ambient to #020612.
- Mobile Audio Button Layout: Relocated from bottom dock to top-4 right-20.
- HeritageSandbox.tsx: 8-course modular Kath-Kuni joint model with Drei PresentationControls and cursor point lighting.
- WebGLGallery.tsx: Fluid wave ripple displacement shader with drag scrub.
- CinematicExperience.tsx: Dynamically imported modals, added trigger buttons in L-03 and L-05 with pointer-events-auto.

## 3. Empirical Verification Results
- pnpm build: 0 errors across 22 static pages.
- Playwright runtime verification on Desktop (1440x900) and Mobile (390x844): Verified modal opening, interaction, shaders, and escape closing.

## 4. Atmospheric Video Overlays Integrated (A-01, A-02, A-03)
- Processed 3 Google Veo/Runway generated videos from Downloads into seamless 1s crossfade loops via FFmpeg xfade:
  - `public/videos/mist_loop.mp4` (2.3 MB)
  - `public/videos/steam_wisps.mp4` (2.1 MB)
  - `public/videos/hearth_embers.mp4` (2.2 MB)
- Stripped audio tracks (-an) to enable instantaneous autoplay and reduce bundle overhead.
- Implemented `AtmosphericVideoPlane.tsx` with custom GLSL edge feathering shader:
  - Additive blending (`THREE.AdditiveBlending`) renders pure black background 100% transparent.
  - Smoothstep boundary masks eradicate all edge lines and corner logos.
  - Automatic playback pausing outside active scroll ranges saves GPU and battery.
- Verified on live Next.js server with Playwright: glowing embers, steam, and mist render seamlessly over the 3D displacement plane.
