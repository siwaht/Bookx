import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl, saveProject, downloadProjectUrl, render as renderApi } from '../services/api';
import type { Track, Clip, ChapterMarker } from '../types';
import {
  Play, Pause, Square, Volume2, VolumeX, SkipBack, Trash2,
  Scissors, Copy, Wand2, Music, Loader, X, Save, Download,
  HelpCircle, ChevronDown,
} from 'lucide-react';

// ── Constants ──
const TRACK_HEIGHT = 80;
const RULER_HEIGHT = 32;
const HEADER_WIDTH = 210;
const DEFAULT_PX_PER_MS = 0.05;
const EDGE_GRAB_PX = 8;
const MIN_CLIP_MS = 50;

const TRACK_COLORS: Record<string, string> = {
  narration: '#4A90D9',
  dialogue: '#D97A4A',
  sfx: '#6BD94A',
  music: '#9B59B6',
  imported: '#888',
};

const TRACK_ICONS: Record<string, string> = {
  narration: '🎙️',
  dialogue: '💬',
  sfx: '🔊',
  music: '🎵',
  imported: '📁',
};

type DragMode = 'move' | 'trim-left' | 'trim-right' | null;

interface ContextMenu { x: number; y: number; clip: Clip; track: Track; }
interface HoverInfo { x: number; y: number; clip: Clip; track: Track; }

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

  // Save/Download state
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [rendering, setRendering] = useState(false);

  // Quick-add panel
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddType, setQuickAddType] = useState<'sfx' | 'music'>('sfx');
  const [quickAddPrompt, setQuickAddPrompt] = useState('');
  const [quickAddGenerating, setQuickAddGenerating] = useState(false);

  // Drag state
  const dragRef = useRef<{
    mode: DragMode; clipId: string; trackId: string; startMouseX: number;
    origPositionMs: number; origTrimStartMs: number; origTrimEndMs: number;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playStartRef = useRef<number>(0);
  const playOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);
  const audioBufferCache = useRef<Map<string, AudioBuffer>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const pxPerMs = DEFAULT_PX_PER_MS * zoom;

  // ── Helpers ──

  const getClipDurationMs = useCallback((clip: Clip): number => {
    const buf = audioBufferCache.current.get(clip.audio_asset_id);
    const totalMs = buf ? buf.duration * 1000 : 3000;
    const trimStart = clip.trim_start_ms || 0;
    const trimEnd = clip.trim_end_ms || totalMs;
    return Math.max(MIN_CLIP_MS, trimEnd - trimStart);
  }, []);

  const getClipTotalMs = useCallback((clip: Clip): number => {
    const buf = audioBufferCache.current.get(clip.audio_asset_id);
    return buf ? buf.duration * 1000 : 3000;
  }, []);

  const findClipAndTrack = useCallback((clipId: string): { clip: Clip; track: Track } | null => {
    for (const t of tracks) {
      const c = (t.clips || []).find((c) => c.id === clipId);
      if (c) return { clip: c, track: t };
    }
    return null;
  }, [tracks]);

  const selectedClip = selectedClipId ? findClipAndTrack(selectedClipId)?.clip ?? null : null;

  const formatTime = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    const frac = Math.floor((ms % 1000) / 100);
    return `${mins}:${String(secs).padStart(2, '0')}.${frac}`;
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // ── Data Loading ──

  const loadTracks = useCallback(async () => {
    if (!bookId) return;
    try {
      const [trackData, markerData] = await Promise.all([
        timelineApi.tracks(bookId),
        timelineApi.chapterMarkers(bookId),
      ]);
      setTracks(Array.isArray(trackData) ? trackData : []);
      setMarkers(Array.isArray(markerData) ? markerData : []);
    } catch (err) { console.error('Failed to load timeline:', err); }
  }, [bookId]);

  useEffect(() => { loadTracks(); }, [loadTracks]);

  const totalDurationMs = Math.max(
    60000,
    ...tracks.flatMap((t) => (t.clips || []).map((c) => c.position_ms + getClipDurationMs(c) + 5000)),
    ...markers.map((m) => m.position_ms + 5000),
  );

  // ── Save & Download ──

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await saveProject();
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err: any) { setSaveMsg('Save failed'); }
    finally { setSaving(false); }
  };

  const handleDownloadProject = () => {
    if (!bookId) return;
    // Direct download via anchor
    const a = document.createElement('a');
    a.href = downloadProjectUrl(bookId);
    a.download = 'project.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleRenderAndDownload = async () => {
    if (!bookId) return;
    setRendering(true);
    try {
      const { job_id } = await renderApi.start(bookId);
      // Poll for completion
      let status = 'running';
      while (status === 'running' || status === 'pending') {
        await new Promise((r) => setTimeout(r, 1500));
        const job = await renderApi.status(bookId, job_id);
        status = job.status;
        if (status === 'failed') throw new Error(job.error_message || 'Render failed');
      }
      // Download the rendered file
      window.open(`/api/books/${bookId}/render/${job_id}/download`, '_blank');
    } catch (err: any) {
      alert(`Render failed: ${err.message}`);
    } finally { setRendering(false); }
  };

  // ── WebAudio Playback ──

  const getAudioContext = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  };

  const fetchAudioBuffer = async (assetId: string): Promise<AudioBuffer> => {
    const cached = audioBufferCache.current.get(assetId);
    if (cached) return cached;
    const ctx = getAudioContext();
    const res = await fetch(audioUrl(assetId));
    const arrayBuf = await res.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    audioBufferCache.current.set(assetId, audioBuf);
    return audioBuf;
  };

  const stopPlayback = useCallback(() => {
    scheduledSourcesRef.current.forEach((src) => { try { src.stop(); } catch {} });
    scheduledSourcesRef.current = [];
    cancelAnimationFrame(animFrameRef.current);
    setPlaying(false);
  }, []);

  const startPlayback = useCallback(async () => {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    stopPlayback();

    const allClips = tracks.flatMap((t) =>
      (t.muted ? [] : (t.clips || [])).map((c) => ({ ...c, trackGain: t.gain, trackType: t.type }))
    );
    const buffers = new Map<string, AudioBuffer>();
    await Promise.all(allClips.map(async (clip) => {
      try { buffers.set(clip.id, await fetchAudioBuffer(clip.audio_asset_id)); } catch {}
    }));

    const startTime = ctx.currentTime;
    const offsetSec = currentTimeMs / 1000;
    playStartRef.current = startTime;
    playOffsetRef.current = offsetSec;

    for (const clip of allClips) {
      const buf = buffers.get(clip.id);
      if (!buf) continue;
      const clipStartSec = clip.position_ms / 1000;
      const trimStartSec = (clip.trim_start_ms || 0) / 1000;
      const clipDuration = buf.duration - trimStartSec;
      if (clipStartSec + clipDuration < offsetSec) continue;

      const source = ctx.createBufferSource();
      source.buffer = buf;
      const gainNode = ctx.createGain();
      gainNode.gain.value = Math.pow(10, ((clip.gain || 0) + (clip.trackGain || 0)) / 20);
      if (clip.fade_in_ms > 0) {
        const fadeStart = Math.max(0, clipStartSec - offsetSec);
        gainNode.gain.setValueAtTime(0, startTime + fadeStart);
        gainNode.gain.linearRampToValueAtTime(gainNode.gain.value, startTime + fadeStart + clip.fade_in_ms / 1000);
      }
      source.connect(gainNode).connect(ctx.destination);
      const when = Math.max(0, clipStartSec - offsetSec);
      const offset = Math.max(0, offsetSec - clipStartSec) + trimStartSec;
      source.start(startTime + when, offset, clipDuration - Math.max(0, offsetSec - clipStartSec));
      scheduledSourcesRef.current.push(source);
    }

    setPlaying(true);
    const animate = () => {
      const elapsed = ctx.currentTime - playStartRef.current;
      const newTimeMs = (playOffsetRef.current + elapsed) * 1000;
      setCurrentTimeMs(newTimeMs);
      if (newTimeMs < totalDurationMs) animFrameRef.current = requestAnimationFrame(animate);
      else stopPlayback();
    };
    animFrameRef.current = requestAnimationFrame(animate);
  }, [tracks, currentTimeMs, totalDurationMs, stopPlayback]);

  const handlePlayPause = () => {
    if (playing) {
      const ctx = audioCtxRef.current;
      if (ctx) setCurrentTimeMs((playOffsetRef.current + ctx.currentTime - playStartRef.current) * 1000);
      stopPlayback();
    } else startPlayback();
  };

  const handleStop = () => { stopPlayback(); setCurrentTimeMs(0); };
  const handleRewind = () => { stopPlayback(); setCurrentTimeMs(0); };
  useEffect(() => () => { stopPlayback(); }, [stopPlayback]);

  // ── Track Actions ──

  const handleAddTrack = async (type: string) => {
    if (!bookId) return;
    const names: Record<string, string> = { narration: 'Narration', dialogue: 'Dialogue', sfx: 'SFX', music: 'Music', imported: 'Imported' };
    await timelineApi.createTrack(bookId, { name: names[type] || type, type, color: TRACK_COLORS[type] || '#888' });
    loadTracks();
  };

  const handleDeleteTrack = async (trackId: string) => {
    if (!bookId || !confirm('Delete this track and all its clips?')) return;
    await timelineApi.deleteTrack(bookId, trackId);
    loadTracks();
  };

  const handleTrackGain = async (trackId: string, gain: number) => {
    if (!bookId) return;
    setTracks((prev) => prev.map((t) => t.id === trackId ? { ...t, gain } : t));
    await timelineApi.updateTrack(bookId, trackId, { gain });
  };

  const handleTrackMute = async (trackId: string, muted: boolean) => {
    if (!bookId) return;
    setTracks((prev) => prev.map((t) => t.id === trackId ? { ...t, muted: muted ? 1 : 0 } : t));
    await timelineApi.updateTrack(bookId, trackId, { muted: muted ? 1 : 0 });
  };

  // ── Clip Actions ──

  const handleDeleteClip = async (clipId: string) => {
    if (!bookId) return;
    await timelineApi.deleteClip(bookId, clipId);
    if (selectedClipId === clipId) setSelectedClipId(null);
    loadTracks();
  };

  const handleSplitClip = async (clipId: string) => {
    if (!bookId) return;
    const found = findClipAndTrack(clipId);
    if (!found) return;
    const { clip, track } = found;
    const dur = getClipDurationMs(clip);
    const splitPoint = dur / 2;
    const trimStart = clip.trim_start_ms || 0;
    // Update original clip to end at split
    await timelineApi.updateClip(bookId, clip.id, { trim_end_ms: trimStart + splitPoint });
    // Create new clip starting at split
    await timelineApi.createClip(bookId, track.id, {
      audio_asset_id: clip.audio_asset_id,
      position_ms: clip.position_ms + splitPoint,
      trim_start_ms: trimStart + splitPoint,
      trim_end_ms: clip.trim_end_ms || 0,
      gain: clip.gain,
    });
    loadTracks();
  };

  const handleDuplicateClip = async (clipId: string) => {
    if (!bookId) return;
    const found = findClipAndTrack(clipId);
    if (!found) return;
    const { clip, track } = found;
    const dur = getClipDurationMs(clip);
    await timelineApi.createClip(bookId, track.id, {
      audio_asset_id: clip.audio_asset_id,
      position_ms: clip.position_ms + dur + 100,
      trim_start_ms: clip.trim_start_ms,
      trim_end_ms: clip.trim_end_ms,
      gain: clip.gain,
      fade_in_ms: clip.fade_in_ms,
      fade_out_ms: clip.fade_out_ms,
      notes: clip.notes,
    });
    loadTracks();
  };

  // ── Quick-Add SFX/Music ──

  const handleQuickAdd = async () => {
    if (!bookId || !quickAddPrompt.trim()) return;
    setQuickAddGenerating(true);
    try {
      const gen = quickAddType === 'sfx'
        ? await elevenlabs.sfx({ prompt: quickAddPrompt, book_id: bookId })
        : await elevenlabs.music({ prompt: quickAddPrompt, book_id: bookId });
      // Place on appropriate track
      let targetTrack = tracks.find((t) => t.type === quickAddType);
      if (!targetTrack) {
        await handleAddTrack(quickAddType);
        const refreshed = await timelineApi.tracks(bookId);
        targetTrack = refreshed.find((t: any) => t.type === quickAddType);
      }
      if (targetTrack) {
        await timelineApi.createClip(bookId, targetTrack.id, {
          audio_asset_id: gen.audio_asset_id,
          position_ms: currentTimeMs,
        });
      }
      setQuickAddPrompt('');
      setQuickAddOpen(false);
      loadTracks();
    } catch (err: any) { alert(`Generation failed: ${err.message}`); }
    finally { setQuickAddGenerating(false); }
  };

  // ── Canvas Drawing ──

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.parentElement?.getBoundingClientRect();
    const canvasWidth = (rect?.width || 800) - HEADER_WIDTH;
    const canvasHeight = RULER_HEIGHT + tracks.length * TRACK_HEIGHT;
    canvas.width = Math.max(canvasWidth, totalDurationMs * pxPerMs + 200);
    canvas.height = Math.max(canvasHeight, 200);

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Ruler
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, RULER_HEIGHT);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT);
    ctx.lineTo(canvas.width, RULER_HEIGHT);
    ctx.stroke();

    const stepMs = zoom > 2 ? 1000 : zoom > 0.5 ? 5000 : 10000;
    for (let ms = 0; ms <= totalDurationMs; ms += stepMs) {
      const x = ms * pxPerMs;
      ctx.strokeStyle = '#333';
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 8);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillStyle = '#666';
      ctx.font = '10px monospace';
      ctx.fillText(formatTime(ms), x + 2, RULER_HEIGHT - 12);
    }

    // Chapter markers
    for (const m of markers) {
      const x = m.position_ms * pxPerMs;
      ctx.strokeStyle = '#D97A4A44';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
      ctx.fillStyle = '#D97A4A';
      ctx.font = '9px sans-serif';
      ctx.fillText(m.label, x + 3, RULER_HEIGHT + 12);
    }

    // Tracks
    tracks.forEach((track, tIdx) => {
      const y = RULER_HEIGHT + tIdx * TRACK_HEIGHT;
      // Track background
      ctx.fillStyle = tIdx % 2 === 0 ? '#141414' : '#181818';
      ctx.fillRect(0, y, canvas.width, TRACK_HEIGHT);
      // Track separator
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK_HEIGHT);
      ctx.lineTo(canvas.width, y + TRACK_HEIGHT);
      ctx.stroke();

      // Clips
      const trackColor = TRACK_COLORS[track.type] || '#888';
      for (const clip of (track.clips || [])) {
        const clipX = clip.position_ms * pxPerMs;
        const clipW = Math.max(4, getClipDurationMs(clip) * pxPerMs);
        const clipY = y + 4;
        const clipH = TRACK_HEIGHT - 8;
        const isSelected = clip.id === selectedClipId;

        // Clip body
        ctx.fillStyle = isSelected ? trackColor : trackColor + '88';
        ctx.beginPath();
        ctx.roundRect(clipX, clipY, clipW, clipH, 4);
        ctx.fill();

        // Selection border
        if (isSelected) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(clipX, clipY, clipW, clipH, 4);
          ctx.stroke();
        }

        // Clip label
        if (clipW > 30) {
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          const icon = TRACK_ICONS[track.type] || '';
          const label = clip.notes || icon;
          ctx.save();
          ctx.beginPath();
          ctx.rect(clipX + 2, clipY, clipW - 4, clipH);
          ctx.clip();
          ctx.fillText(label, clipX + 6, clipY + 14);
          // Duration
          ctx.fillStyle = '#fff9';
          ctx.font = '9px monospace';
          ctx.fillText(formatDuration(getClipDurationMs(clip)), clipX + 6, clipY + clipH - 6);
          ctx.restore();
        }

        // Trim handles
        if (isSelected) {
          ctx.fillStyle = '#fff8';
          ctx.fillRect(clipX, clipY, 3, clipH);
          ctx.fillRect(clipX + clipW - 3, clipY, 3, clipH);
        }
      }
    });

    // Playhead
    const phX = currentTimeMs * pxPerMs;
    ctx.strokeStyle = '#e55';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, canvas.height);
    ctx.stroke();
    // Playhead triangle
    ctx.fillStyle = '#e55';
    ctx.beginPath();
    ctx.moveTo(phX - 6, 0);
    ctx.lineTo(phX + 6, 0);
    ctx.lineTo(phX, 10);
    ctx.closePath();
    ctx.fill();
  }, [tracks, markers, currentTimeMs, pxPerMs, totalDurationMs, selectedClipId, zoom]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  // ── Mouse Interaction ──

  const getTrackAndClipAtPos = (canvasX: number, canvasY: number) => {
    const tIdx = Math.floor((canvasY - RULER_HEIGHT) / TRACK_HEIGHT);
    if (tIdx < 0 || tIdx >= tracks.length) return null;
    const track = tracks[tIdx];
    const timeMs = canvasX / pxPerMs;
    for (const clip of (track.clips || [])) {
      const clipStart = clip.position_ms;
      const clipEnd = clipStart + getClipDurationMs(clip);
      if (timeMs >= clipStart && timeMs <= clipEnd) {
        const clipX = clip.position_ms * pxPerMs;
        const clipW = getClipDurationMs(clip) * pxPerMs;
        let edge: DragMode = 'move';
        if (canvasX - clipX < EDGE_GRAB_PX) edge = 'trim-left';
        else if (clipX + clipW - canvasX < EDGE_GRAB_PX) edge = 'trim-right';
        return { clip, track, edge };
      }
    }
    return null;
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);

    if (e.button === 2) return; // right-click handled separately

    // Click on ruler = seek
    if (y < RULER_HEIGHT) {
      const timeMs = Math.max(0, x / pxPerMs);
      setCurrentTimeMs(timeMs);
      if (playing) { stopPlayback(); }
      return;
    }

    const hit = getTrackAndClipAtPos(x, y);
    if (hit) {
      setSelectedClipId(hit.clip.id);
      setContextMenu(null);
      dragRef.current = {
        mode: hit.edge,
        clipId: hit.clip.id,
        trackId: hit.track.id,
        startMouseX: e.clientX,
        origPositionMs: hit.clip.position_ms,
        origTrimStartMs: hit.clip.trim_start_ms || 0,
        origTrimEndMs: hit.clip.trim_end_ms || getClipTotalMs(hit.clip),
      };
    } else {
      setSelectedClipId(null);
      setContextMenu(null);
      // Click on empty area = seek
      const timeMs = Math.max(0, x / pxPerMs);
      setCurrentTimeMs(timeMs);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);

    // Drag
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startMouseX;
      const deltaMs = dx / pxPerMs;
      const { mode, clipId } = dragRef.current;

      setTracks((prev) => prev.map((t) => ({
        ...t,
        clips: (t.clips || []).map((c) => {
          if (c.id !== clipId) return c;
          if (mode === 'move') {
            return { ...c, position_ms: Math.max(0, dragRef.current!.origPositionMs + deltaMs) };
          } else if (mode === 'trim-left') {
            const newTrim = Math.max(0, dragRef.current!.origTrimStartMs + deltaMs);
            return { ...c, trim_start_ms: newTrim, position_ms: dragRef.current!.origPositionMs + (newTrim - dragRef.current!.origTrimStartMs) };
          } else if (mode === 'trim-right') {
            const total = getClipTotalMs(c);
            const newTrim = Math.min(total, Math.max(MIN_CLIP_MS, dragRef.current!.origTrimEndMs + deltaMs));
            return { ...c, trim_end_ms: newTrim };
          }
          return c;
        }),
      })));
      return;
    }

    // Hover tooltip
    const hit = getTrackAndClipAtPos(x, y);
    if (hit) {
      setHoverInfo({ x: e.clientX, y: e.clientY, clip: hit.clip, track: hit.track });
      canvas.style.cursor = hit.edge === 'move' ? 'grab' : 'col-resize';
    } else {
      setHoverInfo(null);
      canvas.style.cursor = y < RULER_HEIGHT ? 'pointer' : 'default';
    }
  };

  const handleCanvasMouseUp = async () => {
    if (!dragRef.current || !bookId) { dragRef.current = null; return; }
    const { clipId } = dragRef.current;
    const found = findClipAndTrack(clipId);
    if (found) {
      await timelineApi.updateClip(bookId, clipId, {
        position_ms: Math.round(found.clip.position_ms),
        trim_start_ms: Math.round(found.clip.trim_start_ms || 0),
        trim_end_ms: Math.round(found.clip.trim_end_ms || 0),
      });
    }
    dragRef.current = null;
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);
    const hit = getTrackAndClipAtPos(x, y);
    if (hit) {
      setSelectedClipId(hit.clip.id);
      setContextMenu({ x: e.clientX, y: e.clientY, clip: hit.clip, track: hit.track });
    }
  };

  // ── Keyboard Shortcuts ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') { e.preventDefault(); handlePlayPause(); }
      if (e.code === 'Delete' && selectedClipId) { handleDeleteClip(selectedClipId); }
      if (e.code === 'KeyS' && selectedClipId) { handleSplitClip(selectedClipId); }
      if (e.code === 'KeyD' && selectedClipId) { handleDuplicateClip(selectedClipId); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // ── Inspector ──

  const handleClipGainChange = async (val: number) => {
    if (!bookId || !selectedClipId) return;
    setTracks((prev) => prev.map((t) => ({
      ...t, clips: (t.clips || []).map((c) => c.id === selectedClipId ? { ...c, gain: val } : c),
    })));
    await timelineApi.updateClip(bookId, selectedClipId, { gain: val });
  };

  const handleClipNotesChange = async (notes: string) => {
    if (!bookId || !selectedClipId) return;
    setTracks((prev) => prev.map((t) => ({
      ...t, clips: (t.clips || []).map((c) => c.id === selectedClipId ? { ...c, notes } : c),
    })));
    await timelineApi.updateClip(bookId, selectedClipId, { notes });
  };

  // ── Download dropdown state ──
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);

  return (
    <div ref={containerRef} style={S.container}>
      {/* Toolbar */}
      <div style={S.toolbar}>
        <div style={S.toolGroup}>
          <button onClick={handleRewind} style={S.toolBtn} title="Rewind"><SkipBack size={16} /></button>
          <button onClick={handlePlayPause} style={{ ...S.toolBtn, background: playing ? '#e55' : '#2d5a27' }} title="Play/Pause">
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button onClick={handleStop} style={S.toolBtn} title="Stop"><Square size={14} /></button>
          <span style={S.timeDisplay}>{formatTime(currentTimeMs)}</span>
        </div>

        <div style={S.toolGroup}>
          <label style={S.zoomLabel}>Zoom</label>
          <input type="range" min={0.1} max={5} step={0.1} value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))} style={{ width: 80, accentColor: '#4A90D9' }}
            aria-label="Timeline zoom" />
        </div>

        <div style={S.toolGroup}>
          <button onClick={() => setQuickAddOpen(!quickAddOpen)}
            style={{ ...S.toolBtn, background: quickAddOpen ? '#9B59B6' : '#333' }} title="Quick-add SFX/Music">
            <Wand2 size={14} />
          </button>
          {selectedClipId && (
            <>
              <button onClick={() => handleSplitClip(selectedClipId)} style={S.toolBtn} title="Split (S)"><Scissors size={14} /></button>
              <button onClick={() => handleDuplicateClip(selectedClipId)} style={S.toolBtn} title="Duplicate (D)"><Copy size={14} /></button>
              <button onClick={() => handleDeleteClip(selectedClipId)} style={S.toolBtn} title="Delete"><Trash2 size={14} /></button>
            </>
          )}
        </div>

        <div style={S.toolGroup}>
          <button onClick={handleSave} disabled={saving} style={{ ...S.toolBtn, background: saveMsg ? '#2d5a27' : '#333' }} title="Save progress">
            <Save size={14} /> {saveMsg || (saving ? '...' : '')}
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowDownloadMenu(!showDownloadMenu)} style={S.toolBtn} title="Download">
              <Download size={14} /> <ChevronDown size={10} />
            </button>
            {showDownloadMenu && (
              <div style={S.dropdown}>
                <button onClick={() => { handleDownloadProject(); setShowDownloadMenu(false); }} style={S.dropItem}>
                  📦 Download Project (ZIP)
                </button>
                <button onClick={() => { handleRenderAndDownload(); setShowDownloadMenu(false); }} disabled={rendering} style={S.dropItem}>
                  🎧 {rendering ? 'Rendering...' : 'Render & Download'}
                </button>
              </div>
            )}
          </div>
          <button onClick={() => setShowHelp(!showHelp)} style={{ ...S.toolBtn, background: showHelp ? '#4A90D9' : '#333' }} title="Help">
            <HelpCircle size={14} />
          </button>
        </div>
      </div>

      {/* Help overlay */}
      {showHelp && (
        <div style={S.helpOverlay}>
          <div style={S.helpContent}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#4A90D9', fontWeight: 600 }}>Keyboard Shortcuts</span>
              <button onClick={() => setShowHelp(false)} style={S.toolBtn}><X size={14} /></button>
            </div>
            <div style={S.helpGrid}>
              <span>Space</span><span>Play / Pause</span>
              <span>Delete</span><span>Delete selected clip</span>
              <span>S</span><span>Split clip at midpoint</span>
              <span>D</span><span>Duplicate clip</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
              <p>Click ruler to seek · Drag clips to move · Drag edges to trim</p>
              <p>Right-click clip for context menu</p>
            </div>
            <div style={{ marginTop: 8, fontSize: 11 }}>
              <span style={{ color: '#666' }}>Track colors: </span>
              {Object.entries(TRACK_COLORS).map(([k, v]) => (
                <span key={k} style={{ color: v, marginRight: 8 }}>{TRACK_ICONS[k]} {k}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Quick-add panel */}
      {quickAddOpen && (
        <div style={S.quickAddPanel}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button onClick={() => setQuickAddType('sfx')}
              style={{ ...S.tabBtn, background: quickAddType === 'sfx' ? '#2d5a27' : '#222' }}>🔊 SFX</button>
            <button onClick={() => setQuickAddType('music')}
              style={{ ...S.tabBtn, background: quickAddType === 'music' ? '#2a1a3a' : '#222' }}>🎵 Music</button>
          </div>
          <input value={quickAddPrompt} onChange={(e) => setQuickAddPrompt(e.target.value)}
            placeholder={quickAddType === 'sfx' ? 'Describe sound effect...' : 'Describe music...'}
            style={S.quickInput} onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()}
            aria-label="Quick add prompt" />
          <button onClick={handleQuickAdd} disabled={quickAddGenerating || !quickAddPrompt.trim()} style={S.quickGenBtn}>
            {quickAddGenerating ? <Loader size={12} /> : <Wand2 size={12} />}
            {quickAddGenerating ? 'Generating...' : `Add ${quickAddType.toUpperCase()} at playhead`}
          </button>
        </div>
      )}

      <div style={S.body}>
        {/* Track headers */}
        <div style={S.headers}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', padding: '0 8px' }}>
            <select onChange={(e) => e.target.value && handleAddTrack(e.target.value)} value="" style={S.addTrackSelect}
              aria-label="Add track">
              <option value="">+ Add Track</option>
              <option value="narration">🎙️ Narration</option>
              <option value="dialogue">💬 Dialogue</option>
              <option value="sfx">🔊 SFX</option>
              <option value="music">🎵 Music</option>
              <option value="imported">📁 Imported</option>
            </select>
          </div>
          {tracks.map((track) => (
            <div key={track.id} style={{ ...S.trackHeader, borderLeft: `3px solid ${TRACK_COLORS[track.type] || '#888'}` }}>
              <div style={S.trackHeaderTop}>
                <span style={{ fontSize: 12, color: '#ddd' }}>{TRACK_ICONS[track.type]} {track.name}</span>
                <button onClick={() => handleDeleteTrack(track.id)} style={S.tinyBtn} title="Delete track"><Trash2 size={10} /></button>
              </div>
              <div style={S.trackControls}>
                <button onClick={() => handleTrackMute(track.id, !track.muted)}
                  style={{ ...S.tinyBtn, color: track.muted ? '#e55' : '#8f8' }} title="Mute/Unmute">
                  {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                </button>
                <input type="range" min={-20} max={6} step={0.5} value={track.gain}
                  onChange={(e) => handleTrackGain(track.id, parseFloat(e.target.value))}
                  style={{ width: 70, accentColor: TRACK_COLORS[track.type] || '#888' }}
                  title={`Gain: ${track.gain}dB`} aria-label={`${track.name} gain`} />
                <span style={{ fontSize: 9, color: '#666', minWidth: 28 }}>{track.gain > 0 ? '+' : ''}{track.gain}dB</span>
              </div>
            </div>
          ))}
        </div>

        {/* Canvas area */}
        <div ref={scrollRef} style={S.canvasScroll}>
          <canvas ref={canvasRef}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={() => { handleCanvasMouseUp(); setHoverInfo(null); }}
            onContextMenu={handleContextMenu}
          />
        </div>
      </div>

      {/* Hover tooltip */}
      {hoverInfo && !dragRef.current && (
        <div style={{ ...S.tooltip, left: hoverInfo.x + 12, top: hoverInfo.y - 40 }}>
          <span>{TRACK_ICONS[hoverInfo.track.type]} {hoverInfo.track.name}</span>
          <span>Pos: {formatTime(hoverInfo.clip.position_ms)} · Dur: {formatDuration(getClipDurationMs(hoverInfo.clip))}</span>
          {hoverInfo.clip.notes && <span>"{hoverInfo.clip.notes}"</span>}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <>
          <div style={S.overlay} onClick={() => setContextMenu(null)} />
          <div style={{ ...S.ctxMenu, left: contextMenu.x, top: contextMenu.y }}>
            <button onClick={() => { handleSplitClip(contextMenu.clip.id); setContextMenu(null); }} style={S.ctxItem}>
              <Scissors size={12} /> Split
            </button>
            <button onClick={() => { handleDuplicateClip(contextMenu.clip.id); setContextMenu(null); }} style={S.ctxItem}>
              <Copy size={12} /> Duplicate
            </button>
            <button onClick={() => { handleDeleteClip(contextMenu.clip.id); setContextMenu(null); }} style={{ ...S.ctxItem, color: '#e55' }}>
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </>
      )}

      {/* Inspector */}
      {selectedClip && (
        <div style={S.inspector}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#4A90D9', fontSize: 12, fontWeight: 500 }}>Clip Inspector</span>
            <button onClick={() => setSelectedClipId(null)} style={S.tinyBtn}><X size={12} /></button>
          </div>
          <div style={S.inspRow}>
            <label style={S.inspLabel}>Position</label>
            <span style={S.inspVal}>{formatTime(selectedClip.position_ms)}</span>
          </div>
          <div style={S.inspRow}>
            <label style={S.inspLabel}>Duration</label>
            <span style={S.inspVal}>{formatDuration(getClipDurationMs(selectedClip))}</span>
          </div>
          <div style={S.inspRow}>
            <label style={S.inspLabel}>Gain (dB)</label>
            <input type="range" min={-20} max={12} step={0.5} value={selectedClip.gain || 0}
              onChange={(e) => handleClipGainChange(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: '#4A90D9' }} aria-label="Clip gain" />
            <span style={S.inspVal}>{(selectedClip.gain || 0) > 0 ? '+' : ''}{selectedClip.gain || 0}</span>
          </div>
          <div style={S.inspRow}>
            <label style={S.inspLabel}>Notes</label>
            <input value={selectedClip.notes || ''} onChange={(e) => handleClipNotesChange(e.target.value)}
              style={S.inspInput} placeholder="Clip label..." aria-label="Clip notes" />
          </div>
        </div>
      )}

      {/* Empty state */}
      {tracks.length === 0 && (
        <div style={S.emptyState}>
          <Music size={32} color="#333" />
          <p style={{ color: '#666', fontSize: 14 }}>No tracks yet</p>
          <p style={{ color: '#555', fontSize: 12 }}>Go to Manuscript → generate audio → Send to Timeline, or add tracks manually above.</p>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)', background: '#111', position: 'relative' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid #222', background: '#1a1a1a', gap: 8, flexWrap: 'wrap' },
  toolGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  toolBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px',
    background: '#333', color: '#ddd', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 12,
  },
  tinyBtn: { background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 2 },
  timeDisplay: { fontFamily: 'monospace', fontSize: 14, color: '#4A90D9', minWidth: 70 },
  zoomLabel: { fontSize: 11, color: '#666' },

  dropdown: {
    position: 'absolute', top: '100%', right: 0, zIndex: 30,
    background: '#222', border: '1px solid #333', borderRadius: 8, padding: 4,
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  },
  dropItem: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
    background: 'transparent', color: '#ddd', border: 'none', borderRadius: 4,
    cursor: 'pointer', fontSize: 12, textAlign: 'left',
  },

  helpOverlay: { position: 'absolute', top: 48, right: 12, zIndex: 20 },
  helpContent: { background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 14, maxWidth: 320, fontSize: 12, color: '#aaa' },
  helpGrid: { display: 'grid', gridTemplateColumns: '60px 1fr', gap: '4px 12px', marginTop: 8, fontSize: 11 },

  quickAddPanel: { padding: '8px 12px', background: '#1a1a1a', borderBottom: '1px solid #222' },
  tabBtn: { padding: '4px 12px', color: '#ddd', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11 },
  quickInput: {
    width: '100%', padding: '6px 10px', background: '#0f0f0f', color: '#ddd', border: '1px solid #333',
    borderRadius: 6, fontSize: 12, outline: 'none', marginBottom: 6, boxSizing: 'border-box',
  },
  quickGenBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },

  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  headers: { width: HEADER_WIDTH, flexShrink: 0, background: '#1a1a1a', borderRight: '1px solid #222', overflow: 'auto' },
  trackHeader: { height: TRACK_HEIGHT, borderBottom: '1px solid #222', padding: '6px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' },
  trackHeaderTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  trackControls: { display: 'flex', alignItems: 'center', gap: 4 },
  addTrackSelect: { background: '#222', color: '#888', border: '1px solid #333', borderRadius: 4, fontSize: 11, padding: '2px 4px', outline: 'none' },

  canvasScroll: { flex: 1, overflow: 'auto' },

  tooltip: {
    position: 'fixed', zIndex: 25, background: '#222', border: '1px solid #444', borderRadius: 6,
    padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: '#ccc',
    pointerEvents: 'none',
  },

  overlay: { position: 'fixed', inset: 0, zIndex: 15 },
  ctxMenu: {
    position: 'fixed', zIndex: 20, background: '#222', border: '1px solid #333', borderRadius: 8,
    padding: 4, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 120, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  },
  ctxItem: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
    background: 'transparent', color: '#ddd', border: 'none', borderRadius: 4,
    cursor: 'pointer', fontSize: 11, textAlign: 'left',
  },

  inspector: {
    position: 'absolute', bottom: 12, right: 12, width: 240, background: '#1a1a1a',
    border: '1px solid #333', borderRadius: 10, padding: 12, zIndex: 10,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  inspRow: { display: 'flex', alignItems: 'center', gap: 6 },
  inspLabel: { fontSize: 10, color: '#666', minWidth: 50 },
  inspVal: { fontSize: 11, color: '#aaa', fontFamily: 'monospace' },
  inspInput: {
    flex: 1, padding: '3px 6px', background: '#0f0f0f', color: '#ddd', border: '1px solid #333',
    borderRadius: 4, fontSize: 11, outline: 'none',
  },

  emptyState: {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center',
  },
};
