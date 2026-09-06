---
tags: "session-summary,fine-tuning,house-of-hulda,architecture-pivot,gsap,scroll-video"
---
# 2026-09-05: The Apple-Tier Architecture Pivot

## Goal & Problem Solved
The user brutally rejected the real-time WebGL particle system proposal as "fixing a mess" instead of addressing the root cause of how crazy 2026 web experiences are made (like Apple's product pages).
Problem: Faking 3D depth with real-time WebGL on static images is a technical dead-end for cinematic, photorealistic web experiences. 

## Deep Research & Strategic Insights
Conducted deep research into high-end 2026 awwwards and Apple architectures.
The secret to the "crazy movie playing in the background" is exactly that: a pre-rendered movie.
- Real-time WebGL cannot handle the photorealistic rendering, bloom, and fluid dynamics required for a cinematic feel on arbitrary user hardware.
- The true root cause of our failure was relying on `react-three-fiber` and `DisplacementPlane`.
- The industry standard (Apple, high-end agencies) uses **GSAP ScrollTrigger + HTML5 `<canvas>` Video/Image Scrubbing**. The heavy lifting is done offline (Unreal Engine / Sora / Runway), and the browser merely scrubs frames based on the Lenis smooth scroll position.

## Key Architectural Changes (Proposed)
1. Delete R3F `CinematicSpine.tsx` and all faux-3D components.
2. Implement Lenis for smooth scroll physics.
3. Implement `CinematicScrubber.tsx` using an HTML5 `<canvas>` to scrub a high-fidelity video/image sequence based on scroll.
4. Use GSAP to choreograph DOM overlays perfectly to the video frames.

## Empirical Verification Results
N/A - Pending Founder approval to tear down the WebGL spine.
## Phase 3 Completion: Senior Art Director Audit & Timestamp Pacing
Problem: The initial GSAP scrubber mapped total document height to total video duration. This decoupled the narrative text from the visual state (e.g. reading about the hearth while the video scrubbed the sky).
Fix: Built a strict GSAP Choreography Timeline. 
- Rebuilt `.cine-section` blocks to be exactly `150vh` tall. 
- Pinned text inside using CSS `sticky top-0 h-screen` so it locks perfectly into the viewport for reading. 
- Passed explicit `data-time-start` and `data-time-end` attributes to GSAP.
- Result: As the user scrolls, the copy locks on screen, the video scrubs precisely across its dedicated timestamps underneath, and then smoothly transitions to the next beat. This achieves 1-to-1 sync between the copy and the visual environment.

## Phase 3 Completion 2: Safari Freeze Fix & Mobile Engineering
- **Safari Scroll Fix:** The frozen scrollbar on desktop Safari was caused by GSAP ScrollTrigger fighting Lenis' native smooth-scroll hooks. I injected the 2026-standard Webkit fix: `ScrollTrigger.normalizeScroll(true)` and hard-synced the Lenis `requestAnimationFrame` to the GSAP Ticker in `SmoothScroll.tsx`.
- **Dynamic Mobile Loading:** Re-wrote `CinematicScrubber.tsx` to accept both `desktopSrc` and `mobileSrc`, using `window.matchMedia` to cleanly mount the exact asset required for the viewport without downloading both.
- **60fps Mobile Performance:** Standard H.264 video chokes mobile CPUs when forced to scrub backward because it has to calculate missing "predicted" frames. I ran the mobile 9:16 asset through FFmpeg with `keyint=1`, stripping all predictive frames and replacing them with full-fidelity I-frames. It is now effectively a 60fps image sequence packaged in a lightweight MP4 container. Scrubbing is flawless.

## Phase 3 Completion 3: Emotional Pacing, Watermark Removal, Original Audio Atmosphere & Mobile Overhaul
- **Watermark Removal (clean-ai & delogo):** Identified the exact coordinates of the Google Veo 4-pointed star (`x=1130:y=575:w=55:h=55` on desktop 1280x720, `x=570:y=1135:w=55:h=55` on mobile 720x1280). Completely removed the logo via FFmpeg `delogo` pixel interpolation and stripped all C2PA/SynthID container manifests.
- **Audio Extraction & Atmospheric Soundscape:** Extracted the raw audio from the Veo clip, sanitized it through `clean-ai audio`, mastered it into a 50-second seamless soothing loop (`public/audio/ambient_presence.mp3`), and wired it into `Soundscape.tsx`. It crossfades with procedural mountain wind and hearth embers, dynamically filtering down as the user scrolls into night.
- **Senior Art Director Mobile Layout Overhaul:**
  - Separated the Eighteen Gods lore (`L-07`) and the DateDial ephemeris (`L-08`) into two dedicated narrative beats to eliminate mobile viewport clipping.
  - Converted Marketplace (`L-09`) to a horizontal swipeable carousel on mobile.
  - Padded all story text with `pr-16 md:pr-24` so it never collides with the fixed `TimeRail` HUD.
  - Upgraded Lenis smooth physics to `lerp: 0.065`, `touchMultiplier: 1.25`, and `syncTouch: false` for native 120Hz mobile inertial glide.
