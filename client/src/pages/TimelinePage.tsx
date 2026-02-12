import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl } from '../services/api';
import type { Track, Clip, ChapterMarker } from '../types';
import {
  Play, Pause, Square, Volume2, VolumeX, SkipBack, Trash2,
  Scissors, Copy, Wand2, Music, Loader, X,
} from 'lucide-react';

const TRACK_HEIGHT = 72;
const RULER_HEIGHT = 28;
const HEADER_WIDTH = 200;
const DEFAULT_PX_PER_MS = 0.05;
const EDGE_GRAB_PX = 8;
const MIN_CLIP_MS = 50;

type DragMode = 'move' | 'trim-left' | 'trim-right' | null;

interface ContextMenu {
  x: number;
  y: number;
  clip: Clip;
  track: Track;
}

export function TimelinePage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [markers, setMarkers] = useState<ChapterMarker[]>([]);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  // Quick-add panel
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddType, setQuickAddType] = useState<'sfx' | 'music'>('sfx');
  const [quickAddPrompt, setQuickAddPrompt] = useState('');
  const [quickAddGenerating, setQuickAddGenerating] = useState(false);

  // Drag state
  const dragRef = useRef<{
    mode: DragMode;
    clipId: string;
    trackId: string;
    startMouseX: number;
    origPositionMs: number;
    origTrimStartMs: number;
    origTrimEndMs: number;
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
    } catch (err) {
      console.error('Failed to load timeline:', err);
    }
  }, [bookId]);

  useEffect(() => { loadTracks(); }, [loadTracks]);

  const totalDurationMs = Math.max(
    60000,
    ...tracks.flatMap((t) => (t.clips || []).map((c) => c.position_ms + getClipDurationMs(c) + 5000)),
    ...markers.map((m) => m.position_ms + 5000),
  );

  // ── WebAudio Playback (preserved from original) ──

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
    scheduledSourcesRef.current.forEach((src) => {
      try { src.stop(); } catch { /* already stopped */ }
    });
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
    await Promise.all(
      allClips.map(async (clip) => {
        try {
          const buf = await fetchAudioBuffer(clip.audio_asset_id);
          buffers.set(clip.id, buf);
        } catch { /* skip */ }
      })
    );

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
      const clipGainDb = (clip.gain || 0) + (clip.trackGain || 0);
      gainNode.gain.value = Math.pow(10, clipGainDb / 20);

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
      if (newTimeMs < totalDurationMs) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        stopPlayback();
      }
    };
    animFrameRef.current = requestAnimationFrame(animate);
  }, [tracks, currentTimeMs, totalDurationMs, stopPlayback]);

  const handlePlayPause = () => {
    if (playing) {
      const ctx = audioCtxRef.current;
      if (ctx) {
        const elapsed = ctx.currentTime - playStartRef.current;
        setCurrentTimeMs((playOffsetRef.current + elapsed) * 1000);
      }
      stopPlayback();
    } else {
      startPlayback();
    }
  };

  const handleStop = () => { stopPlayback(); setCurrentTimeMs(0); };
  const handleRewind = () => { stopPlayback(); setCurrentTimeMs(0); };

  useEffect(() => { return () => { stopPlayback(); }; }, [stopPlayback]);

  // ── Track Actions ──

  const addTrack = async (type: string) => {
    if (!bookId) return;
    const name = type.charAt(0).toUpperCase() + type.slice(1);
    await timelineApi.createTrack(bookId, { name, type });
    loadTracks();
  };

  const toggleMute = async (track: Track) => {
    if (!bookId) return;
    await timelineApi.updateTrack(bookId, track.id, { muted: track.muted ? 0 : 1 });
    loadTracks();
  };

  const toggleSolo = async (track: Track) => {
    if (!bookId) return;
    await timelineApi.updateTrack(bookId, track.id, { solo: track.solo ? 0 : 1 });
    loadTracks();
  };

  const handleTrackGain = async (track: Track, gain: number) => {
    if (!bookId) return;
    await timelineApi.updateTrack(bookId, track.id, { gain });
    loadTracks();
  };

  const handleDeleteTrack = async (track: Track) => {
    if (!bookId) return;
    if (!confirm(`Delete track "${track.name}" and all its clips?`)) return;
    await timelineApi.deleteTrack(bookId, track.id);
    loadTracks();
  };

  // ── Clip Actions ──

  const handleDeleteClip = async (clipId: string) => {
    if (!bookId) return;
    await timelineApi.deleteClip(bookId, clipId);
    if (selectedClipId === clipId) setSelectedClipId(null);
    loadTracks();
  };

  const handleUpdateClip = async (clipId: string, data: Partial<Clip>) => {
    if (!bookId) return;
    await timelineApi.updateClip(bookId, clipId, data);
    loadTracks();
  };

  const handleSplitAtPlayhead = async (clipId: string) => {
    if (!bookId) return;
    const found = findClipAndTrack(clipId);
    if (!found) return;
    const { clip, track } = found;
    const clipDur = getClipDurationMs(clip);
    const trimStart = clip.trim_start_ms || 0;
    const splitTimeMs = currentTimeMs - clip.position_ms;

    if (splitTimeMs <= MIN_CLIP_MS || splitTimeMs >= clipDur - MIN_CLIP_MS) return;

    // Update original clip: trim its end
    await timelineApi.updateClip(bookId, clip.id, {
      trim_end_ms: trimStart + splitTimeMs,
    });

    // Create new clip for the right half
    await timelineApi.createClip(bookId, track.id, {
      audio_asset_id: clip.audio_asset_id,
      position_ms: clip.position_ms + splitTimeMs,
      trim_start_ms: trimStart + splitTimeMs,
      trim_end_ms: clip.trim_end_ms || getClipTotalMs(clip),
      gain: clip.gain,
      fade_in_ms: 0,
      fade_out_ms: clip.fade_out_ms,
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
    });
    loadTracks();
  };

  // ── Quick-Add (inline SFX/Music generation) ──

  const handleQuickAdd = async () => {
    if (!bookId || !quickAddPrompt.trim()) return;
    setQuickAddGenerating(true);
    try {
      const result = quickAddType === 'sfx'
        ? await elevenlabs.sfx({ prompt: quickAddPrompt, book_id: bookId })
        : await elevenlabs.music({ prompt: quickAddPrompt, music_length_ms: 30000, force_instrumental: true, book_id: bookId });

      // Find or create the right track
      let targetTrack: any = tracks.find((t) => t.type === quickAddType);
      if (!targetTrack) {
        targetTrack = await timelineApi.createTrack(bookId, {
          name: quickAddType === 'sfx' ? 'Sound Effects' : 'Music',
          type: quickAddType,
        });
      }

      // Place at playhead
      await timelineApi.createClip(bookId, targetTrack.id, {
        audio_asset_id: result.audio_asset_id,
        position_ms: Math.round(currentTimeMs),
      });

      setQuickAddPrompt('');
      setQuickAddOpen(false);
      loadTracks();
    } catch (err: any) {
      alert(`Generation failed: ${err.message}`);
    } finally {
      setQuickAddGenerating(false);
    }
  };

  // ── Canvas Drawing ──

  const drawTimeline = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, width, height);

    // Time ruler
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    const secPerTick = zoom < 0.5 ? 10 : zoom < 1 ? 5 : zoom < 2 ? 2 : 1;
    const totalSec = totalDurationMs / 1000;
    for (let t = 0; t <= totalSec; t += secPerTick) {
      const x = t * 1000 * pxPerMs;
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.font = '10px monospace';
      const mins = Math.floor(t / 60);
      const secs = Math.floor(t % 60);
      ctx.fillText(`${mins}:${String(secs).padStart(2, '0')}`, x + 3, 18);
    }

    // Chapter markers
    for (const marker of markers) {
      const x = marker.position_ms * pxPerMs;
      ctx.strokeStyle = '#D4A843';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#D4A843';
      ctx.font = '10px sans-serif';
      ctx.fillText(marker.label, x + 4, 12);
    }

    // Tracks and clips
    tracks.forEach((track, i) => {
      const y = RULER_HEIGHT + i * TRACK_HEIGHT;
      ctx.fillStyle = i % 2 === 0 ? '#121212' : '#161616';
      ctx.fillRect(0, y, width, TRACK_HEIGHT);
      ctx.strokeStyle = '#1e1e1e';
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK_HEIGHT);
      ctx.lineTo(width, y + TRACK_HEIGHT);
      ctx.stroke();

      for (const clip of track.clips || []) {
        const clipX = clip.position_ms * pxPerMs;
        const durationMs = getClipDurationMs(clip);
        const clipWidth = Math.max(4, durationMs * pxPerMs);
        const isSelected = selectedClipId === clip.id;
        const baseColor = track.color || '#4A90D9';

        // Clip body
        ctx.fillStyle = track.muted ? '#1a1a1a' : baseColor;
        ctx.globalAlpha = track.muted ? 0.2 : 0.6;
        ctx.fillRect(clipX, y + 4, clipWidth, TRACK_HEIGHT - 8);
        ctx.globalAlpha = 1;

        // Waveform bars
        if (!track.muted) {
          ctx.fillStyle = baseColor;
          ctx.globalAlpha = 0.4;
          const barCount = Math.max(2, Math.floor(clipWidth / 3));
          for (let b = 0; b < barCount; b++) {
            const bx = clipX + (b / barCount) * clipWidth;
            const bh = (Math.sin(b * 0.7 + clip.position_ms * 0.001) * 0.3 + 0.5) * (TRACK_HEIGHT - 16);
            const by = y + 4 + (TRACK_HEIGHT - 8 - bh) / 2;
            ctx.fillRect(bx, by, 2, bh);
          }
          ctx.globalAlpha = 1;
        }

        // Selection highlight
        if (isSelected) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(clipX, y + 4, clipWidth, TRACK_HEIGHT - 8);
        }

        // Trim edge handles (visible on hover/selected)
        if (isSelected) {
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.fillRect(clipX, y + 4, EDGE_GRAB_PX, TRACK_HEIGHT - 8);
          ctx.fillRect(clipX + clipWidth - EDGE_GRAB_PX, y + 4, EDGE_GRAB_PX, TRACK_HEIGHT - 8);
        }

        // Fade indicators
        if (clip.fade_in_ms > 0) {
          const fadeW = clip.fade_in_ms * pxPerMs;
          ctx.fillStyle = 'rgba(255,255,255,0.1)';
          ctx.beginPath();
          ctx.moveTo(clipX, y + TRACK_HEIGHT - 4);
          ctx.lineTo(clipX + fadeW, y + 4);
          ctx.lineTo(clipX, y + 4);
          ctx.fill();
        }
        if (clip.fade_out_ms > 0) {
          const fadeW = clip.fade_out_ms * pxPerMs;
          ctx.fillStyle = 'rgba(255,255,255,0.1)';
          ctx.beginPath();
          ctx.moveTo(clipX + clipWidth, y + TRACK_HEIGHT - 4);
          ctx.lineTo(clipX + clipWidth - fadeW, y + 4);
          ctx.lineTo(clipX + clipWidth, y + 4);
          ctx.fill();
        }
      }
    });

    // Playhead
    const playheadX = currentTimeMs * pxPerMs;
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(playheadX - 6, 0);
    ctx.lineTo(playheadX + 6, 0);
    ctx.lineTo(playheadX, 8);
    ctx.fill();
  }, [tracks, markers, currentTimeMs, zoom, pxPerMs, totalDurationMs, selectedClipId, getClipDurationMs]);

  useEffect(() => { drawTimeline(); }, [drawTimeline]);

  // Resize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = Math.max(parent.clientWidth, totalDurationMs * pxPerMs + 200);
      canvas.height = Math.max(200, RULER_HEIGHT + tracks.length * TRACK_HEIGHT);
      drawTimeline();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [tracks.length, drawTimeline, totalDurationMs, pxPerMs]);

  // ── Mouse Interaction: Click, Drag, Context Menu ──

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scrollLeft = scrollRef.current?.scrollLeft || 0;
    const scrollTop = scrollRef.current?.scrollTop || 0;
    return {
      x: e.clientX - rect.left + scrollLeft,
      y: e.clientY - rect.top + scrollTop,
    };
  };

  const hitTestClip = (canvasX: number, canvasY: number): { clip: Clip; track: Track; edge: 'left' | 'right' | 'body' } | null => {
    const trackIndex = Math.floor((canvasY - RULER_HEIGHT) / TRACK_HEIGHT);
    if (trackIndex < 0 || trackIndex >= tracks.length) return null;
    const track = tracks[trackIndex];
    for (const clip of (track.clips || []).slice().reverse()) {
      const clipX = clip.position_ms * pxPerMs;
      const clipW = getClipDurationMs(clip) * pxPerMs;
      if (canvasX >= clipX && canvasX <= clipX + clipW) {
        const edge = canvasX < clipX + EDGE_GRAB_PX ? 'left'
          : canvasX > clipX + clipW - EDGE_GRAB_PX ? 'right'
          : 'body';
        return { clip, track, edge };
      }
    }
    return null;
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return; // right-click handled by context menu
    setContextMenu(null);
    const { x, y } = getCanvasCoords(e);
    const hit = hitTestClip(x, y);

    if (hit) {
      setSelectedClipId(hit.clip.id);
      const mode: DragMode = hit.edge === 'left' ? 'trim-left' : hit.edge === 'right' ? 'trim-right' : 'move';
      dragRef.current = {
        mode,
        clipId: hit.clip.id,
        trackId: hit.track.id,
        startMouseX: x,
        origPositionMs: hit.clip.position_ms,
        origTrimStartMs: hit.clip.trim_start_ms || 0,
        origTrimEndMs: hit.clip.trim_end_ms || getClipTotalMs(hit.clip),
      };
    } else {
      setSelectedClipId(null);
      if (!playing) {
        const clickTimeMs = Math.max(0, x / pxPerMs);
        setCurrentTimeMs(clickTimeMs);
      }
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = getCanvasCoords(e);

    // Update cursor
    const hit = hitTestClip(x, y);
    if (dragRef.current) {
      canvas.style.cursor = dragRef.current.mode === 'move' ? 'grabbing' : 'col-resize';
    } else if (hit) {
      canvas.style.cursor = hit.edge === 'body' ? 'grab' : 'col-resize';
    } else {
      canvas.style.cursor = 'crosshair';
    }

    if (!dragRef.current) return;
    const drag = dragRef.current;
    const deltaX = x - drag.startMouseX;
    const deltaMs = deltaX / pxPerMs;

    if (drag.mode === 'move') {
      const newPos = Math.max(0, Math.round(drag.origPositionMs + deltaMs));
      // Optimistic local update for smooth dragging
      setTracks((prev) => prev.map((t) => ({
        ...t,
        clips: (t.clips || []).map((c) =>
          c.id === drag.clipId ? { ...c, position_ms: newPos } : c
        ),
      })));
    } else if (drag.mode === 'trim-left') {
      const newTrimStart = Math.max(0, Math.round(drag.origTrimStartMs + deltaMs));
      const newPosition = Math.max(0, Math.round(drag.origPositionMs + deltaMs));
      if (newTrimStart < drag.origTrimEndMs - MIN_CLIP_MS) {
        setTracks((prev) => prev.map((t) => ({
          ...t,
          clips: (t.clips || []).map((c) =>
            c.id === drag.clipId ? { ...c, trim_start_ms: newTrimStart, position_ms: newPosition } : c
          ),
        })));
      }
    } else if (drag.mode === 'trim-right') {
      const totalMs = getClipTotalMs({ audio_asset_id: '' } as Clip); // fallback
      const found = findClipAndTrack(drag.clipId);
      const maxEnd = found ? getClipTotalMs(found.clip) : drag.origTrimEndMs;
      const newTrimEnd = Math.min(maxEnd, Math.max(drag.origTrimStartMs + MIN_CLIP_MS, Math.round(drag.origTrimEndMs + deltaMs)));
      setTracks((prev) => prev.map((t) => ({
        ...t,
        clips: (t.clips || []).map((c) =>
          c.id === drag.clipId ? { ...c, trim_end_ms: newTrimEnd } : c
        ),
      })));
    }
  };

  const handleCanvasMouseUp = async () => {
    if (!dragRef.current || !bookId) {
      dragRef.current = null;
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;

    // Find the updated clip from local state
    const found = findClipAndTrack(drag.clipId);
    if (!found) return;
    const { clip } = found;

    try {
      if (drag.mode === 'move') {
        await timelineApi.updateClip(bookId, clip.id, { position_ms: clip.position_ms });
      } else if (drag.mode === 'trim-left') {
        await timelineApi.updateClip(bookId, clip.id, {
          trim_start_ms: clip.trim_start_ms,
          position_ms: clip.position_ms,
        });
      } else if (drag.mode === 'trim-right') {
        await timelineApi.updateClip(bookId, clip.id, { trim_end_ms: clip.trim_end_ms });
      }
    } catch (err) {
      console.error('Failed to update clip:', err);
      loadTracks(); // revert on error
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);
    const hit = hitTestClip(x, y);
    if (hit) {
      setSelectedClipId(hit.clip.id);
      setContextMenu({ x: e.clientX, y: e.clientY, clip: hit.clip, track: hit.track });
    } else {
      setContextMenu(null);
    }
  };

  // ── Keyboard Shortcuts ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (selectedClipId) {
          e.preventDefault();
          handleDeleteClip(selectedClipId);
        }
      } else if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
        if (selectedClipId) {
          e.preventDefault();
          handleSplitAtPlayhead(selectedClipId);
        }
      } else if (e.code === 'KeyD' && !e.ctrlKey && !e.metaKey) {
        if (selectedClipId) {
          e.preventDefault();
          handleDuplicateClip(selectedClipId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // ── Inspector: Editable Clip Properties ──

  const renderInspector = () => {
    if (!selectedClip || !bookId) return null;
    return (
      <div style={S.inspector}>
        <div style={S.inspectorTitle}>
          <span>Clip Properties</span>
          <button onClick={() => handleDeleteClip(selectedClip.id)} style={S.inspectorDeleteBtn}
            title="Delete clip" aria-label="Delete clip">
            <Trash2 size={13} />
          </button>
        </div>
        <div style={S.inspectorGrid}>
          <label style={S.inspLabel}>Position (ms)</label>
          <input type="number" value={selectedClip.position_ms} style={S.inspInput}
            onChange={(e) => handleUpdateClip(selectedClip.id, { position_ms: Math.max(0, parseInt(e.target.value) || 0) })}
            aria-label="Clip position in milliseconds" />

          <label style={S.inspLabel}>Gain (dB)</label>
          <input type="number" step={0.5} value={selectedClip.gain} style={S.inspInput}
            onChange={(e) => handleUpdateClip(selectedClip.id, { gain: parseFloat(e.target.value) || 0 })}
            aria-label="Clip gain in decibels" />

          <label style={S.inspLabel}>Fade In (ms)</label>
          <input type="number" step={50} min={0} value={selectedClip.fade_in_ms} style={S.inspInput}
            onChange={(e) => handleUpdateClip(selectedClip.id, { fade_in_ms: Math.max(0, parseInt(e.target.value) || 0) })}
            aria-label="Fade in duration" />

          <label style={S.inspLabel}>Fade Out (ms)</label>
          <input type="number" step={50} min={0} value={selectedClip.fade_out_ms} style={S.inspInput}
            onChange={(e) => handleUpdateClip(selectedClip.id, { fade_out_ms: Math.max(0, parseInt(e.target.value) || 0) })}
            aria-label="Fade out duration" />

          <label style={S.inspLabel}>Trim Start</label>
          <input type="number" step={100} min={0} value={selectedClip.trim_start_ms || 0} style={S.inspInput}
            onChange={(e) => handleUpdateClip(selectedClip.id, { trim_start_ms: Math.max(0, parseInt(e.target.value) || 0) })}
            aria-label="Trim start" />

          <label style={S.inspLabel}>Trim End</label>
          <input type="number" step={100} min={0} value={selectedClip.trim_end_ms || 0} style={S.inspInput}
            onChange={(e) => handleUpdateClip(selectedClip.id, { trim_end_ms: Math.max(0, parseInt(e.target.value) || 0) })}
            aria-label="Trim end" />
        </div>
        <div style={S.inspectorActions}>
          <button onClick={() => handleSplitAtPlayhead(selectedClip.id)} style={S.inspActionBtn} title="Split at playhead (S)">
            <Scissors size={12} /> Split
          </button>
          <button onClick={() => handleDuplicateClip(selectedClip.id)} style={S.inspActionBtn} title="Duplicate (D)">
            <Copy size={12} /> Duplicate
          </button>
        </div>
      </div>
    );
  };

  const totalClips = tracks.reduce((sum, t) => sum + (t.clips?.length || 0), 0);

  // ── Render ──

  return (
    <div ref={containerRef} style={S.container} tabIndex={0}>
      {/* Toolbar */}
      <div style={S.toolbar}>
        <div style={S.transportGroup}>
          <button onClick={handleRewind} style={S.transportBtn} aria-label="Rewind" title="Rewind">
            <SkipBack size={16} />
          </button>
          <button onClick={handlePlayPause}
            style={{ ...S.transportBtn, background: playing ? '#c44' : '#4A90D9' }}
            aria-label={playing ? 'Pause' : 'Play'} title="Play/Pause (Space)">
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button onClick={handleStop} style={S.transportBtn} aria-label="Stop" title="Stop">
            <Square size={16} />
          </button>
        </div>
        <span style={S.timeDisplay}>{formatTime(currentTimeMs)}</span>
        <span style={S.infoText}>{tracks.length} tracks · {totalClips} clips</span>
        <div style={S.zoomControl}>
          <span style={{ fontSize: 11, color: '#666' }}>Zoom</span>
          <input type="range" min="0.1" max="4" step="0.1" value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))} style={{ width: 80 }}
            aria-label="Timeline zoom" />
          <span style={{ fontSize: 11, color: '#666' }}>{zoom.toFixed(1)}x</span>
        </div>

        {/* Quick-Add toggle */}
        <button onClick={() => setQuickAddOpen(!quickAddOpen)}
          style={{ ...S.quickAddToggle, borderColor: quickAddOpen ? '#4A90D9' : '#333' }}
          title="Quick-add SFX or Music at playhead">
          <Wand2 size={14} /> Quick Add
        </button>

        <div style={S.addTrackGroup}>
          <button onClick={() => addTrack('narration')} style={S.addTrackBtn}>+ Narration</button>
          <button onClick={() => addTrack('dialogue')} style={S.addTrackBtn}>+ Dialogue</button>
          <button onClick={() => addTrack('sfx')} style={S.addTrackBtn}>+ SFX</button>
          <button onClick={() => addTrack('music')} style={S.addTrackBtn}>+ Music</button>
        </div>
      </div>

      {/* Quick-Add Panel */}
      {quickAddOpen && (
        <div style={S.quickAddPanel}>
          <div style={S.quickAddTabs}>
            <button onClick={() => setQuickAddType('sfx')}
              style={{ ...S.quickAddTab, ...(quickAddType === 'sfx' ? S.quickAddTabActive : {}) }}>
              <Wand2 size={12} /> SFX
            </button>
            <button onClick={() => setQuickAddType('music')}
              style={{ ...S.quickAddTab, ...(quickAddType === 'music' ? S.quickAddTabActive : {}) }}>
              <Music size={12} /> Music
            </button>
          </div>
          <div style={S.quickAddRow}>
            <input value={quickAddPrompt} onChange={(e) => setQuickAddPrompt(e.target.value)}
              placeholder={quickAddType === 'sfx' ? 'Describe sound effect...' : 'Describe music...'}
              style={S.quickAddInput}
              onKeyDown={(e) => { if (e.key === 'Enter' && !quickAddGenerating) handleQuickAdd(); }}
              aria-label={`${quickAddType} prompt`} />
            <button onClick={handleQuickAdd} disabled={quickAddGenerating || !quickAddPrompt.trim()}
              style={S.quickAddBtn}>
              {quickAddGenerating ? <Loader size={14} /> : <Wand2 size={14} />}
              {quickAddGenerating ? 'Generating...' : `Add ${quickAddType.toUpperCase()} at ${formatTime(currentTimeMs)}`}
            </button>
            <button onClick={() => setQuickAddOpen(false)} style={S.quickAddClose} aria-label="Close quick add">
              <X size={14} />
            </button>
          </div>
          <div style={S.quickAddHint}>
            Generates audio and places it on the {quickAddType} track at the current playhead position.
            Press Enter to generate.
          </div>
        </div>
      )}

      {/* Main timeline area */}
      <div style={S.mainArea}>
        <div style={S.timelineArea}>
          {/* Track headers */}
          <div style={S.trackHeaders}>
            <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid #222' }} />
            {tracks.map((track) => (
              <div key={track.id} style={S.trackHeader}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: track.color || '#4A90D9' }} />
                  <span style={{ color: '#ccc', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{track.name}</span>
                  <button onClick={() => handleDeleteTrack(track)} style={S.trackDeleteBtn}
                    title="Delete track" aria-label={`Delete ${track.name} track`}>
                    <Trash2 size={11} />
                  </button>
                </div>
                <div style={S.trackControls}>
                  <button onClick={() => toggleMute(track)}
                    style={{ ...S.ctrlBtn, color: track.muted ? '#f66' : '#666' }}
                    aria-label={track.muted ? 'Unmute' : 'Mute'} title={track.muted ? 'Unmute' : 'Mute'}>
                    {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  </button>
                  <button onClick={() => toggleSolo(track)}
                    style={{ ...S.ctrlBtn, color: track.solo ? '#ff0' : '#666', fontSize: 10, fontWeight: 'bold' }}
                    aria-label={track.solo ? 'Unsolo' : 'Solo'} title="Solo">
                    S
                  </button>
                  <input type="range" min={-20} max={6} step={0.5} value={track.gain}
                    onChange={(e) => handleTrackGain(track, parseFloat(e.target.value))}
                    style={{ width: 50, accentColor: track.color || '#4A90D9' }}
                    title={`Gain: ${track.gain}dB`} aria-label={`${track.name} gain`} />
                  <span style={{ fontSize: 9, color: '#555', minWidth: 28 }}>{track.gain > 0 ? '+' : ''}{track.gain}dB</span>
                </div>
              </div>
            ))}
          </div>

          {/* Canvas */}
          <div ref={scrollRef} style={S.canvasWrapper}>
            <canvas ref={canvasRef}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              onContextMenu={handleContextMenu}
              style={S.canvas} />
          </div>
        </div>

        {/* Inspector panel */}
        {renderInspector()}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div style={{ ...S.ctxMenu, left: contextMenu.x, top: contextMenu.y }}>
          <button style={S.ctxItem} onClick={() => { handleSplitAtPlayhead(contextMenu.clip.id); setContextMenu(null); }}>
            <Scissors size={12} /> Split at Playhead
          </button>
          <button style={S.ctxItem} onClick={() => { handleDuplicateClip(contextMenu.clip.id); setContextMenu(null); }}>
            <Copy size={12} /> Duplicate
          </button>
          <div style={S.ctxDivider} />
          <button style={{ ...S.ctxItem, color: '#f66' }} onClick={() => { handleDeleteClip(contextMenu.clip.id); setContextMenu(null); }}>
            <Trash2 size={12} /> Delete Clip
          </button>
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      <div style={S.shortcutsBar}>
        <span>Space: Play/Pause</span>
        <span>Del: Delete clip</span>
        <span>S: Split at playhead</span>
        <span>D: Duplicate</span>
        <span>Click: Set playhead</span>
        <span>Drag clip: Move</span>
        <span>Drag edges: Trim</span>
        <span>Right-click: Context menu</span>
      </div>

      {/* Empty state */}
      {tracks.length === 0 && (
        <div style={S.emptyState}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🎚️</div>
          <h3 style={{ color: '#ccc', fontSize: 16, marginBottom: 8 }}>Timeline is empty</h3>
          <p style={{ color: '#666', fontSize: 13, maxWidth: 440, lineHeight: 1.6, textAlign: 'center' as const }}>
            The timeline is where you arrange and preview your audiobook audio before rendering.
          </p>
          <div style={S.emptySteps}>
            <p style={S.emptyStep}>1. Go to the Manuscript page and generate audio for your segments</p>
            <p style={S.emptyStep}>2. Click "Send to Timeline" to auto-populate tracks and clips</p>
            <p style={S.emptyStep}>3. Or use Quick Add above to generate SFX/Music directly here</p>
            <p style={S.emptyStep}>4. Add tracks using the buttons in the toolbar</p>
          </div>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)', outline: 'none' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
    background: '#161616', borderBottom: '1px solid #222', flexWrap: 'wrap',
  },
  transportGroup: { display: 'flex', gap: 4 },
  transportBtn: {
    background: '#2a2a2a', border: 'none', color: '#ddd', borderRadius: 6,
    padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center',
  },
  timeDisplay: { color: '#4A90D9', fontFamily: 'monospace', fontSize: 15, minWidth: 80 },
  infoText: { color: '#555', fontSize: 11 },
  zoomControl: { display: 'flex', alignItems: 'center', gap: 6 },
  quickAddToggle: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px',
    background: '#1a1a1a', color: '#aaa', border: '1px solid #333',
    borderRadius: 6, cursor: 'pointer', fontSize: 12,
  },
  addTrackGroup: { display: 'flex', gap: 3, marginLeft: 'auto' },
  addTrackBtn: {
    padding: '4px 10px', background: '#1e1e1e', color: '#777', border: '1px solid #2a2a2a',
    borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },

  // Quick-Add Panel
  quickAddPanel: {
    padding: '8px 12px', background: '#1a1a1a', borderBottom: '1px solid #333',
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  quickAddTabs: { display: 'flex', gap: 4 },
  quickAddTab: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px',
    background: '#111', color: '#888', border: '1px solid #222',
    borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },
  quickAddTabActive: { background: '#1e2a3a', color: '#4A90D9', borderColor: '#4A90D9' },
  quickAddRow: { display: 'flex', gap: 8, alignItems: 'center' },
  quickAddInput: {
    flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #333',
    background: '#0f0f0f', color: '#ddd', fontSize: 13, outline: 'none',
  },
  quickAddBtn: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 6,
    cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' as const,
  },
  quickAddClose: {
    background: 'none', border: 'none', color: '#666', cursor: 'pointer',
    padding: 4, display: 'flex',
  },
  quickAddHint: { fontSize: 10, color: '#555' },

  // Main area
  mainArea: { display: 'flex', flex: 1, overflow: 'hidden' },
  timelineArea: { display: 'flex', flex: 1, overflow: 'hidden', background: '#0f0f0f' },
  trackHeaders: {
    width: HEADER_WIDTH, flexShrink: 0, background: '#121212',
    borderRight: '1px solid #222', overflow: 'hidden',
  },
  trackHeader: {
    height: TRACK_HEIGHT, padding: '4px 8px', borderBottom: '1px solid #1e1e1e',
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4,
  },
  trackControls: { display: 'flex', gap: 4, alignItems: 'center' },
  ctrlBtn: {
    background: 'none', border: '1px solid #333', borderRadius: 3,
    cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center',
  },
  trackDeleteBtn: {
    background: 'none', border: 'none', color: '#444', cursor: 'pointer',
    padding: 2, display: 'flex', alignItems: 'center',
  },
  canvasWrapper: { flex: 1, overflow: 'auto' },
  canvas: { display: 'block' },

  // Inspector
  inspector: {
    width: 220, flexShrink: 0, background: '#161616', borderLeft: '1px solid #222',
    padding: 12, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
  },
  inspectorTitle: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    color: '#fff', fontSize: 13, fontWeight: 500,
  },
  inspectorDeleteBtn: {
    background: '#2a1a1a', border: '1px solid #3a2222', color: '#f66',
    borderRadius: 4, cursor: 'pointer', padding: '3px 6px', display: 'flex',
  },
  inspectorGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 8px', alignItems: 'center',
  },
  inspLabel: { fontSize: 11, color: '#888' },
  inspInput: {
    padding: '4px 6px', borderRadius: 4, border: '1px solid #333',
    background: '#0f0f0f', color: '#ddd', fontSize: 12, outline: 'none', width: '100%',
  },
  inspectorActions: { display: 'flex', gap: 6, marginTop: 4 },
  inspActionBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px',
    background: '#1e1e1e', color: '#aaa', border: '1px solid #2a2a2a',
    borderRadius: 5, cursor: 'pointer', fontSize: 11, flex: 1, justifyContent: 'center',
  },

  // Context menu
  ctxMenu: {
    position: 'fixed', background: '#1e1e1e', border: '1px solid #333',
    borderRadius: 8, padding: 4, zIndex: 1000, minWidth: 160,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  ctxItem: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '8px 12px', background: 'none', border: 'none', color: '#ccc',
    cursor: 'pointer', fontSize: 12, borderRadius: 4, textAlign: 'left' as const,
  },
  ctxDivider: { height: 1, background: '#333', margin: '4px 0' },

  // Shortcuts bar
  shortcutsBar: {
    display: 'flex', gap: 16, padding: '4px 12px', background: '#111',
    borderTop: '1px solid #1e1e1e', fontSize: 10, color: '#444', flexWrap: 'wrap',
  },

  // Empty state
  emptyState: {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 20px',
  },
  emptySteps: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16, textAlign: 'left' as const },
  emptyStep: { color: '#888', fontSize: 12, lineHeight: 1.5 },
};
