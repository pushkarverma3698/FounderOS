import { useEffect, useRef } from 'react';

const PARTICLE_COUNT = 70;
const LINK_DISTANCE = 118;

/**
 * Ambient deep-space field behind the whole interface: the 2035 reactor plate,
 * a drifting particle mesh, and a slow scanning laser. Purely decorative and
 * pointer-transparent — it never intercepts interaction.
 */
export function CanvasBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let width = 0;
    let height = 0;

    const plate = new Image();
    plate.src = '/assets/jarvis_hud_wallpaper.jpg';
    let plateReady = false;
    plate.onload = () => {
      plateReady = true;
    };

    const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
      x: 0,
      y: 0,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: Math.random() * 1.5 + 0.4,
      a: Math.random() * 0.4 + 0.12,
    }));

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles.forEach((p) => {
        if (p.x === 0 && p.y === 0) {
          p.x = Math.random() * width;
          p.y = Math.random() * height;
        }
      });
    };
    resize();
    window.addEventListener('resize', resize);

    let scanY = 0;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = '#000206';
      ctx.fillRect(0, 0, width, height);

      // Reactor plate as pure atmosphere. It is blurred hard and overscanned on
      // purpose: the source art contains its own fake telemetry ("STABILITY:
      // 99.7%", "ACTIVE NODES: 2,450,111"), and legible fake numbers behind a
      // real telemetry dashboard are worse than no plate at all.
      if (plateReady) {
        ctx.save();
        ctx.globalAlpha = 0.13;
        ctx.filter = 'blur(34px) saturate(1.4)';
        const over = 1.18;
        ctx.drawImage(
          plate,
          (width - width * over) / 2,
          (height - height * over) / 2,
          width * over,
          height * over
        );
        ctx.restore();
        ctx.filter = 'none';
      }

      // Vignette toward the core
      const well = ctx.createRadialGradient(
        width / 2,
        height * 0.47,
        40,
        width / 2,
        height * 0.47,
        Math.max(width, height) * 0.8
      );
      well.addColorStop(0, 'rgba(0, 229, 255, 0.04)');
      well.addColorStop(0.35, 'rgba(0, 5, 12, 0.72)');
      well.addColorStop(1, 'rgba(0, 2, 6, 0.98)');
      ctx.fillStyle = well;
      ctx.fillRect(0, 0, width, height);

      // Scanning laser
      scanY = (scanY + 0.9) % (height + 120);
      const laser = ctx.createLinearGradient(0, scanY - 60, 0, scanY + 60);
      laser.addColorStop(0, 'rgba(0, 229, 255, 0)');
      laser.addColorStop(0.5, 'rgba(0, 229, 255, 0.07)');
      laser.addColorStop(1, 'rgba(0, 229, 255, 0)');
      ctx.fillStyle = laser;
      ctx.fillRect(0, scanY - 60, width, 120);

      // Particle mesh
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 229, 255, ${p.a})`;
        ctx.fill();

        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          const dist = Math.hypot(p.x - q.x, p.y - q.y);
          if (dist < LINK_DISTANCE) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = `rgba(0, 229, 255, ${0.07 * (1 - dist / LINK_DISTANCE)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      frame = requestAnimationFrame(draw);
    };

    if (reduceMotion) {
      // Paint one static frame and stop.
      plate.onload = () => {
        plateReady = true;
        draw();
        cancelAnimationFrame(frame);
      };
      draw();
      cancelAnimationFrame(frame);
    } else {
      draw();
    }

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-0" aria-hidden="true" />;
}
