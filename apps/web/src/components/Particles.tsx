import { useEffect, useRef } from 'react';

/** 萤火虫氛围粒子层：全屏 canvas、pointer-events 关闭、尊重 reduced-motion */
export default function Particles({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let alive = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const N = 34;
    const flies = Array.from({ length: N }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00022,
      vy: (Math.random() - 0.5) * 0.00018,
      phase: Math.random() * Math.PI * 2,
      size: 1 + Math.random() * 1.8,
      hue: Math.random() < 0.75 ? '232, 197, 116' : '170, 190, 255',
    }));

    let last = performance.now();
    const frame = (now: number) => {
      if (!alive) return;
      const dt = Math.min(now - last, 50);
      last = now;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const f of flies) {
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.phase += 0.0012 * dt;
        if (f.x < -0.02) f.x = 1.02;
        if (f.x > 1.02) f.x = -0.02;
        if (f.y < -0.02) f.y = 1.02;
        if (f.y > 1.02) f.y = -0.02;
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(f.phase));
        const px = f.x * canvas.width;
        const py = f.y * canvas.height;
        const r = f.size * dpr * 3;
        const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, `rgba(${f.hue}, ${0.5 * tw})`);
        grad.addColorStop(1, `rgba(${f.hue}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled]);

  if (!enabled) return null;
  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1 }} />;
}
