import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl, render, saveProject, downloadProjectUrl, uploadAudio, audioAssets } from '../services/api';
import { toast } from '../components/Toast';
import { KeyboardShortcutsDialog } from '../components/KeyboardShortcutsDialog';
import type { Track, Clip, ChapterMarker } from '../types';
import {
  Play, Pause, SkipBack, ZoomIn, ZoomOut, Plus, Trash2, Volume2, VolumeX,
  Save, Download, Scissors, Copy, Clipboard, Undo2, Redo2, HelpCircle, X,
  Wand2, Loader, Upload, Clock, Magnet, Layers, GitMerge, AlignLeft, Sliders,
  ChevronDown, Music, Mic, Zap, Grid, Type, Headphones, FileAudio, 
  Maximize2, Minimize2, Settings, Search, Filter, Eye, EyeOff, 
  ChevronRight, ChevronLeft, Square, Circle, Hash, AlignCenter,
  Move, GripVertical, Split, Merge, Waves, BarChart3, Timer
} from 'lucide-react';

type DragMode = 'move' | 'trimStart' | 'trimEnd' | 'fadeIn' | 'fadeOut';
interface ClipboardData { clip: Clip; trackId: string; cut: boolean; }
interface ContextMenu { x: number; y: number; clipId: string; trackId: string; }

const TRACK_H = 80;
const RULER_H = 40;
const MIN_PX_PER_MS = 0.005;
const MAX_PX_PER_MS = 0.5;

// ── Modern track type colors ──
const TRACK_COLORS: Record<string, { 
  bg: string; border: string; text: string; 
  clip: string; clipHover: string; accent: string;
  gradient: string;
}> = {
  narration: { 
    bg: 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(59,130,246,0.02) 100%)', 
    border: 'rgba(59,130,246,0.15)', 
    text: '#3b82f6', 
    clip: 'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(59,130,246,0.4) 100%)', 
    clipHover: 'linear-gradient(135deg, rgba(59,130,246,0.35) 0%, rgba(59,130,246,0.5) 100%)',
    accent: '#1d4ed8',
    gradient: 'linear-gradient(135deg, #3b82f6, #1d4ed8)'
  },
  dialogue:  { 
    bg: 'linear-gradient(135deg, rgba(168,85,247,0.08) 0%, rgba(168,85,247,0.02) 100%)', 
    border: 'rgba(168,85,247,0.15)', 
    text: '#a855f7', 
    clip: 'linear-gradient(135deg, rgba(168,85,247,0.25) 0%, rgba(168,85,247,0.4) 100%)', 
    clipHover: 'linear-gradient(135deg, rgba(168,85,247,0.35) 0%, rgba(168,85,247,0.5) 100%)',
    accent: '#7c3aed',
    gradient: 'linear-gradient(135deg, #a855f7, #7c3aed)'
  },
  sfx:       { 
    bg: 'linear-gradient(135deg, rgba(34,197,94,0.08) 0%, rgba(34,197,94,0.02) 100%)', 
    border: 'rgba(34,197,94,0.15)', 
    text: '#22c55e', 
    clip: 'linear-gradient(135deg, rgba(34,197,94,0.25) 0%, rgba(34,197,94,0.4) 100%)', 
    clipHover: 'linear-gradient(135deg, rgba(34,197,94,0.35) 0%, rgba(34,197,94,0.5) 100%)',
    accent: '#16a34a',
    gradient: 'linear-gradient(135deg, #22c55e, #16a34a)'
  },
  music:     { 
    bg: 'linear-gradient(135deg, rgba(251,146,60,0.08) 0%, rgba(251,146,60,0.02) 100%)', 
    border: 'rgba(251,146,60,0.15)', 
    text: '#fb923c', 
    clip: 'linear-gradient(135deg, rgba(251,146,60,0.25) 0%, rgba(251,146,60,0.4) 100%)', 
    clipHover: 'linear-gradient(135deg, rgba(251,146,60,0.35) 0%, rgba(251,146,60,0.5) 100%)',
    accent: '#ea580c',
    gradient: 'linear-gradient(135deg, #fb923c, #ea580c)'
  },
  imported:  { 
    bg: 'linear-gradient(135deg, rgba(156,163,175,0.08) 0%, rgba(156,163,175,0.02) 100%)', 
    border: 'rgba(156,163,175,0.15)', 
    text: '#9ca3af', 
    clip: 'linear-gradient(135deg, rgba(156,163,175,0.25) 0%, rgba(156,163,175,0.4) 100%)', 
    clipHover: 'linear-gradient(135deg, rgba(156,163,175,0.35) 0%, rgba(156,163,175,0.5) 100%)',
    accent: '#6b7280',
    gradient: 'linear-gradient(135deg, #9ca3af, #6b7280)'
  },
};
const getTrackColor = (type: string) => TRACK_COLORS[type] || TRACK_COLORS.imported;

