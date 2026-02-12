import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { books } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import { Plus, BookOpen, Trash2, LogOut } from 'lucide-react';
import { clearToken } from '../services/api';

export function Dashboard() {
  const [bookList, setBookList] = useState<Book[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);
  const navigate = useNavigate();

  const loadBooks = async () => {
    try {
      const data = await books.list();
      setBookList(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error('Failed to load books:', err);
    }
  };

  useEffect(() => { loadBooks(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const book = await books.create({ title, author });
      setTitle(''); setAuthor(''); setShowCreate(false);
      navigate(`/book/${book.id}`);
    } catch (err: any) {
      alert(`Failed to create book: ${err.message}`);
    }
  };

  const handleDelete = async (id: string, bookTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete "${bookTitle}" and all its audio data? This cannot be undone.`)) {
      await books.delete(id);
      loadBooks();
    }
  };

  const handleLogout = () => {
    clearToken();
    setAuthenticated(false);
  };

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.h1}>🎧 Audiobook Maker</h1>
          <p style={styles.subtitle}>Import a manuscript, assign voices, generate audio, and export for ACX/Audible</p>
        </div>
        <div style={styles.headerActions}>
          <button onClick={() => setShowCreate(true)} style={styles.createBtn}>
            <Plus size={18} /> New Book
          </button>
          <button onClick={handleLogout} style={styles.logoutBtn} title="Log out">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {showCreate && (
        <form onSubmit={handleCreate} style={styles.createForm}>
          <h3 style={styles.formTitle}>Create a new audiobook project</h3>
          <p style={styles.formHint}>You can change these details later.</p>
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Book title (e.g. The Great Adventure)" style={styles.input} autoFocus aria-label="Book title" />
          <input value={author} onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author name (optional)" style={styles.input} aria-label="Author" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" style={styles.submitBtn}>Create Project</button>
            <button type="button" onClick={() => setShowCreate(false)} style={styles.cancelBtn}>Cancel</button>
          </div>
        </form>
      )}

      {bookList.length > 0 && <h2 style={styles.sectionTitle}>Your Projects</h2>}

      <div style={styles.grid}>
        {bookList.map((book) => (
          <div key={book.id} onClick={() => navigate(`/book/${book.id}`)} style={styles.card}
            role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/book/${book.id}`)}>
            <div style={styles.cardIcon}><BookOpen size={28} color="#4A90D9" /></div>
            <div style={styles.cardContent}>
              <h3 style={styles.cardTitle}>{book.title}</h3>
              {book.author && <p style={styles.cardAuthor}>{book.author}</p>}
              <p style={styles.cardDate}>Created {new Date(book.created_at).toLocaleDateString()}</p>
            </div>
            <button onClick={(e) => handleDelete(book.id, book.title, e)} style={styles.deleteBtn}
              aria-label={`Delete ${book.title}`}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      {bookList.length === 0 && !showCreate && (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>📚</div>
          <h3 style={styles.emptyTitle}>No audiobook projects yet</h3>
          <p style={styles.emptyText}>
            Click "New Book" to start. You'll import your manuscript, assign AI voices to characters,
            generate audio, and export a publisher-ready package.
          </p>
          <div style={styles.emptySteps}>
            <div style={styles.emptyStep}><span style={styles.stepDot}>1</span> Import manuscript (EPUB, DOCX, TXT)</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>2</span> Assign ElevenLabs voices to characters</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>3</span> Generate & arrange audio on timeline</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>4</span> Render with loudness normalization</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>5</span> Export ACX-ready ZIP package</div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '32px 40px', maxWidth: 1100, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 },
  h1: { fontSize: 26, color: '#e0e0e0', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#555', lineHeight: 1.5 },
  headerActions: { display: 'flex', gap: 8, alignItems: 'center' },
  createBtn: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 8,
    cursor: 'pointer', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap',
  },
  logoutBtn: {
    background: 'none', border: '1px solid #2a2a2a', color: '#555', borderRadius: 8,
    padding: '8px 10px', cursor: 'pointer',
  },
  createForm: {
    display: 'flex', flexDirection: 'column', gap: 12, padding: 24,
    background: '#141414', borderRadius: 12, marginBottom: 24, maxWidth: 440,
    border: '1px solid #1e1e1e',
  },
  formTitle: { fontSize: 16, color: '#e0e0e0' },
  formHint: { fontSize: 12, color: '#555', marginTop: -4 },
  input: {
    padding: '10px 14px', borderRadius: 8, border: '1px solid #2a2a2a',
    background: '#0a0a0a', color: '#e0e0e0', fontSize: 14, outline: 'none',
  },
  submitBtn: {
    padding: '10px 20px', background: '#4A90D9', color: '#fff',
    border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 500,
  },
  cancelBtn: {
    padding: '10px 20px', background: '#1e1e1e', color: '#888',
    border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  sectionTitle: { fontSize: 14, color: '#555', marginBottom: 12, textTransform: 'uppercase' as const, letterSpacing: 1 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  card: {
    position: 'relative', padding: '18px 20px', background: '#141414', borderRadius: 10,
    cursor: 'pointer', transition: 'border-color 0.2s', border: '1px solid #1e1e1e',
    display: 'flex', alignItems: 'center', gap: 14,
  },
  cardIcon: { flexShrink: 0 },
  cardContent: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 15, color: '#e0e0e0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardAuthor: { fontSize: 12, color: '#666', marginTop: 2 },
  cardDate: { fontSize: 11, color: '#444', marginTop: 4 },
  deleteBtn: {
    background: 'none', border: 'none', color: '#333', cursor: 'pointer', padding: 6,
    borderRadius: 6, transition: 'color 0.2s', flexShrink: 0,
  },
  emptyState: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 20, color: '#ccc', marginBottom: 8 },
  emptyText: { fontSize: 14, color: '#666', maxWidth: 500, margin: '0 auto 24px', lineHeight: 1.6 },
  emptySteps: { display: 'inline-flex', flexDirection: 'column', gap: 8, textAlign: 'left' },
  emptyStep: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#888' },
  stepDot: {
    width: 22, height: 22, borderRadius: '50%', background: '#1a2a3a', color: '#4A90D9',
    fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
};
