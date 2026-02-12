import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  chapters as chaptersApi,
  importManuscript,
  segments as segmentsApi,
  characters as charsApi,
  timeline as timelineApi,
  aiParse,
} from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Chapter, Segment, Character } from '../types';
import {
  Upload, Play, RefreshCw, Plus, Zap, LayoutDashboard, Trash2, BookOpen,
  Scissors, Users, Volume2, Wand2, Loader, Edit3, Copy, ChevronUp,
  ChevronDown, Check, X, Tag, MoreVertical, GripVertical, Send,
} from 'lucide-react';

// V3 audio tags for quick insertion
const V3_TAGS = [
  { cat: 'Emotion', tags: ['happy','sad','angry','excited','melancholic','romantic','mysterious','anxious','confident','tender','dramatic'] },
  { cat: 'Voice', tags: ['whisper','shout','gasp','sigh','laugh','sob','chuckle','growl','murmur'] },
  { cat: 'Style', tags: ['conversational','formal','theatrical','breathy','commanding','gentle','intimate','warm'] },
  { cat: 'Narrative', tags: ['storytelling tone','dramatic pause','suspense build-up','inner monologue','flashback tone'] },
];

interface ChapterStats {
  total_segments: number;
  assigned: number;
  with_audio: number;
  on_timeline: number;
}

