import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Headphones,
  LayoutGrid,
  BookMarked,
  Settings,
  LogOut,
  Sun,
  Moon,
  MoreHorizontal,
  Library,
  Mic,
  WandSparkles,
  X,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { clearToken } from '../services/api';

const PRIMARY_NAV = [
  { path: '/', label: 'Projects', icon: LayoutGrid },
  { path: '/library', label: 'Library', icon: BookMarked },
];

const SECONDARY_NAV = [
  { path: '/series', label: 'Series', icon: Library },
  { path: '/podcast-studio', label: 'Podcast studio', icon: Mic },
  { path: '/book-agent', label: 'Book agent', icon: WandSparkles },
];

export function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);

  const handleLogout = () => {
    clearToken();
    setAuthenticated(false);
  };

  const isActive = (path: string) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
  const secondaryActive = SECONDARY_NAV.some((item) => isActive(item.path));

  const goTo = (path: string) => {
    setMoreOpen(false);
    navigate(path);
  };

  return (
    <nav className="top-nav" style={styles.nav} aria-label="Main navigation">
      <div style={styles.left}>
        <button onClick={() => goTo('/')} style={styles.logo} aria-label="Go to projects">
          <span style={styles.logoIcon}><Headphones size={18} /></span>
          <span style={styles.logoCopy}>
            <strong style={styles.logoText}>Bookx</strong>
            <span style={styles.logoSubtext}>Audio workspace</span>
          </span>
        </button>
        <div style={styles.divider} />
        <div className="top-nav-links" style={styles.links}>
          {PRIMARY_NAV.map((item) => {
            const active = isActive(item.path);
            return (
              <button
                key={item.path}
                onClick={() => goTo(item.path)}
                style={{ ...styles.link, ...(active ? styles.linkActive : {}) }}
                aria-current={active ? 'page' : undefined}
              >
                <item.icon size={15} />
                {item.label}
              </button>
            );
          })}
          <div style={styles.moreWrap}>
            <button
              onClick={() => setMoreOpen((open) => !open)}
              style={{ ...styles.link, ...(secondaryActive ? styles.linkActive : {}) }}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
            >
              {moreOpen ? <X size={15} /> : <MoreHorizontal size={15} />}
              More
            </button>
            {moreOpen && (
              <div style={styles.menu} role="menu">
                {SECONDARY_NAV.map((item) => (
                  <button key={item.path} onClick={() => goTo(item.path)} style={styles.menuItem} role="menuitem">
                    <item.icon size={15} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="top-nav-menu" style={styles.menuButtonWrap}>
        <button onClick={() => setMoreOpen((open) => !open)} style={styles.iconBtn} aria-label="Open navigation menu" aria-expanded={moreOpen}>
          {moreOpen ? <X size={17} /> : <MoreHorizontal size={17} />}
        </button>
        {moreOpen && (
          <div style={styles.mobileMenu} role="menu">
            {[...PRIMARY_NAV, ...SECONDARY_NAV].map((item) => (
              <button key={item.path} onClick={() => goTo(item.path)} style={styles.menuItem} role="menuitem">
                <item.icon size={15} />
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={styles.right}>
        <button onClick={toggleTheme} style={styles.iconBtn} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <button onClick={handleLogout} style={styles.logoutBtn} title="Log out" aria-label="Log out">
          <LogOut size={15} />
          <span className="logout-label">Log out</span>
        </button>
        <button onClick={() => goTo('/settings')} style={styles.settingsBtn} aria-label="Open settings">
          <Settings size={15} />
          <span className="logout-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}

const styles: Record<string, React.CSSProperties> = {
  nav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 64,
    padding: '0 28px', background: 'rgba(255,255,255,0.90)', borderBottom: '1px solid var(--border-subtle)',
    flexShrink: 0, zIndex: 50, backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    position: 'relative',
  },
  left: { display: 'flex', alignItems: 'center', gap: 20, minWidth: 0 },
  logo: { display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', textAlign: 'left' },
  logoIcon: { width: 34, height: 34, borderRadius: 11, background: 'var(--accent-gradient)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 5px 14px rgba(40,123,181,0.20)' },
  logoCopy: { display: 'flex', flexDirection: 'column', gap: 0 },
  logoText: { fontSize: 15, color: 'var(--text-primary)', letterSpacing: '-0.3px' },
  logoSubtext: { fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: '0.02em' },
  divider: { width: 1, height: 28, background: 'var(--border-default)' },
  links: { display: 'flex', alignItems: 'center', gap: 4 },
  link: { display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', background: 'transparent', border: '1px solid transparent', borderRadius: 10, color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, position: 'relative' },
  linkActive: { background: 'var(--accent-subtle)', borderColor: 'var(--border-accent)', color: 'var(--accent)' },
  moreWrap: { position: 'relative' },
  menu: { position: 'absolute', top: 'calc(100% + 10px)', left: 0, minWidth: 190, padding: 7, background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 14, boxShadow: 'var(--shadow-lg)', zIndex: 60 },
  mobileMenu: { position: 'absolute', top: 'calc(100% + 8px)', right: 0, minWidth: 210, padding: 7, background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 14, boxShadow: 'var(--shadow-lg)', zIndex: 60 },
  menuItem: { display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '10px 11px', background: 'transparent', border: 'none', borderRadius: 9, color: 'var(--text-secondary)', cursor: 'pointer', textAlign: 'left', fontSize: 13 },
  menuButtonWrap: { position: 'relative', marginLeft: 'auto' },
  right: { display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 },
  iconBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 10, color: 'var(--text-secondary)', cursor: 'pointer' },
  logoutBtn: { display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px', background: 'transparent', border: '1px solid var(--border-default)', borderRadius: 10, color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  settingsBtn: { display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px', background: 'var(--accent-subtle)', border: '1px solid var(--border-accent)', borderRadius: 10, color: 'var(--accent)', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
};
