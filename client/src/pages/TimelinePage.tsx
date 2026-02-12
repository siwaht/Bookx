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