export function ManuscriptPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [chapterList, setChapterList] = useState<(Chapter & { stats?: ChapterStats })[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [segmentList, setSegmentList] = useState<Segment[]>([]);
  const [characterList, setCharacterList] = useState<Character[]>([]);
  const [importing, setImporting] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const [populating, setPopulating] = useState(false);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [aiParsing, setAiParsing] = useState(false);
  const [aiTagging, setAiTagging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Chapter editing state
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [chapterMenuId, setChapterMenuId] = useState<string | null>(null);
  const [addingChapter, setAddingChapter] = useState(false);
  const [newChapterTitle, setNewChapterTitle] = useState('');

  // Segment editing
  const [editingSegId, setEditingSegId] = useState<string | null>(null);
  const [editingSegText, setEditingSegText] = useState('');

  // V3 tag panel
  const [showTagPanel, setShowTagPanel] = useState(false);

  // Split mode
  const [splitMode, setSplitMode] = useState(false);
  const [splitPos, setSplitPos] = useState<number | null>(null);

  // Text editor ref
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedChapter = chapterList.find((c) => c.id === selectedChapterId) || null;

  // ── Data Loading ──

  const loadChapters = useCallback(async () => {
    if (!bookId) return;
    try {
      const data = await chaptersApi.list(bookId);
      const list = Array.isArray(data) ? data : [];
      setChapterList(list);
      if (list.length > 0 && !selectedChapterId) setSelectedChapterId(list[0].id);
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
  useEffect(() => { if (selectedChapterId) loadSegments(selectedChapterId); }, [selectedChapterId, loadSegments]);

  // ── Chapter Actions ──

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

  const handleAddChapter = async () => {
    if (!bookId) return;
    const title = newChapterTitle.trim() || `Chapter ${chapterList.length + 1}`;
    try {
      const ch = await chaptersApi.create(bookId, { title, raw_text: '' });
      setAddingChapter(false);
      setNewChapterTitle('');
      await loadChapters();
      setSelectedChapterId(ch.id);
    } catch (err: any) { alert(`Failed to add chapter: ${err.message}`); }
  };

  const handleRenameChapter = async (id: string) => {
    if (!bookId || !editingTitle.trim()) return;
    await chaptersApi.update(bookId, id, { title: editingTitle.trim() });
    setEditingChapterId(null);
    loadChapters();
  };

  const handleDeleteChapter = async (id: string) => {
    if (!bookId || !confirm('Delete this chapter and all its segments?')) return;
    await chaptersApi.delete(bookId, id);
    if (selectedChapterId === id) setSelectedChapterId(null);
    setChapterMenuId(null);
    loadChapters();
  };

  const handleDuplicateChapter = async (id: string) => {
    if (!bookId) return;
    try {
      const ch = await chaptersApi.duplicate(bookId, id);
      setChapterMenuId(null);
      await loadChapters();
      setSelectedChapterId(ch.id);
    } catch (err: any) { alert(`Duplicate failed: ${err.message}`); }
  };

  const handleMoveChapter = async (id: string, direction: 'up' | 'down') => {
    if (!bookId) return;
    const idx = chapterList.findIndex((c) => c.id === id);
    if (direction === 'up' && idx <= 0) return;
    if (direction === 'down' && idx >= chapterList.length - 1) return;
    const ids = chapterList.map((c) => c.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
    await chaptersApi.reorder(bookId, ids);
    setChapterMenuId(null);
    loadChapters();
  };

  const handleSplitChapter = async () => {
    if (!bookId || !selectedChapter || splitPos === null) return;
    const text = selectedChapter.cleaned_text || selectedChapter.raw_text;
    if (splitPos < 1 || splitPos >= text.length) { alert('Select a valid split position'); return; }
    try {
      const result = await chaptersApi.split(bookId, selectedChapter.id, splitPos);
      setSplitMode(false);
      setSplitPos(null);
      await loadChapters();
      setSelectedChapterId(result.original.id);
    } catch (err: any) { alert(`Split failed: ${err.message}`); }
  };

  // ── Text Editing with Auto-Save ──

  const handleChapterTextChange = (text: string) => {
    if (!selectedChapter || !bookId) return;
    setChapterList((prev) => prev.map((c) => c.id === selectedChapter.id ? { ...c, raw_text: text } : c));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      chaptersApi.update(bookId, selectedChapter.id, { raw_text: text });
    }, 800);
  };

  // ── V3 Tag Actions ──

  const insertTag = (tag: string) => {
    const ta = textareaRef.current;
    if (!ta || !selectedChapter) return;
    const start = ta.selectionStart;
    const text = selectedChapter.cleaned_text || selectedChapter.raw_text;
    const newText = text.slice(0, start) + `[${tag}] ` + text.slice(start);
    handleChapterTextChange(newText);
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + tag.length + 3; }, 50);
  };

  const handleAiSuggestTags = async () => {
    if (!bookId || !selectedChapter) return;
    const text = selectedChapter.cleaned_text || selectedChapter.raw_text;
    if (!text.trim()) return;
    setAiTagging(true);
    try {
      const result = await aiParse.suggestV3Tags(bookId, text);
      if (result.tagged_text && result.tagged_text !== text) {
        handleChapterTextChange(result.tagged_text);
        alert(`AI inserted ${result.tags_used.length} tags: ${result.tags_used.join(', ')}`);
      } else {
        alert('AI found no tags to suggest for this text.');
      }
    } catch (err: any) { alert(`AI tag suggestion failed: ${err.message}`); }
    finally { setAiTagging(false); }
  };

  // ── Segment Actions ──

  const handleAutoSegment = async () => {
    if (!selectedChapter) return;
    const text = selectedChapter.cleaned_text || selectedChapter.raw_text;
    const paragraphs = text.split(/\n\s*\n/).filter((p: string) => p.trim());
    for (let i = 0; i < paragraphs.length; i++) {
      await segmentsApi.create(selectedChapter.id, { text: paragraphs[i].trim(), sort_order: i });
    }
    loadSegments(selectedChapter.id);
    loadChapters(); // refresh stats
  };

  const handleGenerate = async (segmentId: string) => {
    if (!selectedChapter) return;
    setGeneratingId(segmentId);
    try {
      await segmentsApi.generate(selectedChapter.id, segmentId);
      loadSegments(selectedChapter.id);
      loadChapters();
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
      loadChapters();
    } catch (err: any) { setBatchProgress(`Error: ${err.message}`); }
    finally { setBatchGenerating(false); }
  };

  const handleAssignCharacter = async (segmentId: string, characterId: string | null) => {
    if (!selectedChapter) return;
    await segmentsApi.update(selectedChapter.id, segmentId, { character_id: characterId || null });
    loadSegments(selectedChapter.id);
    loadChapters();
  };

  const handleDeleteSegment = async (segmentId: string) => {
    if (!selectedChapter) return;
    await segmentsApi.delete(selectedChapter.id, segmentId);
    loadSegments(selectedChapter.id);
    loadChapters();
  };

  const handleUpdateSegmentText = async (segmentId: string) => {
    if (!selectedChapter || !editingSegText.trim()) return;
    await segmentsApi.update(selectedChapter.id, segmentId, { text: editingSegText });
    setEditingSegId(null);
    loadSegments(selectedChapter.id);
  };

  const handleAddSegment = async () => {
    if (!selectedChapter) return;
    await segmentsApi.create(selectedChapter.id, { text: 'New segment...', sort_order: segmentList.length });
    loadSegments(selectedChapter.id);
    loadChapters();
  };

  // ── Timeline Actions ──

  const handlePopulateAll = async () => {
    if (!bookId) return;
    setPopulating(true);
    try {
      const result = await timelineApi.populate(bookId);
      alert(`Timeline populated: ${result.clips_created} clips, ${result.markers_created} markers.`);
      loadChapters();
    } catch (err: any) { alert(`Populate failed: ${err.message}`); }
    finally { setPopulating(false); }
  };

  const handleSendChapterToTimeline = async (chapterId: string) => {
    if (!bookId) return;
    try {
      const result = await timelineApi.populate(bookId, [chapterId]);
      alert(`Sent to timeline: ${result.clips_created} clips placed.`);
      loadChapters();
    } catch (err: any) { alert(`Failed: ${err.message}`); }
  };

  const handleAiParse = async () => {
    if (!bookId) return;
    setAiParsing(true);
    try {
      const result = await aiParse.parse(bookId);
      alert(`AI parsed: ${result.characters_created} characters, ${result.segments_created} segments, ${result.sfx_cues} SFX, ${result.music_cues} music cues. Provider: ${result.provider}`);
      await loadChapters();
      await loadCharacters();
      if (selectedChapterId) loadSegments(selectedChapterId);
    } catch (err: any) { alert(`AI parse failed: ${err.message}`); }
    finally { setAiParsing(false); }
  };

  // ── Computed ──

  const segmentsWithAudio = segmentList.filter((s) => s.audio_asset_id);
  const segmentsWithCharacter = segmentList.filter((s) => s.character_id);
  const allHaveCharacters = segmentList.length > 0 && segmentsWithCharacter.length === segmentList.length;
  const allHaveAudio = segmentList.length > 0 && segmentsWithAudio.length === segmentList.length;
  const hasChapters = chapterList.length > 0;
  const hasSegments = segmentList.length > 0;

  const chapterText = selectedChapter ? (selectedChapter.cleaned_text || selectedChapter.raw_text) : '';


  // ── Progress helper ──
  const getChapterProgress = (ch: Chapter & { stats?: ChapterStats }) => {
    const s = ch.stats;
    if (!s || s.total_segments === 0) return { step: 0, label: 'No segments', color: '#555' };
    if (s.on_timeline > 0 && s.on_timeline >= s.total_segments) return { step: 4, label: 'On timeline', color: '#2d5a27' };
    if (s.with_audio >= s.total_segments) return { step: 3, label: 'Audio ready', color: '#4A90D9' };
    if (s.assigned >= s.total_segments) return { step: 2, label: 'Assigned', color: '#D97A4A' };
    if (s.total_segments > 0) return { step: 1, label: `${s.total_segments} segs`, color: '#666' };
    return { step: 0, label: 'Empty', color: '#555' };
  };

  return (
    <div style={styles.container}>
      {/* ── Left: Chapters Panel ── */}
      <div style={styles.chapterPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.panelTitle}>📖 Chapters ({chapterList.length})</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => fileRef.current?.click()} style={styles.smallBtn} disabled={importing}
              title="Import manuscript file">
              <Upload size={13} /> {importing ? '...' : 'Import'}
            </button>
            <button onClick={() => setAddingChapter(true)} style={{ ...styles.smallBtn, background: '#2d5a27', color: '#8f8' }}
              title="Add empty chapter">
              <Plus size={13} />
            </button>
          </div>
          <input ref={fileRef} type="file" accept=".txt,.md,.docx,.epub,.html,.htm" onChange={handleImport} hidden aria-label="Import manuscript file" />
        </div>

        {/* Add chapter inline form */}
        {addingChapter && (
          <div style={styles.addChapterForm}>
            <input value={newChapterTitle} onChange={(e) => setNewChapterTitle(e.target.value)}
              placeholder="Chapter title..." style={styles.inlineInput} autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddChapter(); if (e.key === 'Escape') setAddingChapter(false); }}
              aria-label="New chapter title" />
            <button onClick={handleAddChapter} style={styles.tinyBtn}><Check size={12} /></button>
            <button onClick={() => setAddingChapter(false)} style={styles.tinyBtn}><X size={12} /></button>
          </div>
        )}

        {/* AI Parse bar */}
        {hasChapters && (
          <div style={styles.aiBar}>
            <button onClick={handleAiParse} disabled={aiParsing} style={styles.aiParseBtn}>
              {aiParsing ? <Loader size={13} /> : <Wand2 size={13} />}
              {aiParsing ? 'Parsing...' : 'AI Auto-Assign All'}
            </button>
          </div>
        )}

        {/* Chapter list */}
        <div style={styles.chapterList}>
          {chapterList.map((ch, idx) => {
            const prog = getChapterProgress(ch);
            const isSelected = selectedChapterId === ch.id;
            const isEditing = editingChapterId === ch.id;
            const showMenu = chapterMenuId === ch.id;

            return (
              <div key={ch.id} style={{ ...styles.chapterItem, background: isSelected ? '#2a2a2a' : 'transparent' }}>
                {isEditing ? (
                  <div style={{ display: 'flex', gap: 4, flex: 1, alignItems: 'center' }}>
                    <input value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)}
                      style={styles.inlineInput} autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRenameChapter(ch.id); if (e.key === 'Escape') setEditingChapterId(null); }}
                      aria-label="Rename chapter" />
                    <button onClick={() => handleRenameChapter(ch.id)} style={styles.tinyBtn}><Check size={11} /></button>
                    <button onClick={() => setEditingChapterId(null)} style={styles.tinyBtn}><X size={11} /></button>
                  </div>
                ) : (
                  <>
                    <button onClick={() => setSelectedChapterId(ch.id)}
                      style={{ ...styles.chapterBtn, color: isSelected ? '#4A90D9' : '#aaa' }}>
                      <span style={styles.chapterNum}>{idx + 1}.</span>
                      <span style={styles.chapterTitle}>{ch.title}</span>
                    </button>
                    <div style={styles.chapterMeta}>
                      <span style={{ ...styles.progressDot, background: prog.color }} title={prog.label} />
                      <span style={styles.progressLabel}>{prog.label}</span>
                      <button onClick={(e) => { e.stopPropagation(); setChapterMenuId(showMenu ? null : ch.id); }}
                        style={styles.menuBtn}><MoreVertical size={12} /></button>
                    </div>
                    {/* Context menu */}
                    {showMenu && (
                      <div style={styles.chapterMenu}>
                        <button onClick={() => { setEditingChapterId(ch.id); setEditingTitle(ch.title); setChapterMenuId(null); }}
                          style={styles.menuItem}><Edit3 size={11} /> Rename</button>
                        <button onClick={() => handleDuplicateChapter(ch.id)} style={styles.menuItem}>
                          <Copy size={11} /> Duplicate</button>
                        <button onClick={() => handleMoveChapter(ch.id, 'up')} style={styles.menuItem}
                          disabled={idx === 0}><ChevronUp size={11} /> Move Up</button>
                        <button onClick={() => handleMoveChapter(ch.id, 'down')} style={styles.menuItem}
                          disabled={idx === chapterList.length - 1}><ChevronDown size={11} /> Move Down</button>
                        {ch.stats && ch.stats.with_audio > 0 && (
                          <button onClick={() => { handleSendChapterToTimeline(ch.id); setChapterMenuId(null); }}
                            style={{ ...styles.menuItem, color: '#4A90D9' }}><Send size={11} /> Send to Timeline</button>
                        )}
                        <button onClick={() => handleDeleteChapter(ch.id)}
                          style={{ ...styles.menuItem, color: '#e55' }}><Trash2 size={11} /> Delete</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {!hasChapters && (
            <div style={styles.emptyState}>
              <BookOpen size={24} color="#444" />
              <p style={{ fontSize: 13, color: '#888' }}>No chapters yet</p>
              <p style={{ fontSize: 11, color: '#555' }}>Import a manuscript or add chapters manually.</p>
              <p style={{ fontSize: 10, color: '#444' }}>Supports: EPUB, DOCX, TXT, MD, HTML</p>
            </div>
          )}
        </div>

        {/* Footer: Send all to timeline */}
        {hasChapters && (
          <div style={styles.panelFooter}>
            <button onClick={handlePopulateAll} disabled={populating} style={styles.populateBtn}
              title="Send all chapters with audio to the timeline">
              <LayoutDashboard size={13} /> {populating ? 'Populating...' : 'Send All to Timeline'}
            </button>
          </div>
        )}
      </div>

      {/* ── Center: Text Editor ── */}
      <div style={styles.editorPanel}>
        {selectedChapter ? (
          <>
            <div style={styles.editorHeader}>
              <h3 style={styles.panelTitle}>{selectedChapter.title}</h3>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {splitMode ? (
                  <>
                    <span style={{ fontSize: 11, color: '#D97A4A' }}>Click in text to set split point, then confirm</span>
                    <button onClick={handleSplitChapter} disabled={splitPos === null}
                      style={{ ...styles.smallBtn, background: '#D97A4A', color: '#fff' }}>
                      <Scissors size={12} /> Split Here
                    </button>
                    <button onClick={() => { setSplitMode(false); setSplitPos(null); }} style={styles.smallBtn}>
                      <X size={12} /> Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => setSplitMode(true)} style={styles.smallBtn} title="Split chapter at cursor position">
                      <Scissors size={12} /> Split
                    </button>
                    <button onClick={() => setShowTagPanel(!showTagPanel)}
                      style={{ ...styles.smallBtn, background: showTagPanel ? '#2a1a3a' : '#333', color: showTagPanel ? '#b88ad9' : '#aaa' }}
                      title="Toggle V3 audio tags panel">
                      <Tag size={12} /> V3 Tags
                    </button>
                    <button onClick={handleAiSuggestTags} disabled={aiTagging || !chapterText.trim()}
                      style={{ ...styles.smallBtn, background: '#2a1a3a', color: '#b88ad9' }}
                      title="AI will suggest and insert V3 tags into the text">
                      {aiTagging ? <Loader size={12} /> : <Wand2 size={12} />}
                      {aiTagging ? 'Tagging...' : 'AI Tags'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* V3 Tag insertion panel */}
            {showTagPanel && (
              <div style={styles.tagPanel}>
                {V3_TAGS.map((cat) => (
                  <div key={cat.cat} style={styles.tagRow}>
                    <span style={styles.tagCatLabel}>{cat.cat}:</span>
                    {cat.tags.map((t) => (
                      <button key={t} onClick={() => insertTag(t)} style={styles.tagBtn} title={`Insert [${t}]`}>
                        [{t}]
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Split indicator */}
            {splitMode && splitPos !== null && (
              <div style={styles.splitIndicator}>
                Split at position {splitPos} / {chapterText.length} — "{chapterText.slice(Math.max(0, splitPos - 20), splitPos)}|{chapterText.slice(splitPos, splitPos + 20)}"
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={chapterText}
              onChange={(e) => handleChapterTextChange(e.target.value)}
              onClick={(e) => {
                if (splitMode) {
                  setSplitPos((e.target as HTMLTextAreaElement).selectionStart);
                }
              }}
              style={{
                ...styles.textarea,
                ...(splitMode ? { cursor: 'crosshair', borderColor: '#D97A4A' } : {}),
              }}
              aria-label="Chapter text editor"
            />

            <div style={styles.editorFooter}>
              <span style={{ fontSize: 11, color: '#555' }}>
                {chapterText.length} chars · ~{Math.ceil(chapterText.split(/\s+/).length / 150)} min read
              </span>
              <span style={{ fontSize: 11, color: '#555' }}>Auto-saves on edit</span>
            </div>
          </>
        ) : (
          <div style={styles.emptyEditor}>
            <p style={{ color: '#444', fontSize: 14 }}>
              {hasChapters ? '← Select a chapter to edit' : 'Import a manuscript or add a chapter to get started'}
            </p>
          </div>
        )}
      </div>

      {/* ── Right: Segments Panel ── */}
      <div style={styles.segmentPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.panelTitle}>🔊 Segments</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={handleAutoSegment} style={styles.smallBtn} disabled={!selectedChapter || !chapterText.trim()}
              title="Split chapter text into paragraph-based segments">
              <Scissors size={12} /> Split
            </button>
            <button onClick={handleAddSegment} style={styles.smallBtn} disabled={!selectedChapter}
              title="Add a blank segment">
              <Plus size={12} />
            </button>
            <button onClick={handleBatchGenerate}
              style={{ ...styles.smallBtn, background: segmentList.length > 0 && !allHaveAudio ? '#2d5a27' : '#333', color: segmentList.length > 0 && !allHaveAudio ? '#8f8' : '#666' }}
              disabled={!selectedChapter || batchGenerating || segmentList.length === 0}
              title="Generate TTS for all segments">
              <Zap size={12} /> {batchGenerating ? '...' : 'Gen All'}
            </button>
          </div>
        </div>

        {/* Workflow progress */}
        {hasSegments && (
          <div style={styles.workflowBar}>
            <div style={styles.workflowStep}>
              <span style={{ ...styles.wfDot, background: '#2d5a27' }}>✓</span>
              <span style={{ color: '#8f8', fontSize: 10 }}>Split</span>
            </div>
            <span style={styles.wfArrow}>→</span>
            <div style={styles.workflowStep}>
              <span style={{ ...styles.wfDot, background: allHaveCharacters ? '#2d5a27' : '#333' }}>
                {allHaveCharacters ? '✓' : '2'}
              </span>
              <span style={{ color: allHaveCharacters ? '#8f8' : '#888', fontSize: 10 }}>Assign</span>
            </div>
            <span style={styles.wfArrow}>→</span>
            <div style={styles.workflowStep}>
              <span style={{ ...styles.wfDot, background: allHaveAudio ? '#2d5a27' : '#333' }}>
                {allHaveAudio ? '✓' : '3'}
              </span>
              <span style={{ color: allHaveAudio ? '#8f8' : '#888', fontSize: 10 }}>Generate</span>
            </div>
            <span style={styles.wfArrow}>→</span>
            <div style={styles.workflowStep}>
              <span style={{ ...styles.wfDot, background: selectedChapter?.stats?.on_timeline ? '#2d5a27' : '#333' }}>
                {(selectedChapter?.stats?.on_timeline ?? 0) > 0 ? '✓' : '4'}
              </span>
              <span style={{ color: (selectedChapter?.stats?.on_timeline ?? 0) > 0 ? '#8f8' : '#888', fontSize: 10 }}>Timeline</span>
            </div>
          </div>
        )}

        {batchProgress && (
          <div style={styles.progressBar}><span style={{ fontSize: 11, color: '#aaa' }}>{batchProgress}</span></div>
        )}

        {hasSegments && (
          <div style={styles.statsRow}>
            <span style={{ color: '#4A90D9', fontSize: 11 }}>
              <Users size={10} /> {segmentsWithCharacter.length}/{segmentList.length}
            </span>
            <span style={{ color: '#8f8', fontSize: 11 }}>
              <Volume2 size={10} /> {segmentsWithAudio.length}/{segmentList.length}
            </span>
            {selectedChapter && allHaveAudio && (
              <button onClick={() => handleSendChapterToTimeline(selectedChapter.id)}
                style={{ ...styles.smallBtn, background: '#4A90D9', color: '#fff', fontSize: 10, padding: '2px 8px' }}>
                <Send size={10} /> Send
              </button>
            )}
          </div>
        )}

        {/* Segment list */}
        <div style={styles.segmentList}>
          {segmentList.map((seg, idx) => {
            const isEditingSeg = editingSegId === seg.id;
            return (
              <div key={seg.id} style={{
                ...styles.segmentItem,
                borderLeft: `3px solid ${seg.audio_asset_id ? '#2d5a27' : seg.character_id ? '#4A90D9' : '#333'}`,
              }}>
                <div style={styles.segmentHeader}>
                  <span style={styles.segNum}>#{idx + 1}</span>
                  <select value={seg.character_id || ''} onChange={(e) => handleAssignCharacter(seg.id, e.target.value || null)}
                    style={{ ...styles.charSelect, borderColor: seg.character_id ? '#4A90D9' : '#333' }}
                    aria-label="Assign character">
                    <option value="">— character —</option>
                    {characterList.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.role})</option>
                    ))}
                  </select>
                  <button onClick={() => { setEditingSegId(seg.id); setEditingSegText(seg.text); }}
                    style={styles.iconBtn} title="Edit segment text"><Edit3 size={11} /></button>
                  <button onClick={() => handleDeleteSegment(seg.id)} style={styles.iconBtn} title="Delete segment">
                    <Trash2 size={11} /></button>
                </div>

                {isEditingSeg ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <textarea value={editingSegText} onChange={(e) => setEditingSegText(e.target.value)}
                      style={styles.segEditArea} rows={3} aria-label="Edit segment text" />
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => handleUpdateSegmentText(seg.id)} style={{ ...styles.tinyBtn, background: '#2d5a27', color: '#8f8' }}>
                        <Check size={11} /> Save
                      </button>
                      <button onClick={() => setEditingSegId(null)} style={styles.tinyBtn}><X size={11} /> Cancel</button>
                    </div>
                  </div>
                ) : (
                  <p style={styles.segText} onDoubleClick={() => { setEditingSegId(seg.id); setEditingSegText(seg.text); }}>
                    {seg.text.slice(0, 150)}{seg.text.length > 150 ? '...' : ''}
                  </p>
                )}

                <div style={styles.segActions}>
                  {seg.audio_asset_id ? (
                    <audio src={`/api/audio/${seg.audio_asset_id}`} controls style={{ height: 28, width: '100%' }} />
                  ) : (
                    <button onClick={() => handleGenerate(seg.id)} style={styles.genBtn}
                      disabled={generatingId === seg.id || !seg.character_id}
                      title={!seg.character_id ? 'Assign a character first' : 'Generate TTS'}>
                      <Play size={11} /> {generatingId === seg.id ? '...' : !seg.character_id ? 'Needs character' : 'Generate'}
                    </button>
                  )}
                  {seg.audio_asset_id && (
                    <button onClick={() => handleGenerate(seg.id)} style={styles.regenBtn}
                      disabled={generatingId === seg.id} title="Regenerate">
                      <RefreshCw size={11} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {segmentList.length === 0 && selectedChapter && (
            <div style={styles.emptyState}>
              <Scissors size={20} color="#444" />
              <p style={{ fontSize: 12, color: '#888' }}>No segments yet</p>
              <p style={{ fontSize: 11, color: '#555' }}>Click "Split" to break text into segments, or "+" to add manually.</p>
            </div>
          )}
          {!selectedChapter && (
            <div style={styles.emptyState}>
              <p style={{ fontSize: 12, color: '#555' }}>Select a chapter</p>
            </div>
          )}
        </div>
      </div>

      {/* Close chapter menu on outside click */}
      {chapterMenuId && (
        <div style={styles.overlay} onClick={() => setChapterMenuId(null)} />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', gap: 8, height: 'calc(100vh - 48px)', position: 'relative' },
  overlay: { position: 'fixed', inset: 0, zIndex: 5 },

  // Chapter panel
  chapterPanel: { width: 240, background: '#1a1a1a', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', zIndex: 10 },
  panelHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid #222', gap: 4 },
  panelTitle: { fontSize: 13, color: '#fff', whiteSpace: 'nowrap' },
  panelFooter: { padding: 8, borderTop: '1px solid #222' },

  smallBtn: {
    display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px',
    background: '#333', color: '#aaa', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
  },
  tinyBtn: {
    display: 'flex', alignItems: 'center', gap: 2, padding: '3px 6px',
    background: '#333', color: '#aaa', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10,
  },
  iconBtn: { background: 'none', border: 'none', color: '#555', cursor: 'pointer', padding: 2 },

  addChapterForm: { display: 'flex', gap: 4, padding: '6px 10px', borderBottom: '1px solid #222', alignItems: 'center' },
  inlineInput: {
    flex: 1, padding: '4px 8px', background: '#0f0f0f', color: '#ddd', border: '1px solid #444',
    borderRadius: 4, fontSize: 12, outline: 'none',
  },

  aiBar: { padding: '6px 10px', borderBottom: '1px solid #222' },
  aiParseBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, width: '100%',
    padding: '6px 10px', background: '#2a1a3a', color: '#b88ad9', border: '1px solid #3a2a4a',
    borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 500,
  },

  chapterList: { flex: 1, overflow: 'auto' },
  chapterItem: { position: 'relative', display: 'flex', flexDirection: 'column', borderBottom: '1px solid #1a1a1a' },
  chapterBtn: {
    display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left',
    padding: '8px 10px 2px', border: 'none', cursor: 'pointer', fontSize: 12, background: 'transparent',
  },
  chapterNum: { fontSize: 10, color: '#555', fontFamily: 'monospace', minWidth: 18 },
  chapterTitle: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chapterMeta: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 10px 6px 28px' },
  progressDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  progressLabel: { fontSize: 10, color: '#666', flex: 1 },
  menuBtn: { background: 'none', border: 'none', color: '#555', cursor: 'pointer', padding: 2 },

  chapterMenu: {
    position: 'absolute', top: '100%', right: 8, zIndex: 20,
    background: '#222', border: '1px solid #333', borderRadius: 8, padding: 4,
    display: 'flex', flexDirection: 'column', gap: 1, minWidth: 140, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  },
  menuItem: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
    background: 'transparent', color: '#aaa', border: 'none', borderRadius: 4,
    cursor: 'pointer', fontSize: 11, textAlign: 'left', whiteSpace: 'nowrap',
  },

  populateBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, width: '100%',
    padding: '7px 10px', background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 6,
    cursor: 'pointer', fontSize: 11,
  },

  emptyState: { padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' },

  // Editor panel
  editorPanel: { flex: 1, background: '#1a1a1a', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 },
  editorHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid #222', gap: 8, flexWrap: 'wrap' },
  editorFooter: { display: 'flex', justifyContent: 'space-between', padding: '4px 12px', borderTop: '1px solid #222' },
  textarea: {
    flex: 1, padding: 14, background: 'transparent', color: '#ddd', border: 'none',
    resize: 'none', fontSize: 14, lineHeight: 1.8, outline: 'none', fontFamily: 'Georgia, serif',
  },
  emptyEditor: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' },

  tagPanel: { padding: '6px 12px', borderBottom: '1px solid #222', background: '#111', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflow: 'auto' },
  tagRow: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  tagCatLabel: { fontSize: 10, color: '#666', minWidth: 60 },
  tagBtn: {
    padding: '2px 6px', background: '#1e2a3a', color: '#6a9ad0', border: '1px solid #2a3a5a',
    borderRadius: 3, cursor: 'pointer', fontSize: 10, fontFamily: 'monospace',
  },

  splitIndicator: { padding: '4px 12px', background: '#2a1a0a', color: '#D97A4A', fontSize: 11, borderBottom: '1px solid #3a2a1a', fontFamily: 'monospace' },

  // Segment panel
  segmentPanel: { width: 360, background: '#1a1a1a', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' },

  workflowBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    padding: '6px 10px', background: '#111', borderBottom: '1px solid #222',
  },
  workflowStep: { display: 'flex', alignItems: 'center', gap: 3 },
  wfDot: {
    width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 9, color: '#fff', fontWeight: 600,
  },
  wfArrow: { color: '#333', fontSize: 10 },

  progressBar: { padding: '4px 10px', background: '#111', borderBottom: '1px solid #222' },
  statsRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 10px', borderBottom: '1px solid #222', alignItems: 'center', gap: 6 },

  segmentList: { flex: 1, overflow: 'auto', padding: 4 },
  segmentItem: { padding: 8, borderBottom: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 2, borderRadius: 6 },
  segmentHeader: { display: 'flex', alignItems: 'center', gap: 4 },
  segNum: { fontSize: 9, color: '#555', fontFamily: 'monospace', minWidth: 22 },
  charSelect: {
    flex: 1, padding: '2px 4px', background: '#0f0f0f', color: '#aaa', border: '1px solid #333',
    borderRadius: 4, fontSize: 10, outline: 'none',
  },
  segText: { fontSize: 11, color: '#999', lineHeight: 1.5, cursor: 'pointer' },
  segEditArea: {
    padding: 8, background: '#0f0f0f', color: '#ddd', border: '1px solid #444',
    borderRadius: 4, fontSize: 12, lineHeight: 1.5, outline: 'none', resize: 'vertical', fontFamily: 'inherit',
  },
  segActions: { display: 'flex', alignItems: 'center', gap: 4 },
  genBtn: {
    display: 'flex', alignItems: 'center', gap: 3, padding: '3px 8px',
    background: '#2d5a27', color: '#8f8', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10,
  },
  regenBtn: {
    padding: '3px 5px', background: '#333', color: '#888',
    border: 'none', borderRadius: 4, cursor: 'pointer',
  },
};
