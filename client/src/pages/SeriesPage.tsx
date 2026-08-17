import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { series as seriesApi, books as booksApi } from '../services/api';
import { toast } from '../components/Toast';
import type { Series, Book } from '../types';
import { Library, Plus, BookOpen, Users, Mic, X, Link2, Trash2, ArrowRight } from 'lucide-react';

/**
 * Series = a group of book volumes that share character voice memory
 * automatically. Assigning a voice to "Alice" in Volume 1 means Volume 2
 * (and 3, and 4...) recall the exact same voice the moment "Alice" shows up,
 * with zero manual re-assignment.
 */
export function SeriesPage() {
  const navigate = useNavigate();
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [seriesAuthor, setSeriesAuthor] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Series | null>(null);
  const [attachingBookId, setAttachingBookId] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([seriesApi.list(), booksApi.list()]);
      setSeriesList(Array.isArray(s) ? s : []);
      setAllBooks(Array.isArray(b) ? b : []);
    } catch (err: any) {
      toast.error(`Failed to load series: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await seriesApi.create({ name: name.trim(), author: seriesAuthor.trim() || undefined });
      setName(''); setSeriesAuthor(''); setShowCreate(false);
      load();
    } catch (err: any) { toast.error(`Failed to create series: ${err.message}`); }
  };

  const handleDelete = async (id: string, seriesName: string) => {
    if (!confirm(`Delete series "${seriesName}"? Its books will stay, but will no longer share voice memory.`)) return;
    try {
      await seriesApi.delete(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      load();
    } catch (err: any) { toast.error(`Failed to delete: ${err.message}`); }
  };

  const toggleExpand = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id);
    try {
      const detail = await seriesApi.get(id);
      setExpandedDetail(detail);
    } catch (err: any) { toast.error(`Failed to load series detail: ${err.message}`); }
  };

  const handleAttach = async (seriesId: string) => {
    if (!attachingBookId) return;
    try {
      await seriesApi.attachBook(seriesId, attachingBookId);
      setAttachingBookId('');
      const detail = await seriesApi.get(seriesId);
      setExpandedDetail(detail);
      load();
      toast.success('Book added to series. Its characters will now recall/share voices with the rest of the series.');
    } catch (err: any) { toast.error(`Failed to attach book: ${err.message}`); }
  };

  const handleDetach = async (seriesId: string, bookId: string) => {
    try {
      await seriesApi.detachBook(seriesId, bookId);
      const detail = await seriesApi.get(seriesId);
      setExpandedDetail(detail);
      load();
    } catch (err: any) { toast.error(`Failed to detach book: ${err.message}`); }
  };

  const unattachedBooks = allBooks.filter((b) => !expandedDetail?.books?.some((bb) => bb.id === b.id));

  if (loading) {
    return <div style={S.page}><p style={{ color: 'var(--text-tertiary)' }}>Loading series...</p></div>;
  }

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div>
          <h1 style={S.title}><Library size={20} /> Series</h1>
          <p style={S.subtitle}>Group multiple book volumes so character voices carry over automatically — assign "Alice" once, every volume remembers her.</p>
        </div>
        <button onClick={() => setShowCreate(true)} style={S.createBtn}><Plus size={14} /> New Series</button>
      </header>

      {showCreate && (
        <form onSubmit={handleCreate} style={S.createForm}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Series name (e.g. 'The Windrunner Chronicles')"
            style={S.input} autoFocus aria-label="Series name" />
          <input value={seriesAuthor} onChange={(e) => setSeriesAuthor(e.target.value)} placeholder="Author (optional)"
            style={S.input} aria-label="Series author" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" style={S.submitBtn}>Create</button>
            <button type="button" onClick={() => setShowCreate(false)} style={S.cancelBtn}>Cancel</button>
          </div>
        </form>
      )}

      {seriesList.length === 0 && !showCreate && (
        <div style={S.emptyState}>
          <Library size={28} color="var(--text-muted)" />
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No series yet</p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 400, textAlign: 'center' }}>
            Create a series and attach your book volumes to it. Every character voice you assign in one volume is remembered in the rest.
          </p>
        </div>
      )}

      <div style={S.list}>
        {seriesList.map((s) => {
          const isExpanded = expandedId === s.id;
          return (
            <div key={s.id} style={S.seriesCard}>
              <div style={S.seriesHeader} onClick={() => toggleExpand(s.id)}>
                <div style={S.seriesIcon}><Library size={16} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={S.seriesName}>{s.name}</div>
                  <div style={S.seriesMeta}>
                    {s.author ? `${s.author} · ` : ''}{s.book_count ?? 0} volume{(s.book_count ?? 0) === 1 ? '' : 's'}
                  </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.name); }} style={S.iconBtn} aria-label={`Delete ${s.name}`}>
                  <Trash2 size={13} />
                </button>
              </div>

              {isExpanded && expandedDetail && expandedDetail.id === s.id && (
                <div style={S.seriesBody}>
                  <div style={S.subSection}>
                    <div style={S.subHeader}><BookOpen size={12} /> Volumes</div>
                    {(expandedDetail.books || []).length === 0 && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>No volumes attached yet.</p>
                    )}
                    {(expandedDetail.books || []).map((b: any) => (
                      <div key={b.id} style={S.bookRow}>
                        <button onClick={() => navigate(`/book/${b.id}`)} style={S.bookLink}>
                          {b.project_type === 'podcast' ? <Mic size={12} /> : <BookOpen size={12} />} {b.title}
                          {b.series_volume != null && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> (Vol. {b.series_volume})</span>}
                          <ArrowRight size={10} />
                        </button>
                        <button onClick={() => handleDetach(s.id, b.id)} style={S.iconBtn} title="Remove from series" aria-label={`Remove ${b.title} from series`}>
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    <div style={S.attachRow}>
                      <select value={attachingBookId} onChange={(e) => setAttachingBookId(e.target.value)} style={S.select} aria-label="Book to attach">
                        <option value="">Attach an existing book...</option>
                        {unattachedBooks.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                      </select>
                      <button onClick={() => handleAttach(s.id)} disabled={!attachingBookId} style={S.attachBtn}>
                        <Link2 size={12} /> Attach
                      </button>
                    </div>
                  </div>

                  <div style={S.subSection}>
                    <div style={S.subHeader}><Users size={12} /> Shared Cast ({(expandedDetail.cast || []).filter((m: any) => m.voice_id).length} voiced)</div>
                    {(expandedDetail.cast || []).length === 0 && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>No characters remembered yet. Assign voices in any volume — they'll show up here automatically.</p>
                    )}
                    <div style={S.castGrid}>
                      {(expandedDetail.cast || []).map((m: any) => (
                        <div key={m.id} style={S.castChip}>
                          <span>{m.character_name}</span>
                          {m.voice_name && <span style={{ color: 'var(--accent)', fontSize: 9 }}>{m.voice_name}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { padding: '28px 32px 64px', maxWidth: 800, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8, margin: 0 },
  subtitle: { fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4, maxWidth: 520, lineHeight: 1.5 },
  createBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: 'var(--accent-gradient)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' },
  createForm: { display: 'flex', flexDirection: 'column', gap: 10, padding: 18, background: 'var(--bg-surface)', borderRadius: 12, border: '1px solid var(--border-subtle)', marginBottom: 20, maxWidth: 400 },
  input: { padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
  submitBtn: { padding: '8px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  cancelBtn: { padding: '8px 16px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer', fontSize: 12 },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '48px 20px' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  seriesCard: { background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 12, overflow: 'hidden' },
  seriesHeader: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer' },
  seriesIcon: { width: 34, height: 34, borderRadius: 9, background: 'var(--accent-subtle)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  seriesName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  seriesMeta: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 },
  iconBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 },
  seriesBody: { padding: '4px 16px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 16 },
  subSection: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12 },
  subHeader: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' },
  bookRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px', background: 'var(--bg-elevated)', borderRadius: 8 },
  bookLink: { display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: 0 },
  attachRow: { display: 'flex', gap: 6, marginTop: 4 },
  select: { flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 12, outline: 'none' },
  attachBtn: { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' },
  castGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  castChip: { display: 'flex', flexDirection: 'column', gap: 1, padding: '5px 10px', background: 'var(--bg-elevated)', borderRadius: 8, fontSize: 11, color: 'var(--text-secondary)' },
};
