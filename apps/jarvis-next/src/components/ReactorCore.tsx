import type { NodeStatus } from '../types/graph';

/**
 * The supervisor reactor, drawn in pure SVG.
 *
 * This deliberately does NOT use @react-three/fiber. That package (v9) and drei
 * (v10) both require React >= 19; this app runs React 18.3.1, and mounting the
 * WebGL canvas crashed the entire tree with "Cannot read properties of undefined
 * (reading 'S')" — a blank page. Vector art costs no GPU, paints on the first
 * frame, and carries no React-version risk.
 *
 * All motion is SVG <animateTransform>/<animate>: declarative, no rAF loop, and
 * automatically suspended by the browser when the tab is hidden.
 */

const TICKS = Array.from({ length: 48 }, (_, i) => i * (360 / 48));
const SPOKES = Array.from({ length: 6 }, (_, i) => i * 60);

interface ReactorCoreProps {
  status: NodeStatus;
  activeTurnCount: number;
}

export function ReactorCore({ status, activeTurnCount }: ReactorCoreProps) {
  const live = status === 'EXECUTING' || status === 'TOOL_CALL';
  const gated = status === 'HITL_PAUSE';
  const failed = status === 'ERROR';

  const tone = gated ? 'var(--signal)' : failed ? 'var(--alarm)' : 'var(--accent)';
  const spin = live ? 14 : 34;

  return (
    <div className="w-[176px] h-[176px] relative grid place-items-center">
      <svg viewBox="0 0 200 200" className="w-full h-full overflow-visible" aria-hidden="true">
        <defs>
          <radialGradient id="plasma">
            <stop offset="0%" stopColor={tone} stopOpacity="1" />
            <stop offset="35%" stopColor={tone} stopOpacity="0.55" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </radialGradient>
          <radialGradient id="corona">
            <stop offset="60%" stopColor={tone} stopOpacity="0" />
            <stop offset="88%" stopColor={tone} stopOpacity="0.22" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx="100" cy="100" r="98" fill="url(#corona)" />

        {/* Outer instrument ring + tick collar */}
        <g stroke={tone} fill="none">
          <circle cx="100" cy="100" r="88" strokeOpacity="0.22" strokeWidth="1" />
          <g strokeOpacity="0.4">
            {TICKS.map((deg, i) => (
              <line
                key={deg}
                x1="100"
                y1="12"
                x2="100"
                y2={i % 4 === 0 ? 21 : 17}
                strokeWidth={i % 4 === 0 ? 1.6 : 0.8}
                transform={`rotate(${deg} 100 100)`}
              />
            ))}
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 100 100"
              to="360 100 100"
              dur={`${spin * 4}s`}
              repeatCount="indefinite"
            />
          </g>
        </g>

        {/* Counter-rotating arc segments */}
        <g fill="none" stroke={tone} strokeWidth="2.5" strokeLinecap="round">
          <g strokeOpacity="0.85">
            <path d="M 100 26 A 74 74 0 0 1 164 63" />
            <path d="M 100 174 A 74 74 0 0 1 36 137" />
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 100 100"
              to="360 100 100"
              dur={`${spin}s`}
              repeatCount="indefinite"
            />
          </g>
          <g strokeOpacity="0.45" strokeWidth="1.5">
            <path d="M 100 42 A 58 58 0 0 1 150 71" />
            <path d="M 100 158 A 58 58 0 0 1 50 129" />
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="360 100 100"
              to="0 100 100"
              dur={`${spin * 0.7}s`}
              repeatCount="indefinite"
            />
          </g>
        </g>

        {/* Iris aperture */}
        <g stroke={tone} strokeOpacity="0.55" fill="none" strokeWidth="1">
          <polygon points="100,58 136,79 136,121 100,142 64,121 64,79">
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 100 100"
              to="-360 100 100"
              dur={`${spin * 2.2}s`}
              repeatCount="indefinite"
            />
          </polygon>
          {SPOKES.map((deg) => (
            <line
              key={deg}
              x1="100"
              y1="60"
              x2="100"
              y2="72"
              strokeOpacity="0.8"
              transform={`rotate(${deg} 100 100)`}
            />
          ))}
        </g>

        {/* Plasma core */}
        <circle cx="100" cy="100" r="40" fill="url(#plasma)">
          <animate
            attributeName="r"
            values={live ? '34;44;34' : '32;38;32'}
            dur={live ? '1.7s' : '4.2s'}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values={live ? '0.75;1;0.75' : '0.5;0.78;0.5'}
            dur={live ? '1.7s' : '4.2s'}
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="100" cy="100" r="9" fill={tone}>
          <animate
            attributeName="opacity"
            values="0.7;1;0.7"
            dur={live ? '0.85s' : '2.6s'}
            repeatCount="indefinite"
          />
        </circle>
      </svg>

      {/* Centre readout */}
      <span className="absolute inset-0 grid place-items-center pointer-events-none">
        <span className="flex flex-col items-center gap-0.5 translate-y-[34px]">
          {activeTurnCount > 0 && (
            <span
              className="font-mono text-[9px] font-medium tracking-[0.22em]"
              style={{ color: tone, textShadow: `0 0 12px ${tone}` }}
            >
              {activeTurnCount} ACTIVE
            </span>
          )}
        </span>
      </span>
    </div>
  );
}
