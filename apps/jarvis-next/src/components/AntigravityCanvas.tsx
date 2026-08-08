import { useMemo, useState } from 'react';
import { CentralBrainOrb } from './CentralBrainOrb';
import { OrbitingDepartmentNode } from './OrbitingDepartmentNode';
import { ErrorBoundary } from './ErrorBoundary';
import { ChevronRight } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { voiceEngine } from '../audio/voiceEngine';
import { isStreaming, type DepartmentNodeData, type NodeStatus } from '../types/graph';
import { CORE, VIEW, orbitPoint, streamPath } from '../lib/orbital';

interface AntigravityCanvasProps {
  supervisor: DepartmentNodeData;
  departments: DepartmentNodeData[];
  onSelectNode: (node: DepartmentNodeData) => void;
  onDispatchTurn: (prompt: string) => void;
}

/**
 * The spatial stage: a pure-code Supervisor at the centre routing live streams
 * out to seven ReAct departments on a fixed orbit. Full-bleed by design — there
 * is no card, no grid cell, no box.
 */
export function AntigravityCanvas({
  supervisor,
  departments,
  onSelectNode,
  onDispatchTurn,
}: AntigravityCanvasProps) {
  const [prompt, setPrompt] = useState('');

  // Orbit slots are derived once per department set — deterministic, no overlap.
  const slots = useMemo(
    () =>
      departments.map((node, i) => ({
        node,
        slot: i,
        point: orbitPoint(i, departments.length),
      })),
    [departments]
  );

  const activeCount = departments.filter((n) => isStreaming(n.status)).length;
  const coreStatus: NodeStatus = departments.some((n) => n.status === 'HITL_PAUSE')
    ? 'HITL_PAUSE'
    : activeCount > 0
    ? 'EXECUTING'
    : 'IDLE';

  const dispatch = (e: React.FormEvent) => {
    e.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    soundEngine.dispatch();
    voiceEngine.speak(`Supervisor dispatching: ${value}`);
    onDispatchTurn(value);
    setPrompt('');
  };

  return (
    <ErrorBoundary>
      <div className="absolute inset-0 grid-floor select-none">
        {/* ---------- Routing layer ---------- */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="coreWell" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Gravity well under the supervisor */}
          <ellipse cx={CORE.x} cy={CORE.y} rx={420} ry={360} fill="url(#coreWell)" />

          {/* Counter-rotating orbit guides — the ambient motion of the system */}
          <g fill="none" vectorEffect="non-scaling-stroke">
            <ellipse
              cx={CORE.x}
              cy={CORE.y}
              rx={355}
              ry={300}
              stroke="var(--accent)"
              strokeOpacity="0.14"
              strokeWidth="1"
              strokeDasharray="2 14"
              vectorEffect="non-scaling-stroke"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from={`0 ${CORE.x} ${CORE.y}`}
                to={`360 ${CORE.x} ${CORE.y}`}
                dur="72s"
                repeatCount="indefinite"
              />
            </ellipse>
            <ellipse
              cx={CORE.x}
              cy={CORE.y}
              rx={252}
              ry={212}
              stroke="var(--accent)"
              strokeOpacity="0.1"
              strokeWidth="1"
              strokeDasharray="30 22"
              vectorEffect="non-scaling-stroke"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from={`360 ${CORE.x} ${CORE.y}`}
                to={`0 ${CORE.x} ${CORE.y}`}
                dur="48s"
                repeatCount="indefinite"
              />
            </ellipse>
          </g>

          {/* One stream per department. Packets ride the EXACT same path via
              <mpath>, so a route and its traffic can never drift apart. */}
          {slots.map(({ node, point, slot }) => {
            const id = `stream-${node.id}`;
            const live = isStreaming(node.status);
            const gated = node.status === 'HITL_PAUSE';
            const stroke = gated ? 'var(--signal)' : 'var(--accent)';

            return (
              <g key={id}>
                <path
                  id={id}
                  d={streamPath(point)}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={live ? 0.55 : gated ? 0.4 : 0.14}
                  strokeWidth={live ? 1.6 : 1}
                  strokeDasharray={live ? undefined : '3 9'}
                  vectorEffect="non-scaling-stroke"
                />

                {live && (
                  <>
                    <circle r="3.5" fill={stroke} opacity="0.95">
                      <animateMotion dur="1.6s" repeatCount="indefinite" begin={`${slot * 0.18}s`}>
                        <mpath href={`#${id}`} />
                      </animateMotion>
                    </circle>
                    <circle r="7" fill={stroke} opacity="0.18">
                      <animateMotion dur="1.6s" repeatCount="indefinite" begin={`${slot * 0.18}s`}>
                        <mpath href={`#${id}`} />
                      </animateMotion>
                    </circle>
                  </>
                )}

                {gated && (
                  <circle r="4" fill="var(--signal)">
                    <animate
                      attributeName="opacity"
                      values="0.15;1;0.15"
                      dur="1.4s"
                      repeatCount="indefinite"
                    />
                    <animateMotion dur="3.4s" repeatCount="indefinite">
                      <mpath href={`#${id}`} />
                    </animateMotion>
                  </circle>
                )}
              </g>
            );
          })}
        </svg>

        {/* ---------- Supervisor kernel ---------- */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 z-30"
          style={{ left: `${(CORE.x / VIEW) * 100}%`, top: `${(CORE.y / VIEW) * 100}%` }}
        >
          <CentralBrainOrb
            status={coreStatus}
            receiptCount={supervisor.receiptCount}
            activeTurnCount={activeCount}
            onClick={() => onSelectNode(supervisor)}
          />
        </div>

        {/* ---------- Seven ReAct departments ---------- */}
        {slots.map(({ node, point, slot }) => (
          <OrbitingDepartmentNode
            key={node.id}
            node={node}
            point={point}
            slot={slot}
            onSelect={onSelectNode}
          />
        ))}

        {/* ---------- Command line ---------- */}
        <form
          onSubmit={dispatch}
          className="absolute left-1/2 -translate-x-1/2 bottom-6 z-40 w-[min(720px,72vw)] hud-panel ticks flex items-center gap-3 px-4 py-3 glow-accent"
        >
          <span className="label-micro shrink-0 !text-accent/80">DISPATCH</span>
          <span className="w-px h-5 bg-accent/20" />
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Command the supervisor — e.g. run ATS sweep and verify the PR pipeline"
            aria-label="Command the supervisor"
            className="flex-1 bg-transparent font-mono font-light text-[12px] text-chrome placeholder:text-chrome/25 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!prompt.trim()}
            className="shrink-0 flex items-center gap-1 px-4 py-1.5 bg-accent text-void font-display font-bold text-[11px] tracking-[0.18em] transition-all hover:brightness-110 active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
          >
            EXECUTE
            <ChevronRight className="w-3.5 h-3.5" strokeWidth={3} />
          </button>
        </form>
      </div>
    </ErrorBoundary>
  );
}
