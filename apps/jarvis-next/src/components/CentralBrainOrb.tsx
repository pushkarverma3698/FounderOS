import type { CSSProperties } from 'react';
import { ReactorCore } from './ReactorCore';
import type { NodeStatus } from '../types/graph';

interface CentralBrainOrbProps {
  status: NodeStatus;
  receiptCount: number;
  activeTurnCount: number;
  onClick: () => void;
}

export function CentralBrainOrb({
  status,
  receiptCount,
  activeTurnCount,
  onClick,
}: CentralBrainOrbProps) {
  const executing = status === 'EXECUTING' || status === 'TOOL_CALL';
  const gated = status === 'HITL_PAUSE';
  const tone = gated ? 'var(--signal)' : 'var(--accent)';

  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex flex-col items-center justify-center cursor-pointer transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98] focus:outline-none"
    >
      {/* Containment aura */}
      <span
        aria-hidden="true"
        className="absolute w-[260px] h-[260px] rounded-full border pointer-events-none animate-breathe"
        style={{
          borderColor: tone,
          boxShadow: `0 0 90px -20px ${tone}`,
          animationDuration: executing ? '1.8s' : '4.2s',
        }}
      />

      {/* Counter-rotating containment rings */}
      <span
        aria-hidden="true"
        className="absolute w-[212px] h-[212px] rounded-full border border-dashed pointer-events-none spin-cw"
        style={{ borderColor: 'rgba(var(--accent-rgb), 0.26)', '--spin': '26s' } as CSSProperties}
      />
      <span
        aria-hidden="true"
        className="absolute w-[176px] h-[176px] rounded-full border border-dotted pointer-events-none spin-ccw"
        style={{ borderColor: 'rgba(var(--accent-rgb), 0.38)', '--spin': '17s' } as CSSProperties}
      />

      {/* Vector reactor (WebGL is React-19-only; this app is on React 18) */}
      <ReactorCore status={status} activeTurnCount={activeTurnCount} />

      {/* Identity plate */}
      <span className="mt-3 flex flex-col items-center gap-1.5 pointer-events-none">
        <span className="hud-panel ticks flex items-center gap-2.5 px-3.5 py-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full animate-breathe"
            style={{ background: tone, boxShadow: `0 0 10px ${tone}` }}
          />
          <span className="value-heavy text-[12px] tracking-[0.2em] text-chrome">SUPERVISOR</span>
          <span
            className="font-mono text-[9px] font-medium tracking-widest px-1.5 py-0.5"
            style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
          >
            {status}
          </span>
        </span>

        <span className="label-micro">
          stamped receipts
          <span className="text-accent font-medium ml-1.5 tabular-nums">{receiptCount}</span>
        </span>
      </span>
    </button>
  );
}
