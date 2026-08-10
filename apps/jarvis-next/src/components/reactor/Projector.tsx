import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three/webgpu';
import { DEPT_COUNT, PROJ_STRIDE, attractorPosition } from '../../gpu/ring';

const WORLD = Array.from({ length: DEPT_COUNT }, (_, i) => {
  const p = attractorPosition(i);
  return new Vector3(p.x, p.y, p.z);
});
const scratch = new Vector3();

/**
 * Projects each department attractor to screen space every frame and writes the
 * result into a shared buffer.
 *
 * Deliberately writes to a buffer instead of React state: this runs at 60fps and
 * setting state here would re-render the whole overlay 60 times a second. The DOM
 * layer reads the buffer on its own rAF and mutates transforms directly.
 */
export function Projector({ buffer }: { buffer: Float32Array }) {
  const { camera, size } = useThree();

  useFrame(() => {
    for (let i = 0; i < DEPT_COUNT; i++) {
      scratch.copy(WORLD[i]);
      const distance = camera.position.distanceTo(scratch);
      scratch.project(camera);

      const base = i * PROJ_STRIDE;
      buffer[base] = (scratch.x * 0.5 + 0.5) * size.width;
      buffer[base + 1] = (-scratch.y * 0.5 + 0.5) * size.height;
      // Near attractors read slightly larger; clamped so text stays readable.
      buffer[base + 2] = Math.max(0.82, Math.min(1.12, 150 / distance));
    }
  });

  return null;
}
