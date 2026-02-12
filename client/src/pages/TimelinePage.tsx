import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl, saveProject, downloadProjectUrl, render as renderApi } from '../services/api';
import type { Track, Clip, ChapterMarker } from '../types';
import {
  Play, Pause, Square, Volume2, VolumeX, SkipBack, Trash2,
  Scissors, Copy, ClipboardPaste, Wand2, Music, Loader, X, Save, Download,
  HelpCircle, ChevronDown, Undo2, Redo2,
} from 'lucide-react';

const TRACK_HEIGHT = 80;
const RULER_HEIGHT = 32;
const HEADER_WIDTH = 210;
const DEFAULT_PX_PER_MS = 0.05;
const EDGE_GRAB_PX = 8;
const MIN_CLIP_MS = 50;
const MAX_UNDO = 50;
const TRACK_COLORS: Record<string, string> = { narration: '#4A90D9', dialogue: '#D97A4A', sfx: '#6BD94A', music: '#9B59B6', imported: '#888' };
const TRACK_ICONS: Record<string, string> = { narration: '🎙️', dialogue: '💬', sfx: '🔊', music: '🎵', imported: '📁' };

type DragMode = 'move' | 'trim-left' | 'trim-right' | null;
interface ContextMenu { x: number; y: number; clip: Clip; track: Track }
interface HoverInfo { x: number; y: number; clip: Clip; track: Track }
interface ClipboardData { clip: Clip; trackType: string; action: 'copy' | 'cut'; sourceTrackId: string }

