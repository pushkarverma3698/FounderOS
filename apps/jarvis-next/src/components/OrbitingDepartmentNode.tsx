import { soundEngine } from '../audio/soundEngine';
import { isStreaming, type DepartmentNodeData } from '../types/graph';
import { pct, type OrbitPoint } from '../lib/orbital';

export type { DepartmentNodeData } from '../types/graph';

interface OrbitingDepartmentNodeProps {
  node: DepartmentNodeData;
  point: OrbitPoint;
  /** Orbit slot index — seeds the bob phase so nodes never pulse in lockstep. */
  slot: number;
  onSelect: (node: DepartmentNodeData) => void;
}

/**
 * A department readout pinned to its orbit slot.
 *
 * Two things here are deliberate and load-bearing:
 *  1. It is NOT draggable. Framer Motion v13 snaps `dragConstraints` children into
 *     the constraint box on mount, which collapsed all seven nodes onto one point.
 *  2. The orbit anchor (`left`/`top` + centring translate) lives on the OUTER
 *     element and the float animation on the inner one. Any transform applied to
 *     the anchor would fight the `-translate-x/y-1/2` centring and throw each card
 *     half its own width off its true orbit point.
 */
export function OrbitingDepartmentNode({
  node,
  point,
  slot,
  onSelect,
}: OrbitingDepartmentNodeProps) {
  const Icon = node.icon;
  const streaming = isStreaming(node.status);
  const gated = node.status === 'HITL_PAUSE';
  const failed = node.status === 'ERROR';

  // Depth cue: nodes on the near (lower) arc sit forward — larger and brighter.
  const scale = 0.9 + point.depth * 0.16;

  const edge = gated
    ? 'border-signal/70'
    : failed
    ? 'border-alarm/70'
    : streaming
    ? 'border-accent/80'
    : 'border-accent/20';

  const halo = gated
    ? '0 0 34px -8px rgba(var(--signal-rgb),0.75)'
    : failed
    ? '0 0 34px -8px rgba(var(--alarm-rgb),0.75)'
    : streaming
    ? '0 0 40px -8px rgba(var(--accent-rgb),0.7)'
    : '0 0 24px -12px rgba(var(--accent-rgb),0.45)';

  const statusTone = gated
    ? 'text-signal text-glow-signal'
    : failed
    ? 'text-alarm'
    : streaming
    ? 'text-accent text-glow'
    : 'text-chrome/45';

  return (
    <div
      style={{
        left: pct(point.x),
        top: pct(point.y),
        zIndex: 20 + Math.round(point.depth * 10),
      }}
      className="absolute -translate-x-1/2 -translate-y-1/2 w-[186px]"
    >
      <div
        className="bob"
        style={
          {
            '--bob-dur': `${5 + slot * 0.4}s`,
            '--bob-delay': `${slot * 300}ms`,
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          onClick={() => {
            soundEngine.click();
            onSelect(node);
          }}
          style={{ transform: `scale(${scale})` }}
          className="w-full text-left cursor-pointer rise-in origin-center transition-transform duration-200 hover:!scale-[1.06] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <div
            className={`hud-panel ticks px-3 py-2.5 border ${edge} transition-colors duration-300`}
            style={{ boxShadow: halo }}
          >
            <div className="flex items-center gap-2.5">
              <span
                className={`grid place-items-center w-7 h-7 shrink-0 border ${
                  streaming
                    ? 'bg-accent text-void border-accent'
                    : gated
                    ? 'bg-signal/15 text-signal border-signal/40'
                    : 'bg-accent/10 text-accent/80 border-accent/30'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
              </span>

              <span className="min-w-0">
                <span className="block value-heavy text-[13px] leading-none text-chrome truncate">
                  {node.name}
                </span>
                <span className="block label-micro mt-1 truncate">{node.department}</span>
              </span>
            </div>

            <div className="mt-2.5 pt-2 border-t border-accent/12 flex items-center justify-between font-mono text-[10px]">
              <span className={`font-medium tracking-wider ${statusTone}`}>{node.status}</span>
              <span className="text-chrome/40 font-light tabular-nums">
                R<span className="text-accent/90 ml-0.5">{node.receiptCount}</span>
              </span>
            </div>

            <p className="mt-1.5 font-mono font-light text-[10px] text-chrome/60 truncate">
              {node.lastAction}
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
