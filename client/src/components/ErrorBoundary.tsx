import React, { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div style={styles.container} role="alert">
          <div style={styles.card}>
            <div style={styles.iconWrap}>
              <AlertTriangle size={32} color="#f59e0b" />
            </div>
            <h2 style={styles.title}>Something went wrong</h2>
            <p style={styles.message}>
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <div style={styles.actions}>
              <button onClick={this.handleReset} style={styles.retryBtn}>
                <RefreshCw size={14} /> Try Again
              </button>
              <button onClick={() => window.location.reload()} style={styles.reloadBtn}>
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: 'var(--bg-deep)', padding: 24,
  },
  card: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    padding: '44px 48px', background: 'var(--glass-bg)',
    backdropFilter: 'blur(16px)',
    borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)',
    maxWidth: 420, textAlign: 'center',
    boxShadow: 'var(--shadow-lg)',
  },
  iconWrap: {
    width: 64, height: 64, borderRadius: 16,
    background: 'rgba(245,158,11,0.08)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid rgba(245,158,11,0.12)',
  },
  title: { fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' },
  message: { fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 },
  actions: { display: 'flex', gap: 10, marginTop: 8 },
  retryBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '10px 20px', background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500,
  },
  reloadBtn: {
    padding: '10px 20px', background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
    border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer', fontSize: 13,
  },
};
