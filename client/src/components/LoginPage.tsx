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
      {/* Ambient glow */}
      <div style={styles.glowOrb1} />
      <div style={styles.glowOrb2} />

      <form onSubmit={handleLogin} style={styles.form} className="animate-in-scale">
        <div style={styles.logoWrap}>
          <div style={styles.logoCircle}>
            <Headphones size={28} color="#5b8def" />
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
          {loading ? <Loader size={16} className="spinner" /> : <><span>Continue</span><ArrowRight size={16} /></>}
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
    position: 'absolute', width: 400, height: 400, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(91,141,239,0.08) 0%, transparent 70%)',
    top: '20%', left: '30%', pointerEvents: 'none',
  },
  glowOrb2: {
    position: 'absolute', width: 300, height: 300, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(167,139,250,0.06) 0%, transparent 70%)',
    bottom: '20%', right: '30%', pointerEvents: 'none',
  },
  form: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    padding: '48px 40px 40px',
    background: 'var(--bg-surface)', borderRadius: 'var(--radius-xl)',
    border: '1px solid var(--border-subtle)',
    boxShadow: 'var(--shadow-lg)',
    minWidth: 340, position: 'relative', zIndex: 1,
  },
  logoWrap: { marginBottom: 4 },
  logoCircle: {
    width: 56, height: 56, borderRadius: '50%',
    background: 'var(--accent-subtle)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 0 24px rgba(91,141,239,0.15)',
  },
  title: {
    fontSize: 22, fontWeight: 600, color: 'var(--text-primary)',
    letterSpacing: '-0.3px',
  },
  subtitle: {
    fontSize: 13, color: 'var(--text-tertiary)', marginTop: -8,
  },
  inputWrap: { width: '100%', marginTop: 8 },
  input: {
    width: '100%', padding: '12px 16px', borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-deep)', color: 'var(--text-primary)',
    fontSize: 14, outline: 'none',
  },
  button: {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '12px 20px', background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: 14, fontWeight: 500,
    boxShadow: '0 2px 8px rgba(91,141,239,0.25)',
  },
  error: {
    color: 'var(--danger)', fontSize: 13, textAlign: 'center',
    padding: '8px 12px', background: 'var(--danger-subtle)',
    borderRadius: 'var(--radius-sm)', width: '100%',
  },
};
