import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three/webgpu';
import {
  createReactorGeometry,
  createReactorMaterial,
  DEPT_COUNT,
} from '../../gpu/reactorMaterial';
import { isStreaming, type DepartmentNodeData } from '../../types/graph';

interface ReactorFieldProps {
  departments: DepartmentNodeData[];
  particleCount: number;
  /** 0..1 — today's spend against the daily cap. Drives field brightness. */
  spendRatio: number;
  /** 0..1 — share of departments in an error state. Drives turbulence. */
  failureRatio: number;
}

/**
 * The particle volume. Department state reaches the GPU through an 8x1 RGBA
 * float texture rather than uniforms, so adding a channel later costs nothing
 * and updating costs 32 floats.
 */
export function ReactorField({
  departments,
  particleCount,
  spendRatio,
  failureRatio,
}: ReactorFieldProps) {
  const handles = useMemo(() => createReactorMaterial(), []);
  const geometry = useMemo(() => createReactorGeometry(particleCount), [particleCount]);
  const pointsRef = useRef<THREE.Points>(null);

  // Dispose GPU resources when the particle budget changes or we unmount.
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => {
    const { material, stateTexture } = handles;
    return () => {
      material.dispose();
      stateTexture.dispose();
    };
  }, [handles]);

  // Push department state whenever it actually changes — not per frame.
  useEffect(() => {
    const { stateData, stateTexture } = handles;
    for (let i = 0; i < DEPT_COUNT; i++) {
      const dept = departments[i];
      const base = i * 4;
      stateData[base] = dept && isStreaming(dept.status) ? 1 : 0;
      stateData[base + 1] = dept && dept.status === 'HITL_PAUSE' ? 1 : 0;
      stateData[base + 2] = dept && dept.status === 'ERROR' ? 1 : 0;
      stateData[base + 3] = 0;
    }
    // Slot 7 is the core reservoir: always idle, never gated.
    stateData.fill(0, DEPT_COUNT * 4);
    stateTexture.needsUpdate = true;
  }, [departments, handles]);

  // Ease the scalar uniforms so a status flip reads as the field responding
  // rather than snapping.
  useFrame((_, delta) => {
    const k = Math.min(1, delta * 2.4);
    const { spend, failure } = handles.uniforms;
    spend.value += (spendRatio - spend.value) * k;
    failure.value += (failureRatio - failure.value) * k;
  });

  return (
    <points ref={pointsRef} geometry={geometry} material={handles.material} frustumCulled={false} />
  );
}
