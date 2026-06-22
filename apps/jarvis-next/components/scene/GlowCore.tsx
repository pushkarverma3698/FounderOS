"use client";

/**
 * GlowCore — the orb's solid luminous centre.
 * ===========================================
 * A camera-facing additive disc with a radial-gradient shader (hot-white centre
 * → cyan → transparent). Discrete points alone read as a sparse starfield; this
 * gives the orb a dense, glowing BODY that the Bloom pass amplifies into the
 * luminous plasma core of the reference. It does not rotate — it is the inner
 * light the filament points orbit.
 *
 * Breathes when idle; swells with `busy`/`speaking`, tightens with `recognizing`.
 */

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uIntensity;
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    float d = clamp(length(c) * 2.0, 0.0, 1.0);   // 0 centre .. 1 edge
    float a = pow(smoothstep(1.0, 0.0, d), 2.6);    // bright core, soft falloff
    vec3 col = mix(uHot, uColor, smoothstep(0.0, 0.55, d));
    gl_FragColor = vec4(col * a * uIntensity, a);
  }
`;

export interface GlowCoreProps {
  busy: boolean;
  speaking: boolean;
  recognizing: boolean;
  verifying: boolean;
  awaitingApproval: boolean;
}

const BASE_COLOR = new THREE.Color("#3733cf");
const AMBER_COLOR = new THREE.Color("#b87a1f");
const BASE_HOT = new THREE.Color("#aedcff");
const AMBER_HOT = new THREE.Color("#ffe0a0");

export function GlowCore({ busy, speaking, recognizing, verifying, awaitingApproval }: GlowCoreProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uIntensity: { value: 1.0 },
      uColor: { value: BASE_COLOR.clone() },
      uHot: { value: BASE_HOT.clone() },
    }),
    [],
  );

  useFrame((state) => {
    if (!matRef.current) return;
    const u = matRef.current.uniforms;
    const t = state.clock.elapsedTime;

    // Awaiting approval pulses; verifying holds a calm, brighter centre.
    const target = awaitingApproval
      ? 1.2 + Math.sin(t * 2.4) * 0.18
      : verifying
        ? 1.15
        : busy
          ? 1.35
          : speaking
            ? 1.5
            : recognizing
              ? 1.0
              : 0.88;
    const breathe = 1.0 + Math.sin(t * 0.8) * 0.06;
    u.uIntensity.value = THREE.MathUtils.lerp(u.uIntensity.value, target * breathe, 0.06);

    // Shift the centre toward amber while approval is pending, back otherwise.
    (u.uColor.value as THREE.Color).lerp(awaitingApproval ? AMBER_COLOR : BASE_COLOR, 0.06);
    (u.uHot.value as THREE.Color).lerp(awaitingApproval ? AMBER_HOT : BASE_HOT, 0.06);
  });

  return (
    <mesh>
      <planeGeometry args={[3.6, 3.6]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={uniforms}
      />
    </mesh>
  );
}
