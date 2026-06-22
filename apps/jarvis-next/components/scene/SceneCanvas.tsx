"use client";

/**
 * SceneCanvas — the WebGL scene graph (client-only).
 * ==================================================
 * Holds the r3f <Canvas>, the plasma <JarvisCore>, and the post-processing
 * <EffectComposer> + <Bloom> pass. Bloom is THE lever that turns the additive
 * point-cloud from a faint smatter of specks into a luminous, volumetric core.
 *
 * This whole subtree is loaded behind `ssr: false` (see JarvisScene.tsx) because
 * three.js + postprocessing touch WebGL/DOM and cannot render server-side.
 */

import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { JarvisCore } from "./JarvisCore";
import { GlowCore } from "./GlowCore";

export interface SceneCanvasProps {
  activeDept: string | null;
  speaking: boolean;
  recognizing: boolean;
  busy: boolean;
  verifying: boolean;
  awaitingApproval: boolean;
  reducedMotion: boolean;
}

export function SceneCanvas(props: SceneCanvasProps) {
  return (
    <Canvas
      camera={{ position: [0, 0, 4.4], fov: 42 }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true }}
    >
      {/* Dark backdrop maximises bloom contrast; fog gives the core depth. */}
      <color attach="background" args={["#04060c"]} />
      <fog attach="fog" args={["#04060c", 5, 12]} />

      <Suspense fallback={null}>
        <GlowCore
          busy={props.busy}
          speaking={props.speaking}
          recognizing={props.recognizing}
          verifying={props.verifying}
          awaitingApproval={props.awaitingApproval}
        />
        <JarvisCore {...props} />
      </Suspense>

      {/* Cinematic glow. Threshold at 0 so every additive point feeds the halo;
          mipmapBlur gives a soft, wide, production-grade bloom. */}
      <EffectComposer multisampling={0}>
        <Bloom
          mipmapBlur
          intensity={2.0}
          luminanceThreshold={0.0}
          luminanceSmoothing={0.2}
          radius={0.8}
        />
      </EffectComposer>
    </Canvas>
  );
}
