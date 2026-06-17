"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

const Canvas = dynamic(() => import("@react-three/fiber").then((m) => m.Canvas), { ssr: false });
const JarvisCore = dynamic(() => import("./JarvisCore").then((m) => m.JarvisCore), { ssr: false });

export function JarvisScene({
  activeDept,
  speaking,
  recognizing,
}: {
  activeDept: string | null;
  speaking: boolean;
  recognizing: boolean;
}) {
  const pulse = speaking || recognizing;

  return (
    <div className="scene-root">
      <Canvas camera={{ position: [0, 0.5, 5.5], fov: 42 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true }}>
        <color attach="background" args={["#020408"]} />
        <fog attach="fog" args={["#020408", 6, 14]} />
        <Suspense fallback={null}>
          <JarvisCore activeDept={activeDept} pulse={pulse} />
        </Suspense>
      </Canvas>
      <div className="scene-vignette" aria-hidden />
      <div className="scene-grid" aria-hidden />
      <div className="scene-ring scene-ring-outer" aria-hidden />
      <div className="scene-ring scene-ring-inner" aria-hidden />
    </div>
  );
}
