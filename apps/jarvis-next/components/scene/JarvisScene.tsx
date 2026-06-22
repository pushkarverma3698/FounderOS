"use client";

/**
 * JarvisScene — public scene container.
 * =====================================
 * Stable API consumed by page.tsx. The heavy WebGL subtree (Canvas + plasma
 * core + bloom) lives in SceneCanvas and is loaded with `ssr: false`, so neither
 * three.js nor postprocessing ever executes during the server render.
 */

import dynamic from "next/dynamic";

const SceneCanvas = dynamic(
  () => import("./SceneCanvas").then((m) => m.SceneCanvas),
  { ssr: false },
);

export interface JarvisSceneProps {
  activeDept: string | null;
  speaking: boolean;
  recognizing: boolean;
  busy: boolean;
  verifying: boolean;
  awaitingApproval: boolean;
  reducedMotion: boolean;
}

export function JarvisScene(props: JarvisSceneProps) {
  return (
    <div className="scene-root">
      <SceneCanvas {...props} />
      <div className="scene-vignette" aria-hidden />
    </div>
  );
}