const TRACK_ICONS: Record<string, React.ReactNode> = {
  narration: <Mic size={14} />,
  dialogue: <Type size={14} />,
  sfx: <Zap size={14} />,
  music: <Music size={14} />,
  imported: <FileAudio size={14} />,
};

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
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const playTimerRef = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickType, setQuickType] = useState<'sfx' | 'music'>('sfx');
  const [quickGenerating, setQuickGenerating] = useState(false);
  const [showSilenceMenu, setShowSilenceMenu] = useState(false);
  const [silenceDuration, setSilenceDuration] = useState(1000);
  const [insertingSilence, setInsertingSilence] = useState(false);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [showAddTrackMenu, setShowAddTrackMenu] = useState(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);

  // Advanced editing state
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set());
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapGridMs, setSnapGridMs] = useState(100);
  const [rippleMode, setRippleMode] = useState(false);
  const [showAdvancedPanel, setShowAdvancedPanel] = useState(false);
  
  // Modern timeline features
  const [waveformVisible, setWaveformVisible] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [miniMapScale, setMiniMapScale] = useState(0.1);
  const [showTrackEffects, setShowTrackEffects] = useState(false);
  const [activeTool, setActiveTool] = useState<'select' | 'split' | 'fade' | 'zoom'>('select');
  const [showTimecode, setShowTimecode] = useState(true);
  const [timeFormat, setTimeFormat] = useState<'mm:ss' | 'hh:mm:ss' | 'frames'>('mm:ss');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showClipLabels, setShowClipLabels] = useState(true);
  const [showClipWaveforms, setShowClipWaveforms] = useState(false);
  const [trackHeightMode, setTrackHeightMode] = useState<'compact' | 'normal' | 'expanded'>('normal');

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

  // ── Preview audio blob URL for inspector ──
  useEffect(() => {
    if (!selectedClipId) { setPreviewAudioUrl(null); return; }
    const clip = findClip(selectedClipId);
    if (!clip) { setPreviewAudioUrl(null); return; }
    let revoked = false;
    const token = localStorage.getItem('auth_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch(audioUrl(clip.audio_asset_id), { headers })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
      .then(blob => { if (!revoked) setPreviewAudioUrl(URL.createObjectURL(blob)); })
      .catch(() => setPreviewAudioUrl(null));
    return () => { revoked = true; setPreviewAudioUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; }); };
  }, [selectedClipId, tracks]);

  // ── Preload audio buffers for clips missing duration info ──
  const [bufferLoadTick, setBufferLoadTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const clipsNeedingDuration: string[] = [];
    for (const t of tracks) {
      for (const c of t.clips) {
        const assetDur = (c as any).asset_duration_ms;
        if ((!assetDur || assetDur <= 0) && !audioBuffersRef.current.has(c.audio_asset_id)) {
          clipsNeedingDuration.push(c.audio_asset_id);
        }
      }
    }
    if (clipsNeedingDuration.length === 0) return;
    // Load up to 10 at a time to avoid overwhelming the browser
    const batch = [...new Set(clipsNeedingDuration)].slice(0, 10);
    Promise.all(batch.map(id => loadAudioBuffer(id))).then(() => {
      if (!cancelled) setBufferLoadTick(t => t + 1);
    });
    return () => { cancelled = true; };
  }, [tracks]);

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

  // ── Audio Playback ──
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
      const token = localStorage.getItem('auth_token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(audioUrl(assetId), { headers });
      if (!res.ok) {
        console.error(`Failed to fetch audio ${assetId}: HTTP ${res.status}`);
        return null;
      }
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

    for (const track of tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        const clipDur = getClipDuration(clip);
        const clipEnd = clip.position_ms + clipDur;
        if (clipEnd <= startMs) continue;

        const buffer = await loadAudioBuffer(clip.audio_asset_id);
        if (!buffer) continue;

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gainNode = ctx.createGain();
        const trackGainDb = track.gain || 0;
        const clipGainDb = clip.gain || 0;
        gainNode.gain.value = Math.pow(10, (trackGainDb + clipGainDb) / 20);
        source.playbackRate.value = clip.speed || 1.0;

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

        const trimStartSec = (clip.trim_start_ms || 0) / 1000;
        const clipStartRelative = clip.position_ms - startMs;

        if (clipStartRelative >= 0) {
          source.start(ctx.currentTime + clipStartRelative / 1000, trimStartSec);
        } else {
          const skipSec = Math.abs(clipStartRelative) / 1000;
          source.start(0, trimStartSec + skipSec);
        }

        const assetDur = (clip as any).asset_duration_ms || (buffer.duration * 1000);
        if (assetDur && assetDur > 0) {
          const playDuration = (assetDur - (clip.trim_start_ms || 0) - (clip.trim_end_ms || 0)) / 1000;
          if (playDuration > 0) {
            const stopDelay = clipStartRelative >= 0
              ? clipStartRelative / 1000 + playDuration
              : playDuration - Math.abs(clipStartRelative) / 1000;
            if (stopDelay > 0) source.stop(ctx.currentTime + stopDelay);
          }
        }
        activeSourcesRef.current.push(source);
      }
    }
  };

  const togglePlay = async () => {
    if (playing) {
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      stopAllAudio();
      setPlaying(false);
    } else {
      setPlaying(true);
      await playFromPosition(playheadMs);
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

  const seekTo = async (ms: number) => {
    const newMs = Math.max(0, ms);
    setPlayheadMs(newMs);
    if (playing) {
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      stopAllAudio();
      await playFromPosition(newMs);
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
    setShowAddTrackMenu(false);
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
    const remainingAfterSplit = clipDur - splitMs;
    await timelineApi.updateClip(bookId, clipId, { trim_end_ms: (clip.trim_end_ms || 0) + remainingAfterSplit });
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
    const assetDur = (clip as any).asset_duration_ms;
    if (assetDur && assetDur > 0) {
      return Math.max(assetDur - (clip.trim_start_ms || 0) - (clip.trim_end_ms || 0), 100);
    }
    // Fallback: use loaded audio buffer duration if available
    const cachedBuffer = audioBuffersRef.current.get(clip.audio_asset_id);
    if (cachedBuffer) {
      const bufferDurMs = cachedBuffer.duration * 1000;
      return Math.max(bufferDurMs - (clip.trim_start_ms || 0) - (clip.trim_end_ms || 0), 100);
    }
    return 3000;
  };

  const snapPosition = (ms: number, excludeClipId?: string): number => {
    if (!snapEnabled) return ms;
    let snapped = Math.round(ms / snapGridMs) * snapGridMs;
    const SNAP_THRESHOLD = 50;
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.id === excludeClipId) continue;
        const cEnd = c.position_ms + getClipDuration(c);
        if (Math.abs(ms - c.position_ms) < SNAP_THRESHOLD) snapped = c.position_ms;
        if (Math.abs(ms - cEnd) < SNAP_THRESHOLD) snapped = cEnd;
      }
    }
    for (const m of markers) {
      if (Math.abs(ms - m.position_ms) < SNAP_THRESHOLD) snapped = m.position_ms;
    }
    return Math.max(0, snapped);
  };

  // Multi-select helpers
  const toggleMultiSelect = (clipId: string) => {
    setSelectedClipIds(prev => {
      const next = new Set(prev);
      if (next.has(clipId)) next.delete(clipId); else next.add(clipId);
      return next;
    });
  };
  const clearMultiSelect = () => setSelectedClipIds(new Set());

  // ── Advanced operations ──
  const handleNormalizeTrack = async (trackId: string, targetDb = -3) => {
    if (!bookId) return;
    pushSnapshot(tracks);
    try {
      const result = await timelineApi.normalizeTrack(bookId, trackId, targetDb);
      toast.info(`Normalized ${result.normalized} clips to ${result.target_db}dB`);
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Normalize failed: ${err.message}`); }
  };
  const handleCloseGaps = async (trackId: string, gapMs = 300) => {
    if (!bookId) return;
    pushSnapshot(tracks);
    try {
      const result = await timelineApi.closeGaps(bookId, trackId, gapMs);
      toast.info(`Adjusted ${result.adjusted} clips`);
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Close gaps failed: ${err.message}`); }
  };
  const handleCrossfade = async () => {
    if (!bookId || selectedClipIds.size !== 2) { toast.error('Select exactly 2 clips to crossfade'); return; }
    const ids = Array.from(selectedClipIds);
    const clipA = findClip(ids[0]);
    const clipB = findClip(ids[1]);
    if (!clipA || !clipB) return;
    const [first, second] = clipA.position_ms <= clipB.position_ms ? [ids[0], ids[1]] : [ids[1], ids[0]];
    pushSnapshot(tracks);
    try {
      await timelineApi.crossfade(bookId, first, second, 500);
      toast.info('Crossfade applied');
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Crossfade failed: ${err.message}`); }
  };
  const handleBatchDelete = async () => {
    if (!bookId || selectedClipIds.size === 0) return;
    if (!confirm(`Delete ${selectedClipIds.size} selected clips?`)) return;
    pushSnapshot(tracks);
    try {
      await timelineApi.batchDeleteClips(bookId, Array.from(selectedClipIds));
      clearMultiSelect(); setSelectedClipId(null);
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Batch delete failed: ${err.message}`); }
  };
  const handleBatchGainAdjust = async (deltaDb: number) => {
    if (!bookId || selectedClipIds.size === 0) return;
    pushSnapshot(tracks);
    try {
      await timelineApi.batchUpdateClips(bookId, Array.from(selectedClipIds), { delta_gain: deltaDb });
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Batch adjust failed: ${err.message}`); }
  };
  const handleBatchSpeedAdjust = async (deltaSpeed: number) => {
    if (!bookId || selectedClipIds.size === 0) return;
    pushSnapshot(tracks);
    try {
      await timelineApi.batchUpdateClips(bookId, Array.from(selectedClipIds), { delta_speed: deltaSpeed });
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Batch adjust failed: ${err.message}`); }
  };

  const totalDuration = () => {
    let max = 10000;
    for (const t of tracks) for (const c of t.clips) max = Math.max(max, c.position_ms + getClipDuration(c));
    return max + 5000;
  };

  // ── Drag handling for clips ──
  const handleClipMouseDown = (e: React.MouseEvent, clip: Clip, track: Track, mode: DragMode) => {
    e.stopPropagation();
    if (e.shiftKey) { toggleMultiSelect(clip.id); return; }
    setSelectedClipId(clip.id);
    if (!selectedClipIds.has(clip.id)) clearMultiSelect();
    setContextMenu(null);
    dragRef.current = {
      mode, clipId: clip.id, trackId: track.id,
      startMouseX: e.clientX, origPos: clip.position_ms,
      origTS: clip.trim_start_ms, origTE: clip.trim_end_ms,
    };

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startMouseX;
      const dMs = dx / pxPerMs;
      setTracks(prev => prev.map(t => ({
        ...t,
        clips: t.clips.map(c => {
          if (c.id !== dragRef.current!.clipId) return c;
          if (dragRef.current!.mode === 'trimStart') return { ...c, trim_start_ms: Math.max(0, Math.round(dragRef.current!.origTS + dMs)) };
          if (dragRef.current!.mode === 'trimEnd') return { ...c, trim_end_ms: Math.max(0, Math.round(dragRef.current!.origTE - dMs)) };
          return { ...c, position_ms: Math.max(0, Math.round(dragRef.current!.origPos + dMs)) };
        }),
      })));
    };

    const handleMouseUp = async () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (!dragRef.current || !bookId) return;
      const draggedClipId = dragRef.current.clipId;
      const dragMode = dragRef.current.mode;
      dragRef.current = null;

      const foundClip = findClip(draggedClipId);
      if (!foundClip) return;
      pushSnapshot(tracks);

      if (dragMode === 'move' && snapEnabled) {
        foundClip.position_ms = snapPosition(foundClip.position_ms, draggedClipId);
      }

      await timelineApi.updateClip(bookId, foundClip.id, {
        position_ms: Math.round(foundClip.position_ms),
        trim_start_ms: Math.round(foundClip.trim_start_ms),
        trim_end_ms: Math.round(foundClip.trim_end_ms),
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleTimelineClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.timelineArea) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mx = e.clientX - rect.left + (scrollContainerRef.current?.scrollLeft || 0);
      const clickMs = mx / pxPerMs;
      seekTo(clickMs);
      setSelectedClipId(null);
      if (!e.shiftKey) clearMultiSelect();
    }
  };

  const handleRulerClick = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left + (scrollContainerRef.current?.scrollLeft || 0);
    seekTo(mx / pxPerMs);
  };

  const handleClipContextMenu = (e: React.MouseEvent, clip: Clip, track: Track) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedClipId(clip.id);
    setContextMenu({ x: e.clientX, y: e.clientY, clipId: clip.id, trackId: track.id });
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
        const track = tracks.find(t => t.clips.some(c => c.id === selectedClipId)) || tracks[0];
        if (track) pasteClip(track.id);
      }
      if (e.key === 's' && !e.ctrlKey && selectedClipId) splitClip(selectedClipId);
      if (e.key === 'd' && !e.ctrlKey && selectedClipId) duplicateClip(selectedClipId);
      if (e.key === 'g' && !e.ctrlKey) setSnapEnabled(p => !p);
      if (e.key === 'r' && !e.ctrlKey) setRippleMode(p => !p);
      if (e.key === 'a' && e.ctrlKey) {
        e.preventDefault();
        const allIds = new Set<string>();
        for (const t of tracks) for (const c of t.clips) allIds.add(c.id);
        setSelectedClipIds(allIds);
      }
      if (e.key === 'Delete' && selectedClipIds.size > 0) handleBatchDelete();
      if (e.key === '?') setShowHelp(p => !p);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedClipId, playheadMs, playing, tracks, clipboardData]);

  // ── Zoom ──
  const zoomIn = () => setPxPerMs(p => Math.min(p * 1.5, MAX_PX_PER_MS));
  const zoomOut = () => setPxPerMs(p => Math.max(p / 1.5, MIN_PX_PER_MS));
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) { e.preventDefault(); if (e.deltaY < 0) zoomIn(); else zoomOut(); }
  };

  // ── Save / Render ──
  const handleSave = async () => {
    setSaving(true);
    try { await saveProject(); } catch (err: any) { toast.error(`Save failed: ${err.message}`); }
    finally { setSaving(false); }
  };
  const handleRender = async () => {
    if (!bookId) return;
    setRendering(true);
    try {
      const { job_id } = await render.start(bookId);
      toast.info(`Render started (job: ${job_id}). Check QC & Render page for progress.`);
    } catch (err: any) { toast.error(`Render failed: ${err.message}`); }
    finally { setRendering(false); }
  };

  // ── Quick Add SFX/Music ──
  const handleQuickAdd = async () => {
    if (!bookId || !quickPrompt.trim()) return;
    setQuickGenerating(true);
    try {
      let result;
      if (quickType === 'sfx') result = await elevenlabs.sfx({ prompt: quickPrompt, book_id: bookId });
      else result = await elevenlabs.music({ prompt: quickPrompt, book_id: bookId });
      let targetTrack: Track | undefined = tracks.find(t => t.type === quickType);
      if (!targetTrack) targetTrack = await timelineApi.createTrack(bookId, { name: quickType === 'sfx' ? 'SFX' : 'Music', type: quickType });
      if (!targetTrack) throw new Error('Failed to create track');
      await timelineApi.createClip(bookId, targetTrack.id, { audio_asset_id: result.audio_asset_id, position_ms: playheadMs });
      setQuickPrompt(''); setShowQuickAdd(false);
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Generation failed: ${err.message}`); }
    finally { setQuickGenerating(false); }
  };

  // ── Insert Silence ──
  const handleInsertSilence = async (durationMs: number) => {
    if (!bookId) return;
    setInsertingSilence(true);
    try {
      const result = await audioAssets.generateSilence(bookId, durationMs);
      let sfxTrack = tracks.find(t => t.type === 'sfx');
      if (!sfxTrack) sfxTrack = await timelineApi.createTrack(bookId, { name: 'SFX', type: 'sfx' }) as any;
      if (!sfxTrack) throw new Error('Failed to create track');
      await timelineApi.createClip(bookId, sfxTrack.id, {
        audio_asset_id: result.audio_asset_id, position_ms: playheadMs, notes: `Silence ${durationMs}ms`,
      });
      setShowSilenceMenu(false); skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Insert silence failed: ${err.message}`); }
    finally { setInsertingSilence(false); }
  };

  // ── Import Audio ──
  const handleImportAudio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !bookId) return;
    setImporting(true);
    try {
      const result = await uploadAudio(bookId, file, file.name);
      let importTrack = tracks.find(t => t.type === 'imported');
      if (!importTrack) importTrack = await timelineApi.createTrack(bookId, { name: 'Imported', type: 'imported' });
      if (!importTrack) throw new Error('Failed to create track');
      await timelineApi.createClip(bookId, importTrack.id, {
        audio_asset_id: result.audio_asset_id, position_ms: playheadMs, notes: file.name.replace(/\.[^.]+$/, ''),
      });
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Import failed: ${err.message}`); }
    finally { setImporting(false); if (importFileRef.current) importFileRef.current.value = ''; }
  };

  const selectedClip = selectedClipId ? findClip(selectedClipId) : null;
  const selectedTrack = selectedClip ? tracks.find(t => t.clips.some(c => c.id === selectedClipId)) : null;
  const timelineWidth = totalDuration() * pxPerMs;

  // ── Ruler tick generation ──
  const rulerTicks = () => {
    const ticks: { ms: number; label: string; major: boolean }[] = [];
    const stepMs = pxPerMs > 0.1 ? 1000 : pxPerMs > 0.02 ? 5000 : 10000;
    for (let ms = 0; ms < totalDuration(); ms += stepMs) {
      const sec = ms / 1000;
      const label = sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
      ticks.push({ ms, label, major: ms % (stepMs * 5) === 0 });
    }
    return ticks;
  };

  // ── RENDER ──
  return (
    <div className="tl-root">
      {/* ── Modern Transport Bar ── */}
      <div className="tl-transport">
        <div className="tl-transport-left">
          <div className="tl-transport-playback">
            <button className={`tl-btn tl-btn-play ${playing ? 'active' : ''}`} onClick={togglePlay} title="Space (Play/Pause)">
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button className="tl-btn tl-btn-secondary" onClick={() => seekTo(0)} title="Home (Go to start)"><SkipBack size={16} /></button>
            <div className="tl-time-display">
              <div className="tl-time-current">{formatTimeExtended(playheadMs, timeFormat)}</div>
              <div className="tl-time-total">/ {formatTimeExtended(totalDuration(), timeFormat)}</div>
            </div>
          </div>
          
          <div className="tl-transport-tools">
            <div className={`tl-tool-btn ${activeTool === 'select' ? 'active' : ''}`} onClick={() => setActiveTool('select')} title="Select Tool (V)">
              <Move size={14} />
            </div>
            <div className={`tl-tool-btn ${activeTool === 'split' ? 'active' : ''}`} onClick={() => setActiveTool('split')} title="Split Tool (S)">
              <Scissors size={14} />
            </div>
            <div className={`tl-tool-btn ${activeTool === 'fade' ? 'active' : ''}`} onClick={() => setActiveTool('fade')} title="Fade Tool (F)">
              <Waves size={14} />
            </div>
            <div className={`tl-tool-btn ${activeTool === 'zoom' ? 'active' : ''}`} onClick={() => setActiveTool('zoom')} title="Zoom Tool (Z)">
              <ZoomIn size={14} />
            </div>
          </div>
        </div>

        <div className="tl-transport-center">
          <div className="tl-transport-controls">
            <div className="tl-control-group">
              <button className="tl-btn tl-btn-icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
              <button className="tl-btn tl-btn-icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)"><Redo2 size={14} /></button>
            </div>
            
            <div className="tl-control-group">
              <button className={`tl-btn tl-btn-icon ${snapEnabled ? 'active' : ''}`} onClick={() => setSnapEnabled(p => !p)} title="Snap (G)">
                <Magnet size={14} />
              </button>
              <button className={`tl-btn tl-btn-icon ${rippleMode ? 'active' : ''}`} onClick={() => setRippleMode(p => !p)} title="Ripple (R)">
                <Layers size={14} />
              </button>
              <button className={`tl-btn tl-btn-icon ${gridVisible ? 'active' : ''}`} onClick={() => setGridVisible(p => !p)} title="Grid (Ctrl+G)">
                <Grid size={14} />
              </button>
              <button className={`tl-btn tl-btn-icon ${waveformVisible ? 'active' : ''}`} onClick={() => setWaveformVisible(p => !p)} title="Waveforms (W)">
                <BarChart3 size={14} />
              </button>
            </div>
            
            <div className="tl-control-group">
              <button className="tl-btn tl-btn-icon" onClick={zoomOut} title="Zoom Out (-)"><ZoomOut size={14} /></button>
              <div className="tl-zoom-level">{Math.round(pxPerMs * 1000)}%</div>
              <button className="tl-btn tl-btn-icon" onClick={zoomIn} title="Zoom In (+)"><ZoomIn size={14} /></button>
            </div>
            
            <div className="tl-control-group">
              <button className="tl-btn tl-btn-icon" onClick={() => setShowQuickAdd(!showQuickAdd)} title="Generate SFX/Music">
                <Wand2 size={14} />
              </button>
              <button className="tl-btn tl-btn-icon" onClick={() => importFileRef.current?.click()} disabled={importing} title="Import Audio">
                <Upload size={14} />
              </button>
              <button className="tl-btn tl-btn-icon" onClick={() => setShowSilenceMenu(!showSilenceMenu)} title="Insert Silence">
                <Clock size={14} />
              </button>
              <button className={`tl-btn tl-btn-icon ${showAdvancedPanel ? 'active' : ''}`} onClick={() => setShowAdvancedPanel(p => !p)} title="Advanced Tools">
                <Sliders size={14} />
              </button>
            </div>
          </div>
          
          <div className="tl-transport-progress">
            <div className="tl-progress-bar" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const clickX = e.clientX - rect.left;
              const percentage = clickX / rect.width;
              seekTo(totalDuration() * percentage);
            }}>
              <div className="tl-progress-fill" style={{ width: `${(playheadMs / totalDuration()) * 100}%` }} />
              <div className="tl-progress-playhead" style={{ left: `${(playheadMs / totalDuration()) * 100}%` }} />
            </div>
          </div>
        </div>

        <div className="tl-transport-right">
          <div className="tl-transport-actions">
            <button className="tl-btn tl-btn-primary" onClick={handleSave} disabled={saving}>
              <Save size={14} /> {saving ? 'Saving...' : 'Save'}
            </button>
            {bookId && (
              <a href={downloadProjectUrl(bookId)} className="tl-btn tl-btn-secondary" download title="Download Project">
                <Download size={14} />
              </a>
            )}
            <button className="tl-btn tl-btn-accent" onClick={handleRender} disabled={rendering}>
              {rendering ? <Loader size={14} className="spinner" /> : <Play size={14} />} Render
            </button>
            <button className="tl-btn tl-btn-icon" onClick={() => setShowHelp(true)} title="Keyboard Shortcuts (?)">
              <HelpCircle size={14} />
            </button>
            <button className="tl-btn tl-btn-icon" onClick={() => setShowMiniMap(p => !p)} title="Minimap">
              {showMiniMap ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Quick Add Panel ── */}
      {showQuickAdd && (
        <div className="tl-panel">
          <select value={quickType} onChange={e => setQuickType(e.target.value as 'sfx' | 'music')} className="tl-select" aria-label="Type">
            <option value="sfx">SFX</option><option value="music">Music</option>
          </select>
          <input value={quickPrompt} onChange={e => setQuickPrompt(e.target.value)} placeholder="Describe the sound..."
            className="tl-input" onKeyDown={e => { if (e.key === 'Enter') handleQuickAdd(); }} aria-label="Prompt" />
          <button className="tl-btn tl-btn-accent" onClick={handleQuickAdd} disabled={quickGenerating || !quickPrompt.trim()}>
            {quickGenerating ? <Loader size={12} className="spinner" /> : <Plus size={12} />} {quickGenerating ? 'Generating...' : 'Add at Playhead'}
          </button>
        </div>
      )}

      {/* ── Silence Panel ── */}
      {showSilenceMenu && (
        <div className="tl-panel">
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Insert silence:</span>
          {[500, 1000, 2000, 3000, 5000].map(ms => (
            <button key={ms} className="tl-btn tl-btn-sm" onClick={() => handleInsertSilence(ms)} disabled={insertingSilence}>
              {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
            </button>
          ))}
          <input type="number" min={100} max={30000} step={100} value={silenceDuration}
            onChange={e => setSilenceDuration(parseInt(e.target.value) || 1000)} className="tl-input" style={{ width: 80 }} aria-label="Custom duration" />
          <button className="tl-btn tl-btn-accent" onClick={() => handleInsertSilence(silenceDuration)} disabled={insertingSilence}>
            {insertingSilence ? <Loader size={12} className="spinner" /> : <Clock size={12} />} Insert
          </button>
        </div>
      )}

      {/* ── Advanced Panel ── */}
      {showAdvancedPanel && (
        <div className="tl-panel tl-panel-advanced">
          <div className="tl-adv-section">
            <span className="tl-adv-label">Snap Grid</span>
            <div className="tl-btn-group">
              {[50, 100, 250, 500, 1000].map(ms => (
                <button key={ms} className={`tl-btn tl-btn-sm ${snapGridMs === ms ? 'active' : ''}`} onClick={() => setSnapGridMs(ms)}>{ms}ms</button>
              ))}
            </div>
          </div>
          <div className="tl-adv-section">
            <span className="tl-adv-label">Selection ({selectedClipIds.size})</span>
            <div className="tl-btn-group">
              <button className="tl-btn tl-btn-sm" onClick={handleBatchDelete} disabled={selectedClipIds.size === 0}><Trash2 size={10} /> Delete</button>
              <button className="tl-btn tl-btn-sm" onClick={handleCrossfade} disabled={selectedClipIds.size !== 2}><GitMerge size={10} /> Crossfade</button>
              <button className="tl-btn tl-btn-sm" onClick={() => handleBatchGainAdjust(-3)} disabled={selectedClipIds.size === 0}>-3dB</button>
              <button className="tl-btn tl-btn-sm" onClick={() => handleBatchGainAdjust(3)} disabled={selectedClipIds.size === 0}>+3dB</button>
              <button className="tl-btn tl-btn-sm" onClick={clearMultiSelect} disabled={selectedClipIds.size === 0}>Clear</button>
            </div>
          </div>
          <div className="tl-adv-section">
            <span className="tl-adv-label">Track Ops</span>
            <div className="tl-btn-group" style={{ flexWrap: 'wrap' }}>
              {tracks.map(t => (
                <React.Fragment key={t.id}>
                  <span style={{ fontSize: 10, color: getTrackColor(t.type).text, minWidth: 50 }}>{t.name}:</span>
                  <button className="tl-btn tl-btn-sm" onClick={() => handleNormalizeTrack(t.id)}><Sliders size={10} /> Norm</button>
                  <button className="tl-btn tl-btn-sm" onClick={() => handleCloseGaps(t.id, 300)}><AlignLeft size={10} /> Gaps</button>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Main Timeline Area ── */}
      <div className="tl-body" onWheel={handleWheel}>
        {/* Track Headers */}
        <div className="tl-headers">
          <div className="tl-header-ruler">
            <div style={{ position: 'relative' }}>
              <button className="tl-btn tl-btn-add" onClick={() => setShowAddTrackMenu(p => !p)}>
                <Plus size={12} /> Track
              </button>
              {showAddTrackMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 15 }} onClick={() => setShowAddTrackMenu(false)} />
                  <div className="tl-add-menu">
                    {['narration', 'sfx', 'music', 'dialogue', 'imported'].map(type => (
                      <button key={type} className="tl-add-item" onClick={() => addTrack(type)}>
                        <span style={{ color: getTrackColor(type).text }}>{TRACK_ICONS[type]}</span>
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          {tracks.map(track => {
            const tc = getTrackColor(track.type);
            return (
              <div key={track.id} className="tl-header" style={{ borderLeftColor: tc.text }}>
                <div className="tl-header-top">
                  <span className="tl-header-icon" style={{ color: tc.text }}>{TRACK_ICONS[track.type]}</span>
                  <span className="tl-header-name" style={{ color: track.muted ? 'var(--text-muted)' : 'var(--text-primary)' }}>{track.name}</span>
                  <div className="tl-header-actions">
                    <button className={`tl-btn-icon ${track.muted ? 'muted' : ''}`} onClick={() => toggleMute(track.id)} title={track.muted ? 'Unmute' : 'Mute'}>
                      {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                    </button>
                    <button className="tl-btn-icon danger" onClick={() => deleteTrack(track.id)} title="Delete"><Trash2 size={12} /></button>
                  </div>
                </div>
                <div className="tl-header-vol">
                  <input type="range" min={-20} max={6} step={0.5} value={track.gain}
                    onChange={e => updateTrackGain(track.id, parseFloat(e.target.value))}
                    title={`${track.gain > 0 ? '+' : ''}${track.gain.toFixed(1)} dB`}
                    aria-label={`${track.name} volume`} />
                  <span className="tl-header-db">{track.gain > 0 ? '+' : ''}{track.gain.toFixed(1)}</span>
                </div>
                {track.type === 'music' && (
                  <div className="tl-header-duck">
                    <label>
                      <input type="checkbox" checked={!!track.ducking_enabled}
                        onChange={e => timelineApi.updateTrack(bookId!, track.id, { ducking_enabled: e.target.checked ? 1 : 0 }).then(() => { skipSnap.current = true; loadTracks(); })} />
                      Duck
                    </label>
                    {!!track.ducking_enabled && (
                      <>
                        <input type="range" min={-24} max={0} step={1} value={track.duck_amount_db ?? -12}
                          onChange={e => timelineApi.updateTrack(bookId!, track.id, { duck_amount_db: parseFloat(e.target.value) }).then(() => { skipSnap.current = true; loadTracks(); })}
                          aria-label="Duck amount" />
                        <span>{track.duck_amount_db ?? -12}dB</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Scrollable Timeline */}
        <div className="tl-scroll" ref={scrollContainerRef}>
          <div className="tl-timeline" ref={timelineRef} style={{ width: timelineWidth }} onClick={handleTimelineClick}>
            {/* Ruler */}
            <div className="tl-ruler" onClick={handleRulerClick} style={{ width: timelineWidth }}>
              {rulerTicks().map(tick => (
                <div key={tick.ms} className={`tl-tick ${tick.major ? 'major' : ''}`} style={{ left: tick.ms * pxPerMs }}>
                  <div className="tl-tick-line" />
                  <span className="tl-tick-label">{tick.label}</span>
                </div>
              ))}
            </div>

            {/* Track Lanes */}
            {tracks.map(track => {
              const tc = getTrackColor(track.type);
              return (
                <div key={track.id} className="tl-lane" data-timeline-area="true"
                  style={{ height: TRACK_H, background: tc.bg, borderBottomColor: tc.border }}>
                  {/* Chapter markers */}
                  {markers.map(m => (
                    <div key={m.id} className="tl-marker" style={{ left: m.position_ms * pxPerMs }}>
                      <span className="tl-marker-label">{m.label}</span>
                    </div>
                  ))}

                  {/* Clips */}
                  {track.clips.map(clip => {
                    const dur = getClipDuration(clip);
                    const left = clip.position_ms * pxPerMs;
                    const width = dur * pxPerMs;
                    const isSelected = clip.id === selectedClipId;
                    const isMultiSel = selectedClipIds.has(clip.id);
                    const isHovered = clip.id === hoveredClipId;
                    const label = clip.notes || (clip as any).character_name || (clip as any).segment_text?.slice(0, 50) || clip.audio_asset_id.slice(0, 8);
                    const spd = clip.speed ?? 1.0;

                    return (
                      <div key={clip.id}
                        className={`tl-clip ${isSelected ? 'selected' : ''} ${isMultiSel ? 'multi' : ''} ${isHovered ? 'hovered' : ''}`}
                        style={{
                          left, width: Math.max(width, 4),
                          '--clip-color': tc.clip,
                          '--clip-hover': tc.clipHover,
                          '--clip-border': tc.text,
                        } as React.CSSProperties}
                        onMouseDown={e => handleClipMouseDown(e, clip, track, 'move')}
                        onMouseEnter={() => setHoveredClipId(clip.id)}
                        onMouseLeave={() => setHoveredClipId(null)}
                        onContextMenu={e => handleClipContextMenu(e, clip, track)}
                      >
                        {/* Trim handles */}
                        <div className="tl-clip-handle left" onMouseDown={e => handleClipMouseDown(e, clip, track, 'trimStart')} />
                        <div className="tl-clip-handle right" onMouseDown={e => handleClipMouseDown(e, clip, track, 'trimEnd')} />

                        {/* Clip content */}
                        <div className="tl-clip-body">
                          <span className="tl-clip-label">{label}</span>
                          {spd !== 1.0 && <span className="tl-clip-speed">{spd.toFixed(1)}x</span>}
                        </div>

                        {/* Volume bar */}
                        <div className="tl-clip-vol">
                          <div className="tl-clip-vol-fill" style={{
                            width: `${Math.min(100, Math.max(0, ((clip.gain || 0) + 20) / 26 * 100))}%`,
                            background: (clip.gain || 0) > 0 ? 'var(--danger)' : tc.text,
                          }} />
                        </div>

                        {/* Fade indicators */}
                        {clip.fade_in_ms > 0 && (
                          <div className="tl-clip-fade fade-in" style={{ width: Math.min(clip.fade_in_ms * pxPerMs, width / 2) }} />
                        )}
                        {clip.fade_out_ms > 0 && (
                          <div className="tl-clip-fade fade-out" style={{ width: Math.min(clip.fade_out_ms * pxPerMs, width / 2) }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* Playhead */}
            <div className="tl-playhead" style={{ left: playheadMs * pxPerMs }}>
              <div className="tl-playhead-head" />
              <div className="tl-playhead-line" style={{ height: RULER_H + tracks.length * TRACK_H }} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Clip Inspector ── */}
      {selectedClip && selectedTrack && (
        <div className="tl-inspector">
          <div className="tl-insp-header">
            <h4>Clip Inspector</h4>
            <button className="tl-btn-icon" onClick={() => setSelectedClipId(null)}><X size={14} /></button>
          </div>
          <div className="tl-insp-row"><span>Position</span><span>{formatTime(selectedClip.position_ms)}</span></div>
          <div className="tl-insp-row"><span>Duration</span><span>{formatTime(getClipDuration(selectedClip))}</span></div>
          <div className="tl-insp-row"><span>Track</span><span style={{ color: getTrackColor(selectedTrack.type).text }}>{selectedTrack.name}</span></div>

          <div className="tl-insp-section">
            <label className="tl-insp-label">Volume: {(selectedClip.gain || 0) > 0 ? '+' : ''}{(selectedClip.gain || 0).toFixed(1)} dB</label>
            <input type="range" min={-20} max={6} step={0.5} value={selectedClip.gain || 0}
              onChange={e => updateClipProperty(selectedClip.id, { gain: parseFloat(e.target.value) })} aria-label="Clip volume" />
            <div className="tl-insp-range-labels"><span>-20</span><span>0</span><span>+6</span></div>
          </div>
          <div className="tl-insp-section">
            <label className="tl-insp-label">Speed: {(selectedClip.speed ?? 1.0).toFixed(2)}x</label>
            <input type="range" min={0.25} max={2.0} step={0.05} value={selectedClip.speed ?? 1.0}
              onChange={e => updateClipProperty(selectedClip.id, { speed: parseFloat(e.target.value) })} aria-label="Clip speed" />
            <div className="tl-insp-range-labels"><span>0.25x</span><span>1.0x</span><span>2.0x</span></div>
          </div>
          <div className="tl-insp-section">
            <label className="tl-insp-label">Fade In: {selectedClip.fade_in_ms || 0}ms</label>
            <input type="range" min={0} max={5000} step={50} value={selectedClip.fade_in_ms || 0}
              onChange={e => updateClipProperty(selectedClip.id, { fade_in_ms: parseInt(e.target.value) })} aria-label="Fade in" />
          </div>
          <div className="tl-insp-section">
            <label className="tl-insp-label">Fade Out: {selectedClip.fade_out_ms || 0}ms</label>
            <input type="range" min={0} max={5000} step={50} value={selectedClip.fade_out_ms || 0}
              onChange={e => updateClipProperty(selectedClip.id, { fade_out_ms: parseInt(e.target.value) })} aria-label="Fade out" />
          </div>

          <div className="tl-insp-presets">
            <button onClick={() => updateClipProperty(selectedClip.id, { gain: 0, speed: 1.0, fade_in_ms: 0, fade_out_ms: 0 })}>Reset</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 0.75 })}>0.75x</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 1.0 })}>1.0x</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 1.25 })}>1.25x</button>
            <button onClick={() => updateClipProperty(selectedClip.id, { speed: 1.5 })}>1.5x</button>
          </div>

          {previewAudioUrl && <audio src={previewAudioUrl} controls style={{ width: '100%', height: 28, marginTop: 8 }} />}

          <div className="tl-insp-actions">
            <button onClick={() => splitClip(selectedClip.id)}><Scissors size={11} /> Split</button>
            <button onClick={() => duplicateClip(selectedClip.id)}><Copy size={11} /> Dup</button>
            <button onClick={() => copyClip(selectedClip.id, false)}><Copy size={11} /> Copy</button>
            <button onClick={() => copyClip(selectedClip.id, true)}><Scissors size={11} /> Cut</button>
            <button className="danger" onClick={() => deleteClip(selectedClip.id)}><Trash2 size={11} /> Del</button>
          </div>
        </div>
      )}

      {/* ── Context Menu ── */}
      {contextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 15 }} onClick={() => setContextMenu(null)} />
          <div className="tl-ctx" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button onClick={() => { splitClip(contextMenu.clipId); setContextMenu(null); }}><Scissors size={12} /> Split at Playhead</button>
            <button onClick={() => { duplicateClip(contextMenu.clipId); setContextMenu(null); }}><Copy size={12} /> Duplicate</button>
            <button onClick={() => { copyClip(contextMenu.clipId, false); setContextMenu(null); }}><Copy size={12} /> Copy</button>
            <button onClick={() => { copyClip(contextMenu.clipId, true); setContextMenu(null); }}><Scissors size={12} /> Cut</button>
            {clipboardData && <button onClick={() => { pasteClip(contextMenu.trackId); setContextMenu(null); }}><Clipboard size={12} /> Paste</button>}
            <div className="tl-ctx-divider" />
            <button onClick={() => { toggleMultiSelect(contextMenu.clipId); setContextMenu(null); }}>
              <Layers size={12} /> {selectedClipIds.has(contextMenu.clipId) ? 'Deselect' : 'Add to Selection'}
            </button>
            {selectedClipIds.size === 2 && <button onClick={() => { handleCrossfade(); setContextMenu(null); }}><GitMerge size={12} /> Crossfade</button>}
            {selectedClipIds.size > 0 && <button className="danger" onClick={() => { handleBatchDelete(); setContextMenu(null); }}><Trash2 size={12} /> Delete Selected ({selectedClipIds.size})</button>}
            <div className="tl-ctx-divider" />
            <button className="danger" onClick={() => { deleteClip(contextMenu.clipId); setContextMenu(null); }}><Trash2 size={12} /> Delete</button>
          </div>
        </>
      )}

      {showHelp && <KeyboardShortcutsDialog onClose={() => setShowHelp(false)} />}

      <style>{timelineStyles + timelineStyles2 + timelineStyles3}</style>
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

function formatTimeExtended(ms: number, format: 'mm:ss' | 'hh:mm:ss' | 'frames' = 'mm:ss'): string {
  const totalSeconds = ms / 1000;
  
  if (format === 'frames') {
    const fps = 30; // Standard video frame rate
    const totalFrames = Math.round(totalSeconds * fps);
    const minutes = Math.floor(totalFrames / (fps * 60));
    const seconds = Math.floor((totalFrames % (fps * 60)) / fps);
    const frames = totalFrames % fps;
    return `${minutes}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
  }
  
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((ms % 1000) / 10);
  
  if (format === 'hh:mm:ss') {
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  
  // mm:ss format
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}`;
}

const timelineStyles = `
/* ── Root ── */
.tl-root {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  overflow: hidden;
  background: var(--bg-deep);
}

