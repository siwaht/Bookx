import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  chapters as chaptersApi,
  importManuscript,
  segments as segmentsApi,
  characters as charsApi,
  timeline as timelineApi,
} from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Chapter, Segment, Character } from '../types';
import { Upload, Play, RefreshCw, Plus, Zap, LayoutDashboard, Trash2, BookOpen, Scissors, Users, Volume2 } from 'lucide-react';

export function ManuscriptPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [chapterList, setChapterList] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [segmentList, setSegmentList] = useState<Segment[]>([]);
  const [characterList, setCharacterList] = useState<Character[]>([]);
  const [importing, setImporting] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const [populating, setPopulating] = useState(false);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadChapters = useCallback(async () => {
    if (!bookId) return;
    try {
      const data = await chaptersApi.list(bookId);
      setChapterList(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length > 0 && !selectedChapter) setSelectedChapter(data[0]);
    } catch (err) { console.error('Failed to load chapters:', err); }
  }, [bookId]);

  const loadSegments = useCallback(async (chapterId: string) => {
    try {
      const data = await segmentsApi.list(chapterId);
      setSegmentList(Array.isArray(data) ? data : []);
    } catch (err) { console.error('Failed to load segments:', err); }
  }, []);

  const loadCharacters = useCallback(async () => {
    if (!bookId) return;
    try {
      const data = await charsApi.list(bookId);
      setCharacterList(Array.isArray(data) ? data : []);
    } catch (err) { console.error('Failed to load characters:', err); }
  }, [bookId]);

  useEffect(() => { loadChapters(); loadCharacters(); }, [loadChapters, loadCharacters]);
  useEffect(() => { if (selectedChapter) loadSegments(selectedChapter.id); }, [selectedChapter?.id, loadSegments]);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !bookId) return;
    setImporting(true);
    try {
      await importManuscript(bookId, file);
      await loadChapters();
    } catch (err: any) { alert(`Import failed: ${err.message}`); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const handleAutoSegment = async () => {
    if (!selectedChapter) return;
    const text = selectedChapter.cleaned_text || selectedChapter.raw_text;
    const paragraphs = text.split(/\n\s*\n/).filter((p: string) => p.trim());
    for (let i = 0; i < paragraphs.length; i++) {
      await segmentsApi.create(selectedChapter.id, { text: paragraphs[i].trim(), sort_order: i });
    }
    loadSegments(selectedChapter.id);
  };

  const handleGenerate = async (segmentId: string) => {
    if (!selectedChapter) return;
    setGeneratingId(segmentId);
    try {
      await segmentsApi.generate(selectedChapter.id, segmentId);
      loadSegments(selectedChapter.id);
    } catch (err: any) { alert(`Generation failed: ${err.message}`); }
    finally { setGeneratingId(null); }
  };

  const handleBatchGenerate = async () => {
    if (!selectedChapter) return;
    setBatchGenerating(true);
    setBatchProgress('Starting batch generation...');
    try {
      const result = await segmentsApi.batchGenerate(selectedChapter.id);
      setBatchProgress(`Done: ${result.summary.generated} generated, ${result.summary.cached} cached, ${result.summary.failed} failed`);
      loadSegments(selectedChapter.id);
    } catch (err: any) { setBatchProgress(`Error: ${err.message}`); }
    finally { setBatchGenerating(false); }
  };

  const handleAssignCharacter = async (segmentId: string, characterId: string | null) => {
    if (!selectedChapter) return;
    await segmentsApi.update(selectedChapter.id, segmentId, { character_id: characterId || null });
    loadSegments(selectedChapter.id);
  };

  const handleDeleteSegment = async (segmentId: string) => {
    if (!selectedChapter) return;
    await segmentsApi.delete(selectedChapter.id, segmentId);
    loadSegments(selectedChapter.id);
  };

  const handlePopulateTimeline = async () => {
    if (!bookId) return;
    setPopulating(true);
    try {
      const result = await timelineApi.populate(bookId);
      alert(`Timeline populated: ${result.clips_created} clips placed, ${result.markers_created} chapter markers set.`);
    } catch (err: any) { alert(`Populate failed: ${err.message}`); }
    finally { setPopulating(false); }
  };

  const handleChapterTextChange = (text: string) => {
    if (!selectedChapter || !bookId) return;
    setSelectedChapter({ ...selectedChapter, raw_text: text });
    chaptersApi.update(bookId, selectedChapter.id, { raw_text: text });
  };

  const segmentsWithAudio = segmentList.filter((s) => s.audio_asset_id);
  const segmentsWithoutAudio = segmentList.filter((s) => !s.audio_asset_id);
  const segmentsWithCharacter = segmentList.filter((s) => s.character_id);
  const allHaveCharacters = segmentList.length > 0 && segmentsWithCharacter.length === segmentList.length;
  const allHaveAudio = segmentList.length > 0 && segmentsWithAudio.length === segmentList.length;

  // Determine workflow progress for this chapter
  const hasChapters = chapterList.length > 0;
  const hasSegments = segmentList.length > 0;

  return (
    <div style={styles.container}>
      {/* ── Left: Chapters ── */}
      <div style={styles.chapterPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.panelTitle}>📖 Chapters</h3>
          <button onClick={() => fileRef.current?.click()} style={styles.importBtn} disabled={importing}>
            <Upload size={14} /> {importing ? 'Importing...' : 'Import'}
          </button>
          <input ref={fileRef} type="file" accept=".txt,.md,.docx,.epub,.html,.htm" onChange={handleImport} hidden aria-label="Import manuscript file" />
        </div>

        <div style={styles.chapterList}>
          {chapterList.map((ch) => (
            <button key={ch.id} onClick={() => setSelectedChapter(ch)}
              style={{ ...styles.chapterItem, background: selectedChapter?.id === ch.id ? '#2a2a2a' : 'transparent', color: selectedChapter?.id === ch.id ? '#4A90D9' : '#aaa' }}>
              {ch.title}
            </button>
          ))}

          {!hasChapters && (
            <div style={styles.emptyChapters}>
              <BookOpen size={24} color="#444" />
              <p style={styles.emptyTitle}>No chapters yet</p>
              <p style={styles.emptyHint}>Click "Import" above to load your manuscript.</p>
              <p style={styles.emptyFormats}>Supported formats: EPUB, DOCX, TXT, Markdown, HTML</p>
              <p style={styles.emptyFormats}>The importer will auto-detect chapters from your file structure.</p>
            </div>
          )}
        </div>

        {hasChapters && (
          <div style={styles.panelFooter}>
            <button onClick={handlePopulateTimeline} disabled={populating || !allHaveAudio} style={{
              ...styles.populateBtn,
              opacity: allHaveAudio ? 1 : 0.5,
            }} title={allHaveAudio ? 'Send all generated audio to the timeline' : 'Generate audio for all segments first'}>
              <LayoutDashboard size={14} /> {populating ? 'Populating...' : 'Send to Timeline'}
            </button>
            {!allHaveAudio && hasSegments && (
              <p style={styles.footerHint}>Generate audio for all segments first</p>
            )}
          </div>
        )}
      </div>

      {/* ── Center: Chapter Text Editor ── */}
      <div style={styles.editorPanel}>
        {selectedChapter ? (
          <>
            <div style={styles.editorHeader}>
              <h3 style={styles.panelTitle}>{selectedChapter.title}</h3>
              <span style={styles.editorHint}>Edit text before splitting into segments →</span>
            </div>
            <textarea
              value={selectedChapter.cleaned_text || selectedChapter.raw_text}
              onChange={(e) => handleChapterTextChange(e.target.value)}
              style={styles.textarea} aria-label="Chapter text"
            />
          </>
        ) : (
          <div style={styles.emptyEditor}>
            <p style={styles.emptyEditorText}>
              {hasChapters ? '← Select a chapter to view and edit its text' : 'Import a manuscript to get started'}
            </p>
          </div>
        )}
      </div>

      {/* ── Right: Segments ── */}
      <div style={styles.segmentPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.panelTitle}>🔊 Segments</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={handleAutoSegment} style={styles.actionBtn} disabled={!selectedChapter}
              title="Split chapter text into paragraph-based segments">
              <Scissors size={14} /> Split
            </button>
            <button onClick={handleBatchGenerate}
              style={{ ...styles.actionBtn, background: segmentsWithoutAudio.length > 0 ? '#2d5a27' : '#333', color: segmentsWithoutAudio.length > 0 ? '#8f8' : '#666' }}
              disabled={!selectedChapter || batchGenerating || segmentList.length === 0}
              title="Generate TTS audio for all segments that have a character assigned">
              <Zap size={14} /> {batchGenerating ? 'Generating...' : 'Generate All'}
            </button>
          </div>
        </div>

        {/* Workflow guidance banner */}
        {hasSegments && (
          <div style={styles.workflowBanner}>
            <div style={styles.workflowStep}>
              <span style={{ ...styles.workflowDot, background: hasSegments ? '#2d5a27' : '#333' }}>✓</span>
              <span style={{ color: '#8f8', fontSize: 11 }}>Split</span>
            </div>
            <div style={styles.workflowArrow}>→</div>
            <div style={styles.workflowStep}>
              <span style={{ ...styles.workflowDot, background: allHaveCharacters ? '#2d5a27' : '#333' }}>
                {allHaveCharacters ? '✓' : '2'}
              </span>
              <span style={{ color: allHaveCharacters ? '#8f8' : '#888', fontSize: 11 }}>Assign</span>
            </div>
            <div style={styles.workflowArrow}>→</div>
            <div style={styles.workflowStep}>
              <span style={{ ...styles.workflowDot, background: allHaveAudio ? '#2d5a27' : '#333' }}>
                {allHaveAudio ? '✓' : '3'}
              </span>
              <span style={{ color: allHaveAudio ? '#8f8' : '#888', fontSize: 11 }}>Generate</span>
            </div>
          </div>
        )}

        {batchProgress && (
          <div style={styles.progressBar}>
            <span style={{ fontSize: 12, color: '#aaa' }}>{batchProgress}</span>
          </div>
        )}

        {hasSegments && (
          <div style={styles.statsRow}>
            <span style={{ color: '#4A90D9', fontSize: 11 }}>
              <Users size={10} /> {segmentsWithCharacter.length}/{segmentList.length} assigned
            </span>
            <span style={{ color: '#8f8', fontSize: 11 }}>
              <Volume2 size={10} /> {segmentsWithAudio.length}/{segmentList.length} audio
            </span>
          </div>
        )}

        <div style={styles.segmentList}>
          {segmentList.map((seg, idx) => (
            <div key={seg.id} style={{
              ...styles.segmentItem,
              borderLeft: `3px solid ${seg.audio_asset_id ? '#2d5a27' : seg.character_id ? '#4A90D9' : '#333'}`,
            }}>
              <div style={styles.segmentHeader}>
                <span style={styles.segmentNum}>#{idx + 1}</span>
                <select value={seg.character_id || ''} onChange={(e) => handleAssignCharacter(seg.id, e.target.value || null)}
                  style={{ ...styles.charSelect, borderColor: seg.character_id ? '#4A90D9' : '#333' }} aria-label="Assign character">
                  <option value="">— assign character —</option>
                  {characterList.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.role})</option>
                  ))}
                </select>
                <button onClick={() => handleDeleteSegment(seg.id)} style={styles.delSegBtn} aria-label="Delete segment">
                  <Trash2 size={12} />
                </button>
              </div>
              <p style={styles.segmentText}>{seg.text.slice(0, 120)}{seg.text.length > 120 ? '...' : ''}</p>
              <div style={styles.segmentActions}>
                {seg.audio_asset_id ? (
                  <audio src={`/api/audio/${seg.audio_asset_id}`} controls style={{ height: 28, width: '100%' }} />
                ) : (
                  <button onClick={() => handleGenerate(seg.id)} style={styles.genBtn}
                    disabled={generatingId === seg.id || !seg.character_id}
                    title={!seg.character_id ? 'Assign a character first (use dropdown above)' : 'Generate TTS audio for this segment'}>
                    <Play size={12} /> {generatingId === seg.id ? 'Generating...' : !seg.character_id ? 'Needs character' : 'Generate'}
                  </button>
                )}
                {seg.audio_asset_id && (
                  <button onClick={() => handleGenerate(seg.id)} style={styles.regenBtn} title="Regenerate audio"
                    disabled={generatingId === seg.id}>
                    <RefreshCw size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {segmentList.length === 0 && selectedChapter && (
            <div style={styles.emptySegments}>
              <Scissors size={20} color="#444" />
              <p style={styles.emptyTitle}>No segments yet</p>
              <p style={styles.emptyHint}>Click "Split" above to break the chapter text into paragraph-based segments.</p>
              <p style={styles.emptyHint}>Each segment becomes one audio clip. You'll assign a character voice to each, then generate TTS audio.</p>
            </div>
          )}

          {!selectedChapter && (
            <div style={styles.emptySegments}>
              <p style={styles.emptyHint}>Select a chapter to see its segments</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', gap: 12, height: 'calc(100vh - 48px)' },
  chapterPanel: { width: 220, background: '#1a1a1a', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  panelHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid #222', gap: 4 },
  panelTitle: { fontSize: 13, color: '#fff', whiteSpace: 'nowrap' },
  panelFooter: { padding: 10, borderTop: '1px solid #222' },
  importBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11,
  },
  chapterList: { flex: 1, overflow: 'auto' },
  chapterItem: {
    display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
    border: 'none', cursor: 'pointer', fontSize: 13, transition: 'background 0.2s',
  },
  emptyChapters: { padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' },
  emptyTitle: { fontSize: 13, color: '#888', fontWeight: 500 },
  emptyHint: { fontSize: 12, color: '#555', lineHeight: 1.5 },
  emptyFormats: { fontSize: 11, color: '#444', lineHeight: 1.4 },
  footerHint: { fontSize: 10, color: '#666', textAlign: 'center', marginTop: 4 },
  editorPanel: { flex: 1, background: '#1a1a1a', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 },
  editorHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #222' },
  editorHint: { fontSize: 11, color: '#555' },
  textarea: {
    flex: 1, padding: 16, background: 'transparent', color: '#ddd', border: 'none',
    resize: 'none', fontSize: 14, lineHeight: 1.8, outline: 'none', fontFamily: 'Georgia, serif',
  },
  emptyEditor: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  emptyEditorText: { color: '#444', fontSize: 14 },
  segmentPanel: { width: 360, background: '#1a1a1a', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  actionBtn: {
    display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px',
    background: '#333', color: '#aaa', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },
  workflowBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '8px 12px', background: '#111', borderBottom: '1px solid #222',
  },
  workflowStep: { display: 'flex', alignItems: 'center', gap: 4 },
  workflowDot: {
    width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 600,
  },
  workflowArrow: { color: '#333', fontSize: 11 },
  progressBar: { padding: '6px 12px', background: '#111', borderBottom: '1px solid #222' },
  statsRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid #222', alignItems: 'center', gap: 8 },
  segmentList: { flex: 1, overflow: 'auto', padding: 6 },
  segmentItem: { padding: 10, borderBottom: '1px solid #1f1f1f', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 2, borderRadius: 6 },
  segmentHeader: { display: 'flex', alignItems: 'center', gap: 6 },
  segmentNum: { fontSize: 10, color: '#555', fontFamily: 'monospace', minWidth: 24 },
  charSelect: {
    flex: 1, padding: '3px 6px', background: '#0f0f0f', color: '#aaa', border: '1px solid #333',
    borderRadius: 4, fontSize: 11, outline: 'none',
  },
  delSegBtn: { background: 'none', border: 'none', color: '#444', cursor: 'pointer', padding: 2 },
  segmentText: { fontSize: 12, color: '#999', lineHeight: 1.5 },
  segmentActions: { display: 'flex', alignItems: 'center', gap: 6 },
  genBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px',
    background: '#2d5a27', color: '#8f8', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
  },
  regenBtn: {
    padding: '4px 6px', background: '#333', color: '#888',
    border: 'none', borderRadius: 4, cursor: 'pointer',
  },
  populateBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
    padding: '8px 12px', background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 6,
    cursor: 'pointer', fontSize: 12,
  },
  emptySegments: { padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' },
};
