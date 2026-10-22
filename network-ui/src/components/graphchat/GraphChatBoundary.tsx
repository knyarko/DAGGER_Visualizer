/**
 * An error boundary around the wide view.
 *
 * Without one, any throw below this point unmounts the whole React tree and
 * leaves the viewer on a blank background with no way back - which is exactly
 * what happened in testing. React does not surface the error on the page, so
 * the person testing sees the screen appear for a moment and then vanish.
 *
 * This renders the real error and keeps the way out reachable. It is not a
 * substitute for fixing what threw; it makes what threw legible.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onBack: () => void;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export default class GraphChatBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? null });
    console.error('[graph-chat] the wide view threw:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ minHeight: '100vh', background: '#111827', color: '#E5E7EB',
                    padding: 24, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
        <button
          type="button"
          onClick={this.props.onBack}
          style={{ background: 'transparent', color: '#E5E7EB', border: '1px solid #44587A',
                   borderRadius: 6, padding: '6px 12px', cursor: 'pointer', marginBottom: 20 }}
        >
          &larr; Back to the graph
        </button>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>
          The chat view could not render
        </h1>
        <p style={{ color: '#9CA3AF', margin: '0 0 16px', maxWidth: '62ch' }}>
          The graph itself is untouched - going back returns you to it. The error
          below is the real one, and it is also in the browser console.
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#0B1220', border: '1px solid #44587A',
                      borderRadius: 6, padding: 16, fontSize: 13, overflowX: 'auto' }}>
{String(error && error.stack ? error.stack : error)}
{stack ? '\n\nComponent stack:' + stack : ''}
        </pre>
      </div>
    );
  }
}
