import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl, render, saveProject, downloadProjectUrl, uploadAudio } from '../services/api';
import type { Track, Clip, ChapterMarker } from '../types';
import {
  Play, Pause, SkipBack, ZoomIn, ZoomOut, Plus, Trash2, Volume2, VolumeX,
  Save, Download, Scissors, Copy, Clipboard, Undo2, Redo2, HelpCircle, X,
  Wand2, Loader, Upload,
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
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
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

  // ── Audio Playback with real audio ──
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playStartTimeRef = useRef<number>(0);
  const playStartMsRef = useRef<number>(0);

  const getAudioCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  };

  const loadAudioBuffer = async (assetId: string): Promise<AudioBuffer | null> => {
    if (audioBuffersRef.current.has(assetId)) return audioBuffersRef.current.get(assetId)!;
    try {
      const ctx = getAudioCtx();
      const res = await fetch(audioUrl(assetId));
      const arrayBuf = await res.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      audioBuffersRef.current.set(assetId, audioBuf);
      return audioBuf;
    } catch (err) {
      console.error(`Failed to load audio ${assetId}:`, err);
      return null;
    }
  };

  const stopAllAudio = () => {
    activeSourcesRef.current.forEach((s) => { try { s.stop(); } catch {} });
    activeSourcesRef.current = [];
  };

  const playFromPosition = async (startMs: number) => {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    stopAllAudio();

    playStartTimeRef.current = ctx.currentTime;
    playStartMsRef.current = startMs;

    // Schedule all clips that overlap with or come after startMs
    for (const track of tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        const clipDur = getClipDuration(clip);
        const clipEnd = clip.position_ms + clipDur;
        if (clipEnd <= startMs) continue; // clip already passed

        const buffer = await loadAudioBuffer(clip.audio_asset_id);
        if (!buffer) continue;

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        // Apply gain
        const gainNode = ctx.createGain();
        const trackGainDb = track.gain || 0;
        const clipGainDb = clip.gain || 0;
        gainNode.gain.value = Math.pow(10, (trackGainDb + clipGainDb) / 20);

        // Apply speed
        source.playbackRate.value = clip.speed || 1.0;

        // Apply fade in/out
        if (clip.fade_in_ms && clip.fade_in_ms > 0) {
          const fadeStartTime = Math.max(0, (clip.position_ms - startMs) / 1000);
          gainNode.gain.setValueAtTime(0, ctx.currentTime + fadeStartTime);
          gainNode.gain.linearRampToValueAtTime(
            Math.pow(10, (trackGainDb + clipGainDb) / 20),
            ctx.currentTime + fadeStartTime + clip.fade_in_ms / 1000
          );
        }
        if (clip.fade_out_ms && clip.fade_out_ms > 0) {
          const fadeOutStart = Math.max(0, (clip.position_ms + clipDur - clip.fade_out_ms - startMs) / 1000);
          const fadeOutEnd = Math.max(0, (clip.position_ms + clipDur - startMs) / 1000);
          if (fadeOutStart > 0) {
            gainNode.gain.setValueAtTime(Math.pow(10, (trackGainDb + clipGainDb) / 20), ctx.currentTime + fadeOutStart);
            gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeOutEnd);
          }
        }

        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        // Calculate the offset into the source audio buffer
        // trim_start_ms = skip this much from the start of the audio file
        const trimStartSec = (clip.trim_start_ms || 0) / 1000;
        const clipStartRelative = clip.position_ms - startMs; // ms relative to playback start

        if (clipStartRelative >= 0) {
          // Clip starts in the future — schedule it
          source.start(ctx.currentTime + clipStartRelative / 1000, trimStartSec);
        } else {
          // Clip already started — jump into it
          const skipSec = Math.abs(clipStartRelative) / 1000;
          source.start(0, trimStartSec + skipSec);
        }

        // Auto-stop at the clip's end (accounting for trim)
        const assetDur = (clip as any).asset_duration_ms;
        if (assetDur && assetDur > 0) {
          const playDuration = (assetDur - (clip.trim_start_ms || 0) - (clip.trim_end_ms || 0)) / 1000;
          if (playDuration > 0) {
            const stopDelay = clipStartRelative >= 0
              ? clipStartRelative / 1000 + playDuration
              : playDuration - Math.abs(clipStartRelative) / 1000;
            if (stopDelay > 0) {
              source.stop(ctx.currentTime + stopDelay);
            }
          }
        }

        activeSourcesRef.current.push(source);
      }
    }
  };

  const togglePlay = () => {
    if (playing) {
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      stopAllAudio();
      setPlaying(false);
    } else {
      setPlaying(true);
      playFromPosition(playheadMs);
      const startMs = playheadMs;
      const startTime = performance.now();
      const tick = (now: number) => {
        const elapsed = now - startTime;
        setPlayheadMs(startMs + elapsed);
        playTimerRef.current = requestAnimationFrame(tick);
      };
      playTimerRef.current = requestAnimationFrame(tick);
    }
  };
  const seekTo = (ms: number) => {
    const newMs = Math.max(0, ms);
    setPlayheadMs(newMs);
    if (playing) {
      // Restart audio from new position
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      stopAllAudio();
      playFromPosition(newMs);
      const startTime = performance.now();
      const tick = (now: number) => {
        const elapsed = now - startTime;
        setPlayheadMs(newMs + elapsed);
        playTimerRef.current = requestAnimationFrame(tick);
      };
      playTimerRef.current = requestAnimationFrame(tick);
    }
  };

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
    const clipDur = getClipDuration(clip);
    const splitMs = playheadMs - clip.position_ms;
    if (splitMs <= 0 || splitMs >= clipDur) return;
    pushSnapshot(tracks);
    const track = tracks.find((t) => t.clips.some((c) => c.id === clipId));
    if (!track) return;
    // First half: increase trim_end to cut off the second part
    const remainingAfterSplit = clipDur - splitMs;
    await timelineApi.updateClip(bookId, clipId, { trim_end_ms: (clip.trim_end_ms || 0) + remainingAfterSplit });
    // Second half: increase trim_start to skip the first part
    await timelineApi.createClip(bookId, track.id, {
      audio_asset_id: clip.audio_asset_id,
      position_ms: clip.position_ms + splitMs,
      trim_start_ms: (clip.trim_start_ms || 0) + splitMs,
      trim_end_ms: clip.trim_end_ms || 0,
      gain: clip.gain, speed: clip.speed,
      fade_in_ms: clip.fade_in_ms, fade_out_ms: clip.fade_out_ms,
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
    // asset_duration_ms = full duration of the source audio file (from JOIN)
    const assetDur = (clip as any).asset_duration_ms;
    // trim_start_ms = how much to skip from the beginning
    // trim_end_ms = how much to cut from the end
    // If asset duration is known, use it properly
    if (assetDur && assetDur > 0) {
      return Math.max(assetDur - (clip.trim_start_ms || 0) - (clip.trim_end_ms || 0), 100);
    }
    // Fallback: estimate from trim_end_ms (legacy clips stored duration in trim_end_ms)
    // If trim_end_ms is large (>500), it was likely used as "total duration" in old populate code
    if (clip.trim_end_ms > 500) {
      return Math.max(clip.trim_end_ms - (clip.trim_start_ms || 0), 200);
    }
    return 3000; // absolute fallback
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

    // roundRect polyfill for older browsers
    if (!ctx.roundRect) {
      (ctx as any).roundRect = function(x: number, y: number, w: number, h: number, radii: number | number[]) {
        const r = typeof radii === 'number' ? [radii, radii, radii, radii] : [...radii, 0, 0, 0, 0].slice(0, 4);
        this.moveTo(x + r[0], y);
        this.lineTo(x + w - r[1], y); this.quadraticCurveTo(x + w, y, x + w, y + r[1]);
        this.lineTo(x + w, y + h - r[2]); this.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
        this.lineTo(x + r[3], y + h); this.quadraticCurveTo(x, y + h, x, y + h - r[3]);
        this.lineTo(x, y + r[0]); this.quadraticCurveTo(x, y, x + r[0], y);
        this.closePath();
      };
    }

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
        const isDragging = dragRef.current?.clipId === clip.id;
        const baseColor = track.type === 'narration' ? '#2a4a6a' : track.type === 'sfx' ? '#2a4a2a' : track.type === 'music' ? '#4a2a6a' : '#4a4a2a';
        const activeColor = isSelected ? '#4A90D9' : baseColor;

        // Clip body with rounded corners
        const clipY = y + 4;
        const clipH = TRACK_H - 8;
        const r = 4;
        ctx.beginPath();
        ctx.roundRect(cx, clipY, cw, clipH, r);
        ctx.fillStyle = isDragging ? '#5A9AE9' : activeColor;
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#fff' : '#444';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.stroke();

        // Volume indicator bar at bottom of clip
        const gainDb = clip.gain || 0;
        const volFrac = Math.min(1, Math.max(0, (gainDb + 20) / 26));
        ctx.fillStyle = gainDb > 0 ? '#e55' : '#4A90D9';
        ctx.fillRect(cx + 2, y + TRACK_H - 10, (cw - 4) * volFrac, 3);

        // Speed indicator if not 1.0
        const spd = clip.speed ?? 1.0;
        if (spd !== 1.0 && cw > 40) {
          ctx.fillStyle = '#ff0';
          ctx.font = '8px monospace';
          ctx.fillText(`${spd.toFixed(1)}x`, cx + cw - 28, y + 14);
        }

        // Clip label
        if (cw > 30) {
          ctx.fillStyle = '#ddd';
          ctx.font = '10px sans-serif';
          const label = clip.notes || (clip as any).character_name || (clip as any).segment_text?.slice(0, 40) || clip.audio_asset_id.slice(0, 8);
          ctx.fillText(label, cx + 8, y + TRACK_H / 2 + 1, cw - 16);
        }

        // Trim handles — always visible on selected, subtle on hover
        if (isSelected || isDragging) {
          // Left handle
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.beginPath();
          ctx.roundRect(cx, clipY, 6, clipH, [r, 0, 0, r]);
          ctx.fill();
          // Handle grip lines
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.lineWidth = 1;
          for (let gy = clipY + clipH * 0.3; gy < clipY + clipH * 0.7; gy += 4) {
            ctx.beginPath(); ctx.moveTo(cx + 1.5, gy); ctx.lineTo(cx + 4.5, gy); ctx.stroke();
          }

          // Right handle
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.beginPath();
          ctx.roundRect(cx + cw - 6, clipY, 6, clipH, [0, r, r, 0]);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.lineWidth = 1;
          for (let gy = clipY + clipH * 0.3; gy < clipY + clipH * 0.7; gy += 4) {
            ctx.beginPath(); ctx.moveTo(cx + cw - 4.5, gy); ctx.lineTo(cx + cw - 1.5, gy); ctx.stroke();
          }
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
  const HANDLE_W = 10; // wider grab zone for trim handles
  const getHitInfo = (mx: number, my: number): { clip: Clip; track: Track; mode: DragMode } | null => {
    if (my < RULER_H) return null;
    const trackIdx = Math.floor((my - RULER_H) / TRACK_H);
    if (trackIdx < 0 || trackIdx >= tracks.length) return null;
    const track = tracks[trackIdx];
    // Iterate in reverse so topmost (last drawn) clip is hit first
    for (let i = track.clips.length - 1; i >= 0; i--) {
      const clip = track.clips[i];
      const cx = (clip.position_ms - scrollX) * pxPerMs;
      const cw = getClipDuration(clip) * pxPerMs;
      if (mx >= cx && mx <= cx + cw) {
        let mode: DragMode = 'move';
        if (mx - cx < HANDLE_W) mode = 'trimStart';
        else if (cx + cw - mx < HANDLE_W) mode = 'trimEnd';
        return { clip, track, mode };
      }
    }
    return null;
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (my < RULER_H) { seekTo(mx / pxPerMs + scrollX); return; }
    const hit = getHitInfo(mx, my);
    if (hit) {
      setSelectedClipId(hit.clip.id);
      setContextMenu(null);
      dragRef.current = {
        mode: hit.mode, clipId: hit.clip.id, trackId: hit.track.id,
        startMouseX: mx, origPos: hit.clip.position_ms,
        origTS: hit.clip.trim_start_ms, origTE: hit.clip.trim_end_ms,
      };
      return;
    }
    setSelectedClipId(null);
    const clickMs = mx / pxPerMs + scrollX;
    seekTo(clickMs);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Update cursor based on hover position
    if (!dragRef.current) {
      const hit = getHitInfo(mx, my);
      if (hit) {
        if (hit.mode === 'trimStart' || hit.mode === 'trimEnd') {
          canvas.style.cursor = 'col-resize';
        } else {
          canvas.style.cursor = 'grab';
        }
      } else if (my < RULER_H) {
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'crosshair';
      }
    } else {
      // Dragging — set appropriate cursor
      if (dragRef.current.mode === 'move') canvas.style.cursor = 'grabbing';
      else canvas.style.cursor = 'col-resize';
    }

    if (!dragRef.current || !bookId) return;
    const dx = mx - dragRef.current.startMouseX;
    const dMs = dx / pxPerMs;
    setTracks((prev) => prev.map((t) => {
      // For trim operations or tracks that don't contain the dragged clip, just update the dragged clip
      if (dragRef.current!.mode !== 'move' || !t.clips.some((c) => c.id === dragRef.current!.clipId)) {
        return {
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== dragRef.current!.clipId) return c;
            if (dragRef.current!.mode === 'trimStart') return { ...c, trim_start_ms: Math.max(0, Math.round(dragRef.current!.origTS + dMs)) };
            if (dragRef.current!.mode === 'trimEnd') return { ...c, trim_end_ms: Math.max(0, Math.round(dragRef.current!.origTE - dMs)) };
            return c;
          }),
        };
      }

      // Move mode on the track containing the dragged clip — push neighbors instead of overlapping
      const newPos = Math.max(0, Math.round(dragRef.current!.origPos + dMs));
      let updatedClips = t.clips.map((c) =>
        c.id === dragRef.current!.clipId ? { ...c, position_ms: newPos } : { ...c }
      );

      // Sort by position for ripple push
      updatedClips.sort((a, b) => a.position_ms - b.position_ms);

      // Push clips to the right if they overlap with the dragged clip
      const draggedIdx = updatedClips.findIndex((c) => c.id === dragRef.current!.clipId);
      if (draggedIdx >= 0) {
        const draggedClip = updatedClips[draggedIdx];
        const draggedEnd = draggedClip.position_ms + getClipDuration(draggedClip);

        // Push clips to the right of the dragged clip
        for (let i = draggedIdx + 1; i < updatedClips.length; i++) {
          const prevClip = updatedClips[i - 1];
          const prevEnd = prevClip.position_ms + getClipDuration(prevClip);
          if (updatedClips[i].position_ms < prevEnd) {
            updatedClips[i] = { ...updatedClips[i], position_ms: Math.round(prevEnd) };
          }
        }

        // Push clips to the left of the dragged clip (if dragged left into them)
        for (let i = draggedIdx - 1; i >= 0; i--) {
          const nextClip = updatedClips[i + 1];
          const thisEnd = updatedClips[i].position_ms + getClipDuration(updatedClips[i]);
          if (thisEnd > nextClip.position_ms) {
            updatedClips[i] = { ...updatedClips[i], position_ms: Math.max(0, Math.round(nextClip.position_ms - getClipDuration(updatedClips[i]))) };
          }
        }
      }

      return { ...t, clips: updatedClips };
    }));
  };
  const handleCanvasMouseUp = async () => {
    if (!dragRef.current || !bookId) return;
    const draggedTrackId = dragRef.current.trackId;
    const draggedClipId = dragRef.current.clipId;
    const mode = dragRef.current.mode;
    dragRef.current = null;

    if (mode === 'move') {
      // Save all clips on the same track (positions may have shifted due to push)
      const track = tracks.find((t) => t.id === draggedTrackId);
      if (track) {
        pushSnapshot(tracks);
        for (const clip of track.clips) {
          await timelineApi.updateClip(bookId, clip.id, {
            position_ms: Math.round(clip.position_ms),
            trim_start_ms: Math.round(clip.trim_start_ms),
            trim_end_ms: Math.round(clip.trim_end_ms),
          });
        }
      }
    } else {
      // Trim mode — only save the trimmed clip
      const clip = findClip(draggedClipId);
      if (clip) {
        pushSnapshot(tracks);
        await timelineApi.updateClip(bookId, clip.id, {
          position_ms: Math.round(clip.position_ms),
          trim_start_ms: Math.round(clip.trim_start_ms),
          trim_end_ms: Math.round(clip.trim_end_ms),
        });
      }
    }
  };
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = getHitInfo(mx, my);
    if (hit) {
      setSelectedClipId(hit.clip.id);
      setContextMenu({ x: e.clientX, y: e.clientY, clipId: hit.clip.id, trackId: hit.track.id });
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

  // ── Import Audio File ──
  const handleImportAudio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !bookId) return;
    setImporting(true);
    try {
      const result = await uploadAudio(bookId, file, file.name);
      // Find or create an "Imported" track
      let importTrack = tracks.find((t) => t.type === 'imported');
      if (!importTrack) {
        importTrack = await timelineApi.createTrack(bookId, { name: 'Imported', type: 'imported' });
      }
      if (!importTrack) throw new Error('Failed to create track');
      // Place clip at playhead
      await timelineApi.createClip(bookId, importTrack.id, {
        audio_asset_id: result.audio_asset_id,
        position_ms: playheadMs,
        notes: file.name.replace(/\.[^.]+$/, ''),
      });
      skipSnap.current = true;
      loadTracks();
    } catch (err: any) { alert(`Import failed: ${err.message}`); }
    finally {
      setImporting(false);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

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
          <button onClick={() => importFileRef.current?.click()} disabled={importing} style={S.toolBtn} title="Import audio file to timeline">
            <Upload size={14} /> {importing ? '...' : 'Import'}
          </button>
          <input ref={importFileRef} type="file" accept=".mp3,.wav,.ogg,.m4a,.flac,.aac" onChange={handleImportAudio} hidden aria-label="Import audio file" />
        </div>
        <div style={{ flex: 1 }} />
        <div style={S.toolGroup}>
          <button onClick={handleSave} disabled={saving} style={S.toolBtn} title="Save project to disk"><Save size={14} /> {saving ? '...' : 'Save'}</button>
          {bookId && <a href={downloadProjectUrl(bookId)} style={{ ...S.toolBtn, textDecoration: 'none' }} title="Download project ZIP (all audio + metadata)" download><Download size={14} /></a>}
          <button onClick={handleRender} disabled={rendering} style={{ ...S.toolBtn, background: '#2d5a27', color: '#8f8' }} title="Render per-chapter MP3 files for export">
            {rendering ? <Loader size={14} /> : <Play size={14} />} Render
          </button>
          <button onClick={() => setShowHelp(true)} style={S.toolBtn} title="Keyboard shortcuts"><HelpCircle size={14} /></button>
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
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' },
  toolGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  toolBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px',
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer', fontSize: 11,
    whiteSpace: 'nowrap' as const,
  },
  timeDisplay: { fontSize: 12, color: 'var(--accent)', fontFamily: 'monospace', minWidth: 60, fontWeight: 500 },
  quickPanel: { padding: '8px 14px', background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' },
  quickSelect: { padding: '6px 10px', background: 'var(--bg-deep)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 11 },
  quickInput: { flex: 1, padding: '6px 12px', background: 'var(--bg-deep)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12, outline: 'none' },
  quickBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px',
    background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  trackHeaders: { width: HEADER_W, background: 'var(--bg-base)', borderRight: '1px solid var(--border-subtle)', flexShrink: 0, overflow: 'hidden' },
  trackHeader: {
    height: TRACK_H, display: 'flex', alignItems: 'center', padding: '4px 8px',
    borderBottom: '1px solid var(--border-subtle)',
  },
  trackName: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: 'var(--text-secondary)' },
  trackControls: { display: 'flex', gap: 2 },
  trackSlider: { flex: 1, height: 3, cursor: 'pointer', accentColor: 'var(--accent)' },
  tinyBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 3 },
  canvasContainer: { flex: 1, overflow: 'hidden', position: 'relative' as const },
  canvas: { display: 'block', cursor: 'default' },
  inspector: {
    position: 'absolute' as const, right: 12, top: 60, width: 230,
    background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 14, zIndex: 10,
    maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' as const, boxShadow: 'var(--shadow-lg)',
  },
  inspRow: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 0' },
  inspSection: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' },
  inspLabel: { fontSize: 10, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 },
  inspSlider: { width: '100%', height: 4, cursor: 'pointer', accentColor: 'var(--accent)' },
  inspSliderLabels: { display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--text-muted)', marginTop: 2 },
  inspBtn: {
    display: 'flex', alignItems: 'center', gap: 3, padding: '4px 10px',
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 6, cursor: 'pointer', fontSize: 10,
  },
  presetBtn: {
    padding: '3px 8px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)',
    borderRadius: 5, cursor: 'pointer', fontSize: 9,
  },
  overlay: { position: 'fixed' as const, inset: 0, zIndex: 15 },
  ctxMenu: {
    position: 'fixed' as const, zIndex: 20, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 10,
    padding: 4, display: 'flex', flexDirection: 'column' as const, gap: 1, minWidth: 160,
    boxShadow: 'var(--shadow-lg)',
  },
  ctxItem: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px',
    background: 'transparent', color: 'var(--text-secondary)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11,
    textAlign: 'left' as const,
  },
  helpOverlay: {
    position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30,
  },
  helpBox: { background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 16, padding: 28, maxWidth: 400, boxShadow: 'var(--shadow-lg)' },
  helpGrid: { display: 'grid', gridTemplateColumns: '100px 1fr', gap: '6px 12px' },
  helpKey: {
    fontSize: 11, color: 'var(--accent)', fontFamily: 'monospace', background: 'var(--accent-subtle)',
    padding: '3px 8px', borderRadius: 5, textAlign: 'center' as const,
  },
  helpDesc: { fontSize: 12, color: 'var(--text-tertiary)' },
};
