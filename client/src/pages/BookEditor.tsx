import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { books, elevenlabs } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import { ArrowLeft, FileText, Users, LayoutDashboard, CheckCircle, Download } from 'lucide-react';

export function BookEditor() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { setCurrentBook, setCapabilities } = useAppStore();
  const [book, setBook] = useState<Book | null>(null);

  useEffect(() => {
    if (!bookId) return;

    books.get(bookId).then((b) => {
      setBook(b);
      setCurrentBook(b);
    });

    elevenlabs.capabilities().then(setCapabilities).catch(console.error);

    return () => setCurrentBook(null);
  }, [bookId]);

  if (!book) return <div style={{ padding: 32, color: '#888' }}>Loading...</div>;

  const navItems = [
    { to: '', icon: FileText, label: 'Manuscript', end: true },
    { to: 'voices', icon: Users, label: 'Voices' },
    { to: 'timeline', icon: LayoutDashboard, label: 'Timeline' },
    { to: 'qc', icon: CheckCircle, label: 'QC & Render' },
    { to: 'export', icon: Download, label: 'Export' },
  ];

  return (
    <div style={styles.layout}>
      <nav style={styles.sidebar}>
        <button onClick={() => navigate('/')} style={styles.backBtn}>
          <ArrowLeft size={18} /> Back
        </button>
        <h2 style={styles.bookTitle}>{book.title}</h2>
        {book.author && <p style={styles.bookAuthor}>{book.author}</p>}
        <div style={styles.navList}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                ...styles.navItem,
                background: isActive ? '#2a2a2a' : 'transparent',
                color: isActive ? '#4A90D9' : '#888',
              })}
            >
              <item.icon size={18} /> {item.label}
            </NavLink>
          ))}
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
  sidebar: {
    width: 220, background: '#141414', padding: 20,
    display: 'flex', flexDirection: 'column', gap: 8, borderRight: '1px solid #222',
  },
  backBtn: {
    display: 'flex', alignItems: 'center', gap: 8, background: 'none',
    border: 'none', color: '#888', cursor: 'pointer', padding: '8px 0', fontSize: 14,
  },
  bookTitle: { fontSize: 16, color: '#fff', marginTop: 8 },
  bookAuthor: { fontSize: 13, color: '#666', marginBottom: 16 },
  navList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
    borderRadius: 8, textDecoration: 'none', fontSize: 14, transition: 'background 0.2s',
  },
  main: { flex: 1, padding: 24, overflow: 'auto' },
};