/* ── Modern Transport Bar ── */
.tl-transport {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-deep) 100%);
  border-bottom: 1px solid var(--border-strong);
  gap: 16px;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 20;
}

.tl-transport-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 280px;
}

.tl-transport-playback {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  padding: 6px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-default);
}

.tl-btn-play {
  width: 40px;
  height: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  color: white;
  border: none;
  box-shadow: 0 2px 8px rgba(91, 141, 239, 0.3);
  transition: all 0.2s ease;
}

.tl-btn-play:hover:not(:disabled) {
  transform: scale(1.05);
  box-shadow: 0 4px 12px rgba(91, 141, 239, 0.4);
}

.tl-btn-play.active {
  background: linear-gradient(135deg, var(--warning), #dc2626);
}

.tl-btn-secondary {
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
}

.tl-time-display {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
  margin-left: 8px;
}

.tl-time-current {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.5px;
}

.tl-time-total {
  font-size: 12px;
  color: var(--text-tertiary);
  opacity: 0.7;
}

.tl-transport-tools {
  display: flex;
  gap: 4px;
  background: var(--bg-elevated);
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--border-default);
}

.tl-tool-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.tl-tool-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tl-tool-btn.active {
  background: var(--accent-subtle);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px rgba(91, 141, 239, 0.2);
}

