import { useEffect, useRef } from 'react';
import { soundEngine } from '../../audio/soundEngine';
import { isStreaming, type DepartmentNodeData } from '../../types/graph';
import { PROJ_STRIDE } from '../../gpu/ring';

interface DepartmentOverlayProps {
  departments: DepartmentNodeData[];
  projection: Float32Array;
  onSelect: (node: DepartmentNodeData) => void;
}

/**
 * The readable layer: one card per department, pinned to its attractor's
 * projected screen position so the particle streams visibly terminate at the
 * label rather than near it.
 *
 * Positions are applied by mutating `style.transform` inside a private rAF loop.
 * Routing 60fps projection data through React state would re-render seven cards
 * every frame for no benefit.
 */
export function DepartmentOverlay({
  departments,
  projection,
  onSelect,
}: DepartmentOverlayProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      for (let i = 0; i < refs.current.length; i++) {
        const el = refs.current[i];
        if (!el) continue;
        const base = i * PROJ_STRIDE;
        const x = projection[base];
        const y = projection[base + 1];
        const scale = projection[base + 2] || 1;
        // Buffer starts zeroed; skip until the first projection lands so cards
        // never flash in the top-left corner on mount.
        if (x === 0 && y === 0) {
          el.style.opacity = '0';
          continue;
        }
        el.style.opacity = '1';
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [projection]);

  return (
    <div className="absolute inset-0 pointer-events-none z-30">
      {departments.map((node, i) => {
        const Icon = node.icon;
        const streaming = isStreaming(node.status);
        const gated = node.status === 'HITL_PAUSE';
        const failed = node.status === 'ERROR';

        const edge = gated
          ? 'border-signal/70'
          : failed
          ? 'border-alarm/70'
          : streaming
          ? 'border-accent/80'
          : 'border-accent/25';

        const halo = gated
          ? '0 0 34px -8px rgba(var(--signal-rgb),0.75)'
          : failed
          ? '0 0 34px -8px rgba(var(--alarm-rgb),0.75)'
          : streaming
          ? '0 0 40px -8px rgba(var(--accent-rgb),0.7)'
          : '0 0 24px -12px rgba(var(--accent-rgb),0.45)';

        const tone = gated
          ? 'text-signal text-glow-signal'
          : failed
          ? 'text-alarm'
          : streaming
          ? 'text-accent text-glow'
          : 'text-chrome/45';

        return (
          <button
            key={node.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            onClick={() => {
              soundEngine.click();
              onSelect(node);
            }}
            style={{ opacity: 0, willChange: 'transform' }}
            className="absolute top-0 left-0 w-[184px] text-left pointer-events-auto cursor-pointer transition-opacity duration-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent group"
          >
            <div
              className={`hud-panel ticks px-3 py-2.5 border ${edge} transition-colors duration-300 group-hover:border-accent`}
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
                <span className={`font-medium tracking-wider ${tone}`}>{node.status}</span>
                <span className="text-chrome/40 font-light tabular-nums">
                  R<span className="text-accent/90 ml-0.5">{node.receiptCount}</span>
                </span>
              </div>

              <p className="mt-1.5 font-mono font-light text-[10px] text-chrome/60 truncate">
                {node.lastAction}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
