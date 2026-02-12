import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { books, elevenlabs } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import { ArrowLeft, FileText, Users, LayoutDashboard, CheckCircle, Download, Music, Settings, BookOpen, BarChart3, Headphones } from 'lucide-react';

const STEPS = [
  { to: '', icon: FileText, label: 'Manuscript', podcastLabel: 'Script', step: 1, hint: 'Import & split text', podcastHint: 'Import script / text', end: true },
  { to: 'voices', icon: Users, label: 'Voices', podcastLabel: 'Voices', step: 2, hint: 'Assign character voices', podcastHint: 'Assign speaker voices' },
  { to: 'pronunciation', icon: BookOpen, label: 'Pronunciation', podcastLabel: 'Pronunciation', step: 3, hint: 'Fix word pronunciations', podcastHint: 'Fix word pronunciations' },
  { to: 'studio', icon: Music, label: 'Audio Studio', podcastLabel: 'Audio Studio', step: 4, hint: 'SFX, music & v3 tags', podcastHint: 'SFX, music & effects' },
  { to: 'timeline', icon: LayoutDashboard, label: 'Timeline', podcastLabel: 'Timeline', step: 5, hint: 'Arrange & preview audio', podcastHint: 'Arrange & preview' },
  { to: 'qc', icon: CheckCircle, label: 'QC & Render', podcastLabel: 'QC & Render', step: 6, hint: 'Render & check quality', podcastHint: 'Render & check quality' },
  { to: 'export', icon: Download, label: 'Export', podcastLabel: 'Export', step: 7, hint: 'Download ACX package', podcastHint: 'Download final audio' },
];

export function BookEditor() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { setCurrentBook, setCapabilities } = useAppStore();
  const [book, setBook] = useState<Book | null>(null);

  useEffect(() => {
    if (!bookId) return;
    books.get(bookId).then((b) => { setBook(b); setCurrentBook(b); }).catch(console.error);
    elevenlabs.capabilities().then(setCapabilities).catch(() => {});
    return () => setCurrentBook(null);
  }, [bookId]);

  if (!book) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-deep)', color: 'var(--text-tertiary)' }}>
      Loading project...
    </div>
  );

  const isPodcast = book.project_type === 'podcast';

  return (
    <div style={styles.layout}>
      <nav style={styles.sidebar} aria-label="Project editor navigation">
        <button onClick={() => navigate('/')} style={styles.backBtn}>
          <ArrowLeft size={14} /> All Projects
        </button>

        <div style={styles.bookInfo}>
          <span style={{
            ...styles.typeBadge,
            background: isPodcast ? 'var(--purple-subtle)' : 'var(--accent-subtle)',
            color: isPodcast ? 'var(--purple)' : 'var(--accent)',
          }}>
            {isPodcast ? '🎙️ Podcast' : '📖 Audiobook'}
          </span>
          <h2 style={styles.bookTitle}>{book.title}</h2>
          {book.author && <p style={styles.bookAuthor}>{book.author}</p>}
        </div>

        <div style={styles.stepsLabel}>WORKFLOW</div>
        <div style={styles.navList} className="stagger-children">
          {STEPS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                ...styles.navItem,
                ...(isActive ? styles.navItemActive : {}),
              })}
            >
              <div style={styles.stepNumber}>{item.step}</div>
              <div style={styles.navContent}>
                <div style={styles.navLabel}>
                  <item.icon size={14} style={{ opacity: 0.6 }} />
                  {isPodcast ? item.podcastLabel : item.label}
                </div>
                <div style={styles.navHint}>{isPodcast ? item.podcastHint : item.hint}</div>
              </div>
            </NavLink>
          ))}
        </div>

        <div style={styles.sidebarFooter}>
          <button onClick={() => navigate(`/book/${bookId}/usage`)} style={styles.footerBtn}>
            <BarChart3 size={13} /> Usage & Costs
          </button>
          <button onClick={() => navigate('/settings')} style={styles.footerBtn}>
            <Settings size={13} /> Settings
          </button>
          <div style={styles.tipBox}>
            <span style={{ fontSize: 13, flexShrink: 0 }}>💡</span>
            <span style={styles.tipText}>
              {isPodcast
                ? 'Import your script, AI assigns speakers, then generate audio'
                : 'Follow steps 1→7 to produce your audiobook'}
            </span>
          </div>
        </div>
      </nav>
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layout: { display: 'flex', minHeight: '100vh', background: 'var(--bg-deep)' },
  sidebar: {
    width: 232, background: 'var(--bg-base)', padding: '14px 0',
    display: 'flex', flexDirection: 'column',
    borderRight: '1px solid var(--border-subtle)', flexShrink: 0,
  },
  backBtn: {
    display: 'flex', alignItems: 'center', gap: 6, background: 'none',
    border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
    padding: '8px 16px', fontSize: 12, fontWeight: 500,
  },
  bookInfo: {
    padding: '12px 16px 14px', borderBottom: '1px solid var(--border-subtle)',
    marginBottom: 4, display: 'flex', flexDirection: 'column', gap: 6,
  },
  typeBadge: {
    fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500,
    alignSelf: 'flex-start',
  },
  bookTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 },
  bookAuthor: { fontSize: 11, color: 'var(--text-muted)' },
  stepsLabel: {
    fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1.5, fontWeight: 600,
    padding: '12px 16px 6px',
  },
  navList: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, padding: '0 6px' },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
    textDecoration: 'none', cursor: 'pointer', borderRadius: 'var(--radius-md)',
    borderLeft: '2px solid transparent',
    transition: 'all 150ms ease',
  },
  navItemActive: {
    background: 'var(--accent-subtle)',
    borderLeftColor: 'var(--accent)',
  },
  stepNumber: {
    width: 20, height: 20, borderRadius: '50%', background: 'var(--bg-elevated)',
    color: 'var(--text-muted)', fontSize: 10, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  navContent: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  navLabel: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500 },
  navHint: { fontSize: 10, color: 'var(--text-muted)' },
  sidebarFooter: {
    padding: '10px 12px', borderTop: '1px solid var(--border-subtle)',
    display: 'flex', flexDirection: 'column' as const, gap: 6,
  },
  footerBtn: {
    display: 'flex', alignItems: 'center', gap: 6, background: 'none',
    border: '1px solid var(--border-subtle)', color: 'var(--text-muted)',
    cursor: 'pointer', padding: '7px 10px', borderRadius: 'var(--radius-sm)',
    fontSize: 11, width: '100%', fontWeight: 500,
  },
  tipBox: {
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 10px',
    background: 'var(--accent-subtle)', borderRadius: 'var(--radius-md)',
    border: '1px solid rgba(91,141,239,0.1)',
  },
  tipText: { fontSize: 10, color: 'var(--accent)', lineHeight: 1.4 },
  main: { flex: 1, overflow: 'auto', background: 'var(--bg-deep)' },
};
