import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  positionGeometry,
  uniform,
  texture,
  vec2,
  vec3,
  float,
  sin,
  cos,
  mix,
  fract,
  time,
} from 'three/tsl';

import { DEPT_COUNT, STATE_SLOTS, ATTRACTOR_RADIUS } from './ring';

export { DEPT_COUNT, STATE_SLOTS, ATTRACTOR_RADIUS } from './ring';
const CORE_RADIUS = 15;
const SHELL = 15;
const SCATTER = 6.5;

/**
 * `uniform(0)` matches three's `(value: number, type?: "float")` overload and
 * already resolves to a float uniform whose `.value` is a plain number. Infer it
 * rather than hand-writing the node type — the node generics do not survive a
 * manual cast.
 */
const floatUniform = () => uniform(0);
export type FloatUniform = ReturnType<typeof floatUniform>;

export interface ReactorHandles {
  material: THREE.PointsNodeMaterial;
  /** RGBA per department: [activity, gated, reserved, reserved]. */
  stateTexture: THREE.DataTexture;
  stateData: Float32Array;
  uniforms: {
    spend: FloatUniform;
    failure: FloatUniform;
  };
}

/**
 * Builds the reactor's point material.
 *
 * Motion is ANALYTIC — every particle's position is a pure function of its seed,
 * the clock, and its department's state. There is no ping-pong state buffer and
 * no compute pass, which means:
 *   - identical behaviour on the WebGPU and WebGL2 backends (one code path),
 *   - the simulation cannot accumulate error or blow up,
 *   - department state can change mid-flight without corrupting anything.
 *
 * The cost is no history-dependent physics (no collisions, no true trails). For
 * "work streams from the core to a department, turbulence is the failure rate"
 * that buys nothing, so it is not a compromise.
 */
export function createReactorMaterial(): ReactorHandles {
  const stateData = new Float32Array(STATE_SLOTS * 4);
  const stateTexture = new THREE.DataTexture(
    stateData,
    STATE_SLOTS,
    1,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  stateTexture.minFilter = THREE.NearestFilter;
  stateTexture.magFilter = THREE.NearestFilter;
  stateTexture.needsUpdate = true;

  const uSpend = floatUniform();
  const uFailure = floatUniform();

  const material = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // `position` carries the per-particle seed, not a location.
  const seed = positionGeometry;
  const meta = attribute<'vec4'>('aMeta', 'vec4'); // [deptIndex, phase, sizeSeed, speedSeed]

  const dept = meta.x;
  const state = texture(stateTexture, vec2(dept.add(0.5).div(STATE_SLOTS), 0.5));
  const activity = state.x;
  const gated = state.y;

  const t = time;

  const position = Fn(() => {
    // Attractor ring lives in the XY plane, FACING the camera, with only a small
    // Z wobble for depth. A ring in the XZ plane projects to a narrow ellipse
    // from any near-horizontal camera, which collapsed the seven department
    // labels on top of each other. Keep this identical to
    // `attractorWorldPosition()` in Projector.tsx — the DOM cards are pinned to
    // whatever that function returns.
    const ang = dept.div(DEPT_COUNT).mul(Math.PI * 2);
    const attractor = vec3(
      sin(ang).mul(ATTRACTOR_RADIUS),
      cos(ang).mul(ATTRACTOR_RADIUS),
      sin(ang.mul(2)).mul(ATTRACTOR_RADIUS * 0.3)
    );

    // Idle: a slowly swirling shell around the core.
    const orbitAngle = seed.x.mul(Math.PI * 2).add(t.mul(0.1).mul(seed.y.add(1.6)));
    const radius = float(CORE_RADIUS).add(seed.z.abs().mul(SHELL));
    const home = vec3(
      sin(orbitAngle).mul(radius),
      seed.y.mul(SHELL * 0.85),
      cos(orbitAngle).mul(radius)
    );

    // Active: ride a quadratic bezier from the core out to the attractor.
    const progress = fract(t.mul(float(0.22).add(meta.w.mul(0.2))).add(meta.y));
    const control = attractor.mul(0.55).add(vec3(0, ATTRACTOR_RADIUS * 0.38, 0));
    const leg1 = mix(vec3(0, 0, 0), control, progress);
    const leg2 = mix(control, attractor, progress);
    const streamed = mix(leg1, leg2, progress).add(
      seed.mul(SCATTER).mul(progress.oneMinus().mul(0.8).add(0.3))
    );

    const blended = mix(home, streamed, activity).toVar();

    // Curl-ish turbulence. Divergence-free enough to look like flow rather than
    // jitter, and its amplitude is the kernel's failure rate.
    const f = float(0.05);
    const turb = vec3(
      sin(blended.y.mul(f).add(t.mul(0.9))).mul(cos(blended.z.mul(f).sub(t.mul(0.6)))),
      sin(blended.z.mul(f).sub(t.mul(1.1))).mul(cos(blended.x.mul(f).add(t.mul(0.5)))),
      sin(blended.x.mul(f).add(t.mul(0.8))).mul(cos(blended.y.mul(f).sub(t.mul(0.7))))
    );

    return blended.add(turb.mul(float(1.6).add(uFailure.mul(20))));
  })();

  material.positionNode = position;

  // Cyan is the resting tone; a gated department pushes its particles to amber.
  const accent = vec3(0.0, 0.9, 1.0);
  const signal = vec3(1.0, 0.69, 0.13);
  const tint = mix(accent, signal, gated);
  const brightness = float(0.22)
    .add(activity.mul(0.5))
    .add(uSpend.mul(0.22))
    .add(meta.z.mul(0.12));

  // Additive blending accumulates: with hundreds of thousands of overlapping
  // points, a brightness near 1 drives every channel to saturation and the field
  // reads white instead of cyan. Keep per-particle intensity low and let density
  // do the work — that is also what makes density legible as spend.
  material.colorNode = tint.mul(brightness);
  material.opacityNode = float(0.16).add(activity.mul(0.3));
  material.sizeNode = float(1.0).add(meta.z.mul(1.2)).add(activity.mul(1.1));

  return {
    material,
    stateTexture,
    stateData,
    uniforms: { spend: uSpend, failure: uFailure },
  };
}

/**
 * Particle seeds and per-particle metadata. Written once at mount; department
 * state travels through the state texture instead, so changing what the kernel
 * is doing never touches these buffers.
 */
export function createReactorGeometry(count: number): THREE.BufferGeometry {
  const seeds = new Float32Array(count * 3);
  const meta = new Float32Array(count * 4);

  // Part of the field stays in the core reservoir (slot 7, never active) so the
  // centre never empties out when every department goes quiet. Kept modest: a
  // dense idle core saturates additively and washes the cyan out to white.
  const reservoirCutoff = Math.floor(count * 0.17);

  for (let i = 0; i < count; i++) {
    // Rejection-free spherical seed: uniform direction, cube-rooted radius.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = Math.cbrt(Math.random());
    seeds[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    seeds[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * r;
    seeds[i * 3 + 2] = Math.cos(phi) * r;

    meta[i * 4] = i < reservoirCutoff ? DEPT_COUNT : i % DEPT_COUNT;
    meta[i * 4 + 1] = Math.random();
    meta[i * 4 + 2] = Math.random();
    meta[i * 4 + 3] = Math.random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aMeta', new THREE.BufferAttribute(meta, 4));
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(),
    ATTRACTOR_RADIUS * 2
  );
  return geometry;
}
