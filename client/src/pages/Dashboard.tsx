import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { books } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import { Plus, BookOpen, Trash2, LogOut, Settings, Mic } from 'lucide-react';
import { clearToken } from '../services/api';

export function Dashboard() {
  const [bookList, setBookList] = useState<Book[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [projectType, setProjectType] = useState<'audiobook' | 'podcast'>('audiobook');
  const [format, setFormat] = useState('single_narrator');
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
      const book = await books.create({ title, author, project_type: projectType, format } as any);
      setTitle(''); setAuthor(''); setShowCreate(false);
      navigate(`/book/${book.id}`);
    } catch (err: any) {
      alert(`Failed to create project: ${err.message}`);
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
          <h1 style={styles.h1}>🎧 Audio Producer</h1>
          <p style={styles.subtitle}>Create audiobooks and podcasts with AI voices, sound effects, and music</p>
        </div>
        <div style={styles.headerActions}>
          <button onClick={() => navigate('/settings')} style={styles.settingsBtn} title="Settings & API Keys">
            <Settings size={16} />
          </button>
          <button onClick={() => setShowCreate(true)} style={styles.createBtn}>
            <Plus size={18} /> New Project
          </button>
          <button onClick={handleLogout} style={styles.logoutBtn} title="Log out">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {showCreate && (
        <form onSubmit={handleCreate} style={styles.createForm}>
          <h3 style={styles.formTitle}>Create a new project</h3>

          {/* Project type toggle */}
          <div style={styles.typeToggle}>
            <button type="button" onClick={() => { setProjectType('audiobook'); setFormat('single_narrator'); }}
              style={{ ...styles.typeBtn, ...(projectType === 'audiobook' ? styles.typeBtnActive : {}) }}>
              <BookOpen size={16} /> Audiobook
            </button>
            <button type="button" onClick={() => { setProjectType('podcast'); setFormat('two_person_conversation'); }}
              style={{ ...styles.typeBtn, ...(projectType === 'podcast' ? styles.typeBtnActive : {}) }}>
              <Mic size={16} /> Podcast
            </button>
          </div>

          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={projectType === 'podcast' ? 'Episode title (e.g. Tech Talk #42)' : 'Book title (e.g. The Great Adventure)'}
            style={styles.input} autoFocus aria-label="Project title" />
          <input value={author} onChange={(e) => setAuthor(e.target.value)}
            placeholder={projectType === 'podcast' ? 'Host name (optional)' : 'Author name (optional)'}
            style={styles.input} aria-label="Author or host" />

          {/* Format selection */}
          <div style={styles.formatSection}>
            <label style={styles.formatLabel}>Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value)} style={styles.formatSelect}
              aria-label="Project format">
              {projectType === 'audiobook' ? (
                <>
                  <option value="single_narrator">Single narrator</option>
                  <option value="multi_character">Multi-character (full cast)</option>
                  <option value="conversation_with_narrator">Characters + narrator</option>
                </>
              ) : (
                <>
                  <option value="two_person_conversation">Two people conversing</option>
                  <option value="conversation_with_narrator">Conversation + narrator</option>
                  <option value="narrator_and_guest">Host + guest(s)</option>
                  <option value="interview">Interview format</option>
                  <option value="single_narrator">Solo (single speaker)</option>
                  <option value="multi_character">Panel / multi-speaker</option>
                </>
              )}
            </select>
          </div>

          <p style={styles.formHint}>
            {projectType === 'podcast'
              ? 'Upload your script and AI will auto-assign speakers, suggest SFX & music.'
              : 'Import your manuscript and AI will detect characters and assign voices.'}
          </p>

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
            <div style={styles.cardIcon}>
              {book.project_type === 'podcast' ? <Mic size={28} color="#9B59B6" /> : <BookOpen size={28} color="#4A90D9" />}
            </div>
            <div style={styles.cardContent}>
              <h3 style={styles.cardTitle}>{book.title}</h3>
              {book.author && <p style={styles.cardAuthor}>{book.author}</p>}
              <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                <span style={{ ...styles.typeBadge, background: book.project_type === 'podcast' ? '#2a1a3a' : '#1a2a3a', color: book.project_type === 'podcast' ? '#b88ad9' : '#6a9ad0' }}>
                  {book.project_type === 'podcast' ? '🎙️ Podcast' : '📖 Audiobook'}
                </span>
                <span style={styles.cardDate}>{new Date(book.created_at).toLocaleDateString()}</span>
              </div>
            </div>
            <button onClick={(e) => handleDelete(book.id, book.title, e)} style={styles.deleteBtn}
              aria-label={`Delete ${book.title}`}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      {bookList.length === 0 && !showCreate && (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>🎧</div>
          <h3 style={styles.emptyTitle}>No projects yet</h3>
          <p style={styles.emptyText}>
            Create an audiobook or podcast project. Import your text, and AI will assign characters,
            suggest sound effects and music. Then generate audio with ElevenLabs voices.
          </p>
          <div style={styles.emptySteps}>
            <div style={styles.emptyStep}><span style={styles.stepDot}>1</span> Create a project (audiobook or podcast)</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>2</span> Import text / script (EPUB, DOCX, TXT)</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>3</span> AI auto-assigns characters, SFX & music</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>4</span> Generate audio with ElevenLabs voices</div>
            <div style={styles.emptyStep}><span style={styles.stepDot}>5</span> Arrange on timeline, render & export</div>
          </div>
          <p style={{ fontSize: 12, color: '#555', marginTop: 16 }}>
            First time? Go to <button onClick={() => navigate('/settings')} style={{ background: 'none', border: 'none', color: '#4A90D9', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>Settings</button> to add your API keys.
          </p>
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
  settingsBtn: {
    background: 'none', border: '1px solid #2a2a2a', color: '#666', borderRadius: 8,
    padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center',
  },
  typeToggle: { display: 'flex', gap: 8 },
  typeBtn: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '10px 16px', background: '#1a1a1a', color: '#888', border: '1px solid #222',
    borderRadius: 8, cursor: 'pointer', fontSize: 14, transition: 'all 0.2s',
  },
  typeBtnActive: { background: '#1e2a3a', color: '#4A90D9', borderColor: '#4A90D9' },
  formatSection: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  formatLabel: { fontSize: 12, color: '#888' },
  formatSelect: {
    padding: '8px 12px', borderRadius: 8, border: '1px solid #2a2a2a',
    background: '#0a0a0a', color: '#ddd', fontSize: 13, outline: 'none',
  },
  typeBadge: { fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 500 },
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
