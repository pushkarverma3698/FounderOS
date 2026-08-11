import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Antigravity Physics Error caught:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="p-4 bg-red-950/40 border border-red-500/40 rounded-xl backdrop-blur-md text-red-300 font-mono text-xs">
          <h4 className="font-bold text-red-400">Physics Computation Error</h4>
          <p className="mt-1">{this.state.error?.message || 'Calculation fault'}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2 px-3 py-1 bg-red-500/20 border border-red-500/50 rounded text-red-200 hover:bg-red-500/30"
          >
            Reset Node Canvas
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
