import * as THREE from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

/**
 * Which backend the browser will actually give us.
 *
 * Measured on this machine (Apple M4, Chrome): WebGPU adapter GRANTED, with
 * WebGL2 + EXT_color_buffer_float as fallback. We probe rather than assume,
 * because the particle budget is sized off the answer.
 */
export async function detectBackend(): Promise<Backend> {
  if (!('gpu' in navigator) || !navigator.gpu) return 'webgl2';
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? 'webgpu' : 'webgl2';
  } catch {
    return 'webgl2';
  }
}

/**
 * Renderer factory for R3F's async `gl` prop.
 *
 * three's WebGPURenderer carries its own WebGL2 backend, so a single renderer
 * class covers both paths — `forceWebGL` flips it. The particle field is written
 * against the vertex stage only (analytic motion, no ping-pong state buffer), so
 * it runs identically on either backend instead of needing two code paths.
 */
export function createRenderer(backend: Backend) {
  return async (props: Record<string, unknown>) => {
    const renderer = new THREE.WebGPURenderer({
      ...(props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]),
      antialias: false,
      alpha: true,
      forceWebGL: backend === 'webgl2',
    });
    await renderer.init();
    return renderer;
  };
}
