import React, { useEffect, useState, useRef } from 'react';
import { library } from '../services/api';
import { toast } from '../components/Toast';
import type { LibraryBook } from '../types';
import { Upload, BookOpen, Trash2, Download, FileText, Eye, Search, Plus, X, Settings, Headphones } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export function LibraryPage() {
  const navigate = useNavigate();
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedBook, setSelectedBook] = useState<LibraryBook | null>(null);
  const [detailTab, setDetailTab] = useState<'details' | 'read' | 'formats'>('details');
  const [uploading, setUploading] = useState(false);
  const [uploadMeta, setUploadMeta] = useState({ title: '', author: '', description: '', tags: '' });
  const fileRef = useRef<HTMLInputElement>(null);

  const loadBooks = async () => {
    try {
      const data = await library.list();
      setBooks(Array.isArray(data) ? data : []);
    } catch (err) { console.error('Failed to load library:', err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadBooks(); }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await library.upload(file, uploadMeta);
      setUploadMeta({ title: '', author: '', description: '', tags: '' });
      await loadBooks();
    } catch (err: any) { toast.error(`Upload failed: ${err.message}`); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Delete "${title}" from library?`)) return;
    try {
      await library.delete(id);
      if (selectedBook?.id === id) setSelectedBook(null);
      loadBooks();
    } catch (err: any) { toast.error(`Delete failed: ${err.message}`); }
  };

  const handleConvertToAudiobook = async (id: string) => {
    try {
      const result = await library.convertToAudiobook(id);
      toast.info(result.message);
      if (result.book_id) navigate(`/book/${result.book_id}`);
    } catch (err: any) { toast.error(`Conversion failed: ${err.message}`); }
  };

  const filtered = books.filter(b => 
    b.title.toLowerCase().includes(search.toLowerCase()) ||
    b.author?.toLowerCase().includes(search.toLowerCase())
  );

  const canRead = (fmt: string) => ['pdf', 'epub', 'docx', 'txt'].includes(fmt);
  const fl = (fmt: string) => fmt.toUpperCase();

  const st: Record<string, React.CSSProperties> = {
    page: { padding: '32px 40px', maxWidth: 1200, margin: '0 auto', minHeight: '100vh', overflow: 'auto' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.5px' },
    searchBox: { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', padding: '8px 14px', border: '1px solid var(--border-default)' },
    searchInput: { background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: 13, outline: 'none', width: 200 },
    uploadBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: 'var(--accent-gradient)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600, boxShadow: '0 2px 12px rgba(91,141,239,0.2)' },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 },
    card: { padding: 16, background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', cursor: 'pointer', transition: 'all 150ms' },
    cardCover: { width: '100%', height: 140, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12, overflow: 'hidden' },
    cardTitle: { fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 },
    cardAuthor: { fontSize: 12, color: 'var(--text-tertiary)' },
    cardMeta: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' as const },
    badge: { fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'var(--accent-subtle)', color: 'var(--accent)' },
    detailPanel: { position: 'fixed', top: 0, right: 0, width: 500, height: '100vh', background: 'var(--glass-bg)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', borderLeft: '1px solid var(--glass-border)', padding: 24, overflow: 'auto', zIndex: 100, boxShadow: 'var(--shadow-xl)' },
    detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
    detailTitle: { fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' },
    tabBar: { display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 12 },
    tab: { padding: '8px 16px', background: 'transparent', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 13, borderRadius: 'var(--radius-sm)' },
    tabActive: { background: 'var(--accent-subtle)', color: 'var(--accent)' },
    readBtn: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-md)', textDecoration: 'none', fontSize: 13, justifyContent: 'center' },
    actionRow: { display: 'flex', gap: 8, marginTop: 16 },
    actionBtn: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 },
    empty: { textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' },
  };

  return (
    <div style={st.page}>
      <div style={st.header}>
        <h1 style={st.title}>📚 Library</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={st.searchBox}>
            <Search size={14} color="var(--text-muted)" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." style={st.searchInput} />
          </div>
          <button onClick={() => fileRef.current?.click()} style={st.uploadBtn} disabled={uploading}>
            <Upload size={14} /> {uploading ? 'Uploading...' : 'Add Book'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.epub,.docx,.doc,.mobi,.azw,.azw3,.txt" onChange={handleUpload} hidden />
        </div>
      </div>

      {loading ? (
        <div style={st.empty}>Loading library...</div>
      ) : filtered.length === 0 ? (
        <div style={st.empty}>
          <BookOpen size={48} color="var(--text-muted)" style={{ marginBottom: 16 }} />
          <p>No books in library</p>
          <p style={{ fontSize: 12, marginTop: 8 }}>Upload PDF, EPUB, DOCX, or TXT files to get started</p>
        </div>
      ) : (
        <div style={st.grid}>
          {filtered.map(book => (
            <div key={book.id} onClick={() => { setSelectedBook(book); setDetailTab('details'); }} style={st.card}>
              <div style={st.cardCover}>
                {book.cover_path ? <img src={library.coverUrl(book.id)} alt={book.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <BookOpen size={32} color="var(--text-muted)" />}
              </div>
              <div style={st.cardTitle}>{book.title}</div>
              {book.author && <div style={st.cardAuthor}>{book.author}</div>}
              <div style={st.cardMeta}>
                <span style={st.badge}>{book.original_format.toUpperCase()}</span>
                {book.audiobook_ready && <span style={{ ...st.badge, background: 'var(--success-subtle)', color: 'var(--success)' }}>Audio Ready</span>}
                {book.kindle_ready && <span style={{ ...st.badge, background: 'var(--purple-subtle)', color: 'var(--purple)' }}>Kindle Ready</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedBook && (
        <div style={st.detailPanel}>
          <div style={st.detailHeader}>
            <div>
              <div style={st.detailTitle}>{selectedBook.title}</div>
              {selectedBook.author && <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{selectedBook.author}</div>}
            </div>
            <button onClick={() => setSelectedBook(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
          </div>

          <div style={st.tabBar}>
            <button onClick={() => setDetailTab('details')} style={{ ...st.tab, ...(detailTab === 'details' ? st.tabActive : {}) }}>Details</button>
            <button onClick={() => setDetailTab('read')} style={{ ...st.tab, ...(detailTab === 'read' ? st.tabActive : {}) }}>Read</button>
            <button onClick={() => setDetailTab('formats')} style={{ ...st.tab, ...(detailTab === 'formats' ? st.tabActive : {}) }}>Formats</button>
          </div>

          {detailTab === 'details' && (
            <div>
              {selectedBook.description && <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{selectedBook.description}</p>}
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
                <div>Format: {selectedBook.original_format.toUpperCase()}</div>
                {selectedBook.isbn && <div>ISBN: {selectedBook.isbn}</div>}
                {selectedBook.page_count && <div>Pages: {selectedBook.page_count}</div>}
                {selectedBook.tags && <div style={{ marginTop: 8 }}>Tags: {selectedBook.tags}</div>}
              </div>
              <div style={st.actionRow}>
                <button onClick={() => handleConvertToAudiobook(selectedBook.id)} style={st.actionBtn}><Headphones size={14} /> Convert to Audiobook</button>
                <button onClick={() => handleDelete(selectedBook.id, selectedBook.title)} style={{ ...st.actionBtn, color: 'var(--danger)' }}><Trash2 size={14} /> Delete</button>
              </div>
            </div>
          )}

          {detailTab === 'read' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Read your book in the browser.</p>
              {selectedBook.original_format === 'pdf' ? (
                <>
                  <a href={library.readUrl(selectedBook.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Open PDF Reader</a>
                  <iframe src={library.readUrl(selectedBook.id)} style={{ width: '100%', height: 500, border: '1px solid var(--border-subtle)', borderRadius: 8, background: '#fff' }} title="Reader" />
                </>
              ) : selectedBook.original_format === 'epub' ? (
                <a href={library.readUrl(selectedBook.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Download EPUB to read</a>
              ) : (selectedBook.original_format === 'docx' || selectedBook.original_format === 'txt' || selectedBook.original_format === 'kindle' || selectedBook.original_format === 'mobi') ? (
                <>
                  <a href={library.readHtmlUrl(selectedBook.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Open {fl(selectedBook.original_format)} Reader</a>
                  <iframe src={library.readHtmlUrl(selectedBook.id)} style={{ width: '100%', height: 500, border: '1px solid var(--border-subtle)', borderRadius: 8, background: '#fff' }} title="Reader" />
                </>
              ) : (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>This format cannot be read in browser. Download or upload a PDF/EPUB.</div>
              )}
              {selectedBook.formats?.filter(f => f.format !== selectedBook.original_format && canRead(f.format)).map(fmt => (
                <a key={fmt.id} href={fmt.format === 'docx' || fmt.format === 'txt' ? library.readHtmlUrl(selectedBook.id) : library.formatReadUrl(selectedBook.id, fmt.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Read {fl(fmt.format)}</a>
              ))}
              <a href={library.downloadUrl(selectedBook.id)} style={{ ...st.readBtn, background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}><Download size={16} /> Download original</a>
            </div>
          )}

          {detailTab === 'formats' && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Available Formats</div>
              {selectedBook.formats?.map(fmt => (
                <div key={fmt.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13 }}>{fmt.format.toUpperCase()}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{(fmt.file_size_bytes / 1024 / 1024).toFixed(1)} MB</div>
                  </div>
                  <a href={library.formatDownloadUrl(selectedBook.id, fmt.id)} style={{ color: 'var(--accent)', fontSize: 12 }}><Download size={14} /></a>
                </div>
              ))}
              <button style={{ ...st.actionBtn, marginTop: 12 }}><Plus size={14} /> Add Format</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}