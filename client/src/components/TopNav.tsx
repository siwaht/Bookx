import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Headphones, LayoutGrid, BookMarked, Settings, LogOut } from 'lucide-react';
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
            <Headphones size={18} color="var(--accent)" />
          </div>
          <span style={styles.logoText}>Audio Producer</span>
        </button>
        <div style={styles.links}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              style={{
                ...styles.link,
                ...(isActive(item.path) ? styles.linkActive : {}),
              }}
              aria-current={isActive(item.path) ? 'page' : undefined}
            >
              <item.icon size={15} />
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <button onClick={handleLogout} style={styles.logoutBtn} title="Log out" aria-label="Log out">
        <LogOut size={15} />
        <span style={styles.logoutLabel}>Log out</span>
      </button>
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
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 24,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '4px 0',
  },
  logoIcon: {
    width: 30,
    height: 30,
    borderRadius: '50%',
    background: 'var(--accent-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.3px',
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
    padding: '6px 14px',
    background: 'none',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  linkActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
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
  },
  logoutLabel: {
    fontSize: 12,
  },
};