.tl-transport-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.tl-transport-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.tl-control-group {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-elevated);
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--border-default);
}

.tl-btn-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tl-btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tl-btn-icon.active {
  background: var(--accent-subtle);
  color: var(--accent);
}

.tl-zoom-level {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  min-width: 40px;
  text-align: center;
  font-family: 'SF Mono', monospace;
}

.tl-transport-progress {
  width: 100%;
  height: 6px;
}

.tl-progress-bar {
  width: 100%;
  height: 100%;
  background: var(--bg-deep);
  border-radius: 3px;
  position: relative;
  cursor: pointer;
  overflow: hidden;
}

.tl-progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  border-radius: 3px;
}

.tl-progress-playhead {
  position: absolute;
  top: 0;
  width: 2px;
  height: 100%;
  background: white;
  box-shadow: 0 0 4px rgba(255, 255, 255, 0.8);
  transform: translateX(-1px);
  z-index: 2;
}

.tl-transport-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 200px;
  justify-content: flex-end;
}

.tl-transport-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tl-btn-primary {
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 500;
  font-size: 13px;
  box-shadow: 0 2px 6px rgba(91, 141, 239, 0.3);
}

.tl-btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(91, 141, 239, 0.4);
}

.tl-btn-accent {
  background: linear-gradient(135deg, var(--success), #16a34a);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 500;
  font-size: 13px;
  box-shadow: 0 2px 6px rgba(34, 197, 94, 0.3);
}

.tl-btn-accent:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(34, 197, 94, 0.4);
}

