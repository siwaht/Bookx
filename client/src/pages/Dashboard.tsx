import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { books } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import { Plus, BookOpen, Trash2, LogOut, Settings, Mic, Headphones, ArrowRight } from 'lucide-react';
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
    } catch (err: any) { console.error('Failed to load books:', err); }
  };

  useEffect(() => { loadBooks(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const book = await books.create({ title, author, project_type: projectType, format } as any);
      setTitle(''); setAuthor(''); setShowCreate(false);
      navigate(`/book/${book.id}`);
    } catch (err: any) { alert(`Failed to create project: ${err.message}`); }
  };

  const handleDelete = async (id: string, bookTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete "${bookTitle}" and all its audio data? This cannot be undone.`)) {
      await books.delete(id);
      loadBooks();
    }
  };

  const handleLogout = () => { clearToken(); setAuthenticated(false); };

  return (
    <div style={styles.page}>
      <header style={styles.header} className="animate-in">
        <div style={styles.headerLeft}>
          <div style={styles.logoRow}>
            <div style={styles.logoCircle}><Headphones size={20} color="#5b8def" /></div>
            <h1 style={styles.h1}>Audio Producer</h1>
          </div>
          <p style={styles.subtitle}>Create audiobooks and podcasts with AI voices, sound effects, and music</p>
        </div>
        <div style={styles.headerActions}>
          <button onClick={() => navigate('/settings')} style={styles.iconBtn} title="Settings">
            <Settings size={16} />
          </button>
          <button onClick={() => setShowCreate(true)} style={styles.createBtn}>
            <Plus size={16} /> New Project
          </button>
          <button onClick={handleLogout} style={styles.iconBtn} title="Log out">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {showCreate && (
        <form onSubmit={handleCreate} style={styles.createForm} className="animate-in-scale">
          <h3 style={styles.formTitle}>New project</h3>
          <div style={styles.typeToggle}>
            <button type="button" onClick={() => { setProjectType('audiobook'); setFormat('single_narrator'); }}
              style={{ ...styles.typeBtn, ...(projectType === 'audiobook' ? styles.typeBtnActive : {}) }}>
              <BookOpen size={15} /> Audiobook
            </button>
            <button type="button" onClick={() => { setProjectType('podcast'); setFormat('two_person_conversation'); }}
              style={{ ...styles.typeBtn, ...(projectType === 'podcast' ? styles.typeBtnActive : {}) }}>
              <Mic size={15} /> Podcast
            </button>
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={projectType === 'podcast' ? 'Episode title' : 'Book title'}
            style={styles.input} autoFocus aria-label="Project title" />
          <input value={author} onChange={(e) => setAuthor(e.target.value)}
            placeholder={projectType === 'podcast' ? 'Host name (optional)' : 'Author (optional)'}
            style={styles.input} aria-label="Author or host" />
          <div style={styles.formatSection}>
            <label style={styles.formatLabel}>Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value)} style={styles.select} aria-label="Project format">
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
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="submit" style={styles.submitBtn}>Create</button>
            <button type="button" onClick={() => setShowCreate(false)} style={styles.cancelBtn}>Cancel</button>
          </div>
        </form>
      )}

      {bookList.length > 0 && <div style={styles.sectionLabel}>YOUR PROJECTS</div>}

      <div style={styles.grid} className="stagger-children">
        {bookList.map((book) => (
          <div key={book.id} onClick={() => navigate(`/book/${book.id}`)} style={styles.card}
            className="card-hover" role="button" tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && navigate(`/book/${book.id}`)}>
            <div style={{
              ...styles.cardIconWrap,
              background: book.project_type === 'podcast' ? 'var(--purple-subtle)' : 'var(--accent-subtle)',
            }}>
              {book.project_type === 'podcast'
                ? <Mic size={20} color="var(--purple)" />
                : <BookOpen size={20} color="var(--accent)" />}
            </div>
            <div style={styles.cardContent}>
              <h3 style={styles.cardTitle}>{book.title}</h3>
              {book.author && <p style={styles.cardAuthor}>{book.author}</p>}
              <div style={styles.cardMeta}>
                <span style={{
                  ...styles.badge,
                  background: book.project_type === 'podcast' ? 'var(--purple-subtle)' : 'var(--accent-subtle)',
                  color: book.project_type === 'podcast' ? 'var(--purple)' : 'var(--accent)',
                }}>
                  {book.project_type === 'podcast' ? 'Podcast' : 'Audiobook'}
                </span>
                <span style={styles.cardDate}>{new Date(book.created_at).toLocaleDateString()}</span>
              </div>
            </div>
            <div style={styles.cardActions}>
              <button onClick={(e) => handleDelete(book.id, book.title, e)} style={styles.deleteBtn}
                aria-label={`Delete ${book.title}`}><Trash2 size={14} /></button>
              <ArrowRight size={14} style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>
        ))}
      </div>

      {bookList.length === 0 && !showCreate && (
        <div style={styles.emptyState} className="animate-in">
          <div style={styles.emptyIconWrap}>
            <Headphones size={36} color="var(--accent)" />
          </div>
          <h3 style={styles.emptyTitle}>No projects yet</h3>
          <p style={styles.emptyText}>
            Create a project, import your text, and AI will assign characters and generate audio with ElevenLabs voices.
          </p>
          <div style={styles.emptySteps} className="stagger-children">
            {[
              'Create a project (audiobook or podcast)',
              'Import text / script (EPUB, DOCX, TXT)',
              'AI auto-assigns characters & voices',
              'Generate audio, arrange on timeline',
              'Render & export final audio',
            ].map((step, i) => (
              <div key={i} style={styles.emptyStep}>
                <span style={styles.stepDot}>{i + 1}</span>
                <span>{step}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 20 }}>
            First time? Go to{' '}
            <button onClick={() => navigate('/settings')} style={styles.linkBtn}>Settings</button>
            {' '}to add your API keys.
          </p>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '32px 40px', maxWidth: 960, margin: '0 auto', minHeight: '100vh', overflow: 'auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 },
  headerLeft: {},
  logoRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  logoCircle: {
    width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-subtle)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  h1: { fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.3px' },
  subtitle: { fontSize: 13, color: 'var(--text-tertiary)', marginLeft: 46 },
  headerActions: { display: 'flex', gap: 8, alignItems: 'center' },
  iconBtn: {
    background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
    color: 'var(--text-tertiary)', borderRadius: 'var(--radius-md)',
    padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center',
  },
  createBtn: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px',
    background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: 13, fontWeight: 500,
    boxShadow: '0 2px 8px rgba(91,141,239,0.2)',
  },
  createForm: {
    display: 'flex', flexDirection: 'column', gap: 12, padding: 24,
    background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)',
    marginBottom: 28, maxWidth: 420, border: '1px solid var(--border-subtle)',
    boxShadow: 'var(--shadow-md)',
  },
  formTitle: { fontSize: 15, color: 'var(--text-primary)', fontWeight: 600 },
  typeToggle: { display: 'flex', gap: 8 },
  typeBtn: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '9px 14px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: 13,
  },
  typeBtnActive: {
    background: 'var(--accent-subtle)', color: 'var(--accent)',
    borderColor: 'rgba(91,141,239,0.3)',
  },
  input: {
    padding: '10px 14px', borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)', background: 'var(--bg-deep)',
    color: 'var(--text-primary)', fontSize: 13, outline: 'none',
  },
  formatSection: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  formatLabel: { fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 500 },
  select: {
    padding: '8px 12px', borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)', background: 'var(--bg-deep)',
    color: 'var(--text-secondary)', fontSize: 12, outline: 'none',
  },
  submitBtn: {
    padding: '10px 24px', background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 500, fontSize: 13,
  },
  cancelBtn: {
    padding: '10px 20px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13,
  },
  sectionLabel: {
    fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1.5, fontWeight: 600,
    marginBottom: 12,
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 },
  card: {
    position: 'relative', padding: '16px 18px', background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-lg)', cursor: 'pointer',
    border: '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', gap: 14,
  },
  cardIconWrap: {
    width: 44, height: 44, borderRadius: 'var(--radius-md)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  cardContent: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardAuthor: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 },
  cardMeta: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' },
  badge: { fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500 },
  cardDate: { fontSize: 10, color: 'var(--text-muted)' },
  cardActions: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flexShrink: 0 },
  deleteBtn: {
    background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
    padding: 4, borderRadius: 'var(--radius-sm)',
  },
  emptyState: { textAlign: 'center', padding: '60px 20px' },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: '50%', background: 'var(--accent-subtle)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    margin: '0 auto 20px', boxShadow: '0 0 30px rgba(91,141,239,0.1)',
  },
  emptyTitle: { fontSize: 18, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 8 },
  emptyText: { fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 440, margin: '0 auto 28px', lineHeight: 1.6 },
  emptySteps: { display: 'inline-flex', flexDirection: 'column', gap: 10, textAlign: 'left' },
  emptyStep: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary)' },
  stepDot: {
    width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-subtle)', color: 'var(--accent)',
    fontSize: 10, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  linkBtn: {
    background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer',
    fontSize: 12, textDecoration: 'underline', padding: 0,
  },
};
