import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ReactorField } from './ReactorField';
import { ReactorCoreGlow } from './ReactorCoreGlow';
import { Projector } from './Projector';
import { detectBackend, createRenderer, type Backend } from '../../gpu/renderer';
import { isStreaming, type DepartmentNodeData } from '../../types/graph';

/**
 * Particle budget ladder. We start mid-ladder and let the frame monitor settle on
 * whatever this machine actually holds, rather than shipping a number that sounds
 * impressive and stutters.
 */
const BUDGET_LADDER = [40_000, 90_000, 180_000, 320_000, 550_000, 900_000];
const START_RUNG = 3;

export interface ReactorPerf {
  fps: number;
  particles: number;
  backend: Backend | 'detecting';
}

/** A frame this long means the page was throttled, not that the GPU struggled. */
const THROTTLED_FRAME_S = 0.1;

/**
 * Walks the particle budget to the rung this GPU sustains. Downshifts on the
 * first bad second, upshifts only while it has never downshifted, and locks once
 * it finds a stable rung — a budget that oscillates is worse than a low one.
 *
 * Critically, it ignores throttled frames. Browsers clamp requestAnimationFrame
 * hard for backgrounded or occluded pages (measured: 2fps in an unfocused pane,
 * with the canvas UNMOUNTED — so the throttle is environmental, not GPU load).
 * Counting those samples made the monitor downshift to the bottom rung and latch
 * there, so minimising the window permanently degraded the field.
 */
function FrameMonitor({
  rung,
  onRung,
  onSample,
}: {
  rung: number;
  onRung: (next: number) => void;
  onSample: (fps: number) => void;
}) {
  const acc = useRef({ frames: 0, elapsed: 0, everDownshifted: false, locked: false });

  // Discard the in-flight sample whenever visibility changes; the frames either
  // side of the transition are not comparable.
  useEffect(() => {
    const reset = () => {
      acc.current.frames = 0;
      acc.current.elapsed = 0;
    };
    document.addEventListener('visibilitychange', reset);
    return () => document.removeEventListener('visibilitychange', reset);
  }, []);

  useFrame((_, delta) => {
    if (document.hidden || delta > THROTTLED_FRAME_S) {
      acc.current.frames = 0;
      acc.current.elapsed = 0;
      return;
    }

    const a = acc.current;
    a.frames += 1;
    a.elapsed += delta;
    if (a.elapsed < 1) return;

    const fps = a.frames / a.elapsed;
    a.frames = 0;
    a.elapsed = 0;
    onSample(fps);
    if (a.locked) return;

    if (fps < 48 && rung > 0) {
      a.everDownshifted = true;
      onRung(rung - 1);
    } else if (fps > 58 && !a.everDownshifted && rung < BUDGET_LADDER.length - 1) {
      onRung(rung + 1);
    } else if (fps > 52) {
      a.locked = true;
    }
  });

  return null;
}

/**
 * Fixed camera with damped pointer parallax.
 *
 * Deliberately NOT an orbiting camera. The department cards are projected onto
 * their real 3D attractors, so a drifting camera would drag every label around
 * the screen continuously — unreadable in a surface meant for daily use. Parallax
 * keeps the volume feeling dimensional without moving anything you need to read.
 */
function CameraRig({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!enabled) return;
    const onMove = (e: PointerEvent) => {
      target.current.x = (e.clientX / window.innerWidth - 0.5) * 2;
      target.current.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [enabled]);

  useFrame((_, delta) => {
    const k = Math.min(1, delta * 2.2);
    current.current.x += (target.current.x - current.current.x) * k;
    current.current.y += (target.current.y - current.current.y) * k;
    camera.position.set(current.current.x * 9, current.current.y * -6, 126);
    // Aim below centre so the ring sits high enough that the lowest department
    // card clears the command bar pinned to the bottom of the stage.
    camera.lookAt(0, -7, 0);
  });

  return null;
}

interface ReactorStageProps {
  departments: DepartmentNodeData[];
  spendRatio: number;
  /** Shared screen-projection buffer the DOM overlay reads. */
  projection: Float32Array;
  onPerf?: (perf: ReactorPerf) => void;
}

export function ReactorStage({
  departments,
  spendRatio,
  projection,
  onPerf,
}: ReactorStageProps) {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [rung, setRung] = useState(START_RUNG);
  const [fps, setFps] = useState(0);
  const reduceMotion = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    let alive = true;
    void detectBackend().then((b) => alive && setBackend(b));
    return () => {
      alive = false;
    };
  }, []);

  const particles = reduceMotion.current ? BUDGET_LADDER[0] : BUDGET_LADDER[rung];

  useEffect(() => {
    onPerf?.({ fps, particles, backend: backend ?? 'detecting' });
  }, [fps, particles, backend, onPerf]);

  const handleSample = useCallback((v: number) => setFps(Math.round(v)), []);

  // MUST be memoized. R3F treats a new `gl` value as a new renderer and tears
  // the WebGPU device down and rebuilds it — calling createRenderer() inline in
  // the JSX rebuilt the whole renderer on every state change and pinned the
  // frame rate at 2fps.
  const glFactory = useMemo(() => (backend ? createRenderer(backend) : null), [backend]);

  const activeCount = departments.filter((d) => isStreaming(d.status)).length;
  const failureRatio = departments.length
    ? departments.filter((d) => d.status === 'ERROR').length / departments.length
    : 0;

  if (!backend || !glFactory) return null;

  return (
    <Canvas
      gl={glFactory}
      camera={{ position: [0, 0, 126], fov: 52, near: 1, far: 900 }}
      dpr={[1, 1.75]}
      style={{ position: 'absolute', inset: 0 }}
    >
      <ReactorField
        departments={departments}
        particleCount={particles}
        spendRatio={spendRatio}
        failureRatio={failureRatio}
      />
      <ReactorCoreGlow
        active={activeCount > 0}
        gated={departments.some((d) => d.status === 'HITL_PAUSE')}
      />
      <Projector buffer={projection} />
      <CameraRig enabled={!reduceMotion.current} />
      {!reduceMotion.current && (
        <FrameMonitor rung={rung} onRung={setRung} onSample={handleSample} />
      )}
    </Canvas>
  );
}
