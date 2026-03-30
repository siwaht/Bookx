import React, { useEffect, useState, useRef } from 'react';
import { library } from '../services/api';
import type { LibraryBook } from '../types';
import { Upload, BookOpen, Trash2, Download, FileText, Eye, Image, Headphones, Plus, X, Check, Loader, Edit3, BookMarked, Smartphone, Globe, Music } from 'lucide-react';

type DetailTab = 'info' | 'formats' | 'publish' | 'read';

export function LibraryPage() {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBook, setSelectedBook] = useState<LibraryBook | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('info');
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadAuthor, setUploadAuthor] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editIsbn, setEditIsbn] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const formatRef = useRef<HTMLInputElement>(null);

  const loadBooks = async () => {
    try { const d = await library.list(); setBooks(Array.isArray(d) ? d : []); }
    catch { /* ignore */ } finally { setLoading(false); }
  };
  useEffect(() => { loadBooks(); }, []);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault(); if (!uploadFile) return; setUploading(true);
    try {
      await library.upload(uploadFile, { title: uploadTitle, author: uploadAuthor, description: uploadDesc });
      setShowUpload(false); setUploadFile(null); setUploadTitle(''); setUploadAuthor(''); setUploadDesc('');
      loadBooks();
    } catch (err: any) { alert(err.message); } finally { setUploading(false); }
  };

  const handleDelete = async (id: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation(); if (!confirm(`Delete "${title}"?`)) return;
    await library.delete(id); if (selectedBook?.id === id) setSelectedBook(null); loadBooks();
  };

  const handleCoverUpload = async (file: File) => {
    if (!selectedBook) return;
    try { await library.uploadCover(selectedBook.id, file); const u = await library.get(selectedBook.id); setSelectedBook(u); loadBooks(); }
    catch (err: any) { alert(err.message); }
  };

  const handleFormatUpload = async (file: File) => {
    if (!selectedBook) return;
    try { await library.uploadFormat(selectedBook.id, file); const u = await library.get(selectedBook.id); setSelectedBook(u); loadBooks(); }
    catch (err: any) { alert(err.message); }
  };

  const handleSaveMeta = async () => {
    if (!selectedBook) return;
    try { const u = await library.update(selectedBook.id, { title: editTitle, author: editAuthor, description: editDesc, isbn: editIsbn }); setSelectedBook(u); setEditingMeta(false); loadBooks(); }
    catch (err: any) { alert(err.message); }
  };

  const handlePrepareAudiobook = async () => {
    if (!selectedBook) return;
    try { const r = await library.prepareAudiobook(selectedBook.id); alert(r.message); const u = await library.get(selectedBook.id); setSelectedBook(u); loadBooks(); }
    catch (err: any) { alert(err.message); }
  };

  const handlePrepareKindle = async () => {
    if (!selectedBook) return;
    try { const r = await library.prepareKindle(selectedBook.id); alert(r.message); const u = await library.get(selectedBook.id); setSelectedBook(u); loadBooks(); }
    catch (err: any) { alert(err.message); }
  };

  const openBook = (b: LibraryBook) => { setSelectedBook(b); setDetailTab('info'); setEditingMeta(false); };

  const startEdit = () => {
    if (!selectedBook) return;
    setEditTitle(selectedBook.title); setEditAuthor(selectedBook.author || '');
    setEditDesc(selectedBook.description || ''); setEditIsbn(selectedBook.isbn || '');
    setEditingMeta(true);
  };

  const fl = (f: string) => ({ pdf: 'PDF', epub: 'EPUB', docx: 'Word', kindle: 'Kindle', mobi: 'MOBI', txt: 'Text' }[f] || f.toUpperCase());
  const fz = (b: number) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  const canRead = (f: string) => ['pdf', 'epub', 'docx', 'txt'].includes(f);

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-deep)', color: 'var(--text-tertiary)' }}>Loading...</div>;

  const pubTargets = [
    { key: 'ke', icon: Smartphone, label: 'Amazon Kindle eBook', desc: 'Publish as Kindle eBook', ready: selectedBook?.kindle_ready, color: 'var(--warning)' },
    { key: 'kp', icon: BookOpen, label: 'Amazon Paperback', desc: 'Print-on-demand via KDP', ready: selectedBook?.kindle_ready, color: 'var(--warning)' },
    { key: 'kh', icon: BookMarked, label: 'Amazon Hardcover', desc: 'Hardcover via KDP', ready: selectedBook?.kindle_ready, color: 'var(--warning)' },
    { key: 'ab', icon: Headphones, label: 'Audiobook (ACX/Audible)', desc: 'Convert to audiobook', ready: selectedBook?.audiobook_ready, color: 'var(--success)' },
    { key: 'sp', icon: Music, label: 'Spotify Audiobook', desc: 'Distribute on Spotify', ready: selectedBook?.audiobook_ready, color: '#1DB954' },
    { key: 'ap', icon: BookOpen, label: 'Apple Books', desc: 'Publish on Apple Books', ready: !!selectedBook?.formats?.some(f => f.format === 'epub'), color: 'var(--accent)' },
    { key: 'gp', icon: Globe, label: 'Google Play Books', desc: 'Publish on Google Play', ready: !!selectedBook?.formats?.some(f => f.format === 'epub' || f.format === 'pdf'), color: 'var(--accent)' },
  ];

  return (
    <div style={st.page}>
      <header style={st.header} className="animate-in">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--purple-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><BookMarked size={20} color="var(--purple)" /></div>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)' }}>Book Library</h1>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginLeft: 46 }}>Store, manage, and prepare your books for publishing</p>
        </div>
        <button onClick={() => setShowUpload(true)} style={st.primaryBtn}><Upload size={16} /> Add Book</button>
      </header>

      {showUpload && (
        <form onSubmit={handleUpload} style={st.form} className="animate-in-scale">
          <h3 style={{ fontSize: 15, color: 'var(--text-primary)', fontWeight: 600 }}>Add book to library</h3>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Upload PDF, EPUB, Word, Kindle/MOBI, or text files</p>
          <input value={uploadTitle} onChange={e => setUploadTitle(e.target.value)} placeholder="Book title" style={st.input} autoFocus />
          <input value={uploadAuthor} onChange={e => setUploadAuthor(e.target.value)} placeholder="Author (optional)" style={st.input} />
          <textarea value={uploadDesc} onChange={e => setUploadDesc(e.target.value)} placeholder="Description (optional)" style={{ ...st.input, minHeight: 60, resize: 'vertical' as const }} />
          <button type="button" onClick={() => fileRef.current?.click()} style={{ ...st.input, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: uploadFile ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            <Upload size={14} />{uploadFile ? `${uploadFile.name} (${fz(uploadFile.size)})` : 'Choose file...'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.epub,.docx,.doc,.mobi,.azw,.azw3,.txt" onChange={e => setUploadFile(e.target.files?.[0] || null)} hidden />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={uploading || !uploadFile} style={{ ...st.primaryBtn, opacity: (uploading || !uploadFile) ? 0.5 : 1 }}>{uploading ? 'Uploading...' : 'Upload'}</button>
            <button type="button" onClick={() => { setShowUpload(false); setUploadFile(null); }} style={st.cancelBtn}>Cancel</button>
          </div>
        </form>
      )}

      <div style={{ display: 'flex', gap: 20, flex: 1, minHeight: 0 }}>
        <div style={{ flex: selectedBook ? '0 0 360px' : 1, overflow: 'auto' }}>
          {books.length > 0 && <div style={st.sectionLabel}>YOUR BOOKS ({books.length})</div>}
          <div style={{ display: 'grid', gridTemplateColumns: selectedBook ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }} className="stagger-children">
            {books.map(bk => (
              <div key={bk.id} onClick={() => openBook(bk)} style={{ ...st.card, ...(selectedBook?.id === bk.id ? { borderColor: 'var(--accent)', background: 'var(--accent-subtle)' } : {}) }} className="card-hover" role="button" tabIndex={0}>
                <div style={{ width: 48, height: 64, borderRadius: 6, background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                  {bk.cover_path ? <img src={`${library.coverUrl(bk.id)}?t=${bk.updated_at}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <BookOpen size={20} color="var(--text-muted)" />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bk.title}</div>
                  {bk.author && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{bk.author}</div>}
                  <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' as const }}>
                    <span style={{ ...st.badge, background: 'var(--purple-subtle)', color: 'var(--purple)' }}>{fl(bk.original_format)}</span>
                    {bk.audiobook_ready ? <span style={{ ...st.badge, background: 'var(--success-subtle)', color: 'var(--success)' }}>Audiobook</span> : null}
                    {bk.kindle_ready ? <span style={{ ...st.badge, background: 'var(--warning-subtle)', color: 'var(--warning)' }}>Kindle</span> : null}
                  </div>
                </div>
                <button onClick={e => handleDelete(bk.id, bk.title, e)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          {books.length === 0 && !showUpload && (
            <div style={{ textAlign: 'center', padding: '80px 20px' }} className="animate-in">
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'var(--purple-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}><BookMarked size={36} color="var(--purple)" /></div>
              <h3 style={{ fontSize: 18, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 8 }}>Your library is empty</h3>
              <p style={{ fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 400, margin: '0 auto 20px', lineHeight: 1.6 }}>Upload books in PDF, EPUB, Word, or Kindle format.</p>
              <button onClick={() => setShowUpload(true)} style={st.primaryBtn}><Upload size={16} /> Add Your First Book</button>
            </div>
          )}
        </div>

        {selectedBook && (
          <div style={st.detailPanel} className="animate-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>{selectedBook.title}</h2>
              <button onClick={() => setSelectedBook(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={16} /></button>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              {(['info', 'formats', 'publish', 'read'] as DetailTab[]).map(t => (
                <button key={t} onClick={() => setDetailTab(t)} style={{ ...st.tabBtn, ...(detailTab === t ? st.tabActive : {}) }}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </div>

            {detailTab === 'info' && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  <div style={{ width: 120, height: 160, borderRadius: 8, background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--border-subtle)', cursor: 'pointer', position: 'relative' as const }} onClick={() => coverRef.current?.click()}>
                    {selectedBook.cover_path
                      ? <img src={`${library.coverUrl(selectedBook.id)}?t=${selectedBook.updated_at}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}><Image size={24} /><div style={{ fontSize: 10, marginTop: 4 }}>Add cover</div></div>}
                    <div style={{ position: 'absolute' as const, bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.6)', padding: '4px 0', textAlign: 'center', fontSize: 10, color: '#fff' }}>Change</div>
                  </div>
                  <input ref={coverRef} type="file" accept=".jpg,.jpeg,.png,.webp" onChange={e => { if (e.target.files?.[0]) handleCoverUpload(e.target.files[0]); }} hidden />
                  {editingMeta ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                      <input value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="Title" style={st.input} />
                      <input value={editAuthor} onChange={e => setEditAuthor(e.target.value)} placeholder="Author" style={st.input} />
                      <input value={editIsbn} onChange={e => setEditIsbn(e.target.value)} placeholder="ISBN" style={st.input} />
                      <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Description" style={{ ...st.input, minHeight: 50, resize: 'vertical' as const }} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={handleSaveMeta} style={{ ...st.smallBtn, background: 'var(--accent)', color: '#fff' }}><Check size={12} /> Save</button>
                        <button onClick={() => setEditingMeta(false)} style={st.smallBtn}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ flex: 1 }}>
                      {selectedBook.author && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4 }}>by {selectedBook.author}</div>}
                      {selectedBook.isbn && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>ISBN: {selectedBook.isbn}</div>}
                      {selectedBook.description && <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>{selectedBook.description}</div>}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>{fl(selectedBook.original_format)} &middot; {fz(selectedBook.file_size_bytes)} &middot; {new Date(selectedBook.created_at).toLocaleDateString()}</div>
                      <button onClick={startEdit} style={st.smallBtn}><Edit3 size={12} /> Edit</button>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                  {selectedBook.audiobook_ready
                    ? <span style={{ ...st.statusBadge, background: 'var(--success-subtle)', color: 'var(--success)' }}><Headphones size={12} /> Audiobook Ready</span>
                    : <button onClick={handlePrepareAudiobook} style={{ ...st.statusBadge, cursor: 'pointer', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}><Headphones size={12} /> Prepare Audiobook</button>}
                  {selectedBook.kindle_ready
                    ? <span style={{ ...st.statusBadge, background: 'var(--warning-subtle)', color: 'var(--warning)' }}><Smartphone size={12} /> Kindle Ready</span>
                    : <button onClick={handlePrepareKindle} style={{ ...st.statusBadge, cursor: 'pointer', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}><Smartphone size={12} /> Prepare Kindle</button>}
                </div>
              </div>
            )}

            {detailTab === 'formats' && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Manage file formats for this book.</p>
                {selectedBook.formats?.map(fmt => (
                  <div key={fmt.id} style={st.formatRow}>
                    <FileText size={16} color="var(--text-tertiary)" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{fl(fmt.format)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fz(fmt.file_size_bytes)}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {canRead(fmt.format) && <a href={library.formatReadUrl(selectedBook.id, fmt.id)} target="_blank" rel="noopener noreferrer" style={st.iconBtn}><Eye size={14} /></a>}
                      <a href={library.formatDownloadUrl(selectedBook.id, fmt.id)} style={st.iconBtn}><Download size={14} /></a>
                      <button onClick={async () => { await library.deleteFormat(selectedBook.id, fmt.id); const u = await library.get(selectedBook.id); setSelectedBook(u); loadBooks(); }} style={{ ...st.iconBtn, color: 'var(--danger)' }}><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))}
                <button onClick={() => formatRef.current?.click()} style={st.smallBtn}><Plus size={12} /> Add format</button>
                <input ref={formatRef} type="file" accept=".pdf,.epub,.docx,.doc,.mobi,.azw,.azw3,.txt" onChange={e => { if (e.target.files?.[0]) handleFormatUpload(e.target.files[0]); }} hidden />
              </div>
            )}

            {detailTab === 'publish' && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Prepare and publish to various platforms.</p>
                {pubTargets.map(t => (
                  <div key={t.key} style={st.publishCard}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: t.ready ? 'var(--success-subtle)' : 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <t.icon size={18} color={t.ready ? t.color : 'var(--text-muted)'} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{t.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.desc}</div>
                    </div>
                    {t.ready
                      ? <span style={{ ...st.badge, background: 'var(--success-subtle)', color: 'var(--success)' }}><Check size={10} /> Ready</span>
                      : <span style={{ ...st.badge, background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>Not ready</span>}
                  </div>
                ))}
                <div style={{ padding: 14, background: 'var(--accent-subtle)', borderRadius: 10, border: '1px solid rgba(91,141,239,0.1)', marginTop: 4 }}>
                  <p style={{ fontSize: 12, color: 'var(--accent)', lineHeight: 1.5 }}>Tip: Use the Info tab to prepare for Kindle and Audiobook. Upload EPUB for Apple Books and Google Play.</p>
                </div>
              </div>
            )}

            {detailTab === 'read' && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Read your book in the browser.</p>
                {canRead(selectedBook.original_format) ? (
                  <>
                    <a href={library.readUrl(selectedBook.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Open {fl(selectedBook.original_format)} Reader</a>
                    {selectedBook.original_format === 'pdf' && <iframe src={library.readUrl(selectedBook.id)} style={{ width: '100%', height: 500, border: '1px solid var(--border-subtle)', borderRadius: 8, background: '#fff' }} title="Reader" />}
                  </>
                ) : (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>This format cannot be read in browser. Download or upload a PDF/EPUB.</div>
                )}
                {selectedBook.formats?.filter(f => f.format !== selectedBook.original_format && canRead(f.format)).map(fmt => (
                  <a key={fmt.id} href={library.formatReadUrl(selectedBook.id, fmt.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Read {fl(fmt.format)}</a>
                ))}
                <a href={library.downloadUrl(selectedBook.id)} style={{ ...st.readBtn, background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}><Download size={16} /> Download original</a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  page: { padding: '32px 40px', maxWidth: 1200, margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 },
  primaryBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: 'var(--purple)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 500 },
  cancelBtn: { padding: '10px 20px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13 },
  form: { display: 'flex', flexDirection: 'column', gap: 12, padding: 24, background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', marginBottom: 24, maxWidth: 460, border: '1px solid var(--border-subtle)' },
  input: { padding: '10px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
  sectionLabel: { fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1.5, fontWeight: 600, marginBottom: 12 },
  card: { padding: '14px 16px', background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', cursor: 'pointer', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 12 },
  badge: { fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 3 },
  detailPanel: { flex: 1, minWidth: 0, padding: 24, background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', overflow: 'auto', maxHeight: 'calc(100vh - 160px)' },
  tabBtn: { padding: '7px 14px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  tabActive: { background: 'var(--accent-subtle)', color: 'var(--accent)', borderColor: 'rgba(91,141,239,0.25)' },
  smallBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 11, fontWeight: 500 },
  statusBadge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500, border: '1px solid var(--border-subtle)' },
  formatRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' },
  iconBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)', cursor: 'pointer', textDecoration: 'none' },
  publishCard: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' },
  readBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 20px', background: 'var(--accent-subtle)', color: 'var(--accent)', border: '1px solid rgba(91,141,239,0.15)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 500, textDecoration: 'none' },
};
