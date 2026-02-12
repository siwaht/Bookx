import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl, render, saveProject, downloadProjectUrl } from '../services/api';
import type { Track, Clip, ChapterMarker } from '../types';
import {
  Play, Pause, SkipBack, ZoomIn, ZoomOut, Plus, Trash2, Volume2, VolumeX,
  Save, Download, Scissors, Copy, Clipboard, Undo2, Redo2, HelpCircle, X,
  Wand2, Loader,
} from 'lucide-react';

type DragMode = 'move' | 'trimStart' | 'trimEnd';

interface ClipboardData { clip: Clip; trackId: string; cut: boolean; }
interface ContextMenu { x: number; y: number; clipId: string; trackId: string; }

const TRACK_H = 60;
const HEADER_W = 200;
const RULER_H = 28;
const MIN_PX_PER_MS = 0.005;
const MAX_PX_PER_MS = 0.5;

export function TimelinePage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [markers, setMarkers] = useState<ChapterMarker[]>([]);
  const [pxPerMs, setPxPerMs] = useState(0.05);
  const [scrollX, setScrollX] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [clipboardData, setClipboardData] = useState<ClipboardData | null>(null);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const skipSnap = useRef(false);
  const dragRef = useRef<{
    mode: DragMode; clipId: string; trackId: string;
    startMouseX: number; origPos: number; origTS: number; origTE: number;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playTimerRef = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickType, setQuickType] = useState<'sfx' | 'music'>('sfx');
  const [quickGenerating, setQuickGenerating] = useState(false);

  // ── Data Loading ──
  const loadTracks = useCallback(async () => {
    if (!bookId) return;
    const data = await timelineApi.tracks(bookId);
    setTracks(data);
    if (!skipSnap.current) pushSnapshot(data);
    skipSnap.current = false;
  }, [bookId]);

  const loadMarkers = useCallback(async () => {
    if (!bookId) return;
    const data = await timelineApi.chapterMarkers(bookId);
    setMarkers(data);
  }, [bookId]);

  useEffect(() => { loadTracks(); loadMarkers(); }, [loadTracks, loadMarkers]);

  // ── Undo/Redo ──
  const pushSnapshot = (data: Track[]) => {
    undoStack.current.push(JSON.stringify(data));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(undoStack.current.length > 1);
    setCanRedo(false);
  };
  const undo = () => {
    if (undoStack.current.length <= 1) return;
    const current = undoStack.current.pop()!;
    redoStack.current.push(current);
    const prev = undoStack.current[undoStack.current.length - 1];
    setTracks(JSON.parse(prev));
    setCanUndo(undoStack.current.length > 1);
    setCanRedo(true);
  };
  const redo = () => {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current.pop()!;
    undoStack.current.push(next);
    setTracks(JSON.parse(next));
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  };

  // ── Playback ──
  const togglePlay = () => {
    if (playing) {
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      setPlaying(false);
    } else {
      setPlaying(true);
      let lastTime = performance.now();
      const tick = (now: number) => {
        const dt = now - lastTime;
        lastTime = now;
        setPlayheadMs((p) => p + dt);
        playTimerRef.current = requestAnimationFrame(tick);
      };
      playTimerRef.current = requestAnimationFrame(tick);
    }
  };
  const seekTo = (ms: number) => setPlayheadMs(Math.max(0, ms));

  // ── Track Actions ──
  const addTrack = async (type: string) => {
    if (!bookId) return;
    pushSnapshot(tracks);
    const names: Record<string, string> = { narration: 'Narration', dialogue: 'Dialogue', sfx: 'SFX', music: 'Music', imported: 'Imported' };
    await timelineApi.createTrack(bookId, { name: names[type] || type, type });
    skipSnap.current = true;
    loadTracks();
  };
  const deleteTrack = async (trackId: string) => {
    if (!bookId || !confirm('Delete this track and all its clips?')) return;
    pushSnapshot(tracks);
    await timelineApi.deleteTrack(bookId, trackId);
    skipSnap.current = true;
    loadTracks();
  };
  const toggleMute = async (trackId: string) => {
    if (!bookId) return;
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;
    await timelineApi.updateTrack(bookId, trackId, { muted: track.muted ? 0 : 1 });
    skipSnap.current = true;
    loadTracks();
  };
  const updateTrackGain = async (trackId: string, gain: number) => {
    if (!bookId) return;
    await timelineApi.updateTrack(bookId, trackId, { gain });
    skipSnap.current = true;
    loadTracks();
  };

  // ── Clip Actions ──
  const deleteClip = async (clipId: string) => {
    if (!bookId) return;
    pushSnapshot(tracks);
    await timelineApi.deleteClip(bookId, clipId);
    if (selectedClipId === clipId) setSelectedClipId(null);
    skipSnap.current = true;
    loadTracks();
  };
  const splitClip = async (clipId: string) => {
    if (!bookId) return;
    const clip = findClip(clipId);
    if (!clip) return;
    const splitMs = playheadMs - clip.position_ms;
    if (splitMs <= 0) return;
    pushSnapshot(tracks);
    const track = tracks.find((t) => t.clips.some((c) => c.id === clipId));
    if (!track) return;
    await timelineApi.updateClip(bookId, clipId, { trim_end_ms: clip.trim_end_ms + splitMs });
    await timelineApi.createClip(bookId, track.id, {
      audio_asset_id: clip.audio_asset_id,
      position_ms: clip.position_ms + splitMs,
      trim_start_ms: clip.trim_start_ms + splitMs,
      trim_end_ms: clip.trim_end_ms,
      gain: clip.gain, speed: clip.speed,
    });
    skipSnap.current = true;
    loadTracks();
  };
  const duplicateClip = async (clipId: string) => {
    if (!bookId) return;
    const clip = findClip(clipId);
    if (!clip) return;
    pushSnapshot(tracks);
    const track = tracks.find((t) => t.clips.some((c) => c.id === clipId));
    if (!track) return;
    const dur = getClipDuration(clip);
    await timelineApi.createClip(bookId, track.id, {
      audio_asset_id: clip.audio_asset_id,
      position_ms: clip.position_ms + dur + 200,
      trim_start_ms: clip.trim_start_ms, trim_end_ms: clip.trim_end_ms,
      gain: clip.gain, speed: clip.speed,
      fade_in_ms: clip.fade_in_ms, fade_out_ms: clip.fade_out_ms,
    });
    skipSnap.current = true;
    loadTracks();
  };
  const copyClip = (clipId: string, cut: boolean) => {
    const clip = findClip(clipId);
    if (!clip) return;
    const track = tracks.find((t) => t.clips.some((c) => c.id === clipId));
    if (!track) return;
    setClipboardData({ clip: { ...clip }, trackId: track.id, cut });
    if (cut) deleteClip(clipId);
  };
  const pasteClip = async (trackId: string) => {
    if (!bookId || !clipboardData) return;
    pushSnapshot(tracks);
    await timelineApi.createClip(bookId, trackId, {
      audio_asset_id: clipboardData.clip.audio_asset_id,
      position_ms: playheadMs,
      trim_start_ms: clipboardData.clip.trim_start_ms, trim_end_ms: clipboardData.clip.trim_end_ms,
      gain: clipboardData.clip.gain, speed: clipboardData.clip.speed,
      fade_in_ms: clipboardData.clip.fade_in_ms, fade_out_ms: clipboardData.clip.fade_out_ms,
    });
    skipSnap.current = true;
    loadTracks();
  };
  const updateClipProperty = async (clipId: string, props: Partial<Clip>) => {
    if (!bookId) return;
    pushSnapshot(tracks);
    await timelineApi.updateClip(bookId, clipId, props);
    skipSnap.current = true;
    loadTracks();
  };

  // ── Helpers ──
  const findClip = (clipId: string): Clip | null => {
    for (const t of tracks) { const c = t.clips.find((c) => c.id === clipId); if (c) return c; }
    return null;
  };
  const getClipDuration = (clip: Clip) => {
    const base = clip.trim_end_ms || 5000;
    return Math.max(base - clip.trim_start_ms, 200);
  };
  const totalDuration = () => {
    let max = 10000;
    for (const t of tracks) for (const c of t.clips) max = Math.max(max, c.position_ms + getClipDuration(c));
    return max + 5000;
  };

  // ── Canvas Drawing ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    // Ruler
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    const stepMs = pxPerMs > 0.1 ? 1000 : pxPerMs > 0.02 ? 5000 : 10000;
    for (let ms = 0; ms < totalDuration(); ms += stepMs) {
      const x = (ms - scrollX) * pxPerMs;
      if (x < -50 || x > W + 50) continue;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.font = '10px monospace';
      const sec = ms / 1000;
      const label = sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
      ctx.fillText(label, x + 3, 12);
    }

    // Chapter markers
    for (const m of markers) {
      const x = (m.position_ms - scrollX) * pxPerMs;
      if (x < -100 || x > W + 100) continue;
      ctx.fillStyle = '#D97A4A33';
      ctx.fillRect(x, RULER_H, 1, H);
      ctx.fillStyle = '#D97A4A';
      ctx.font = '9px sans-serif';
      ctx.fillText(m.label.slice(0, 20), x + 3, RULER_H + 12);
    }

    // Tracks and clips
    tracks.forEach((track, ti) => {
      const y = RULER_H + ti * TRACK_H;
      ctx.fillStyle = track.muted ? '#0d0d0d' : '#111';
      ctx.fillRect(0, y, W, TRACK_H);
      ctx.strokeStyle = '#1a1a1a';
      ctx.beginPath(); ctx.moveTo(0, y + TRACK_H); ctx.lineTo(W, y + TRACK_H); ctx.stroke();

      for (const clip of track.clips) {
        const cx = (clip.position_ms - scrollX) * pxPerMs;
        const cw = getClipDuration(clip) * pxPerMs;
        if (cx + cw < 0 || cx > W) continue;
        const isSelected = clip.id === selectedClipId;
        const baseColor = track.type === 'narration' ? '#2a4a6a' : track.type === 'sfx' ? '#2a4a2a' : track.type === 'music' ? '#4a2a6a' : '#4a4a2a';
        ctx.fillStyle = isSelected ? '#4A90D9' : baseColor;
        ctx.fillRect(cx, y + 4, cw, TRACK_H - 8);
        ctx.strokeStyle = isSelected ? '#fff' : '#333';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(cx, y + 4, cw, TRACK_H - 8);

        // Volume indicator bar at bottom of clip
        const gainDb = clip.gain || 0;
        const volFrac = Math.min(1, Math.max(0, (gainDb + 20) / 26)); // -20dB to +6dB mapped to 0-1
        ctx.fillStyle = gainDb > 0 ? '#e55' : '#4A90D9';
        ctx.fillRect(cx + 1, y + TRACK_H - 10, (cw - 2) * volFrac, 3);

        // Speed indicator if not 1.0
        const spd = clip.speed ?? 1.0;
        if (spd !== 1.0 && cw > 40) {
          ctx.fillStyle = '#ff0';
          ctx.font = '8px monospace';
          ctx.fillText(`${spd.toFixed(1)}x`, cx + cw - 28, y + 14);
        }

        if (cw > 30) {
          ctx.fillStyle = '#ddd';
          ctx.font = '10px sans-serif';
          const label = clip.notes || clip.segment_id?.slice(0, 8) || clip.audio_asset_id.slice(0, 8);
          ctx.fillText(label, cx + 4, y + TRACK_H / 2 + 1, cw - 8);
        }
        if (isSelected) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(cx, y + 4, 4, TRACK_H - 8);
          ctx.fillRect(cx + cw - 4, y + 4, 4, TRACK_H - 8);
        }
      }
    });

    // Playhead
    const phX = (playheadMs - scrollX) * pxPerMs;
    ctx.strokeStyle = '#e55';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke();
    ctx.fillStyle = '#e55';
    ctx.beginPath(); ctx.moveTo(phX - 6, 0); ctx.lineTo(phX + 6, 0); ctx.lineTo(phX, 8); ctx.closePath(); ctx.fill();
  }, [tracks, markers, pxPerMs, scrollX, playheadMs, selectedClipId]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth;
      canvas.height = Math.max(RULER_H + tracks.length * TRACK_H, 200);
      draw();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [tracks.length, draw]);

  // ── Mouse Interaction ──
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (my < RULER_H) { seekTo(mx / pxPerMs + scrollX); return; }
    const trackIdx = Math.floor((my - RULER_H) / TRACK_H);
    if (trackIdx < 0 || trackIdx >= tracks.length) { setSelectedClipId(null); return; }
    const track = tracks[trackIdx];
    const clickMs = mx / pxPerMs + scrollX;
    for (const clip of track.clips) {
      const cx = (clip.position_ms - scrollX) * pxPerMs;
      const cw = getClipDuration(clip) * pxPerMs;
      if (mx >= cx && mx <= cx + cw) {
        setSelectedClipId(clip.id);
        setContextMenu(null);
        let mode: DragMode = 'move';
        if (mx - cx < 6) mode = 'trimStart';
        else if (cx + cw - mx < 6) mode = 'trimEnd';
        dragRef.current = { mode, clipId: clip.id, trackId: track.id, startMouseX: mx, origPos: clip.position_ms, origTS: clip.trim_start_ms, origTE: clip.trim_end_ms };
        return;
      }
    }
    setSelectedClipId(null);
    seekTo(clickMs);
  };
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || !bookId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const dx = mx - dragRef.current.startMouseX;
    const dMs = dx / pxPerMs;
    setTracks((prev) => prev.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== dragRef.current!.clipId) return c;
        if (dragRef.current!.mode === 'move') return { ...c, position_ms: Math.max(0, dragRef.current!.origPos + dMs) };
        if (dragRef.current!.mode === 'trimStart') return { ...c, trim_start_ms: Math.max(0, dragRef.current!.origTS + dMs) };
        if (dragRef.current!.mode === 'trimEnd') return { ...c, trim_end_ms: Math.max(0, dragRef.current!.origTE - dMs) };
        return c;
      }),
    })));
  };
  const handleCanvasMouseUp = async () => {
    if (!dragRef.current || !bookId) return;
    const clip = findClip(dragRef.current.clipId);
    if (clip) {
      pushSnapshot(tracks);
      await timelineApi.updateClip(bookId, clip.id, {
        position_ms: Math.round(clip.position_ms),
        trim_start_ms: Math.round(clip.trim_start_ms),
        trim_end_ms: Math.round(clip.trim_end_ms),
      });
    }
    dragRef.current = null;
  };
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const trackIdx = Math.floor((my - RULER_H) / TRACK_H);
    if (trackIdx < 0 || trackIdx >= tracks.length) return;
    const track = tracks[trackIdx];
    for (const clip of track.clips) {
      const cx = (clip.position_ms - scrollX) * pxPerMs;
      const cw = getClipDuration(clip) * pxPerMs;
      if (mx >= cx && mx <= cx + cw) {
        setSelectedClipId(clip.id);
        setContextMenu({ x: e.clientX, y: e.clientY, clipId: clip.id, trackId: track.id });
        return;
      }
    }
  };

  // ── Keyboard Shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      if (e.key === 'Delete' && selectedClipId) deleteClip(selectedClipId);
      if (e.key === 'Home') seekTo(0);
      if (e.key === 'ArrowLeft') seekTo(playheadMs - 1000);
      if (e.key === 'ArrowRight') seekTo(playheadMs + 1000);
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.ctrlKey && e.key === 'c' && selectedClipId) copyClip(selectedClipId, false);
      if (e.ctrlKey && e.key === 'x' && selectedClipId) copyClip(selectedClipId, true);
      if (e.ctrlKey && e.key === 'v' && clipboardData) {
        const track = tracks.find((t) => t.clips.some((c) => c.id === selectedClipId)) || tracks[0];
        if (track) pasteClip(track.id);
      }
      if (e.key === 's' && !e.ctrlKey && selectedClipId) splitClip(selectedClipId);
      if (e.key === 'd' && !e.ctrlKey && selectedClipId) duplicateClip(selectedClipId);
      if (e.key === '?') setShowHelp((p) => !p);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedClipId, playheadMs, playing, tracks, clipboardData]);

  // ── Zoom ──
  const zoomIn = () => setPxPerMs((p) => Math.min(p * 1.5, MAX_PX_PER_MS));
  const zoomOut = () => setPxPerMs((p) => Math.max(p / 1.5, MIN_PX_PER_MS));
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) { e.preventDefault(); if (e.deltaY < 0) zoomIn(); else zoomOut(); }
    else { setScrollX((s) => Math.max(0, s + e.deltaY / pxPerMs)); }
  };

  // ── Save / Render ──
  const handleSave = async () => {
    setSaving(true);
    try { await saveProject(); } catch (err: any) { alert(`Save failed: ${err.message}`); }
    finally { setSaving(false); }
  };
  const handleRender = async () => {
    if (!bookId) return;
    setRendering(true);
    try {
      const { job_id } = await render.start(bookId);
      alert(`Render started (job: ${job_id}). Check QC & Render page for progress.`);
    } catch (err: any) { alert(`Render failed: ${err.message}`); }
    finally { setRendering(false); }
  };

  // ── Quick Add SFX/Music ──
  const handleQuickAdd = async () => {
    if (!bookId || !quickPrompt.trim()) return;
    setQuickGenerating(true);
    try {
      let result;
      if (quickType === 'sfx') {
        result = await elevenlabs.sfx({ prompt: quickPrompt, book_id: bookId });
      } else {
        result = await elevenlabs.music({ prompt: quickPrompt, book_id: bookId });
      }
      let targetTrack: Track | undefined = tracks.find((t) => t.type === quickType);
      if (!targetTrack) {
        targetTrack = await timelineApi.createTrack(bookId, { name: quickType === 'sfx' ? 'SFX' : 'Music', type: quickType });
      }
      if (!targetTrack) throw new Error('Failed to create track');
      await timelineApi.createClip(bookId, targetTrack.id, { audio_asset_id: result.audio_asset_id, position_ms: playheadMs });
      setQuickPrompt('');
      setShowQuickAdd(false);
      skipSnap.current = true;
      loadTracks();
    } catch (err: any) { alert(`Generation failed: ${err.message}`); }
    finally { setQuickGenerating(false); }
  };

  const selectedClip = selectedClipId ? findClip(selectedClipId) : null;
  const selectedTrack = selectedClip ? tracks.find((t) => t.clips.some((c) => c.id === selectedClipId)) : null;

  return (
    <div style={S.container}>
      {/* Toolbar */}
      <div style={S.toolbar}>
        <div style={S.toolGroup}>
          <button onClick={togglePlay} style={S.toolBtn} title="Space">{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          <button onClick={() => seekTo(0)} style={S.toolBtn} title="Home"><SkipBack size={14} /></button>
          <span style={S.timeDisplay}>{formatTime(playheadMs)}</span>
        </div>
        <div style={S.toolGroup}>
          <button onClick={undo} disabled={!canUndo} style={S.toolBtn} title="Ctrl+Z"><Undo2 size={14} /></button>
          <button onClick={redo} disabled={!canRedo} style={S.toolBtn} title="Ctrl+Y"><Redo2 size={14} /></button>
        </div>
        <div style={S.toolGroup}>
          <button onClick={zoomOut} style={S.toolBtn} title="Zoom out"><ZoomOut size={14} /></button>
          <button onClick={zoomIn} style={S.toolBtn} title="Zoom in"><ZoomIn size={14} /></button>
        </div>
        <div style={S.toolGroup}>
          <button onClick={() => addTrack('narration')} style={S.toolBtn}><Plus size={12} /> Narration</button>
          <button onClick={() => addTrack('sfx')} style={S.toolBtn}><Plus size={12} /> SFX</button>
          <button onClick={() => addTrack('music')} style={S.toolBtn}><Plus size={12} /> Music</button>
        </div>
        <div style={S.toolGroup}>
          <button onClick={() => setShowQuickAdd(!showQuickAdd)} style={{ ...S.toolBtn, background: showQuickAdd ? '#2a1a3a' : '#222' }} title="Quick add SFX/Music">
            <Wand2 size={14} />
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <div style={S.toolGroup}>
          <button onClick={handleSave} disabled={saving} style={S.toolBtn}><Save size={14} /> {saving ? '...' : 'Save'}</button>
          {bookId && <a href={downloadProjectUrl(bookId)} style={{ ...S.toolBtn, textDecoration: 'none' }} download><Download size={14} /></a>}
          <button onClick={handleRender} disabled={rendering} style={{ ...S.toolBtn, background: '#2d5a27', color: '#8f8' }}>
            {rendering ? <Loader size={14} /> : <Play size={14} />} Render
          </button>
          <button onClick={() => setShowHelp(true)} style={S.toolBtn}><HelpCircle size={14} /></button>
        </div>
      </div>

      {/* Quick Add Panel */}
      {showQuickAdd && (
        <div style={S.quickPanel}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select value={quickType} onChange={(e) => setQuickType(e.target.value as 'sfx' | 'music')} style={S.quickSelect} aria-label="Quick add type">
              <option value="sfx">SFX</option>
              <option value="music">Music</option>
            </select>
            <input value={quickPrompt} onChange={(e) => setQuickPrompt(e.target.value)} placeholder="Describe the sound..."
              style={S.quickInput} onKeyDown={(e) => { if (e.key === 'Enter') handleQuickAdd(); }} aria-label="Quick add prompt" />
            <button onClick={handleQuickAdd} disabled={quickGenerating || !quickPrompt.trim()} style={S.quickBtn}>
              {quickGenerating ? <Loader size={12} /> : <Plus size={12} />} {quickGenerating ? '...' : 'Add at Playhead'}
            </button>
          </div>
        </div>
      )}

      <div style={S.body}>
        {/* Track headers with gain sliders */}
        <div style={S.trackHeaders}>
          <div style={{ height: RULER_H, borderBottom: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', padding: '0 8px' }}>
            <span style={{ fontSize: 9, color: '#444' }}>TRACKS</span>
          </div>
          {tracks.map((track) => (
            <div key={track.id} style={S.trackHeader}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ ...S.trackName, color: track.muted ? '#444' : '#aaa' }}>{track.name}</span>
                  <div style={S.trackControls}>
                    <button onClick={() => toggleMute(track.id)} style={S.tinyBtn} title={track.muted ? 'Unmute' : 'Mute'}>
                      {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                    </button>
                    <button onClick={() => deleteTrack(track.id)} style={S.tinyBtn} title="Delete track"><Trash2 size={11} /></button>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 8, color: '#555', width: 20 }}>Vol</span>
                  <input type="range" min={-20} max={6} step={0.5}
                    value={track.gain}
                    onChange={(e) => updateTrackGain(track.id, parseFloat(e.target.value))}
                    style={S.trackSlider}
                    title={`Track gain: ${track.gain > 0 ? '+' : ''}${track.gain.toFixed(1)} dB`}
                    aria-label={`${track.name} volume`}
                  />
                  <span style={{ fontSize: 8, color: '#555', width: 28, textAlign: 'right' }}>{track.gain > 0 ? '+' : ''}{track.gain.toFixed(1)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Canvas */}
        <div ref={containerRef} style={S.canvasContainer} onWheel={handleWheel}>
          <canvas ref={canvasRef} style={S.canvas}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
            onContextMenu={handleContextMenu}
          />
        </div>
      </div>

      {/* Clip Inspector — Volume, Speed, Fades */}
      {selectedClip && selectedTrack && (
        <div style={S.inspector}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h4 style={{ color: '#fff', fontSize: 12, margin: 0 }}>Clip Inspector</h4>
            <button onClick={() => setSelectedClipId(null)} style={S.tinyBtn}><X size={12} /></button>
          </div>

          <div style={S.inspRow}><span>Position:</span><span>{formatTime(selectedClip.position_ms)}</span></div>
          <div style={S.inspRow}><span>Duration:</span><span>{formatTime(getClipDuration(selectedClip))}</span></div>
          <div style={S.inspRow}><span>Track:</span><span>{selectedTrack.name}</span></div>

          {/* Volume (Gain) */}
          <div style={S.inspSection}>
            <label style={S.inspLabel}>
              Volume: {(selectedClip.gain || 0) > 0 ? '+' : ''}{(selectedClip.gain || 0).toFixed(1)} dB
            </label>
            <input type="range" min={-20} max={6} step={0.5}
              value={selectedClip.gain || 0}
              onChange={(e) => updateClipProperty(selectedClip.id, { gain: parseFloat(e.target.value) })}
              style={S.inspSlider}
              aria-label="Clip volume"
            />
            <div style={S.inspSliderLabels}><span>-20</span><span>0</span><span>+6</span></div>
          </div>

          {/* Speed */}
          <div style={S.inspSection}>
            <label style={S.inspLabel}>
              Speed: {(selectedClip.speed ?? 1.0).toFixed(2)}x
            </label>
            <input type="range" min={0.25} max={2.0} step={0.05}
              value={selectedClip.speed ?? 1.0}
              onChange={(e) => updateClipProperty(selectedClip.id, { speed: parseFloat(e.target.value) })}
              style={S.inspSlider}
              aria-label="Clip speed"
            />
            <div style={S.inspSliderLabels}><span>0.25x</span><span>1.0x</span><span>2.0x</span></div>
          </div>

          {/* Fade In */}
          <div style={S.inspSection}>
            <label style={S.inspLabel}>
              Fade In: {selectedClip.fade_in_ms || 0}ms
            </label>
            <input type="range" min={0} max={5000} step={50}
              value={selectedClip.fade_in_ms || 0}
              onChange={(e) => updateClipProperty(selectedClip.id, { fade_in_ms: parseInt(e.target.value) })}
              style={S.inspSlider}
              aria-label="Fade in duration"
            />
          </div>

          {/* Fade Out */}
          <div style={S.inspSection}>
            <label style={S.inspLabel}>
              Fade Out: {selectedClip.fade_out_ms || 0}ms
            </label>
            <input type="range" min={0} max={5000} step={50}
              value={selectedClip.fade_out_ms || 0}
              onChange={(e) => updateClipProperty(selectedClip.id, { fade_out_ms: parseInt(e.target.value) })}
              style={S.inspSlider}
              aria-label="Fade out duration"
            />
          </div>

          {/* Quick presets */}
          <div style={{ marginTop: 8, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            <button onClick={() => updateClipProperty(selectedClip.id, { gain: 0, speed: 1.0, fade_in_ms: 0, fade_out_ms: 0 })} style={S.presetBtn}>Reset All</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 0.75 })} style={S.presetBtn}>0.75x</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 1.0 })} style={S.presetBtn}>1.0x</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 1.25 })} style={S.presetBtn}>1.25x</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 1.5 })} style={S.presetBtn}>1.5x</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { gain: -6 })} style={S.presetBtn}>-6dB</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { gain: 0 })} style={S.presetBtn}>0dB</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { gain: 3 })} style={S.presetBtn}>+3dB</button>
          </div>

          <audio src={audioUrl(selectedClip.audio_asset_id)} controls style={{ width: '100%', height: 28, marginTop: 8 }} />

          <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
            <button onClick={() => splitClip(selectedClip.id)} style={S.inspBtn}><Scissors size={10} /> Split</button>
            <button onClick={() => duplicateClip(selectedClip.id)} style={S.inspBtn}><Copy size={10} /> Dup</button>
            <button onClick={() => copyClip(selectedClip.id, false)} style={S.inspBtn}><Copy size={10} /> Copy</button>
            <button onClick={() => copyClip(selectedClip.id, true)} style={S.inspBtn}><Scissors size={10} /> Cut</button>
            <button onClick={() => deleteClip(selectedClip.id)} style={{ ...S.inspBtn, color: '#e55' }}><Trash2 size={10} /> Del</button>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div style={S.overlay} onClick={() => setContextMenu(null)} />
          <div style={{ ...S.ctxMenu, left: contextMenu.x, top: contextMenu.y }}>
            <button onClick={() => { splitClip(contextMenu.clipId); setContextMenu(null); }} style={S.ctxItem}><Scissors size={11} /> Split at Playhead</button>
            <button onClick={() => { duplicateClip(contextMenu.clipId); setContextMenu(null); }} style={S.ctxItem}><Copy size={11} /> Duplicate</button>
            <button onClick={() => { copyClip(contextMenu.clipId, false); setContextMenu(null); }} style={S.ctxItem}><Copy size={11} /> Copy</button>
            <button onClick={() => { copyClip(contextMenu.clipId, true); setContextMenu(null); }} style={S.ctxItem}><Scissors size={11} /> Cut</button>
            {clipboardData && (
              <button onClick={() => { pasteClip(contextMenu.trackId); setContextMenu(null); }} style={S.ctxItem}><Clipboard size={11} /> Paste</button>
            )}
            <button onClick={() => { deleteClip(contextMenu.clipId); setContextMenu(null); }} style={{ ...S.ctxItem, color: '#e55' }}><Trash2 size={11} /> Delete</button>
          </div>
        </>
      )}

      {/* Help Overlay */}
      {showHelp && (
        <div style={S.helpOverlay}>
          <div style={S.helpBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ color: '#fff' }}>Keyboard Shortcuts</h3>
              <button onClick={() => setShowHelp(false)} style={S.tinyBtn}><X size={14} /></button>
            </div>
            <div style={S.helpGrid}>
              {[
                ['Space', 'Play / Pause'], ['Home', 'Go to start'], ['←/→', 'Seek ±1s'],
                ['Delete', 'Delete clip'], ['S', 'Split at playhead'], ['D', 'Duplicate clip'],
                ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'],
                ['Ctrl+C', 'Copy clip'], ['Ctrl+X', 'Cut clip'], ['Ctrl+V', 'Paste clip'],
                ['Ctrl+Scroll', 'Zoom'], ['Scroll', 'Pan'], ['?', 'Toggle help'],
              ].map(([key, desc]) => (
                <React.Fragment key={key}>
                  <span style={S.helpKey}>{key}</span>
                  <span style={S.helpDesc}>{desc}</span>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return `${m}:${String(sec).padStart(2, '0')}.${frac}`;
}

const S: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)', overflow: 'hidden' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#111', borderBottom: '1px solid #222', flexWrap: 'wrap' },
  toolGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  toolBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px',
    background: '#222', color: '#aaa', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11,
    whiteSpace: 'nowrap' as const,
  },
  timeDisplay: { fontSize: 13, color: '#4A90D9', fontFamily: 'monospace', minWidth: 60 },
  quickPanel: { padding: '8px 12px', background: '#1a1a1a', borderBottom: '1px solid #222' },
  quickSelect: { padding: '5px 8px', background: '#0f0f0f', color: '#ddd', border: '1px solid #333', borderRadius: 5, fontSize: 11 },
  quickInput: { flex: 1, padding: '5px 10px', background: '#0f0f0f', color: '#ddd', border: '1px solid #333', borderRadius: 5, fontSize: 12, outline: 'none' },
  quickBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11,
    whiteSpace: 'nowrap' as const,
  },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  trackHeaders: { width: HEADER_W, background: '#111', borderRight: '1px solid #222', flexShrink: 0, overflow: 'hidden' },
  trackHeader: {
    height: TRACK_H, display: 'flex', alignItems: 'center', padding: '4px 8px',
    borderBottom: '1px solid #1a1a1a',
  },
  trackName: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  trackControls: { display: 'flex', gap: 2 },
  trackSlider: { flex: 1, height: 3, cursor: 'pointer', accentColor: '#4A90D9' },
  tinyBtn: { background: 'none', border: 'none', color: '#555', cursor: 'pointer', padding: 3 },
  canvasContainer: { flex: 1, overflow: 'hidden', position: 'relative' as const },
  canvas: { display: 'block', cursor: 'crosshair' },
  inspector: {
    position: 'absolute' as const, right: 12, top: 60, width: 230,
    background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: 12, zIndex: 10,
    maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' as const,
  },
  inspRow: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#888', padding: '2px 0' },
  inspSection: { marginTop: 10, paddingTop: 8, borderTop: '1px solid #222' },
  inspLabel: { fontSize: 10, color: '#aaa', display: 'block', marginBottom: 4 },
  inspSlider: { width: '100%', height: 4, cursor: 'pointer', accentColor: '#4A90D9' },
  inspSliderLabels: { display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#444', marginTop: 2 },
  inspBtn: {
    display: 'flex', alignItems: 'center', gap: 3, padding: '3px 8px',
    background: '#222', color: '#aaa', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10,
  },
  presetBtn: {
    padding: '2px 6px', background: '#222', color: '#777', border: '1px solid #333',
    borderRadius: 3, cursor: 'pointer', fontSize: 9,
  },
  overlay: { position: 'fixed' as const, inset: 0, zIndex: 15 },
  ctxMenu: {
    position: 'fixed' as const, zIndex: 20, background: '#222', border: '1px solid #333', borderRadius: 8,
    padding: 4, display: 'flex', flexDirection: 'column' as const, gap: 1, minWidth: 160,
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  },
  ctxItem: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
    background: 'transparent', color: '#aaa', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
    textAlign: 'left' as const,
  },
  helpOverlay: {
    position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30,
  },
  helpBox: { background: '#1a1a1a', border: '1px solid #333', borderRadius: 12, padding: 24, maxWidth: 400 },
  helpGrid: { display: 'grid', gridTemplateColumns: '100px 1fr', gap: '6px 12px' },
  helpKey: {
    fontSize: 12, color: '#4A90D9', fontFamily: 'monospace', background: '#111',
    padding: '2px 6px', borderRadius: 3, textAlign: 'center' as const,
  },
  helpDesc: { fontSize: 12, color: '#888' },
};
