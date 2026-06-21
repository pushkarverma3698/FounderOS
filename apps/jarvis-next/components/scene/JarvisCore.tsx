"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { DEPARTMENTS } from "@/lib/jarvis-api";

const vertexShader = `
  uniform float uTime;
  uniform float uNoiseFreq;
  uniform float uNoiseAmp;
  uniform float uVolume;
  uniform float uSensitivity;
  
  attribute float randoms;
  
  varying vec3 vPosition;
  varying float vRandom;
  
  // Simplex 3D Noise by Ashima Arts / Ian McEwan
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
    
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;
    
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vPosition = position;
    vRandom = randoms;
    
    // Scale orb down in high sensitivity listening mode
    float baseScale = mix(1.35, 0.65, uSensitivity);
    vec3 pos = position * baseScale;
    
    // Calculate noise displacement based on time and status
    vec3 noisePos = pos * uNoiseFreq + vec3(0.0, 0.0, uTime * 0.55);
    float noiseVal = snoise(noisePos);
    
    float displace = noiseVal * uNoiseAmp * (1.0 + uVolume * 2.2);
    pos += normalize(position) * displace;
    
    // Cadence contraction/pulsation
    pos += normalize(position) * sin(uTime * 18.0) * uVolume * 0.15;
    
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    
    // Scale point size based on depth and voice level
    float baseSize = mix(12.0, 6.0, uSensitivity);
    gl_PointSize = baseSize * (1.0 / -mvPosition.z) * (1.0 + displace * 0.6 + uVolume * 1.5);
  }
`;

const fragmentShader = `
  uniform vec3 uColorBase;
  uniform vec3 uColorActive;
  uniform float uActivation;
  uniform float uTime;
  uniform float uSensitivity;
  
  varying vec3 vPosition;
  varying float vRandom;
  
  void main() {
    // Perfect anti-aliased round point
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    if (dist > 0.5) discard;
    
    float alpha = smoothstep(0.5, 0.12, dist);
    
    // Morph base to active department color
    vec3 color = mix(uColorBase, uColorActive, uActivation);
    
    // Core dynamic spark/shimmer effect
    float spark = sin(uTime * 4.0 + vRandom * 6.283) * 0.12 + 0.88;
    
    // Make particles softer in listening mode
    float finalAlpha = alpha * mix(0.75, 0.55, uSensitivity) * spark;
    
    gl_FragColor = vec4(color * spark, finalAlpha);
  }
`;

export function JarvisCore({
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
  const pointsRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  // Generate 2500 points distributed inside/on a sphere
  const count = 2500;
  const [positions, randoms] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Golden spiral distribution on sphere surface
      const phi = Math.acos(1 - 2 * (i / count));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 1.45 + (Math.random() - 0.5) * 0.15; // slightly fuzz the thickness

      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);

      rnd[i] = Math.random();
    }
    return [pos, rnd];
  }, []);

  const uniforms = useMemo(() => {
    return {
      uTime: { value: 0 },
      uNoiseFreq: { value: 1.25 },
      uNoiseAmp: { value: 0.16 },
      uVolume: { value: 0.0 },
      uSensitivity: { value: 0.0 },
      uColorBase: { value: new THREE.Color("#4ef0ff") },
      uColorActive: { value: new THREE.Color("#4ef0ff") },
      uActivation: { value: 0.0 },
    };
  }, []);

  useFrame((state) => {
    if (!materialRef.current) return;
    const currentUniforms = materialRef.current.uniforms;

    // Time increment
    currentUniforms.uTime.value = state.clock.elapsedTime;

    // Rotation of points container
    if (pointsRef.current) {
      pointsRef.current.rotation.y = state.clock.elapsedTime * 0.08;
      pointsRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.04) * 0.05;
    }

    // Lerp sensitivity (listening contraction)
    const targetSensitivity = recognizing ? 1.0 : 0.0;
    currentUniforms.uSensitivity.value = THREE.MathUtils.lerp(
      currentUniforms.uSensitivity.value,
      targetSensitivity,
      0.08
    );

    // Lerp frequency (computational speed)
    const targetFreq = busy ? 2.8 : 1.25;
    currentUniforms.uNoiseFreq.value = THREE.MathUtils.lerp(
      currentUniforms.uNoiseFreq.value,
      targetFreq,
      0.06
    );

    // Lerp amplitude (speaking deformation)
    const targetAmp = speaking ? 0.35 : 0.16;
    currentUniforms.uNoiseAmp.value = THREE.MathUtils.lerp(
      currentUniforms.uNoiseAmp.value,
      targetAmp,
      0.08
    );

    // Simulate voice volume cadence
    let targetVolume = 0.0;
    if (speaking) {
      const t = state.clock.elapsedTime;
      targetVolume = 0.18 + Math.abs(Math.sin(t * 15.0)) * 0.35 + Math.abs(Math.cos(t * 24.0)) * 0.2 + Math.random() * 0.1;
    }
    currentUniforms.uVolume.value = THREE.MathUtils.lerp(
      currentUniforms.uVolume.value,
      targetVolume,
      0.15
    );

    // Color morphing base on active department
    const hasActiveDept = !!activeDept;
    currentUniforms.uActivation.value = THREE.MathUtils.lerp(
      currentUniforms.uActivation.value,
      hasActiveDept ? 1.0 : 0.0,
      0.06
    );

    if (hasActiveDept) {
      const deptObj = DEPARTMENTS.find((d) => activeDept.includes(d.id));
      if (deptObj) {
        const activeColor = new THREE.Color(deptObj.color);
        currentUniforms.uColorActive.value.lerp(activeColor, 0.08);
      }
    }
  });

  return (
    <group>
      <ambientLight intensity={0.1} />
      <pointLight position={[2, 4, 3]} intensity={1.5} color="#4ef0ff" />
      
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[positions, 3]}
          />
          <bufferAttribute
            attach="attributes-randoms"
            args={[randoms, 1]}
          />
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
