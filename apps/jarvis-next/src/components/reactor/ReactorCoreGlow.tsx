import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec3, vec4, float, uv, length, smoothstep, sin, mix, time } from 'three/tsl';

/**
 * The core: a soft additive disc at the origin the particle streams flow out of.
 *
 * Billboarded against the camera each frame. It must look at the CAMERA, not at
 * the origin — the mesh sits at the origin itself, so `lookAt(0,0,0)` is
 * degenerate and leaves the quad edge-on and invisible from most angles.
 *
 * Shader rather than a sprite texture so the tone can cross-fade to signal amber
 * when a HITL gate is pending without loading a second asset.
 */
export function ReactorCoreGlow({ active, gated }: { active: boolean; gated: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);

  const { material, uGate, uActive } = useMemo(() => {
    const gate = uniform(0);
    const act = uniform(0);

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    mat.colorNode = Fn(() => {
      const d = length(uv().sub(0.5)).mul(2);
      const tone = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.69, 0.13), gate);

      // Tight centre plus a wide corona. Kept dim on purpose — this sits on top
      // of an additive particle field, so anything near full alpha blows the
      // whole middle of the screen out to white and buries the streams.
      const centre = smoothstep(0.3, 0.0, d).mul(0.5);
      const corona = smoothstep(1.0, 0.1, d).mul(0.07);
      const pulse = sin(time.mul(float(1.1).add(act.mul(1.9)))).mul(0.1).add(1);
      const alpha = centre.add(corona).mul(pulse).mul(float(0.4).add(act.mul(0.45)));

      return vec4(tone, alpha);
    })();

    return { material: mat, uGate: gate, uActive: act };
  }, []);

  useFrame(({ camera }, delta) => {
    const k = Math.min(1, delta * 3);
    uGate.value += ((gated ? 1 : 0) - uGate.value) * k;
    uActive.value += ((active ? 1 : 0) - uActive.value) * k;
    meshRef.current?.quaternion.copy(camera.quaternion);
  });

  return (
    <mesh ref={meshRef} material={material} renderOrder={-1}>
      {/* Kept small. At 92 units the amber corona covered the entire particle
          mass and additively pushed the red channel up everywhere, so the whole
          field read gold-white instead of cyan. */}
      <planeGeometry args={[46, 46]} />
    </mesh>
  );
}
