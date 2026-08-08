import React, { useEffect, useRef } from 'react';
import { voiceEngine } from '../audio/voiceEngine';

export const SpatialVoiceParticleOrb: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let rotationX = 0;
    let rotationY = 0;
    let isSpeaking = false;
    let isListening = false;
    let amplitude = 0;

    const unsubscribe = voiceEngine.subscribe((state) => {
      isSpeaking = state.isSpeaking;
      isListening = state.isListening;
      amplitude = state.amplitude;
    });

    const NUM_PARTICLES = 160;
    const radius = 65;

    // Generate 3D Fibonacci Sphere Particles
    const particles = Array.from({ length: NUM_PARTICLES }, (_, i) => {
      const phi = Math.acos(1 - (2 * (i + 0.5)) / NUM_PARTICLES);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      return {
        x: radius * Math.sin(phi) * Math.cos(theta),
        y: radius * Math.sin(phi) * Math.sin(theta),
        z: radius * Math.cos(phi),
        baseRadius: radius,
        color: i % 2 === 0 ? '#5eead4' : '#818cf8',
      };
    });

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;

      ctx.clearRect(0, 0, width, height);

      rotationX += 0.008;
      rotationY += 0.012;

      const activeAmp = isSpeaking || isListening ? 1.5 + amplitude * 1.2 : 1.0;
      const cosX = Math.cos(rotationX);
      const sinX = Math.sin(rotationX);
      const cosY = Math.cos(rotationY);
      const sinY = Math.sin(rotationY);

      // Draw Glowing Core Wave Rings
      if (isSpeaking || isListening) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius * activeAmp * 0.8, 0, Math.PI * 2);
        ctx.strokeStyle = isListening ? 'rgba(251, 191, 36, 0.4)' : 'rgba(94, 234, 212, 0.5)';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = isListening ? '#fbbf24' : '#5eead4';
        ctx.shadowBlur = 20;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, radius * activeAmp * 1.1, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.3)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      // Render 3D Projected Particles
      particles.forEach((p) => {
        // Rotate Y
        let x1 = p.x * cosY - p.z * sinY;
        const z1 = p.z * cosY + p.x * sinY;

        // Rotate X
        const y1 = p.y * cosX - z1 * sinX;
        const z2 = z1 * cosX + p.y * sinX;

        // Apply Voice Amplitude Expansion
        x1 *= activeAmp;
        const finalY = y1 * activeAmp;

        // 3D Perspective Projection
        const fov = 180;
        const scale = fov / (fov + z2);
        const px = cx + x1 * scale;
        const py = cy + finalY * scale;

        const size = Math.max(1, 2.5 * scale * (isSpeaking ? 1.4 : 1.0));
        const alpha = Math.min(1, Math.max(0.2, (z2 + radius) / (radius * 2)));

        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fillStyle = isListening
          ? `rgba(251, 191, 36, ${alpha})`
          : isSpeaking
          ? `rgba(94, 234, 212, ${alpha})`
          : `rgba(129, 140, 248, ${alpha * 0.6})`;
        ctx.fill();
      });

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      unsubscribe();
    };
  }, []);

  return (
    <div className="relative w-48 h-48 flex items-center justify-center pointer-events-none select-none">
      <canvas ref={canvasRef} width={200} height={200} className="w-full h-full" />
    </div>
  );
};
