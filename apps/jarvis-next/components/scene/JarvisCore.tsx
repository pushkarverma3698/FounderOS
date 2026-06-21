"use client";

/**
 * JarvisCore — the plasma energy orb (the "presence").
 * ====================================================
 * A single GPU point-cloud distributed across THREE radial bands so the orb
 * reads as a volume, not a hollow shell:
 *   - shell 0  core  : a dense, white-hot filled sphere (the luminous centre)
 *   - shell 1  body  : the main golden-spiral surface (simplex-noise displaced)
 *   - shell 2  halo  : a sparse, slow-drifting outer atmosphere of filaments
 *
 * The fragment shader applies a plasma gradient (hot-white → cyan → violet →
 * gold) by radial position, with the active department colour layered on top as
 * a tint. Everything is additively blended and emissive-boosted so the Bloom
 * pass (see SceneCanvas) renders a cinematic, volumetric glow.
 *
 * State reactions (lerped):
 *   busy        → faster internal noise (computation)
 *   speaking    → larger amplitude + voice-cadence pulsing
 *   recognizing → contracts + tightens (listening)
 *   activeDept  → tints toward that department's signature hue
 */

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { DEPARTMENTS } from "@/lib/jarvis-api";

const CORE_COUNT = 4200;
const BODY_COUNT = 10500;
const HALO_COUNT = 3800;
const COUNT = CORE_COUNT + BODY_COUNT + HALO_COUNT;
const MAX_RADIUS = 2.1; // normalisation bound for the colour ramp

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uNoiseFreq;
  uniform float uNoiseAmp;
  uniform float uVolume;
  uniform float uSensitivity;
  uniform float uVerify;   // 0..1 — completion "validating" beat
  uniform float uAwait;    // 0..1 — HITL approval pending

  attribute float randoms;
  attribute float aShell;   // 0 = core, 1 = body, 2 = halo

  varying float vRandom;
  varying float vShell;
  varying float vRadius;    // 0 (centre) .. 1 (outer rim)

  // Simplex 3D Noise — Ashima Arts / Ian McEwan
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vRandom = randoms;
    vShell = aShell;
    vRadius = clamp(length(position) / ${MAX_RADIUS.toFixed(1)}, 0.0, 1.0);

    // Contract slightly while listening; collapse a touch while verifying.
    float baseScale = mix(1.0, 0.78, uSensitivity) * mix(1.0, 0.93, uVerify);
    vec3 pos = position * baseScale;

    // Per-shell displacement: core stays tight, halo drifts wide + slow.
    float shellAmp  = aShell < 0.5 ? 0.35 : (aShell < 1.5 ? 1.0 : 1.7);
    float shellFreq = aShell < 1.5 ? 1.0 : 0.55;

    vec3 noisePos = pos * uNoiseFreq * shellFreq + vec3(0.0, 0.0, uTime * 0.5);
    float noiseVal = snoise(noisePos);
    // Verifying calms the surface — the data "settles" as it validates.
    float displace = noiseVal * uNoiseAmp * shellAmp * (1.0 + uVolume * 2.2) * mix(1.0, 0.45, uVerify);
    pos += normalize(position) * displace;

    // Voice-cadence contraction pulse (body + halo).
    pos += normalize(position) * sin(uTime * 18.0) * uVolume * 0.15 * step(0.5, aShell);

    // Awaiting approval: slow, deliberate breathing so the founder notices.
    pos += normalize(position) * sin(uTime * 2.4) * uAwait * 0.10;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Per-shell point size; core dense, body large, halo fine.
    float shellSize = aShell < 0.5 ? 16.0 : (aShell < 1.5 ? 18.0 : 9.0);
    float listenShrink = mix(1.0, 0.7, uSensitivity);
    gl_PointSize = shellSize * listenShrink * (1.0 / -mvPosition.z)
                 * (1.0 + displace * 0.5 + uVolume * 1.4);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorActive;
  uniform float uActivation;
  uniform float uTime;
  uniform float uSensitivity;
  uniform float uVerify;
  uniform float uAwait;

  varying float vRandom;
  varying float vShell;
  varying float vRadius;

  // Plasma gradient: hot-white centre → cyan → violet → gold rim.
  vec3 plasmaRamp(float t) {
    vec3 cHot    = vec3(0.92, 1.00, 1.00); // near-white core
    vec3 cCyan   = vec3(0.306, 0.941, 1.0); // #4ef0ff
    vec3 cViolet = vec3(0.655, 0.545, 0.98); // #a78bfa
    vec3 cGold   = vec3(1.0, 0.784, 0.341);  // #ffc857
    vec3 col = mix(cHot, cCyan, smoothstep(0.0, 0.30, t));
    col = mix(col, cViolet, smoothstep(0.28, 0.64, t));
    col = mix(col, cGold,   smoothstep(0.64, 1.0,  t));
    return col;
  }

  void main() {
    // Anti-aliased round point.
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    if (dist > 0.5) discard;
    float alpha = smoothstep(0.5, 0.10, dist);

    // Ramp parameter: radial position fuzzed by per-point randomness so the
    // gradient feels organic rather than perfectly concentric.
    float t = clamp(vRadius * 0.85 + (vRandom - 0.5) * 0.35, 0.0, 1.0);
    vec3 color = plasmaRamp(t);

    // Layer the active department hue on top as a tint.
    color = mix(color, uColorActive, uActivation * 0.55);

    // Verifying: validate-green wash with a faint vertical scan.
    vec3 cVerify = vec3(0.36, 1.0, 0.69); // #5cffb0
    float scan = 0.85 + 0.15 * sin(vRadius * 14.0 - uTime * 6.0);
    color = mix(color, cVerify * scan, uVerify * 0.40);

    // Awaiting approval: amber hold so the founder's eye is pulled to the core.
    vec3 cAmber = vec3(1.0, 0.784, 0.341); // #ffc857
    color = mix(color, cAmber, uAwait * 0.55);

    // Shimmer + emissive boost (per shell) to feed the bloom pass.
    float spark = sin(uTime * 4.0 + vRandom * 6.283) * 0.12 + 0.88;
    float emissive = vShell < 0.5 ? 2.2 : (vShell < 1.5 ? 2.1 : 1.25);
    float shellAlpha = vShell < 0.5 ? 0.95 : (vShell < 1.5 ? 0.7 : 0.42);

    float finalAlpha = alpha * shellAlpha * mix(1.0, 0.75, uSensitivity) * spark;
    gl_FragColor = vec4(color * spark * emissive, finalAlpha);
  }
