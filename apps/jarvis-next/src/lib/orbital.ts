/**
 * Deterministic orbital layout for the Supervisor → 7 ReAct department topology.
 *
 * Everything here is pure math over a normalised 1000x1000 viewBox. No DOM, no
 * refs, no drag. Node positions are a function of (index, count, phase) alone,
 * which is why nodes can never overlap or collapse onto each other the way the
 * Framer-Motion `dragConstraints` layout did.
 */

/** Normalised design space. All coordinates below are in this space. */
export const VIEW = 1000;

/** Supervisor kernel sits slightly above centre, mirroring the reactor reference. */
export const CORE = { x: 500, y: 470 } as const;

/** Orbit radii — an ellipse, not a circle, so the ring reads as a 3D plane. */
const ORBIT_RX = 355;
const ORBIT_RY = 300;

export interface OrbitPoint {
  x: number;
  y: number;
  /** Angle in radians, measured from 12 o'clock, clockwise. */
  angle: number;
  /** 0 = far side of the ellipse, 1 = near side. Drives depth cues. */
  depth: number;
}

/**
 * Position for slot `index` of `count`, rotated by `phase` radians.
 * Slot 0 starts at 12 o'clock and slots advance clockwise.
 */
export function orbitPoint(index: number, count: number, phase = 0): OrbitPoint {
  const angle = (index / count) * Math.PI * 2 + phase;
  const x = CORE.x + Math.sin(angle) * ORBIT_RX;
  const y = CORE.y - Math.cos(angle) * ORBIT_RY;
  // cos(angle) is +1 at the top of the ellipse and -1 at the bottom; remap to 0..1
  // so nodes at the bottom (nearest the viewer) render larger and brighter.
  const depth = (1 - Math.cos(angle)) / 2;
  return { x, y, angle, depth };
}

/**
 * Quadratic bezier from the core to an orbit point, bowed perpendicular to the
 * chord so the routes read as curved data streams rather than a starburst.
 */
export function streamPath(target: OrbitPoint): string {
  const dx = target.x - CORE.x;
  const dy = target.y - CORE.y;
  const midX = CORE.x + dx * 0.5;
  const midY = CORE.y + dy * 0.5;
  // Perpendicular offset, scaled by chord length so long routes bow more.
  const len = Math.hypot(dx, dy) || 1;
  const bow = len * 0.16;
  const ctrlX = midX + (-dy / len) * bow;
  const ctrlY = midY + (dx / len) * bow;
  return `M ${CORE.x} ${CORE.y} Q ${ctrlX} ${ctrlY} ${target.x} ${target.y}`;
}

/** Convert a design-space coordinate to a CSS percentage string. */
export function pct(value: number): string {
  return `${(value / VIEW) * 100}%`;
}