/* ── Buttons ── */
.tl-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  text-decoration: none;
  line-height: 1;
}
.tl-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.tl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.tl-btn.active { background: var(--accent-subtle); color: var(--accent); border-color: rgba(91,141,239,0.3); }

.tl-btn-play {
  width: 36px; height: 36px;
  padding: 0;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  border: none;
}
.tl-btn-play:hover:not(:disabled) { background: var(--accent-hover); color: #fff; border: none; }
.tl-btn-play.active { background: var(--warning); }

.tl-btn-render {
  background: rgba(34,197,94,0.15);
  color: var(--success);
  border-color: rgba(34,197,94,0.3);
}
.tl-btn-render:hover:not(:disabled) { background: rgba(34,197,94,0.25); color: var(--success); }

.tl-btn-accent {
  background: var(--accent);
  color: #fff;
  border: none;
  font-weight: 500;
}
.tl-btn-accent:hover:not(:disabled) { background: var(--accent-hover); color: #fff; }

.tl-btn-sm { padding: 4px 8px; font-size: 11px; border-radius: 6px; }

.tl-toggle.on {
  background: var(--accent-subtle);
  color: var(--accent);
  border-color: rgba(91,141,239,0.3);
}

.tl-btn-group { display: flex; gap: 3px; align-items: center; }

.tl-btn-icon {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}
.tl-btn-icon:hover { color: var(--text-primary); background: var(--bg-hover); }
.tl-btn-icon.muted { color: var(--warning); }
.tl-btn-icon.danger:hover { color: var(--danger); }

.tl-btn-add {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 6px;
}

/* ── Panels ── */
.tl-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  flex-wrap: wrap;
  flex-shrink: 0;
}
.tl-panel-advanced { flex-direction: column; align-items: flex-start; gap: 10px; }
.tl-adv-section { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tl-adv-label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; min-width: 80px; }

.tl-select {
  padding: 6px 28px 6px 10px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  font-size: 12px;
}
.tl-input {
  flex: 1;
  min-width: 120px;
  padding: 6px 12px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  font-size: 12px;
  outline: none;
}

/* ── Add Track Menu ── */
.tl-add-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 4px;
  z-index: 20;
  min-width: 140px;
  box-shadow: var(--shadow-lg);
}
.tl-add-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
  text-align: left;
}
.tl-add-item:hover { background: var(--bg-hover); color: var(--text-primary); }

