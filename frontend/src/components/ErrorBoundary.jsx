import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('DocTrail UI error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-md px-6 py-24">
        <h1 className="text-lg font-semibold">This screen failed to load</h1>
        <p className="mt-2 text-sm text-muted">{this.state.error.message}</p>
        <div className="mt-6 flex gap-2">
          <button className="h-9 rounded-md bg-accent px-3.5 text-sm font-medium text-white" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            className="h-9 rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium"
            onClick={() => {
              localStorage.clear();
              window.location.reload();
            }}
          >
            Sign out and reload
          </button>
        </div>
      </div>
    );
  }
}
