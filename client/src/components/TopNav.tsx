import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Headphones, LayoutGrid, BookMarked, Settings, LogOut, Sun, Moon } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { clearToken } from '../services/api';

const NAV_ITEMS = [
  { path: '/', label: 'Projects', icon: LayoutGrid },
  { path: '/library', label: 'Library', icon: BookMarked },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);

  const handleLogout = () => {
    clearToken();
    setAuthenticated(false);
  };

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <nav style={styles.nav} aria-label="Main navigation">
      <div style={styles.left}>
        <button onClick={() => navigate('/')} style={styles.logo} aria-label="Home">
          <div style={styles.logoIcon}>
            <Headphones size={17} color="var(--accent)" />
          </div>
          <span style={styles.logoText}>Audio Producer</span>
        </button>
        <div style={styles.divider} />
        <div style={styles.links}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.path);
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                style={{
                  ...styles.link,
                  ...(active ? styles.linkActive : {}),
                }}
                aria-current={active ? 'page' : undefined}
              >
                <item.icon size={14} style={{ opacity: active ? 1 : 0.6 }} />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={styles.right}>
        <button
          onClick={toggleTheme}
          style={styles.iconBtn}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button onClick={handleLogout} style={styles.logoutBtn} title="Log out" aria-label="Log out">
          <LogOut size={14} />
          <span>Log out</span>
        </button>
      </div>
    </nav>
  );
}

const styles: Record<string, React.CSSProperties> = {
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 52,
    padding: '0 20px',
    background: 'var(--bg-base)',
    borderBottom: '1px solid var(--border-subtle)',
    flexShrink: 0,
    zIndex: 50,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '4px 0',
  },
  logoIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'var(--accent-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid rgba(91, 141, 239, 0.15)',
  },
  logoText: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.4px',
  },
  divider: {
    width: 1,
    height: 20,
    background: 'var(--border-default)',
  },
  links: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
  },
  link: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'none',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    position: 'relative' as const,
  },
  linkActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    background: 'none',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  logoutBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'none',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
  },
};