`;
const timelineStyles2 = `
/* ── Body Layout ── */
.tl-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ── Track Headers ── */
.tl-headers {
  width: 200px;
  flex-shrink: 0;
  background: var(--bg-base);
  border-right: 1px solid var(--border-default);
  overflow-y: auto;
  overflow-x: hidden;
}
.tl-header-ruler {
  height: ${RULER_H}px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-surface);
}
.tl-header {
  height: ${TRACK_H}px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
  border-left: 3px solid transparent;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}
.tl-header-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tl-header-icon { display: flex; align-items: center; flex-shrink: 0; }
.tl-header-name {
  font-size: 12px;
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-header-actions { display: flex; gap: 2px; margin-left: auto; }
.tl-header-vol {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tl-header-vol input[type="range"] { flex: 1; height: 3px; }
.tl-header-db { font-size: 9px; color: var(--text-muted); min-width: 28px; text-align: right; font-family: monospace; }
.tl-header-duck {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  color: var(--text-muted);
}
.tl-header-duck label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
.tl-header-duck input[type="range"] { flex: 1; height: 2px; }

/* ── Scrollable Timeline ── */
.tl-scroll {
  flex: 1;
  overflow-x: auto;
  overflow-y: auto;
  position: relative;
}
.tl-timeline {
  position: relative;
  min-height: 100%;
}

/* ── Ruler ── */
.tl-ruler {
  height: ${RULER_H}px;
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  cursor: pointer;
  user-select: none;
}
.tl-tick {
  position: absolute;
  top: 0;
  height: 100%;
}
.tl-tick-line {
  width: 1px;
  height: 10px;
  background: var(--border-strong);
  position: absolute;
  bottom: 0;
}
.tl-tick.major .tl-tick-line { height: 16px; background: var(--text-muted); }
.tl-tick-label {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 10px;
  font-family: monospace;
  color: var(--text-tertiary);
  white-space: nowrap;
  pointer-events: none;
}
.tl-tick.major .tl-tick-label { color: var(--text-secondary); }

/* ── Track Lanes ── */
.tl-lane {
  position: relative;
  border-bottom: 1px solid;
  overflow: visible;
}

/* ── Chapter Markers ── */
.tl-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(251,146,60,0.2);
  pointer-events: none;
  z-index: 1;
}
.tl-marker-label {
  position: absolute;
  top: 2px;
  left: 4px;
  font-size: 9px;
  color: rgba(251,146,60,0.6);
  white-space: nowrap;
  pointer-events: none;
}

/* ── Clips ── */
.tl-clip {
  position: absolute;
  top: 6px;
  bottom: 6px;
  border-radius: 6px;
  background: var(--clip-color);
  border: 1px solid transparent;
  cursor: grab;
  user-select: none;
  overflow: hidden;
  z-index: 2;
  transition: border-color 100ms, box-shadow 100ms;
}
.tl-clip:hover, .tl-clip.hovered {
  background: var(--clip-hover);
  border-color: var(--clip-border);
}
.tl-clip.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 0 12px rgba(91,141,239,0.2);
  z-index: 3;
}
.tl-clip.multi {
  border-color: var(--purple);
  border-style: dashed;
}
.tl-clip:active { cursor: grabbing; }

