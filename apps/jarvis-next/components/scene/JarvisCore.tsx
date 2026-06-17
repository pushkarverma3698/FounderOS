"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Float, MeshDistortMaterial, Sphere, Stars } from "@react-three/drei";
import * as THREE from "three";
import { DEPARTMENTS } from "@/lib/jarvis-api";

function DeptNode({
  angle,
  radius,
  color,
  active,
}: {
  angle: number;
  radius: number;
  color: string;
  active: boolean;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;

  useFrame((state) => {
    if (!ref.current) return;
    ref.current.position.y = Math.sin(state.clock.elapsedTime * 1.2 + angle) * 0.15;
    const scale = active ? 1.35 : 1;
    ref.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.08);
  });

  return (
    <mesh ref={ref} position={[x, 0, z]}>
      <sphereGeometry args={[0.12, 16, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={active ? 2.2 : 0.8}
        toneMapped={false}
      />
    </mesh>
  );
}

export function JarvisCore({ activeDept, pulse }: { activeDept: string | null; pulse: boolean }) {
  const coreRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (coreRef.current) {
      coreRef.current.rotation.y = t * 0.25;
      coreRef.current.rotation.x = Math.sin(t * 0.3) * 0.15;
    }
    if (ringRef.current) {
      ringRef.current.rotation.z = t * 0.4;
      const s = pulse ? 1.08 + Math.sin(t * 8) * 0.04 : 1;
      ringRef.current.scale.setScalar(s);
    }
  });

  return (
    <group>
      <ambientLight intensity={0.35} />
      <pointLight position={[4, 6, 4]} intensity={2.5} color="#4ef0ff" />
      <pointLight position={[-5, -2, -3]} intensity={1.2} color="#a78bfa" />

      <Float speed={1.2} rotationIntensity={0.4} floatIntensity={0.6}>
        <Sphere ref={coreRef} args={[1.1, 64, 64]}>
          <MeshDistortMaterial
            color="#0a2840"
            emissive="#1a5a7a"
            emissiveIntensity={0.6}
            distort={0.35}
            speed={2}
            roughness={0.15}
            metalness={0.9}
          />
        </Sphere>
      </Float>

      <mesh ref={ringRef} rotation={[Math.PI / 2.2, 0, 0]}>
        <torusGeometry args={[1.65, 0.02, 16, 128]} />
        <meshStandardMaterial color="#4ef0ff" emissive="#4ef0ff" emissiveIntensity={1.5} toneMapped={false} />
      </mesh>

      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.1, 0.008, 8, 128]} />
        <meshStandardMaterial color="#ffc857" emissive="#ffc857" emissiveIntensity={0.6} toneMapped={false} />
      </mesh>

      <Stars radius={8} depth={40} count={1200} factor={3} saturation={0} fade speed={0.5} />

      {DEPARTMENTS.map((d, i) => {
        const angle = (i / DEPARTMENTS.length) * Math.PI * 2;
        return (
          <DeptNode
            key={d.id}
            angle={angle}
            radius={2.35}
            color={d.color}
            active={activeDept?.includes(d.id) ?? false}
          />
        );
      })}
    </group>
  );
}
