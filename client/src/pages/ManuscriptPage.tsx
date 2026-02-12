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
import { Upload, Play, RefreshCw, Plus, Zap, LayoutDashboard, Trash2 } from 'lucide-react';

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
    } catch (err) {
      console.error('Failed to load chapters:', err);
    }
  }, [bookId]);

  const loadSegments = useCallback(async (chapterId: string) => {
    try {
      const data = await segmentsApi.list(chapterId);
      setSegmentList(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load segments:', err);
    }
  }, []);

  const loadCharacters = useCallback(async () => {
    if (!bookId) return;
    try {
      const data = await charsApi.list(bookId);
      setCharacterList(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load characters:', err);
    }
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
    } catch (err: any) {
      alert(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleAutoSegment = async () => {
    if (!selectedChapter) return;
    const text = selectedChapter.cleaned_text || selectedChapter.raw_text;
    const paragraphs = text.split(/\n\s*\n/).filter((p: string) => p.trim());

    for (let i = 0; i < paragraphs.length; i++) {
      await segmentsApi.create(selectedChapter.id, {
        text: paragraphs[i].trim(),
        sort_order: i,
      });
    }
    loadSegments(selectedChapter.id);
  };

  const handleGenerate = async (segmentId: string) => {
    if (!selectedChapter) return;
    setGeneratingId(segmentId);
    try {
      await segmentsApi.generate(selectedChapter.id, segmentId);
      loadSegments(selectedChapter.id);
    } catch (err: any) {
      alert(`Generation failed: ${err.message}`);
    } finally {
      setGeneratingId(null);
    }
  };

  const handleBatchGenerate = async () => {
    if (!selectedChapter) return;
    setBatchGenerating(true);
    setBatchProgress('Starting batch generation...');
    try {
      const result = await segmentsApi.batchGenerate(selectedChapter.id);
      setBatchProgress(
        `Done: ${result.summary.generated} generated, ${result.summary.cached} cached, ${result.summary.failed} failed`
      );
      loadSegments(selectedChapter.id);
    } catch (err: any) {
      setBatchProgress(`Error: ${err.message}`);
    } finally {
      setBatchGenerating(false);
    }
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
    } catch (err: any) {
      alert(`Populate failed: ${err.message}`);
    } finally {
      setPopulating(false);
    }
  };

  const handleChapterTextChange = (text: string) => {
    if (!selectedChapter || !bookId) return;
    setSelectedChapter({ ...selectedChapter, raw_text: text });
    chaptersApi.update(bookId, selectedChapter.id, { raw_text: text });
  };

  const getCharacterName = (charId: string | null) => {
    if (!charId) return null;
    return characterList.find((c) => c.id === charId)?.name || 'Unknown';
  };

  const segmentsWithAudio = segmentList.filter((s) => s.audio_asset_id);
  const segmentsWithoutAudio = segmentList.filter((s) => !s.audio_asset_id);

  return (
    <div style={styles.container}>
      <div style={styles.chapterPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.panelTitle}>Chapters</h3>
          <button onClick={() => fileRef.current?.click()} style={styles.importBtn} disabled={importing}>
            <Upload size={14} /> {importing ? 'Importing...' : 'Import'}
          </button>
          <input ref={fileRef} type="file" accept=".txt,.md,.docx" onChange={handleImport} hidden aria-label="Import manuscript file" />
        </div>
        <div style={styles.chapterList}>
          {chapterList.map((ch) => (
            <button
              key={ch.id}
              onClick={() => setSelectedChapter(ch)}
              style={{
                ...styles.chapterItem,
                background: selectedChapter?.id === ch.id ? '#2a2a2a' : 'transparent',
                color: selectedChapter?.id === ch.id ? '#4A90D9' : '#aaa',
              }}
            >
              {ch.title}
            </button>
          ))}
          {chapterList.length === 0 && (
            <p style={{ color: '#555', padding: 16, fontSize: 13 }}>Import a manuscript to get started</p>
          )}
        </div>

        {chapterList.length > 0 && (
          <div style={styles.panelFooter}>
            <button onClick={handlePopulateTimeline} disabled={populating} style={styles.populateBtn}>
              <LayoutDashboard size={14} /> {populating ? 'Populating...' : 'Send to Timeline'}
            </button>
          </div>
        )}
      </div>

      <div style={styles.editorPanel}>
        {selectedChapter ? (
          <>
            <div style={styles.editorHeader}>
              <h3 style={styles.panelTitle}>{selectedChapter.title}</h3>
            </div>
            <textarea
              value={selectedChapter.cleaned_text || selectedChapter.raw_text}
              onChange={(e) => handleChapterTextChange(e.target.value)}
              style={styles.textarea}
              aria-label="Chapter text"
            />
          </>
        ) : (
          <p style={{ color: '#555', padding: 32 }}>Select a chapter to edit</p>
        )}
      </div>

      <div style={styles.segmentPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.panelTitle}>Segments ({segmentList.length})</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={handleAutoSegment} style={styles.actionBtn} disabled={!selectedChapter}>
              <Plus size={14} /> Split
            </button>
            <button
              onClick={handleBatchGenerate}
              style={{ ...styles.actionBtn, background: '#2d5a27', color: '#8f8' }}
              disabled={!selectedChapter || batchGenerating || segmentList.length === 0}
            >
              <Zap size={14} /> {batchGenerating ? 'Generating...' : 'Generate All'}
            </button>
          </div>
        </div>

        {batchProgress && (
          <div style={styles.progressBar}>
            <span style={{ fontSize: 12, color: '#aaa' }}>{batchProgress}</span>
          </div>
        )}

        {segmentList.length > 0 && (
          <div style={styles.statsRow}>
            <span style={{ color: '#8f8', fontSize: 11 }}>{segmentsWithAudio.length} with audio</span>
            <span style={{ color: '#f88', fontSize: 11 }}>{segmentsWithoutAudio.length} pending</span>
          </div>
        )}

        <div style={styles.segmentList}>
          {segmentList.map((seg, idx) => (
            <div key={seg.id} style={styles.segmentItem}>
              <div style={styles.segmentHeader}>
                <span style={styles.segmentNum}>#{idx + 1}</span>
                <select
                  value={seg.character_id || ''}
                  onChange={(e) => handleAssignCharacter(seg.id, e.target.value || null)}
                  style={styles.charSelect}
                  aria-label="Assign character"
                >
                  <option value="">No character</option>
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
                  <button
                    onClick={() => handleGenerate(seg.id)}
                    style={styles.genBtn}
                    disabled={generatingId === seg.id || !seg.character_id}
                    title={!seg.character_id ? 'Assign a character first' : 'Generate audio'}
                  >
                    <Play size={12} /> {generatingId === seg.id ? 'Generating...' : 'Generate'}
                  </button>
                )}
                {seg.audio_asset_id && (
                  <button onClick={() => handleGenerate(seg.id)} style={styles.regenBtn} title="Regenerate"
                    disabled={generatingId === seg.id}>
                    <RefreshCw size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {segmentList.length === 0 && selectedChapter && (
            <p style={{ color: '#555', padding: 16, fontSize: 13 }}>
              Click "Split" to split chapter text into segments
            </p>
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
    background: '#333', color: '#aaa', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11,
  },
  chapterList: { flex: 1, overflow: 'auto' },
  chapterItem: {
    display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
    border: 'none', cursor: 'pointer', fontSize: 13, transition: 'background 0.2s',
  },
  editorPanel: { flex: 1, background: '#1a1a1a', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 },
  editorHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #222' },
  textarea: {
    flex: 1, padding: 16, background: 'transparent', color: '#ddd', border: 'none',
    resize: 'none', fontSize: 14, lineHeight: 1.8, outline: 'none', fontFamily: 'Georgia, serif',
  },
  segmentPanel: { width: 340, background: '#1a1a1a', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  actionBtn: {
    display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px',
    background: '#333', color: '#aaa', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },
  progressBar: { padding: '6px 12px', background: '#111', borderBottom: '1px solid #222' },
  statsRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 12px', borderBottom: '1px solid #222' },
  segmentList: { flex: 1, overflow: 'auto', padding: 6 },
  segmentItem: { padding: 10, borderBottom: '1px solid #1f1f1f', display: 'flex', flexDirection: 'column', gap: 6 },
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
};