`;

/** Uniform direction on the unit sphere. */
function randomDirection(): [number, number, number] {
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const s = Math.sin(phi);
  return [s * Math.cos(theta), s * Math.sin(theta), Math.cos(phi)];
}

export interface JarvisCoreProps {
  activeDept: string | null;
  speaking: boolean;
  recognizing: boolean;
  busy: boolean;
  verifying: boolean;
  awaitingApproval: boolean;
  reducedMotion: boolean;
}

export function JarvisCore({
  activeDept,
  speaking,
  recognizing,
  busy,
  verifying,
  awaitingApproval,
  reducedMotion,
}: JarvisCoreProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const [positions, randoms, shells] = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const rnd = new Float32Array(COUNT);
    const shell = new Float32Array(COUNT);
    let i = 0;

    // Shell 0 — core: filled volume, biased toward the centre (white-hot).
    for (let k = 0; k < CORE_COUNT; k++, i++) {
      const r = 0.85 * Math.cbrt(Math.random());
      const [dx, dy, dz] = randomDirection();
      pos[i * 3] = dx * r;
      pos[i * 3 + 1] = dy * r;
      pos[i * 3 + 2] = dz * r;
      rnd[i] = Math.random();
      shell[i] = 0;
    }

    // Shell 1 — body: golden-spiral surface, lightly fuzzed thickness.
    const golden = Math.PI * (1 + Math.sqrt(5));
    for (let k = 0; k < BODY_COUNT; k++, i++) {
      const phi = Math.acos(1 - 2 * (k / BODY_COUNT));
      const theta = golden * k;
      const r = 1.25 + (Math.random() - 0.5) * 0.16;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      rnd[i] = Math.random();
      shell[i] = 1;
    }

    // Shell 2 — halo: sparse outer atmosphere.
    for (let k = 0; k < HALO_COUNT; k++, i++) {
      const r = 1.5 + Math.random() * 0.6;
      const [dx, dy, dz] = randomDirection();
      pos[i * 3] = dx * r;
      pos[i * 3 + 1] = dy * r;
      pos[i * 3 + 2] = dz * r;
      rnd[i] = Math.random();
      shell[i] = 2;
    }

    return [pos, rnd, shell];
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uNoiseFreq: { value: 1.25 },
      uNoiseAmp: { value: 0.16 },
      uVolume: { value: 0.0 },
      uSensitivity: { value: 0.0 },
      uColorActive: { value: new THREE.Color("#4ef0ff") },
      uActivation: { value: 0.0 },
      uVerify: { value: 0.0 },
      uAwait: { value: 0.0 },
    }),
    [],
  );

  useFrame((state) => {
    const mat = materialRef.current;
    if (!mat) return;
    const u = mat.uniforms;
    const t = state.clock.elapsedTime;

    u.uTime.value = t;

    if (pointsRef.current) {
      // Reduced motion calms the perpetual rotation to a near-still drift.
      const spin = reducedMotion ? 0.012 : 0.08;
      pointsRef.current.rotation.y = t * spin;
      pointsRef.current.rotation.x = Math.sin(t * 0.04) * (reducedMotion ? 0.01 : 0.05);
    }

    u.uSensitivity.value = THREE.MathUtils.lerp(u.uSensitivity.value, recognizing ? 1.0 : 0.0, 0.08);
    u.uNoiseFreq.value = THREE.MathUtils.lerp(u.uNoiseFreq.value, busy ? 2.8 : 1.25, 0.06);
    u.uNoiseAmp.value = THREE.MathUtils.lerp(u.uNoiseAmp.value, speaking ? 0.35 : 0.16, 0.08);
    u.uVerify.value = THREE.MathUtils.lerp(u.uVerify.value, verifying ? 1.0 : 0.0, 0.12);
    u.uAwait.value = THREE.MathUtils.lerp(u.uAwait.value, awaitingApproval ? 1.0 : 0.0, 0.07);

    let targetVolume = 0.0;
    if (speaking) {
      // Deterministic cadence under reduced motion (no per-frame randomness).
      const jitter = reducedMotion ? 0.0 : Math.random() * 0.1;
      targetVolume =
        0.18 +
        Math.abs(Math.sin(t * 15.0)) * 0.35 +
        Math.abs(Math.cos(t * 24.0)) * 0.2 +
        jitter;
    }
    u.uVolume.value = THREE.MathUtils.lerp(u.uVolume.value, targetVolume, 0.15);

    const hasActiveDept = !!activeDept;
    u.uActivation.value = THREE.MathUtils.lerp(u.uActivation.value, hasActiveDept ? 1.0 : 0.0, 0.06);
    if (hasActiveDept) {
      const deptObj = DEPARTMENTS.find((d) => activeDept.includes(d.id));
      if (deptObj) {
        (u.uColorActive.value as THREE.Color).lerp(new THREE.Color(deptObj.color), 0.08);
      }
    }
  });

  return (
    <group>
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-randoms" args={[randoms, 1]} />
          <bufferAttribute attach="attributes-aShell" args={[shells, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={materialRef}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={uniforms}
        />
      </points>
    </group>
  );
}
