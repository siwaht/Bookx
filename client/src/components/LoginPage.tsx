import React, { useState } from 'react';
import { auth, setToken } from '../services/api';
import { useAppStore } from '../stores/appStore';

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
      <form onSubmit={handleLogin} style={styles.form}>
        <h1 style={styles.title}>🎧 Audiobook Maker</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter password"
          style={styles.input}
          autoFocus
          aria-label="Password"
        />
        {error && <p style={styles.error}>{error}</p>}
        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? 'Logging in...' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: '#0f0f0f',
  },
  form: {
    display: 'flex', flexDirection: 'column', gap: 16, padding: 40,
    background: '#1a1a1a', borderRadius: 12, minWidth: 320,
  },
  title: { textAlign: 'center', fontSize: 24, color: '#fff' },
  input: {
    padding: '12px 16px', borderRadius: 8, border: '1px solid #333',
    background: '#0f0f0f', color: '#fff', fontSize: 16, outline: 'none',
  },
  button: {
    padding: '12px 16px', borderRadius: 8, border: 'none',
    background: '#4A90D9', color: '#fff', fontSize: 16, cursor: 'pointer',
  },
  error: { color: '#ff6b6b', fontSize: 14, textAlign: 'center' },
};
