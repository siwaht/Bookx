import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { books, elevenlabs } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import { ArrowLeft, FileText, Users, LayoutDashboard, CheckCircle, Download, Music, Settings, BookOpen, BarChart3, Headphones, BookMarked, ChevronRight } from 'lucide-react';

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
  const location = useLocation();
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

  // Determine current step index for progress indicator
  const pathSegments = location.pathname.split('/');
  const lastSegment = pathSegments[pathSegments.length - 1];
  const currentStepIdx = STEPS.findIndex((s) =>
    s.to === '' ? (lastSegment === bookId) : lastSegment === s.to
  );

  return (
    <div style={styles.layout}>
      <nav style={styles.sidebar} aria-label="Project editor navigation">
        <button onClick={() => navigate('/')} style={styles.backBtn}>
          <ArrowLeft size={14} />
          <span>Projects</span>
          <ChevronRight size={10} style={{ opacity: 0.4 }} />
          <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {book.title.length > 16 ? book.title.slice(0, 16) + '…' : book.title}
          </span>
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
          {book.library_book_id && (
            <button onClick={() => navigate('/library')} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--purple)', cursor: 'pointer', fontSize: 10, padding: '2px 0', fontWeight: 500 }}>
              <BookMarked size={10} /> From Library
            </button>
          )}
        </div>

        <div style={styles.stepsLabel}>
          <span>WORKFLOW</span>
          <span style={styles.stepProgress}>
            {currentStepIdx >= 0 ? currentStepIdx + 1 : 1}/{STEPS.length}
          </span>
        </div>
        <div style={styles.navList} className="stagger-children">
          {STEPS.map((item, idx) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                ...styles.navItem,
                ...(isActive ? styles.navItemActive : {}),
              })}
            >
              {({ isActive }: { isActive: boolean }) => (
                <>
                  <div style={{
                    ...styles.stepNumber,
                    ...(isActive ? styles.stepNumberActive : {}),
                    ...(currentStepIdx > idx ? styles.stepNumberDone : {}),
                  }}>
                    {currentStepIdx > idx ? '✓' : item.step}
                  </div>
                  <div style={styles.navContent}>
                    <div style={{
                      ...styles.navLabel,
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}>
                      <item.icon size={14} style={{ opacity: isActive ? 1 : 0.5 }} />
                      {isPodcast ? item.podcastLabel : item.label}
                    </div>
                    <div style={{
                      ...styles.navHint,
                      color: isActive ? 'var(--text-tertiary)' : 'var(--text-muted)',
                    }}>
                      {isPodcast ? item.podcastHint : item.hint}
                    </div>
                  </div>
                </>
              )}
            </NavLink>
          ))}
        </div>

        <div style={styles.sidebarFooter}>
          <NavLink to={`/book/${bookId}/usage`} style={({ isActive }) => ({
            ...styles.footerLink,
            ...(isActive ? { color: 'var(--accent)', borderColor: 'rgba(91,141,239,0.3)', background: 'var(--accent-subtle)' } : {}),
          })}>
            <BarChart3 size={13} /> Usage & Costs
          </NavLink>
          <button onClick={() => navigate('/settings')} style={styles.footerLink}>
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
    width: 248, background: 'var(--bg-base)', padding: '10px 0',
    display: 'flex', flexDirection: 'column',
    borderRight: '1px solid var(--border-subtle)', flexShrink: 0,
    overflow: 'hidden',
  },
  backBtn: {
    display: 'flex', alignItems: 'center', gap: 5, background: 'none',
    border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
    padding: '8px 16px', fontSize: 11, fontWeight: 500,
    whiteSpace: 'nowrap', overflow: 'hidden',
  },
  bookInfo: {
    padding: '10px 16px 14px', borderBottom: '1px solid var(--border-subtle)',
    marginBottom: 4, display: 'flex', flexDirection: 'column', gap: 6,
  },
  typeBadge: {
    fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500,
    alignSelf: 'flex-start',
  },
  bookTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 },
  bookAuthor: { fontSize: 11, color: 'var(--text-tertiary)' },
  stepsLabel: {
    fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1.5, fontWeight: 600,
    padding: '12px 16px 6px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  stepProgress: {
    fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: 0, fontWeight: 500,
    background: 'var(--bg-elevated)', padding: '1px 7px', borderRadius: 10,
  },
  navList: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, padding: '0 8px', overflowY: 'auto' },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
    textDecoration: 'none', cursor: 'pointer', borderRadius: 'var(--radius-md)',
    transition: 'all 150ms ease',
    position: 'relative',
  },
  navItemActive: {
    background: 'var(--accent-subtle)',
  },
  activeIndicator: {
    position: 'absolute', left: 0, top: '20%', bottom: '20%', width: 3,
    borderRadius: 2, background: 'var(--accent)',
  },
  stepNumber: {
    width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-elevated)',
    color: 'var(--text-muted)', fontSize: 10, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    border: '1.5px solid var(--border-subtle)',
  },
  stepNumberActive: {
    background: 'var(--accent)', color: '#fff',
    border: '1.5px solid var(--accent)',
    boxShadow: '0 0 8px var(--accent-glow)',
  },
  stepNumberDone: {
    background: 'var(--success-subtle)', color: 'var(--success)',
    border: '1.5px solid rgba(74, 222, 128, 0.3)',
    fontSize: 9,
  },
  navContent: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  navLabel: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500 },
  navHint: { fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.3 },
  sidebarFooter: {
    padding: '10px 12px', borderTop: '1px solid var(--border-subtle)',
    display: 'flex', flexDirection: 'column' as const, gap: 6,
  },
  footerLink: {
    display: 'flex', alignItems: 'center', gap: 6, background: 'none',
    border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)',
    cursor: 'pointer', padding: '7px 10px', borderRadius: 'var(--radius-sm)',
    fontSize: 11, width: '100%', fontWeight: 500, textDecoration: 'none',
  },
  tipBox: {
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 10px',
    background: 'var(--accent-subtle)', borderRadius: 'var(--radius-md)',
    border: '1px solid rgba(91,141,239,0.1)',
  },
  tipText: { fontSize: 10, color: 'var(--accent)', lineHeight: 1.4 },
  main: { flex: 1, overflow: 'auto', background: 'var(--bg-deep)' },
};
