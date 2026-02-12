import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { books, elevenlabs } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import { ArrowLeft, FileText, Users, LayoutDashboard, CheckCircle, Download } from 'lucide-react';

const STEPS = [
  { to: '', icon: FileText, label: 'Manuscript', step: 1, hint: 'Import & split text', end: true },
  { to: 'voices', icon: Users, label: 'Voices', step: 2, hint: 'Assign character voices' },
  { to: 'timeline', icon: LayoutDashboard, label: 'Timeline', step: 3, hint: 'Arrange & preview audio' },
  { to: 'qc', icon: CheckCircle, label: 'QC & Render', step: 4, hint: 'Render & check quality' },
  { to: 'export', icon: Download, label: 'Export', step: 5, hint: 'Download ACX package' },
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

  if (!book) return <div style={styles.loading}>Loading book...</div>;

  return (
    <div style={styles.layout}>
      <nav style={styles.sidebar} aria-label="Book editor navigation">
        <button onClick={() => navigate('/')} style={styles.backBtn}>
          <ArrowLeft size={16} /> All Books
        </button>

        <div style={styles.bookInfo}>
          <h2 style={styles.bookTitle}>{book.title}</h2>
          {book.author && <p style={styles.bookAuthor}>by {book.author}</p>}
        </div>

        <div style={styles.stepsLabel}>WORKFLOW</div>
        <div style={styles.navList}>
          {STEPS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                ...styles.navItem,
                background: isActive ? '#1e2a3a' : 'transparent',
                borderLeft: isActive ? '3px solid #4A90D9' : '3px solid transparent',
              })}
            >
              <div style={styles.stepNumber}>{item.step}</div>
              <div style={styles.navContent}>
                <div style={styles.navLabel}>
                  <item.icon size={15} style={{ opacity: 0.7 }} /> {item.label}
                </div>
                <div style={styles.navHint}>{item.hint}</div>
              </div>
            </NavLink>
          ))}
        </div>

        <div style={styles.sidebarFooter}>
          <div style={styles.tipBox}>
            <span style={styles.tipIcon}>💡</span>
            <span style={styles.tipText}>Follow steps 1→5 to produce your audiobook</span>
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
  layout: { display: 'flex', minHeight: '100vh' },
  loading: { padding: 32, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' },
  sidebar: {
    width: 240, background: '#111', padding: '16px 0',
    display: 'flex', flexDirection: 'column', borderRight: '1px solid #1e1e1e',
    flexShrink: 0,
  },
  backBtn: {
    display: 'flex', alignItems: 'center', gap: 6, background: 'none',
    border: 'none', color: '#666', cursor: 'pointer', padding: '8px 16px', fontSize: 13,
    transition: 'color 0.2s',
  },
  bookInfo: { padding: '12px 16px', borderBottom: '1px solid #1e1e1e', marginBottom: 8 },
  bookTitle: { fontSize: 15, color: '#e0e0e0', lineHeight: 1.3 },
  bookAuthor: { fontSize: 12, color: '#555', marginTop: 4 },
  stepsLabel: { fontSize: 10, color: '#444', letterSpacing: 1.5, padding: '12px 16px 6px', fontWeight: 600 },
  navList: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
    textDecoration: 'none', transition: 'background 0.2s', cursor: 'pointer',
  },
  stepNumber: {
    width: 22, height: 22, borderRadius: '50%', background: '#1e1e1e',
    color: '#666', fontSize: 11, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  navContent: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  navLabel: { display: 'flex', alignItems: 'center', gap: 6, color: '#bbb', fontSize: 13 },
  navHint: { fontSize: 10, color: '#555' },
  sidebarFooter: { padding: '12px 16px', borderTop: '1px solid #1e1e1e' },
  tipBox: {
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
    background: '#0d1520', borderRadius: 8, border: '1px solid #1a2a3a',
  },
  tipIcon: { fontSize: 14, flexShrink: 0 },
  tipText: { fontSize: 11, color: '#6a8ab0', lineHeight: 1.4 },
  main: { flex: 1, overflow: 'auto', background: '#0a0a0a' },
};
