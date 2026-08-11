import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Isolates GPU failure from the rest of the interface.
 *
 * This exists because of a measured incident: mounting @react-three/fiber@9 on
 * React 18 threw during render and blanked the ENTIRE page — no header, no
 * panels, no HITL gate, nothing. A driver reset, a lost WebGPU device, or a
 * shader that fails to compile on a different machine would do the same.
 *
 * The volume is decoration over data. It must never be able to take the data
 * with it when it dies.
 */
export class ReactorErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[reactor] GPU layer failed, falling back to flat mode:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 grid-floor grid place-items-center pointer-events-none">
          <div className="hud-panel ticks px-5 py-4 max-w-md pointer-events-auto">
            <span className="label-micro block !text-signal">gpu layer offline</span>
            <p className="mt-2 font-mono font-light text-[11px] text-chrome/70 leading-relaxed">
              The particle volume failed to start, so the interface is running flat.
              Everything else on this screen is live and unaffected.
            </p>
            <p className="mt-2 font-mono font-light text-[10px] text-chrome/40 break-words">
              {this.state.error.message}
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-3 px-3 py-1.5 border border-accent/40 text-accent font-mono text-[10px] tracking-[0.14em] hover:bg-accent/10 transition-colors"
            >
              RETRY GPU
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
