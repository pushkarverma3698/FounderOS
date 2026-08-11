/**
 * Shared geometry of the department ring — deliberately free of any `three`
 * import.
 *
 * The DOM layer (App, DepartmentOverlay) needs these constants, and three's
 * WebGPU build is ~1.8MB. Importing them from a module that touches `three`
 * dragged the whole renderer into the main bundle and defeated the code split,
 * leaving the instrument layer waiting on the decoration to download.
 */

/** Seven ReAct departments; slot 7 is the core reservoir and never activates. */
export const DEPT_COUNT = 7;
export const STATE_SLOTS = 8;

/**
 * Ring radius the department attractors sit on, in world units. Sized so the
 * seven cards clear each other once projected at the stage camera's distance.
 */
export const ATTRACTOR_RADIUS = 45;

/** Stride of the shared projection buffer: screen x, screen y, depth scale. */
export const PROJ_STRIDE = 3;
export const PROJ_LENGTH = DEPT_COUNT * PROJ_STRIDE;

export interface RingPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * World position of a department attractor.
 *
 * The ring lives in the XY plane FACING the camera, with only a small Z wobble
 * for depth. A ring in the XZ plane projects to a narrow ellipse from any
 * near-horizontal camera, which collapsed the seven labels onto each other.
 *
 * The shader in `reactorMaterial.ts` recomputes this same expression in TSL.
 * Both must agree — the DOM cards are pinned to these coordinates, so any drift
 * puts labels somewhere the particles do not actually go.
 */
export function attractorPosition(index: number): RingPoint {
  const ang = (index / DEPT_COUNT) * Math.PI * 2;
  return {
    x: Math.sin(ang) * ATTRACTOR_RADIUS,
    y: Math.cos(ang) * ATTRACTOR_RADIUS,
    z: Math.sin(ang * 2) * ATTRACTOR_RADIUS * 0.3,
  };
}
