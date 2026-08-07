import React, { useEffect, useRef } from 'react';

export const CanvasBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    // Preload wallpaper asset
    const img = new Image();
    img.src = '/assets/jarvis_hud_wallpaper.jpg';
    let imgLoaded = false;
    img.onload = () => { imgLoaded = true; };

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    // Particle System
    const particles: { x: number; y: number; vx: number; vy: number; radius: number; alpha: number }[] = [];
    for (let i = 0; i < 90; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        radius: Math.random() * 2 + 0.5,
        alpha: Math.random() * 0.6 + 0.2,
      });
    }

    let scanY = 0;
    let angle = 0;

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Deep space background
      ctx.fillStyle = '#010308';
      ctx.fillRect(0, 0, width, height);

      // Draw blended wallpaper asset if loaded
      if (imgLoaded) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.drawImage(img, 0, 0, width, height);
        ctx.restore();
      }

      // Sci-Fi Radial Ambient Glow
      const bgGrad = ctx.createRadialGradient(width / 2, height * 0.38, 50, width / 2, height * 0.38, Math.max(width, height) / 1.1);
      bgGrad.addColorStop(0, 'rgba(11, 30, 54, 0.4)');
      bgGrad.addColorStop(0.5, 'rgba(3, 7, 18, 0.7)');
      bgGrad.addColorStop(1, 'rgba(1, 3, 8, 0.95)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Scanning Laser Line
      scanY = (scanY + 1.2) % height;
      ctx.save();
      const laserGrad = ctx.createLinearGradient(0, scanY - 10, 0, scanY + 10);
      laserGrad.addColorStop(0, 'rgba(94, 234, 212, 0)');
      laserGrad.addColorStop(0.5, 'rgba(94, 234, 212, 0.25)');
      laserGrad.addColorStop(1, 'rgba(94, 234, 212, 0)');
      ctx.fillStyle = laserGrad;
      ctx.fillRect(0, scanY - 10, width, 20);
      ctx.restore();

      // 3D Orbital Rings in Center
      ctx.save();
      ctx.translate(width / 2, height * 0.42);
      angle += 0.005;

      // Outer Ring
      ctx.beginPath();
      ctx.ellipse(0, 0, 240, 90, angle * 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(94, 234, 212, 0.15)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 12]);
      ctx.stroke();

      // Inner Ring
      ctx.beginPath();
      ctx.ellipse(0, 0, 160, 60, -angle * 0.8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 8]);
      ctx.stroke();

      ctx.restore();

      // Floating Particles
      ctx.setLineDash([]);
      particles.forEach((p, idx) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(94, 234, 212, ${p.alpha})`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#5eead4';
        ctx.fill();
        ctx.shadowBlur = 0;

        // Connect nearby particles with subtle laser lines
        for (let j = idx + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < 100) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(94, 234, 212, ${0.12 * (1 - dist / 100)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-0" />;
};
