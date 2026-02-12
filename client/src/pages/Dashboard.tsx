import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { books } from '../services/api';
import type { Book } from '../types';
import { Plus, BookOpen, Trash2 } from 'lucide-react';

export function Dashboard() {
  const [bookList, setBookList] = useState<Book[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
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
      setTitle('');
      setAuthor('');
      setShowCreate(false);
      navigate(`/book/${book.id}`);
    } catch (err: any) {
      alert(`Failed to create book: ${err.message}`);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this book and all its data?')) {
      await books.delete(id);
      loadBooks();
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.h1}>🎧 Audiobook Maker</h1>
        <button onClick={() => setShowCreate(true)} style={styles.createBtn}>
          <Plus size={18} /> New Book
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} style={styles.createForm}>
          <input
            value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Book title" style={styles.input} autoFocus
            aria-label="Book title"
          />
          <input
            value={author} onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author (optional)" style={styles.input}
            aria-label="Author"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" style={styles.submitBtn}>Create</button>
            <button type="button" onClick={() => setShowCreate(false)} style={styles.cancelBtn}>Cancel</button>
          </div>
        </form>
      )}

      <div style={styles.grid}>
        {bookList.map((book) => (
          <div key={book.id} onClick={() => navigate(`/book/${book.id}`)} style={styles.card} role="button" tabIndex={0}>
            <BookOpen size={32} color="#4A90D9" />
            <h3 style={styles.cardTitle}>{book.title}</h3>
            {book.author && <p style={styles.cardAuthor}>{book.author}</p>}
            <p style={styles.cardDate}>{new Date(book.created_at).toLocaleDateString()}</p>
            <button
              onClick={(e) => handleDelete(book.id, e)}
              style={styles.deleteBtn}
              aria-label={`Delete ${book.title}`}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}

        {bookList.length === 0 && !showCreate && (
          <p style={{ color: '#666', gridColumn: '1 / -1', textAlign: 'center', padding: 40 }}>
            No books yet. Create your first audiobook project.
          </p>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: 32, maxWidth: 1200, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 },
  h1: { fontSize: 28, color: '#fff' },
  createBtn: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 8,
    cursor: 'pointer', fontSize: 14,
  },
  createForm: {
    display: 'flex', flexDirection: 'column', gap: 12, padding: 24,
    background: '#1a1a1a', borderRadius: 12, marginBottom: 24, maxWidth: 400,
  },
  input: {
    padding: '10px 14px', borderRadius: 8, border: '1px solid #333',
    background: '#0f0f0f', color: '#fff', fontSize: 14, outline: 'none',
  },
  submitBtn: {
    padding: '10px 20px', background: '#4A90D9', color: '#fff',
    border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  cancelBtn: {
    padding: '10px 20px', background: '#333', color: '#aaa',
    border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
    gap: 16,
  },
  card: {
    position: 'relative', padding: 24, background: '#1a1a1a', borderRadius: 12,
    cursor: 'pointer', transition: 'background 0.2s',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  cardTitle: { fontSize: 18, color: '#fff' },
  cardAuthor: { fontSize: 14, color: '#888' },
  cardDate: { fontSize: 12, color: '#555' },
  deleteBtn: {
    position: 'absolute', top: 12, right: 12, background: 'none',
    border: 'none', color: '#555', cursor: 'pointer', padding: 4,
  },
};