/* Clip trim handles */
.tl-clip-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 4;
  opacity: 0;
  transition: opacity 100ms;
}
.tl-clip-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  border-radius: 2px;
  background: rgba(255,255,255,0.6);
}
.tl-clip-handle.left { left: 0; }
.tl-clip-handle.left::after { left: 2px; }
.tl-clip-handle.right { right: 0; }
.tl-clip-handle.right::after { right: 2px; }
.tl-clip:hover .tl-clip-handle,
.tl-clip.selected .tl-clip-handle { opacity: 1; }

/* Clip body */
.tl-clip-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  height: 100%;
  gap: 4px;
  pointer-events: none;
}
.tl-clip-label {
  font-size: 11px;
  font-weight: 500;
  color: rgba(255,255,255,0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}
.tl-clip-speed {
  font-size: 9px;
  font-weight: 600;
  color: var(--warning);
  background: rgba(0,0,0,0.3);
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}

/* Volume bar at bottom of clip */
.tl-clip-vol {
  position: absolute;
  bottom: 2px;
  left: 4px;
  right: 4px;
  height: 2px;
  background: rgba(255,255,255,0.06);
  border-radius: 1px;
  pointer-events: none;
}
.tl-clip-vol-fill {
  height: 100%;
  border-radius: 1px;
  opacity: 0.6;
}

/* Fade indicators */
.tl-clip-fade {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: none;
}
.tl-clip-fade.fade-in {
  left: 0;
  background: linear-gradient(to right, rgba(255,255,255,0.12), transparent);
  border-right: 1px dashed rgba(255,255,255,0.15);
}
.tl-clip-fade.fade-out {
  right: 0;
  background: linear-gradient(to left, rgba(255,255,255,0.12), transparent);
  border-left: 1px dashed rgba(255,255,255,0.15);
}

/* ── Playhead ── */
.tl-playhead {
  position: absolute;
  top: 0;
  z-index: 10;
  pointer-events: none;
}
.tl-playhead-head {
  width: 12px;
  height: 12px;
  background: #ef4444;
  border-radius: 2px 2px 0 0;
  transform: translateX(-6px);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
.tl-playhead-line {
  width: 2px;
  background: #ef4444;
  transform: translateX(-1px);
  box-shadow: 0 0 6px rgba(239,68,68,0.4);
}

`;
const timelineStyles3 = `
/* ── Inspector ── */
.tl-inspector {
  position: absolute;
  right: 16px;
  top: 64px;
  width: 240px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  padding: 16px;
  z-index: 10;
  max-height: calc(100vh - 160px);
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
}
.tl-insp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.tl-insp-header h4 { color: var(--text-primary); font-size: 13px; font-weight: 600; margin: 0; }
.tl-insp-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-tertiary);
  padding: 3px 0;
}
.tl-insp-row span:last-child { color: var(--text-secondary); font-family: monospace; }
.tl-insp-section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
}
.tl-insp-label { font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 6px; }
.tl-insp-section input[type="range"] { width: 100%; }
.tl-insp-range-labels { display: flex; justify-content: space-between; font-size: 9px; color: var(--text-muted); margin-top: 2px; }
.tl-insp-presets {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.tl-insp-presets button {
  padding: 4px 8px;
  background: var(--bg-elevated);
  color: var(--text-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  cursor: pointer;
  font-size: 10px;
}
.tl-insp-presets button:hover { color: var(--text-primary); border-color: var(--border-default); }
.tl-insp-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.tl-insp-actions button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
}
.tl-insp-actions button:hover { color: var(--text-primary); border-color: var(--border-default); }
.tl-insp-actions button.danger { color: var(--danger); }
.tl-insp-actions button.danger:hover { background: var(--danger-subtle); }

/* ── Context Menu ── */
.tl-ctx {
  position: fixed;
  z-index: 20;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 4px;
  min-width: 180px;
  box-shadow: var(--shadow-lg);
}
.tl-ctx button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
  text-align: left;
}
.tl-ctx button:hover { background: var(--bg-hover); color: var(--text-primary); }
.tl-ctx button.danger { color: var(--danger); }
.tl-ctx button.danger:hover { background: var(--danger-subtle); }
.tl-ctx-divider { height: 1px; background: var(--border-subtle); margin: 2px 8px; }

/* ── Empty state ── */
.tl-lane:empty::after {
  content: 'Drop or add clips here';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 11px;
  color: var(--text-muted);
  pointer-events: none;
}
`;