export function TimelinePage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [markers, setMarkers] = useState<ChapterMarker[]>([]);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [rendering, setRendering] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddType, setQuickAddType] = useState<'sfx' | 'music'>('sfx');
  const [quickAddPrompt, setQuickAddPrompt] = useState('');
  const [quickAddGenerating, setQuickAddGenerating] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [clipboardData, setClipboardData] = useState<ClipboardData | null>(null);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const skipSnap = useRef(false);
  const dragRef = useRef<{ mode: DragMode; clipId: string; trackId: string; startMouseX: number; origPos: number; origTS: number; origTE: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const scheduledRef = useRef<AudioBufferSourceNode[]>([]);
  const playStartRef = useRef(0);
  const playOffsetRef = useRef(0);
  const animRef = useRef(0);
  const bufCache = useRef<Map<string, AudioBuffer>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const pxPerMs = DEFAULT_PX_PER_MS * zoom;

  // ── Undo/Redo ──
  const pushSnapshot = useCallback(() => {
    if (skipSnap.current) { skipSnap.current = false; return; }
    const snap = JSON.stringify(tracks);
    if (undoStack.current.length > 0 && undoStack.current[undoStack.current.length - 1] === snap) return;
    undoStack.current.push(snap);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true); setCanRedo(false);
  }, [tracks]);

  const handleUndo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    redoStack.current.push(JSON.stringify(tracks));
    const prev = undoStack.current.pop()!;
    skipSnap.current = true;
    setTracks(JSON.parse(prev));
    setCanUndo(undoStack.current.length > 0); setCanRedo(true);
    saveProject().catch(() => {});
  }, [tracks]);

  const handleRedo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    undoStack.current.push(JSON.stringify(tracks));
    const next = redoStack.current.pop()!;
    skipSnap.current = true;
    setTracks(JSON.parse(next));
    setCanUndo(true); setCanRedo(redoStack.current.length > 0);
    saveProject().catch(() => {});
  }, [tracks]);

  // ── Helpers ──
  const getClipDur = useCallback((clip: Clip): number => {
    const buf = bufCache.current.get(clip.audio_asset_id);
    const total = buf ? buf.duration * 1000 : 3000;
    return Math.max(MIN_CLIP_MS, (clip.trim_end_ms || total) - (clip.trim_start_ms || 0));
  }, []);

  const getClipTotal = useCallback((clip: Clip): number => {
    const buf = bufCache.current.get(clip.audio_asset_id);
    return buf ? buf.duration * 1000 : 3000;
  }, []);

  const findCT = useCallback((clipId: string): { clip: Clip; track: Track } | null => {
    for (const t of tracks) { const c = (t.clips || []).find(cl => cl.id === clipId); if (c) return { clip: c, track: t }; }
    return null;
  }, [tracks]);

  const selClip = selectedClipId ? findCT(selectedClipId)?.clip ?? null : null;

  const fmtTime = (ms: number) => {
    const s = Math.floor(ms / 1000); const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  };
  const fmtDur = (ms: number) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

  // ── Data Loading ──
  const loadTracks = useCallback(async () => {
    if (!bookId) return;
    try {
      const [td, md] = await Promise.all([timelineApi.tracks(bookId), timelineApi.chapterMarkers(bookId)]);
      skipSnap.current = true;
      setTracks(Array.isArray(td) ? td : []);
      setMarkers(Array.isArray(md) ? md : []);
    } catch (err) { console.error('Failed to load timeline:', err); }
  }, [bookId]);

  useEffect(() => { loadTracks(); }, [loadTracks]);

  const totalDurMs = Math.max(60000,
    ...tracks.flatMap(t => (t.clips || []).map(c => c.position_ms + getClipDur(c) + 5000)),
    ...markers.map(m => m.position_ms + 5000));

  // ── Preload audio buffers ──
  useEffect(() => {
    const load = async () => {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      for (const t of tracks) for (const c of t.clips || []) {
        if (!bufCache.current.has(c.audio_asset_id)) {
          try { const r = await fetch(audioUrl(c.audio_asset_id)); const ab = await r.arrayBuffer(); bufCache.current.set(c.audio_asset_id, await ctx.decodeAudioData(ab)); } catch {}
        }
      }
      drawCanvas();
    };
    if (tracks.length > 0) load();
  }, [tracks]);

  // ── Save / Download ──
  const handleSave = async () => {
    setSaving(true); setSaveMsg('');
    try { await saveProject(); setSaveMsg('Saved!'); setTimeout(() => setSaveMsg(''), 2000); }
    catch { setSaveMsg('Save failed'); }
    finally { setSaving(false); }
  };
  const handleDownload = () => { if (bookId) window.open(downloadProjectUrl(bookId), '_blank'); };
  const handleRender = async () => {
    if (!bookId) return; setRendering(true);
    try {
      const { job_id } = await renderApi.start(bookId);
      const poll = setInterval(async () => {
        const st = await renderApi.status(bookId, job_id);
        if (st.status === 'completed' || st.status === 'failed') {
          clearInterval(poll); setRendering(false);
          alert(st.status === 'completed' ? 'Render complete!' : `Render failed: ${st.error_message}`);
        }
      }, 2000);
    } catch (err: any) { alert(`Render failed: ${err.message}`); setRendering(false); }
  };

  // ── Playback ──
  const stopPlayback = useCallback(() => {
    scheduledRef.current.forEach(s => { try { s.stop(); } catch {} });
    scheduledRef.current = [];
    cancelAnimationFrame(animRef.current);
    setPlaying(false);
  }, []);

  const startPlayback = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    stopPlayback();
    const off = currentTimeMs / 1000;
    playStartRef.current = ctx.currentTime; playOffsetRef.current = off;
    for (const t of tracks) {
      if (t.muted) continue;
      const gn = ctx.createGain(); gn.gain.value = Math.pow(10, (t.gain || 0) / 20); gn.connect(ctx.destination);
      for (const c of t.clips || []) {
        const buf = bufCache.current.get(c.audio_asset_id); if (!buf) continue;
        const cs = c.position_ms / 1000, ts = (c.trim_start_ms || 0) / 1000;
        const te = (c.trim_end_ms || buf.duration * 1000) / 1000, cd = te - ts;
        const when = cs - off; if (when + cd < 0) continue;
        const src = ctx.createBufferSource(); src.buffer = buf;
        const cg = ctx.createGain(); cg.gain.value = Math.pow(10, (c.gain || 0) / 20);
        src.connect(cg).connect(gn);
        if (when >= 0) src.start(ctx.currentTime + when, ts, cd);
        else src.start(0, ts - when, cd + when);
        scheduledRef.current.push(src);
      }
    }
    setPlaying(true);
    const anim = () => {
      const el = (ctx.currentTime - playStartRef.current) * 1000;
      setCurrentTimeMs(playOffsetRef.current * 1000 + el);
      animRef.current = requestAnimationFrame(anim);
    };
    animRef.current = requestAnimationFrame(anim);
  }, [tracks, currentTimeMs, stopPlayback]);

  const togglePlay = useCallback(() => { if (playing) stopPlayback(); else startPlayback(); }, [playing, stopPlayback, startPlayback]);
  const handleStop = useCallback(() => { stopPlayback(); setCurrentTimeMs(0); }, [stopPlayback]);

  // ── Track Actions ──
  const handleAddTrack = async (type: string) => {
    if (!bookId) return; pushSnapshot();
    try {
      const tr = await timelineApi.createTrack(bookId, { name: type.charAt(0).toUpperCase() + type.slice(1), type, color: TRACK_COLORS[type] || '#888' });
      setTracks(p => [...p, { ...tr, clips: [] }]);
    } catch (err: any) { alert(`Failed: ${err.message}`); }
  };
  const handleDeleteTrack = async (trackId: string) => {
    if (!bookId || !confirm('Delete this track and all its clips?')) return; pushSnapshot();
    try { await timelineApi.deleteTrack(bookId, trackId); setTracks(p => p.filter(t => t.id !== trackId)); }
    catch (err: any) { alert(`Failed: ${err.message}`); }
  };
  const handleTrackGain = async (trackId: string, gain: number) => {
    if (!bookId) return;
    setTracks(p => p.map(t => t.id === trackId ? { ...t, gain } : t));
    try { await timelineApi.updateTrack(bookId, trackId, { gain }); } catch {}
  };
  const handleTrackMute = async (trackId: string) => {
    if (!bookId) return; const tr = tracks.find(t => t.id === trackId); if (!tr) return;
    const muted = tr.muted ? 0 : 1;
    setTracks(p => p.map(t => t.id === trackId ? { ...t, muted } : t));
    try { await timelineApi.updateTrack(bookId, trackId, { muted }); } catch {}
  };

  // ── Clip Actions ──
  const handleDeleteClip = async (clipId: string) => {
    if (!bookId) return; pushSnapshot();
    try {
      await timelineApi.deleteClip(bookId, clipId);
      setTracks(p => p.map(t => ({ ...t, clips: (t.clips || []).filter(c => c.id !== clipId) })));
      if (selectedClipId === clipId) setSelectedClipId(null);
    } catch (err: any) { alert(`Failed: ${err.message}`); }
  };

  const handleSplitClip = async (clipId: string) => {
    if (!bookId) return;
    const f = findCT(clipId); if (!f) return;
    const { clip, track } = f;
    const dur = getClipDur(clip);
    const splitAt = currentTimeMs - clip.position_ms;
    if (splitAt <= MIN_CLIP_MS || splitAt >= dur - MIN_CLIP_MS) return;
    pushSnapshot();
    const ts = clip.trim_start_ms || 0;
    const newTE = ts + splitAt;
    try {
      await timelineApi.updateClip(bookId, clip.id, { trim_end_ms: newTE });
      const nc = await timelineApi.createClip(bookId, track.id, {
        audio_asset_id: clip.audio_asset_id, segment_id: clip.segment_id,
        position_ms: clip.position_ms + splitAt, trim_start_ms: newTE,
        trim_end_ms: clip.trim_end_ms || getClipTotal(clip),
        gain: clip.gain, fade_in_ms: 0, fade_out_ms: clip.fade_out_ms,
      });
      setTracks(p => p.map(t => t.id !== track.id ? t : {
        ...t, clips: (t.clips || []).map(c => c.id === clip.id ? { ...c, trim_end_ms: newTE, fade_out_ms: 0 } : c).concat([nc]),
      }));
    } catch (err: any) { alert(`Split failed: ${err.message}`); }
  };

  const handleDupClip = async (clipId: string) => {
    if (!bookId) return; const f = findCT(clipId); if (!f) return; pushSnapshot();
    const { clip, track } = f;
    try {
      const nc = await timelineApi.createClip(bookId, track.id, {
        audio_asset_id: clip.audio_asset_id, segment_id: clip.segment_id,
        position_ms: clip.position_ms + getClipDur(clip) + 100,
        trim_start_ms: clip.trim_start_ms, trim_end_ms: clip.trim_end_ms,
        gain: clip.gain, fade_in_ms: clip.fade_in_ms, fade_out_ms: clip.fade_out_ms,
      });
      setTracks(p => p.map(t => t.id === track.id ? { ...t, clips: [...(t.clips || []), nc] } : t));
    } catch (err: any) { alert(`Duplicate failed: ${err.message}`); }
  };

  // ── Clipboard ──
  const handleCopy = useCallback((clipId: string) => {
    const f = findCT(clipId); if (!f) return;
    setClipboardData({ clip: { ...f.clip }, trackType: f.track.type, action: 'copy', sourceTrackId: f.track.id });
  }, [findCT]);

  const handleCut = useCallback((clipId: string) => {
    const f = findCT(clipId); if (!f) return;
    setClipboardData({ clip: { ...f.clip }, trackType: f.track.type, action: 'cut', sourceTrackId: f.track.id });
    handleDeleteClip(clipId);
  }, [findCT, handleDeleteClip]);

  const handlePaste = useCallback(async () => {
    if (!bookId || !clipboardData) return;
    let tt = tracks.find(t => t.type === clipboardData.trackType) || tracks[0];
    if (!tt) return; pushSnapshot();
    try {
      const nc = await timelineApi.createClip(bookId, tt.id, {
        audio_asset_id: clipboardData.clip.audio_asset_id, segment_id: clipboardData.clip.segment_id,
        position_ms: currentTimeMs, trim_start_ms: clipboardData.clip.trim_start_ms,
        trim_end_ms: clipboardData.clip.trim_end_ms, gain: clipboardData.clip.gain,
        fade_in_ms: clipboardData.clip.fade_in_ms, fade_out_ms: clipboardData.clip.fade_out_ms,
      });
      setTracks(p => p.map(t => t.id === tt.id ? { ...t, clips: [...(t.clips || []), nc] } : t));
      setSelectedClipId(nc.id);
    } catch (err: any) { alert(`Paste failed: ${err.message}`); }
  }, [bookId, clipboardData, tracks, currentTimeMs, pushSnapshot]);

  const handleUpdateField = async (clipId: string, field: string, value: number) => {
    if (!bookId) return; pushSnapshot();
    try {
      await timelineApi.updateClip(bookId, clipId, { [field]: value });
      setTracks(p => p.map(t => ({ ...t, clips: (t.clips || []).map(c => c.id === clipId ? { ...c, [field]: value } : c) })));
    } catch {}
  };

  // ── Quick Add SFX/Music ──
  const handleQuickAdd = async () => {
    if (!bookId || !quickAddPrompt.trim()) return; setQuickAddGenerating(true);
    try {
      const result = quickAddType === 'sfx'
        ? await elevenlabs.sfx({ prompt: quickAddPrompt, book_id: bookId })
        : await elevenlabs.music({ prompt: quickAddPrompt, book_id: bookId });
      let tt: Track | undefined = tracks.find(t => t.type === quickAddType);
      if (!tt) {
        const created = await timelineApi.createTrack(bookId, { name: quickAddType === 'sfx' ? 'SFX' : 'Music', type: quickAddType, color: TRACK_COLORS[quickAddType] });
        tt = { ...created, clips: [] } as Track;
      }
      pushSnapshot();
      const nc = await timelineApi.createClip(bookId, tt.id, { audio_asset_id: result.audio_asset_id, position_ms: currentTimeMs });
      await loadTracks(); setSelectedClipId(nc.id); setQuickAddPrompt('');
    } catch (err: any) { alert(`Generation failed: ${err.message}`); }
    finally { setQuickAddGenerating(false); }
  };

  // ── Canvas Drawing ──
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Ruler
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, W, RULER_HEIGHT);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    const step = zoom < 0.5 ? 10000 : zoom < 1 ? 5000 : zoom < 2 ? 2000 : 1000;
    for (let ms = 0; ms <= totalDurMs; ms += step) {
      const x = ms * pxPerMs;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, RULER_HEIGHT); ctx.stroke();
      ctx.fillStyle = '#666'; ctx.font = '10px monospace'; ctx.fillText(fmtTime(ms), x + 3, 12);
    }
    // Chapter markers
    ctx.strokeStyle = '#D97A4A'; ctx.setLineDash([4, 4]);
    for (const m of markers) {
      const x = m.position_ms * pxPerMs;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = '#D97A4A'; ctx.font = '9px sans-serif'; ctx.fillText(m.label, x + 3, RULER_HEIGHT - 4);
    }
    ctx.setLineDash([]);
    // Tracks & clips
    tracks.forEach((track, tIdx) => {
      const y = RULER_HEIGHT + tIdx * TRACK_HEIGHT;
      ctx.fillStyle = tIdx % 2 === 0 ? '#111' : '#0d0d0d'; ctx.fillRect(0, y, W, TRACK_HEIGHT);
      ctx.strokeStyle = '#222'; ctx.beginPath(); ctx.moveTo(0, y + TRACK_HEIGHT); ctx.lineTo(W, y + TRACK_HEIGHT); ctx.stroke();
      for (const clip of track.clips || []) {
        const dur = getClipDur(clip), cx = clip.position_ms * pxPerMs, cw = Math.max(4, dur * pxPerMs);
        const isSel = clip.id === selectedClipId, color = TRACK_COLORS[track.type] || '#888';
        ctx.fillStyle = isSel ? color : `${color}88`;
        ctx.beginPath(); ctx.roundRect(cx, y + 6, cw, TRACK_HEIGHT - 12, 4); ctx.fill();
        // Waveform
        const buf = bufCache.current.get(clip.audio_asset_id);
        if (buf && cw > 10) {
          ctx.strokeStyle = `${color}44`; ctx.lineWidth = 1;
          const data = buf.getChannelData(0);
          const ts = clip.trim_start_ms || 0, te = clip.trim_end_ms || buf.duration * 1000;
          const ss = Math.floor((ts / 1000) * buf.sampleRate), es = Math.floor((te / 1000) * buf.sampleRate);
          const st = Math.max(1, Math.floor((es - ss) / cw));
          ctx.beginPath();
          for (let i = 0; i < cw; i++) {
            const si = ss + i * st, v = si < data.length ? Math.abs(data[si]) : 0;
            const h = v * (TRACK_HEIGHT - 20), my = y + TRACK_HEIGHT / 2;
            ctx.moveTo(cx + i, my - h / 2); ctx.lineTo(cx + i, my + h / 2);
          }
          ctx.stroke();
        }
        if (isSel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(cx, y + 6, cw, TRACK_HEIGHT - 12, 4); ctx.stroke(); }
        if (cw > 30) {
          ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif';
          ctx.fillText(clip.notes || clip.segment_id?.slice(0, 6) || clip.audio_asset_id.slice(0, 6), cx + 4, y + TRACK_HEIGHT / 2 + 3, cw - 8);
        }
      }
    });
    // Playhead
    const phX = currentTimeMs * pxPerMs;
    ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke();
    ctx.fillStyle = '#ff4444'; ctx.beginPath(); ctx.moveTo(phX - 6, 0); ctx.lineTo(phX + 6, 0); ctx.lineTo(phX, 10); ctx.closePath(); ctx.fill();
  }, [tracks, markers, currentTimeMs, pxPerMs, totalDurMs, selectedClipId, getClipDur]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current, scroll = scrollRef.current;
      if (!canvas || !scroll) return;
      canvas.width = Math.max(scroll.clientWidth, totalDurMs * pxPerMs);
      canvas.height = Math.max(RULER_HEIGHT + tracks.length * TRACK_HEIGHT, 200);
      drawCanvas();
    };
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [tracks, totalDurMs, pxPerMs, drawCanvas]);

  // ── Mouse Interaction ──
  const hitTest = useCallback((cx: number, cy: number) => {
    const tIdx = Math.floor((cy - RULER_HEIGHT) / TRACK_HEIGHT);
    if (tIdx < 0 || tIdx >= tracks.length) return null;
    const track = tracks[tIdx]; const ms = cx / pxPerMs;
    for (const clip of track.clips || []) {
      const dur = getClipDur(clip);
      if (ms >= clip.position_ms && ms <= clip.position_ms + dur) {
        const rx = cx - clip.position_ms * pxPerMs, cw = dur * pxPerMs;
        let edge: DragMode = 'move';
        if (rx < EDGE_GRAB_PX) edge = 'trim-left';
        else if (rx > cw - EDGE_GRAB_PX) edge = 'trim-right';
        return { track, clip, edge };
      }
    }
    return { track, clip: null as Clip | null, edge: null as DragMode };
  }, [tracks, pxPerMs, getClipDur]);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);
    if (y < RULER_HEIGHT) { setCurrentTimeMs(Math.max(0, x / pxPerMs)); return; }
    const hit = hitTest(x, y);
    if (!hit) { setSelectedClipId(null); setContextMenu(null); return; }
    if (hit.clip) {
      setSelectedClipId(hit.clip.id); setContextMenu(null);
      if (e.button === 0) {
        pushSnapshot();
        dragRef.current = { mode: hit.edge, clipId: hit.clip.id, trackId: hit.track.id, startMouseX: e.clientX,
          origPos: hit.clip.position_ms, origTS: hit.clip.trim_start_ms || 0, origTE: hit.clip.trim_end_ms || getClipTotal(hit.clip) };
      }
    } else { setSelectedClipId(null); setContextMenu(null); setCurrentTimeMs(Math.max(0, x / pxPerMs)); }
  }, [pxPerMs, hitTest, pushSnapshot, getClipTotal]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startMouseX, dMs = dx / pxPerMs;
      const { mode, clipId } = dragRef.current;
      setTracks(p => p.map(t => ({ ...t, clips: (t.clips || []).map(c => {
        if (c.id !== clipId) return c;
        if (mode === 'move') return { ...c, position_ms: Math.max(0, dragRef.current!.origPos + dMs) };
        if (mode === 'trim-left') {
          const nts = Math.max(0, dragRef.current!.origTS + dMs);
          return { ...c, trim_start_ms: nts, position_ms: Math.max(0, dragRef.current!.origPos + (nts - dragRef.current!.origTS)) };
        }
        if (mode === 'trim-right') {
          const tot = getClipTotal(c);
          return { ...c, trim_end_ms: Math.min(tot, Math.max(dragRef.current!.origTS + MIN_CLIP_MS, dragRef.current!.origTE + dMs)) };
        }
        return c;
      }) })));
      return;
    }
    const hit = hitTest(x, y);
    if (hit?.clip) {
      setHoverInfo({ x: e.clientX, y: e.clientY, clip: hit.clip, track: hit.track });
      canvas.style.cursor = hit.edge === 'trim-left' || hit.edge === 'trim-right' ? 'col-resize' : 'grab';
    } else { setHoverInfo(null); canvas.style.cursor = 'default'; }
  }, [pxPerMs, hitTest, getClipTotal]);

  const onMouseUp = useCallback(async () => {
    if (!dragRef.current || !bookId) { dragRef.current = null; return; }
    const { clipId } = dragRef.current; dragRef.current = null;
    const f = findCT(clipId);
    if (f) try { await timelineApi.updateClip(bookId, clipId, { position_ms: f.clip.position_ms, trim_start_ms: f.clip.trim_start_ms, trim_end_ms: f.clip.trim_end_ms }); } catch {}
  }, [bookId, findCT]);

  const onCtxMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);
    const hit = hitTest(x, y);
    if (hit?.clip) { setSelectedClipId(hit.clip.id); setContextMenu({ x: e.clientX, y: e.clientY, clip: hit.clip, track: hit.track }); }
    else setContextMenu(null);
  }, [hitTest]);

  // ── Keyboard Shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Escape') { stopPlayback(); setContextMenu(null); setShowHelp(false); }
      else if (e.key === 'Home') setCurrentTimeMs(0);
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedClipId) handleDeleteClip(selectedClipId); }
      else if (e.key === 's' && ctrl) { e.preventDefault(); if (selectedClipId) handleSplitClip(selectedClipId); }
      else if (e.key === 'd' && ctrl) { e.preventDefault(); if (selectedClipId) handleDupClip(selectedClipId); }
      else if (e.key === 'z' && ctrl && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      else if ((e.key === 'y' && ctrl) || (e.key === 'z' && ctrl && e.shiftKey)) { e.preventDefault(); handleRedo(); }
      else if (e.key === 'c' && ctrl) { e.preventDefault(); if (selectedClipId) handleCopy(selectedClipId); }
      else if (e.key === 'x' && ctrl) { e.preventDefault(); if (selectedClipId) handleCut(selectedClipId); }
      else if (e.key === 'v' && ctrl) { e.preventDefault(); handlePaste(); }
      else if (e.key === '?' || (e.key === '/' && e.shiftKey)) setShowHelp(p => !p);
      else if (e.key === '+' || e.key === '=') setZoom(z => Math.min(8, z * 1.3));
      else if (e.key === '-') setZoom(z => Math.max(0.1, z / 1.3));
      else if (e.key === 'ArrowLeft') setCurrentTimeMs(t => Math.max(0, t - (e.shiftKey ? 5000 : 1000)));
      else if (e.key === 'ArrowRight') setCurrentTimeMs(t => t + (e.shiftKey ? 5000 : 1000));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlay, stopPlayback, selectedClipId, handleUndo, handleRedo, handleCopy, handleCut, handlePaste]);

  useEffect(() => { return () => { stopPlayback(); cancelAnimationFrame(animRef.current); }; }, [stopPlayback]);

  // ── JSX ──
  return (
    <div ref={containerRef} style={S.container}>
      {/* Toolbar */}
      <div style={S.toolbar}>
        <div style={S.tg}>
          <button onClick={handleStop} style={S.tb} title="Stop (Esc)"><Square size={14} /></button>
          <button onClick={togglePlay} style={{ ...S.tb, background: playing ? '#a33' : '#2d5a27' }} title="Play/Pause (Space)">
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button onClick={() => setCurrentTimeMs(0)} style={S.tb} title="Go to start (Home)"><SkipBack size={14} /></button>
          <span style={S.time}>{fmtTime(currentTimeMs)}</span>
        </div>
        <div style={S.tg}>
          <button onClick={handleUndo} disabled={!canUndo} style={{ ...S.tb, opacity: canUndo ? 1 : 0.3 }} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
          <button onClick={handleRedo} disabled={!canRedo} style={{ ...S.tb, opacity: canRedo ? 1 : 0.3 }} title="Redo (Ctrl+Y)"><Redo2 size={14} /></button>
        </div>
        <div style={S.tg}>
          {selectedClipId && <>
            <button onClick={() => handleCopy(selectedClipId)} style={S.tb} title="Copy (Ctrl+C)"><Copy size={14} /></button>
            <button onClick={() => handleCut(selectedClipId)} style={S.tb} title="Cut (Ctrl+X)"><Scissors size={14} /></button>
          </>}
          {clipboardData && <button onClick={handlePaste} style={S.tb} title="Paste (Ctrl+V)"><ClipboardPaste size={14} /></button>}
          {selectedClipId && <>
            <button onClick={() => handleSplitClip(selectedClipId)} style={S.tb} title="Split (Ctrl+S)"><Scissors size={14} /></button>
            <button onClick={() => handleDupClip(selectedClipId)} style={S.tb} title="Duplicate (Ctrl+D)"><Copy size={14} /></button>
            <button onClick={() => handleDeleteClip(selectedClipId)} style={S.tb} title="Delete (Del)"><Trash2 size={14} /></button>
          </>}
        </div>
        <div style={S.tg}>
          <span style={{ fontSize: 10, color: '#666' }}>Zoom:</span>
          <input type="range" min={0.1} max={8} step={0.1} value={zoom} onChange={e => setZoom(parseFloat(e.target.value))} style={{ width: 80 }} />
          <span style={{ fontSize: 10, color: '#888' }}>{zoom.toFixed(1)}x</span>
        </div>
        <div style={S.tg}>
          <button onClick={() => setQuickAddOpen(!quickAddOpen)} style={{ ...S.tb, background: quickAddOpen ? '#2a1a3a' : '#222' }} title="Quick-add SFX/Music">
            <Wand2 size={14} /> <ChevronDown size={10} />
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowDownloadMenu(!showDownloadMenu)} style={S.tb} title="Save & Download"><Save size={14} /> <ChevronDown size={10} /></button>
            {showDownloadMenu && (
              <div style={S.dropdown}>
                <button onClick={() => { handleSave(); setShowDownloadMenu(false); }} style={S.ddi}><Save size={12} /> {saving ? 'Saving...' : 'Save Project'}</button>
                <button onClick={() => { handleDownload(); setShowDownloadMenu(false); }} style={S.ddi}><Download size={12} /> Download .zip</button>
                <button onClick={() => { handleRender(); setShowDownloadMenu(false); }} style={S.ddi} disabled={rendering}><Music size={12} /> {rendering ? 'Rendering...' : 'Render Audio'}</button>
              </div>
            )}
          </div>
          {saveMsg && <span style={{ fontSize: 10, color: '#8f8' }}>{saveMsg}</span>}
          <button onClick={() => setShowHelp(true)} style={S.tb} title="Help (?)"><HelpCircle size={14} /></button>
        </div>
      </div>

      {/* Quick-Add Panel */}
      {quickAddOpen && (
        <div style={S.qaPanel}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select value={quickAddType} onChange={e => setQuickAddType(e.target.value as 'sfx' | 'music')} style={S.qaSelect} aria-label="Quick add type">
              <option value="sfx">🔊 SFX</option><option value="music">🎵 Music</option>
            </select>
            <input value={quickAddPrompt} onChange={e => setQuickAddPrompt(e.target.value)}
              placeholder={quickAddType === 'sfx' ? 'e.g. thunder crack...' : 'e.g. tense orchestral...'}
              style={S.qaInput} onKeyDown={e => { if (e.key === 'Enter') handleQuickAdd(); }} aria-label="Quick add prompt" />
            <button onClick={handleQuickAdd} disabled={quickAddGenerating || !quickAddPrompt.trim()} style={S.qaBtn}>
              {quickAddGenerating ? <Loader size={12} /> : <Wand2 size={12} />} {quickAddGenerating ? 'Generating...' : 'Add'}
            </button>
            <button onClick={() => setQuickAddOpen(false)} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer' }}><X size={12} /></button>
          </div>
        </div>
      )}

      {/* Main area */}
      <div style={S.main}>
        <div style={S.headers}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', padding: '0 8px' }}>
            <span style={{ fontSize: 10, color: '#666' }}>Tracks</span>
          </div>
          {tracks.map(track => (
            <div key={track.id} style={S.trackHdr}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
                <span>{TRACK_ICONS[track.type] || '📁'}</span>
                <span style={{ fontSize: 11, color: '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.name}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button onClick={() => handleTrackMute(track.id)} style={{ ...S.tiny, color: track.muted ? '#e55' : '#888' }} title={track.muted ? 'Unmute' : 'Mute'}>
                  {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                </button>
                <input type="range" min={-20} max={6} step={0.5} value={track.gain || 0}
                  onChange={e => handleTrackGain(track.id, parseFloat(e.target.value))} style={{ width: 50, height: 12 }} title={`Gain: ${track.gain || 0}dB`} />
                <button onClick={() => handleDeleteTrack(track.id)} style={{ ...S.tiny, color: '#555' }} title="Delete track"><Trash2 size={10} /></button>
              </div>
            </div>
          ))}
          <div style={S.addRow}>
            {(['narration', 'dialogue', 'sfx', 'music'] as const).map(type => (
              <button key={type} onClick={() => handleAddTrack(type)} style={{ ...S.addBtn, borderColor: TRACK_COLORS[type] }} title={`Add ${type} track`}>
                {TRACK_ICONS[type]} +
              </button>
            ))}
          </div>
        </div>
        <div ref={scrollRef} style={S.scroll}>
          <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
            onMouseLeave={() => { dragRef.current = null; setHoverInfo(null); }} onContextMenu={onCtxMenu} style={{ display: 'block' }} />
        </div>
      </div>

      {/* Inspector */}
      {selClip && (
        <div style={S.inspector}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>Clip Inspector</span>
            <button onClick={() => setSelectedClipId(null)} style={S.tiny}><X size={11} /></button>
          </div>
          <div style={S.iRow}><label style={S.iLbl}>Position</label><span style={S.iVal}>{fmtTime(selClip.position_ms)}</span></div>
          <div style={S.iRow}><label style={S.iLbl}>Duration</label><span style={S.iVal}>{fmtDur(getClipDur(selClip))}</span></div>
          <div style={S.iRow}><label style={S.iLbl}>Gain (dB)</label>
            <input type="number" value={selClip.gain || 0} step={0.5} onChange={e => handleUpdateField(selClip.id, 'gain', parseFloat(e.target.value))} style={S.iInput} /></div>
          <div style={S.iRow}><label style={S.iLbl}>Fade In</label>
            <input type="number" value={selClip.fade_in_ms || 0} min={0} step={50} onChange={e => handleUpdateField(selClip.id, 'fade_in_ms', parseInt(e.target.value))} style={S.iInput} /></div>
          <div style={S.iRow}><label style={S.iLbl}>Fade Out</label>
            <input type="number" value={selClip.fade_out_ms || 0} min={0} step={50} onChange={e => handleUpdateField(selClip.id, 'fade_out_ms', parseInt(e.target.value))} style={S.iInput} /></div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div style={{ ...S.ctx, left: contextMenu.x, top: contextMenu.y }}>
          <button onClick={() => { handleCopy(contextMenu.clip.id); setContextMenu(null); }} style={S.ctxI}><Copy size={11} /> Copy</button>
          <button onClick={() => { handleCut(contextMenu.clip.id); setContextMenu(null); }} style={S.ctxI}><Scissors size={11} /> Cut</button>
          {clipboardData && <button onClick={() => { handlePaste(); setContextMenu(null); }} style={S.ctxI}><ClipboardPaste size={11} /> Paste</button>}
          <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '2px 0' }} />
          <button onClick={() => { handleSplitClip(contextMenu.clip.id); setContextMenu(null); }} style={S.ctxI}><Scissors size={11} /> Split at Playhead</button>
          <button onClick={() => { handleDupClip(contextMenu.clip.id); setContextMenu(null); }} style={S.ctxI}><Copy size={11} /> Duplicate</button>
          <button onClick={() => { handleDeleteClip(contextMenu.clip.id); setContextMenu(null); }} style={{ ...S.ctxI, color: '#e55' }}><Trash2 size={11} /> Delete</button>
        </div>
      )}

      {/* Hover tooltip */}
      {hoverInfo && !dragRef.current && (
        <div style={{ ...S.tip, left: hoverInfo.x + 12, top: hoverInfo.y - 40 }}>
          <span>{hoverInfo.track.name} · {fmtDur(getClipDur(hoverInfo.clip))}</span>
          {hoverInfo.clip.notes && <span style={{ color: '#888' }}> · {hoverInfo.clip.notes}</span>}
        </div>
      )}

      {/* Help Overlay */}
      {showHelp && (
        <div style={S.helpOv} onClick={() => setShowHelp(false)}>
          <div style={S.helpBox} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>Keyboard Shortcuts</span>
              <button onClick={() => setShowHelp(false)} style={S.tiny}><X size={14} /></button>
            </div>
            <div style={S.helpGrid}>
              {([['Space','Play / Pause'],['Esc','Stop'],['Home','Go to start'],['← / →','Nudge 1s'],['Shift+← / →','Nudge 5s'],
                ['+/-','Zoom'],['Delete','Delete clip'],['Ctrl+S','Split clip'],['Ctrl+D','Duplicate clip'],
                ['Ctrl+Z','Undo'],['Ctrl+Y','Redo'],['Ctrl+C','Copy clip'],['Ctrl+X','Cut clip'],['Ctrl+V','Paste clip'],['?','Help'],
              ] as [string,string][]).map(([k,d]) => (
                <React.Fragment key={k}><kbd style={S.kbd}>{k}</kbd><span style={{ fontSize: 12, color: '#aaa' }}>{d}</span></React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {(contextMenu || showDownloadMenu) && <div style={S.clickAway} onClick={() => { setContextMenu(null); setShowDownloadMenu(false); }} />}

      {tracks.length === 0 && (
        <div style={S.empty}>
          <Music size={32} color="#333" />
          <p style={{ color: '#555', fontSize: 14 }}>No tracks yet</p>
          <p style={{ color: '#444', fontSize: 12 }}>Add a track or go to Manuscript to generate audio.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {(['narration','dialogue','sfx','music'] as const).map(type => (
              <button key={type} onClick={() => handleAddTrack(type)} style={{ ...S.addBtn, padding: '6px 12px', fontSize: 12, pointerEvents: 'auto' as const }}>
                {TRACK_ICONS[type]} Add {type}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)', background: '#0f0f0f', position: 'relative' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: '#1a1a1a', borderBottom: '1px solid #222', flexWrap: 'wrap' },
  tg: { display: 'flex', alignItems: 'center', gap: 4 },
  tb: { display: 'flex', alignItems: 'center', gap: 3, padding: '5px 8px', background: '#222', color: '#aaa', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11 },
  time: { fontSize: 13, color: '#4A90D9', fontFamily: 'monospace', minWidth: 70 },
  main: { flex: 1, display: 'flex', overflow: 'hidden' },
  headers: { width: HEADER_WIDTH, flexShrink: 0, background: '#1a1a1a', borderRight: '1px solid #222', overflow: 'auto', display: 'flex', flexDirection: 'column' },
  trackHdr: { height: TRACK_HEIGHT, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '4px 8px', borderBottom: '1px solid #222', gap: 2 },
  scroll: { flex: 1, overflow: 'auto', position: 'relative' },
  tiny: { display: 'flex', alignItems: 'center', gap: 2, padding: '2px 4px', background: 'transparent', color: '#888', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 10 },
  addRow: { display: 'flex', gap: 4, padding: 8, flexWrap: 'wrap' },
  addBtn: { padding: '3px 8px', background: 'transparent', color: '#888', border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 10 },
  inspector: { position: 'absolute', right: 12, top: 60, width: 200, background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 12, zIndex: 20 },
  iRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  iLbl: { fontSize: 10, color: '#666' },
  iVal: { fontSize: 11, color: '#aaa', fontFamily: 'monospace' },
  iInput: { width: 60, padding: '2px 4px', background: '#0f0f0f', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 11, textAlign: 'right' as const },
  ctx: { position: 'fixed', zIndex: 100, background: '#222', border: '1px solid #333', borderRadius: 8, padding: 4, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 160, boxShadow: '0 4px 16px rgba(0,0,0,0.6)' },
  ctxI: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'transparent', color: '#aaa', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, textAlign: 'left' as const },
  tip: { position: 'fixed', zIndex: 50, background: '#222', border: '1px solid #333', borderRadius: 6, padding: '4px 8px', fontSize: 10, color: '#ccc', pointerEvents: 'none' as const, whiteSpace: 'nowrap' as const },
  qaPanel: { padding: '8px 12px', background: '#1a1a1a', borderBottom: '1px solid #222' },
  qaSelect: { padding: '4px 6px', background: '#0f0f0f', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 11 },
  qaInput: { flex: 1, padding: '5px 8px', background: '#0f0f0f', color: '#ddd', border: '1px solid #333', borderRadius: 5, fontSize: 12, outline: 'none', minWidth: 200 },
  qaBtn: { display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', background: '#2d5a27', color: '#8f8', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11 },
  dropdown: { position: 'absolute', top: '100%', right: 0, zIndex: 30, background: '#222', border: '1px solid #333', borderRadius: 8, padding: 4, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 1, boxShadow: '0 4px 12px rgba(0,0,0,0.5)' },
  ddi: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'transparent', color: '#aaa', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, textAlign: 'left' as const },
  helpOv: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  helpBox: { background: '#1a1a1a', border: '1px solid #333', borderRadius: 16, padding: 24, maxWidth: 420, width: '90%' },
  helpGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', alignItems: 'center' },
  kbd: { padding: '2px 8px', background: '#222', color: '#ddd', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', border: '1px solid #333', textAlign: 'center' as const },
  clickAway: { position: 'fixed', inset: 0, zIndex: 5 },
  empty: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, pointerEvents: 'none' as const },
};
