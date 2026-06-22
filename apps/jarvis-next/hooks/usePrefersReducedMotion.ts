"use client";

import { useEffect, useState } from "react";

/**
 * usePrefersReducedMotion — tracks the OS "reduce motion" accessibility setting.
 *
 * Drives the WebGL core's motion budget (rotation speed, jitter) so the orb can
 * calm down for users who are motion-sensitive — and incidentally lightens the
 * per-frame work on large displays. CSS keyframe animations are handled
 * separately via the `prefers-reduced-motion` media query in the stylesheets.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reduced;
}
