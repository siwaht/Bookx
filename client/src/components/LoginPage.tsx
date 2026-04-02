import React, { useState } from 'react';
import { auth, setToken } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { Headphones, ArrowRight, Loader } from 'lucide-react';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { token } = await auth.login(password);
      setToken(token);
      setAuthenticated(true);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      {/* Ambient glow orbs */}
      <div style={styles.glowOrb1} />
      <div style={styles.glowOrb2} />
      <div style={styles.glowOrb3} />

      <form onSubmit={handleLogin} style={styles.form} className="animate-in-scale">
        <div style={styles.logoWrap}>
          <div style={styles.logoCircle}>
            <Headphones size={26} color="#5b8def" />
          </div>
        </div>
        <h1 style={styles.title}>Audio Producer</h1>
        <p style={styles.subtitle}>Audiobooks & podcasts with AI</p>

        <div style={styles.inputWrap}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            style={styles.input}
            autoFocus
            aria-label="Password"
          />
        </div>

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? (
            <Loader size={16} className="spinner" />
          ) : (
            <>
              <span>Continue</span>
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: 'var(--bg-deep)',
    position: 'relative', overflow: 'hidden',
  },
  glowOrb1: {
    position: 'absolute', width: 500, height: 500, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(91,141,239,0.07) 0%, transparent 65%)',
    top: '15%', left: '25%', pointerEvents: 'none',
    animation: 'gentleFloat 8s ease-in-out infinite',
  },
  glowOrb2: {
    position: 'absolute', width: 400, height: 400, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(167,139,250,0.05) 0%, transparent 65%)',
    bottom: '15%', right: '25%', pointerEvents: 'none',
    animation: 'gentleFloat 10s ease-in-out infinite 1s',
  },
  glowOrb3: {
    position: 'absolute', width: 300, height: 300, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(45,212,191,0.04) 0%, transparent 65%)',
    top: '50%', right: '15%', pointerEvents: 'none',
    animation: 'gentleFloat 12s ease-in-out infinite 2s',
  },
  form: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    padding: '52px 44px 44px',
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    borderRadius: 'var(--radius-2xl)',
    border: '1px solid var(--glass-border)',
    boxShadow: 'var(--shadow-xl)',
    minWidth: 360, position: 'relative', zIndex: 1,
  },
  logoWrap: { marginBottom: 4 },
  logoCircle: {
    width: 60, height: 60, borderRadius: 16,
    background: 'var(--accent-subtle)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 0 32px rgba(91,141,239,0.12)',
    border: '1px solid rgba(91, 141, 239, 0.12)',
  },
  title: {
    fontSize: 22, fontWeight: 700, color: 'var(--text-primary)',
    letterSpacing: '-0.5px',
  },
  subtitle: {
    fontSize: 13, color: 'var(--text-tertiary)', marginTop: -8,
  },
  inputWrap: { width: '100%', marginTop: 8 },
  input: {
    width: '100%', padding: '13px 16px', borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-deep)', color: 'var(--text-primary)',
    fontSize: 14, outline: 'none',
  },
  button: {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '13px 20px',
    background: 'var(--accent-gradient)',
    backgroundSize: '200% 200%',
    color: '#fff',
    border: 'none', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: 14, fontWeight: 600,
    boxShadow: '0 4px 16px rgba(91,141,239,0.25)',
  },
  error: {
    color: 'var(--danger)', fontSize: 13, textAlign: 'center',
    padding: '8px 12px', background: 'var(--danger-subtle)',
    borderRadius: 'var(--radius-sm)', width: '100%',
  },
};
