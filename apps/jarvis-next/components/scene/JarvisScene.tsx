"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

const Canvas = dynamic(() => import("@react-three/fiber").then((m) => m.Canvas), { ssr: false });
const JarvisCore = dynamic(() => import("./JarvisCore").then((m) => m.JarvisCore), { ssr: false });

export function JarvisScene({
  activeDept,
  speaking,
  recognizing,
  busy,
}: {
  activeDept: string | null;
  speaking: boolean;
  recognizing: boolean;
  busy: boolean;
}) {
  return (
    <div className="scene-root">
      <Canvas 
        camera={{ position: [0, 0, 5.0], fov: 42 }} 
        dpr={[1, 1.5]} 
        gl={{ antialias: true, alpha: true }}
      >
        <color attach="background" args={["#050505"]} />
        <fog attach="fog" args={["#050505", 5, 12]} />
        <Suspense fallback={null}>
          <JarvisCore 
            activeDept={activeDept} 
            speaking={speaking} 
            recognizing={recognizing} 
            busy={busy} 
          />
        </Suspense>
      </Canvas>
      <div className="scene-vignette" aria-hidden />
    </div>
  );
}
