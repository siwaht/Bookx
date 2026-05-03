import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl, render, saveProject, downloadProjectUrl, uploadAudio, audioAssets } from '../services/api';
import { toast } from '../components/Toast';
import { KeyboardShortcutsDialog } from '../components/KeyboardShortcutsDialog';
import type { Track, Clip, ChapterMarker, AutomationPoint } from '../types';
import {
  Play, Pause, SkipBack, ZoomIn, ZoomOut, Plus, Trash2, Volume2, VolumeX,
  Save, Download, Scissors, Copy, Clipboard, Undo2, Redo2, HelpCircle, X,
  Wand2, Loader, Upload, Clock, Magnet, Layers, GitMerge, AlignLeft, Sliders,
  Music, Mic, Zap, Grid, Type, FileAudio, Lock, Unlock, Repeat,
  Move, Waves, BarChart3,
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
  // Perf: DOM refs avoid React re-renders during playback
  const playheadElRef = useRef<HTMLDivElement>(null);
  const pxPerMsRef = useRef(0.05);
  const autoScrollRef = useRef(true);
  const inspSaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gainDebounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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
  const [activeTool, setActiveTool] = useState<'select' | 'split' | 'fade' | 'zoom'>('select');
  const [timeFormat] = useState<'mm:ss' | 'hh:mm:ss' | 'frames'>('mm:ss');
  const [autoScroll] = useState(true);

  // Loop region (A/B playback)
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopInMs, setLoopInMs] = useState<number | null>(null);
  const [loopOutMs, setLoopOutMs] = useState<number | null>(null);
  const loopRef = useRef<{ enabled: boolean; inMs: number | null; outMs: number | null }>({ enabled: false, inMs: null, outMs: null });
  useEffect(() => { loopRef.current = { enabled: loopEnabled, inMs: loopInMs, outMs: loopOutMs }; }, [loopEnabled, loopInMs, loopOutMs]);

  // Scrub state — used to show subtle UI feedback during ruler drag
  const [scrubbing, setScrubbing] = useState(false);

  // Inspector docking state — collapsed shows a thin gutter
  const [inspectorOpen, setInspectorOpen] = useState(true);

  // Automation points per track (for ducking)
  const [automationByTrack, setAutomationByTrack] = useState<Map<string, AutomationPoint[]>>(new Map());

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

  // Load automation points for tracks that have ducking enabled
  const loadAutomation = useCallback(async () => {
    if (!bookId || tracks.length === 0) return;
    const duckingTracks = tracks.filter(t => t.ducking_enabled);
    if (duckingTracks.length === 0) return;
    const newMap = new Map<string, AutomationPoint[]>();
    for (const t of duckingTracks) {
      try {
        const points = await timelineApi.getAutomation(bookId, t.id);
        if (points.length > 0) {
          newMap.set(t.id, points.sort((a: AutomationPoint, b: AutomationPoint) => a.time_ms - b.time_ms));
        }
      } catch {}
    }
    setAutomationByTrack(newMap);
  }, [bookId, tracks]);

  useEffect(() => { loadTracks(); loadMarkers(); }, [loadTracks, loadMarkers]);
  useEffect(() => { loadAutomation(); }, [loadAutomation]);

  // Keep DOM-sync refs up to date without causing re-renders
  useEffect(() => { pxPerMsRef.current = pxPerMs; }, [pxPerMs]);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

  // Cleanup playback timer and audio context on unmount
  useEffect(() => {
    return () => {
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      stopAllAudio();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

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

  // In-flight dedupe — multiple ClipWaveform instances and the parent preload
  // effect can request the same asset concurrently. We share one promise per asset.
  const inFlightLoadsRef = useRef<Map<string, Promise<AudioBuffer | null>>>(new Map());
  const loadAudioBuffer = (assetId: string): Promise<AudioBuffer | null> => {
    const cached = audioBuffersRef.current.get(assetId);
    if (cached) return Promise.resolve(cached);
    const inFlight = inFlightLoadsRef.current.get(assetId);
    if (inFlight) return inFlight;
    const p = (async () => {
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
      } finally {
        inFlightLoadsRef.current.delete(assetId);
      }
    })();
    inFlightLoadsRef.current.set(assetId, p);
    return p;
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
      const trackAutomation = automationByTrack.get(track.id);
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
        const baseGain = Math.pow(10, (trackGainDb + clipGainDb) / 20);
        gainNode.gain.value = baseGain;
        source.playbackRate.value = clip.speed || 1.0;

        // Apply automation points (ducking) if available for this track
        if (trackAutomation && trackAutomation.length > 0) {
          // Schedule gain automation for the duration of this clip
          for (let i = 0; i < trackAutomation.length; i++) {
            const point = trackAutomation[i];
            const pointTimeRelative = (point.time_ms - startMs) / 1000;
            if (pointTimeRelative < -1) continue; // skip points well before playback start
            const scheduleTime = Math.max(0, pointTimeRelative);
            const automatedGain = baseGain * point.value;

            if (point.curve === 'exponential' && automatedGain > 0) {
              gainNode.gain.exponentialRampToValueAtTime(
                Math.max(automatedGain, 0.0001), // exponentialRamp requires > 0
                ctx.currentTime + scheduleTime
              );
            } else {
              gainNode.gain.linearRampToValueAtTime(
                automatedGain,
                ctx.currentTime + scheduleTime
              );
            }
          }
        }

        if (clip.fade_in_ms && clip.fade_in_ms > 0) {
          const fadeStartTime = Math.max(0, (clip.position_ms - startMs) / 1000);
          gainNode.gain.setValueAtTime(0, ctx.currentTime + fadeStartTime);
          gainNode.gain.linearRampToValueAtTime(
            baseGain,
            ctx.currentTime + fadeStartTime + clip.fade_in_ms / 1000
          );
        }
        if (clip.fade_out_ms && clip.fade_out_ms > 0) {
          const fadeOutStart = Math.max(0, (clip.position_ms + clipDur - clip.fade_out_ms - startMs) / 1000);
          const fadeOutEnd = Math.max(0, (clip.position_ms + clipDur - startMs) / 1000);
          if (fadeOutStart > 0) {
            gainNode.gain.setValueAtTime(baseGain, ctx.currentTime + fadeOutStart);
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
      let startMs = playheadMs;
      let startWall = performance.now();
      let lastStateUpdate = startWall;
      const tick = (now: number) => {
        const elapsed = now - startWall;
        let currentMs = startMs + elapsed;

        // Loop region: when enabled and playhead crosses loopOut, jump back to loopIn
        const loop = loopRef.current;
        if (loop.enabled && loop.inMs !== null && loop.outMs !== null && loop.outMs > loop.inMs && currentMs >= loop.outMs) {
          currentMs = loop.inMs;
          startMs = loop.inMs;
          startWall = now;
          lastStateUpdate = now;
          stopAllAudio();
          playFromPosition(loop.inMs);
          setPlayheadMs(currentMs);
        }

        // Move playhead directly in DOM — zero React re-renders during playback
        if (playheadElRef.current) {
          playheadElRef.current.style.left = (currentMs * pxPerMsRef.current) + 'px';
        }

        // Auto-scroll via DOM API (no state needed)
        if (autoScrollRef.current && scrollContainerRef.current) {
          const playheadPx = currentMs * pxPerMsRef.current;
          const container = scrollContainerRef.current;
          const viewLeft = container.scrollLeft;
          const viewRight = viewLeft + container.clientWidth;
          if (playheadPx > viewRight - 100 || playheadPx < viewLeft) {
            container.scrollLeft = playheadPx - container.clientWidth * 0.3;
          }
        }

        // Throttle React state updates to ~10fps — only for time display & progress bar
        if (now - lastStateUpdate >= 100) {
          setPlayheadMs(currentMs);
          lastStateUpdate = now;
        }

        playTimerRef.current = requestAnimationFrame(tick);
      };
      playTimerRef.current = requestAnimationFrame(tick);
    }
  };

  const seekTo = async (ms: number) => {
    const newMs = Math.max(0, ms);
    setPlayheadMs(newMs);
    if (playheadElRef.current) {
      playheadElRef.current.style.left = (newMs * pxPerMsRef.current) + 'px';
    }
    if (playing) {
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      stopAllAudio();
      await playFromPosition(newMs);
      let startMs = newMs;
      let startWall = performance.now();
      let lastStateUpdate = startWall;
      const tick = (now: number) => {
        const elapsed = now - startWall;
        let currentMs = startMs + elapsed;
        // Same loop wrap-around behaviour as togglePlay's tick
        const loop = loopRef.current;
        if (loop.enabled && loop.inMs !== null && loop.outMs !== null && loop.outMs > loop.inMs && currentMs >= loop.outMs) {
          currentMs = loop.inMs;
          startMs = loop.inMs;
          startWall = now;
          lastStateUpdate = now;
          stopAllAudio();
          playFromPosition(loop.inMs);
          setPlayheadMs(currentMs);
        }
        if (playheadElRef.current) {
          playheadElRef.current.style.left = (currentMs * pxPerMsRef.current) + 'px';
        }
        if (autoScrollRef.current && scrollContainerRef.current) {
          const playheadPx = currentMs * pxPerMsRef.current;
          const container = scrollContainerRef.current;
          const viewLeft = container.scrollLeft;
          const viewRight = viewLeft + container.clientWidth;
          if (playheadPx > viewRight - 100 || playheadPx < viewLeft) {
            container.scrollLeft = playheadPx - container.clientWidth * 0.3;
          }
        }
        if (now - lastStateUpdate >= 100) {
          setPlayheadMs(currentMs);
          lastStateUpdate = now;
        }
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
    const newMuted = track.muted ? 0 : 1;
    // Optimistic local update — no round-trip needed for UI
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, muted: newMuted } : t));
    await timelineApi.updateTrack(bookId, trackId, { muted: newMuted });
  };
  const toggleTrackLock = async (trackId: string) => {
    if (!bookId) return;
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;
    const newLocked = track.locked ? 0 : 1;
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, locked: newLocked } : t));
    try { await timelineApi.updateTrack(bookId, trackId, { locked: newLocked }); }
    catch (err: any) {
      // Revert on failure
      setTracks(prev => prev.map(t => t.id === trackId ? { ...t, locked: track.locked } : t));
      toast.error(`Failed to ${newLocked ? 'lock' : 'unlock'} track`);
    }
  };
  const updateTrackGain = (trackId: string, gain: number) => {
    if (!bookId) return;
    // Optimistic local update immediately (smooth slider)
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, gain } : t));
    // Debounce server write — don't hit API on every px of slider drag
    const existing = gainDebounceRef.current.get(trackId);
    if (existing) clearTimeout(existing);
    gainDebounceRef.current.set(trackId, setTimeout(() => {
      timelineApi.updateTrack(bookId, trackId, { gain });
      gainDebounceRef.current.delete(trackId);
    }, 300));
  };

  // ── Clip Actions ──
  const deleteClip = async (clipId: string) => {
    if (!bookId) return;
    if (isClipLocked(clipId)) { toast.error('Track is locked'); return; }
    pushSnapshot(tracks);
    await timelineApi.deleteClip(bookId, clipId);
    if (selectedClipId === clipId) setSelectedClipId(null);
    skipSnap.current = true;
    loadTracks();
  };
  const splitClip = async (clipId: string) => {
    if (!bookId) return;
    if (isClipLocked(clipId)) { toast.error('Track is locked'); return; }
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
    if (isClipLocked(clipId)) { toast.error('Track is locked'); return; }
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
    // Copy is allowed on locked tracks (read-only). Cut requires unlocked.
    if (cut && track.locked) { toast.error('Track is locked — cannot cut'); return; }
    setClipboardData({ clip: { ...clip }, trackId: track.id, cut });
    if (cut) deleteClip(clipId);
  };
  const pasteClip = async (trackId: string) => {
    if (!bookId || !clipboardData) return;
    const targetTrack = tracks.find(t => t.id === trackId);
    if (targetTrack?.locked) { toast.error('Target track is locked'); return; }
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
  const updateClipProperty = useCallback((clipId: string, props: Partial<Clip>) => {
    if (!bookId) return;
    // Lock guard: don't apply or persist changes for clips on locked tracks
    for (const t of tracks) {
      if (t.clips.some(c => c.id === clipId) && t.locked) {
        toast.error('Track is locked');
        return;
      }
    }
    // Optimistic local update — slider moves feel instant
    setTracks(prev => prev.map(t => ({
      ...t,
      clips: t.clips.map(c => c.id === clipId ? { ...c, ...props } : c),
    })));
    // Debounce server write — avoid API call on every px of range slider drag
    if (inspSaveDebounceRef.current) clearTimeout(inspSaveDebounceRef.current);
    inspSaveDebounceRef.current = setTimeout(async () => {
      pushSnapshot(tracks);
      await timelineApi.updateClip(bookId, clipId, props);
    }, 300);
  }, [bookId, tracks]);

  // ── Helpers ──
  // Perf: O(1) lookup instead of O(N*M) linear scan
  const clipMap = useMemo(() => {
    const map = new Map<string, Clip>();
    for (const t of tracks) for (const c of t.clips) map.set(c.id, c);
    return map;
  }, [tracks]);

  const findClip = useCallback((clipId: string): Clip | null => clipMap.get(clipId) ?? null, [clipMap]);

  // Lock-enforcement helper. The drag/trim handler and inspector buttons already
  // gate locked tracks at the UI level; this guard hardens every mutation boundary
  // so keyboard shortcuts, context-menu actions and batch ops cannot bypass it.
  const isClipLocked = useCallback((clipId: string): boolean => {
    for (const t of tracks) {
      if (t.clips.some(c => c.id === clipId)) return !!t.locked;
    }
    return false;
  }, [tracks]);

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
    if (ids.some(isClipLocked)) { toast.error('One or more selected clips are on a locked track'); return; }
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
    const ids = Array.from(selectedClipIds);
    const allowed = ids.filter(id => !isClipLocked(id));
    const skipped = ids.length - allowed.length;
    if (allowed.length === 0) { toast.error('All selected clips are on locked tracks'); return; }
    if (!confirm(`Delete ${allowed.length} selected clips?${skipped ? ` (${skipped} on locked tracks will be skipped)` : ''}`)) return;
    pushSnapshot(tracks);
    try {
      await timelineApi.batchDeleteClips(bookId, allowed);
      clearMultiSelect(); setSelectedClipId(null);
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Batch delete failed: ${err.message}`); }
  };
  const handleBatchGainAdjust = async (deltaDb: number) => {
    if (!bookId || selectedClipIds.size === 0) return;
    const allowed = Array.from(selectedClipIds).filter(id => !isClipLocked(id));
    if (allowed.length === 0) { toast.error('All selected clips are on locked tracks'); return; }
    pushSnapshot(tracks);
    try {
      await timelineApi.batchUpdateClips(bookId, allowed, { delta_gain: deltaDb });
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Batch adjust failed: ${err.message}`); }
  };
  const handleBatchSpeedAdjust = async (deltaSpeed: number) => {
    if (!bookId || selectedClipIds.size === 0) return;
    const allowed = Array.from(selectedClipIds).filter(id => !isClipLocked(id));
    if (allowed.length === 0) { toast.error('All selected clips are on locked tracks'); return; }
    pushSnapshot(tracks);
    try {
      await timelineApi.batchUpdateClips(bookId, allowed, { delta_speed: deltaSpeed });
      skipSnap.current = true; loadTracks();
    } catch (err: any) { toast.error(`Batch adjust failed: ${err.message}`); }
  };

  // Perf: memoized — recomputes when tracks change or when audio buffers finish loading
  const totalDurationMs = useMemo(() => {
    let max = 10000;
    for (const t of tracks) for (const c of t.clips) max = Math.max(max, c.position_ms + getClipDuration(c));
    return max + 5000;
  // bufferLoadTick triggers recompute when audio buffer durations become available
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, bufferLoadTick]);

  // ── Drag handling for clips ──
  const handleClipMouseDown = (e: React.MouseEvent, clip: Clip, track: Track, mode: DragMode) => {
    e.stopPropagation();
    if (e.shiftKey) { toggleMultiSelect(clip.id); return; }
    setSelectedClipId(clip.id);
    if (!selectedClipIds.has(clip.id)) clearMultiSelect();
    setContextMenu(null);
    // Locked tracks: allow selection but block any drag/trim
    if (track.locked) return;
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

  // Drag-to-scrub on the ruler. Hold shift+drag to define a loop region (A→B).
  const handleRulerMouseDown = (e: React.MouseEvent) => {
    const rulerEl = e.currentTarget as HTMLElement;
    const rect = rulerEl.getBoundingClientRect();
    const scrollLeft = scrollContainerRef.current?.scrollLeft || 0;
    const startMs = Math.max(0, (e.clientX - rect.left + scrollLeft) / pxPerMs);
    const isLoopGesture = e.shiftKey;

    // Pause playback while scrubbing for clean feedback
    const wasPlaying = playing;
    if (wasPlaying && !isLoopGesture) {
      if (playTimerRef.current) cancelAnimationFrame(playTimerRef.current);
      stopAllAudio();
      setPlaying(false);
    }

    if (isLoopGesture) {
      setLoopInMs(startMs);
      setLoopOutMs(startMs);
      setLoopEnabled(true);
    } else {
      setScrubbing(true);
      seekTo(startMs);
    }

    const onMove = (ev: MouseEvent) => {
      const ms = Math.max(0, (ev.clientX - rect.left + (scrollContainerRef.current?.scrollLeft || 0)) / pxPerMs);
      if (isLoopGesture) {
        setLoopOutMs(Math.max(startMs, ms));
      } else {
        // Update playhead via DOM ref for buttery scrub feel; throttle React state to ~30fps
        if (playheadElRef.current) playheadElRef.current.style.left = (ms * pxPerMsRef.current) + 'px';
        setPlayheadMs(ms);
      }
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const finalMs = Math.max(0, (ev.clientX - rect.left + (scrollContainerRef.current?.scrollLeft || 0)) / pxPerMs);
      if (isLoopGesture) {
        if (Math.abs(finalMs - startMs) < 50) {
          // Click without dragging — clear the loop
          setLoopInMs(null); setLoopOutMs(null); setLoopEnabled(false);
        }
      } else {
        setScrubbing(false);
        seekTo(finalMs);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
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
      if (e.key === 'Delete' && selectedClipIds.size > 1) handleBatchDelete();
      else if (e.key === 'Delete' && selectedClipId) deleteClip(selectedClipId);
      if (e.key === '?') setShowHelp(p => !p);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedClipId, playheadMs, playing, tracks, clipboardData, selectedClipIds]);

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
  const timelineWidth = totalDurationMs * pxPerMs;

  // Perf: memoized — only recomputes when duration or zoom changes
  const rulerTicks = useMemo(() => {
    const ticks: { ms: number; label: string; major: boolean }[] = [];
    const stepMs = pxPerMs > 0.1 ? 1000 : pxPerMs > 0.02 ? 5000 : 10000;
    for (let ms = 0; ms < totalDurationMs; ms += stepMs) {
      const sec = ms / 1000;
      const label = sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
      ticks.push({ ms, label, major: ms % (stepMs * 5) === 0 });
    }
    return ticks;
  }, [totalDurationMs, pxPerMs]);

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
              <div className="tl-time-total">/ {formatTimeExtended(totalDurationMs, timeFormat)}</div>
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
              <button
                className={`tl-btn tl-btn-icon ${loopEnabled && loopInMs !== null && loopOutMs !== null ? 'active' : ''}`}
                onClick={() => {
                  if (loopInMs !== null && loopOutMs !== null) setLoopEnabled(p => !p);
                  else toast.info('Hold Shift and drag on the ruler to set a loop region');
                }}
                title="Loop region (Shift+drag on ruler)">
                <Repeat size={14} />
              </button>
              {loopInMs !== null && loopOutMs !== null && (
                <button className="tl-btn tl-btn-icon" onClick={() => { setLoopInMs(null); setLoopOutMs(null); setLoopEnabled(false); }} title="Clear loop region">
                  <X size={12} />
                </button>
              )}
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
              seekTo(totalDurationMs * percentage);
            }}>
              <div className="tl-progress-fill" style={{ width: `${(playheadMs / totalDurationMs) * 100}%` }} />
              <div className="tl-progress-playhead" style={{ left: `${(playheadMs / totalDurationMs) * 100}%` }} />
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
      <div className="tl-body" onWheel={handleWheel} data-scrubbing={scrubbing ? 'true' : undefined}>
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
                    <button className={`tl-btn-icon ${track.locked ? 'locked' : ''}`} onClick={() => toggleTrackLock(track.id)} title={track.locked ? 'Unlock track' : 'Lock track'}>
                      {track.locked ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
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
            <div className="tl-ruler" onMouseDown={handleRulerMouseDown} style={{ width: timelineWidth }}>
              {rulerTicks.map(tick => (
                <div key={tick.ms} className={`tl-tick ${tick.major ? 'major' : ''}`} style={{ left: tick.ms * pxPerMs }}>
                  <div className="tl-tick-line" />
                  <span className="tl-tick-label">{tick.label}</span>
                </div>
              ))}
              {/* Chapter marker pins live on the ruler */}
              {markers.map(m => (
                <div key={`pin-${m.id}`} className="tl-marker-pin" style={{ left: m.position_ms * pxPerMs }} title={m.label}>
                  <span className="tl-marker-pin-label">{m.label}</span>
                </div>
              ))}
              {/* Loop region indicator on the ruler */}
              {loopInMs !== null && loopOutMs !== null && loopOutMs > loopInMs && (
                <div className={`tl-loop-bar ${loopEnabled ? 'on' : 'off'}`}
                  style={{ left: loopInMs * pxPerMs, width: (loopOutMs - loopInMs) * pxPerMs }} />
              )}
            </div>

            {/* Loop region overlay across all lanes */}
            {loopInMs !== null && loopOutMs !== null && loopOutMs > loopInMs && (
              <div
                className={`tl-loop-region ${loopEnabled ? 'on' : 'off'}`}
                style={{
                  left: loopInMs * pxPerMs,
                  width: (loopOutMs - loopInMs) * pxPerMs,
                  top: RULER_H,
                  height: tracks.length * TRACK_H,
                }}
              />
            )}

            {/* Track Lanes */}
            {tracks.map(track => {
              const tc = getTrackColor(track.type);
              return (
                <div key={track.id} className={`tl-lane ${track.locked ? 'locked' : ''}`} data-timeline-area="true"
                  style={{ height: TRACK_H, background: tc.bg, borderBottomColor: tc.border }}>
                  {/* Chapter marker guidelines */}
                  {markers.map(m => (
                    <div key={m.id} className="tl-marker" style={{ left: m.position_ms * pxPerMs }} />
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
                        className={`tl-clip ${isSelected ? 'selected' : ''} ${isMultiSel ? 'multi' : ''} ${isHovered ? 'hovered' : ''} ${track.locked ? 'locked' : ''}`}
                        style={{
                          left, width: Math.max(width, 4),
                          '--clip-color': tc.clip,
                          '--clip-hover': tc.clipHover,
                          '--clip-border': tc.text,
                          '--clip-accent': tc.text,
                        } as React.CSSProperties}
                        onMouseDown={e => handleClipMouseDown(e, clip, track, 'move')}
                        onMouseEnter={() => setHoveredClipId(clip.id)}
                        onMouseLeave={() => setHoveredClipId(null)}
                        onContextMenu={e => handleClipContextMenu(e, clip, track)}
                      >
                        {/* Trim handles (hidden when track is locked) */}
                        {!track.locked && <>
                          <div className="tl-clip-handle left" onMouseDown={e => handleClipMouseDown(e, clip, track, 'trimStart')} />
                          <div className="tl-clip-handle right" onMouseDown={e => handleClipMouseDown(e, clip, track, 'trimEnd')} />
                        </>}

                        {/* Waveform layer */}
                        {waveformVisible && width > 12 && (
                          <ClipWaveform
                            assetId={clip.audio_asset_id}
                            width={Math.max(2, Math.floor(width))}
                            color={tc.text}
                            trimStartMs={clip.trim_start_ms || 0}
                            trimEndMs={clip.trim_end_ms || 0}
                            audioBuffersRef={audioBuffersRef}
                            requestLoad={loadAudioBuffer}
                            onLoaded={() => setBufferLoadTick(t => t + 1)}
                          />
                        )}

                        {/* Clip content */}
                        <div className="tl-clip-body">
                          <span className="tl-clip-label">{label}</span>
                          <div className="tl-clip-meta">
                            {(clip.gain || 0) !== 0 && <span className="tl-clip-chip">{(clip.gain || 0) > 0 ? '+' : ''}{(clip.gain || 0).toFixed(1)}dB</span>}
                            {spd !== 1.0 && <span className="tl-clip-chip warn">{spd.toFixed(2)}x</span>}
                          </div>
                        </div>

                        {/* Fade overlays — sloped for clarity */}
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

            {/* Playhead — position driven by DOM ref during playback to skip React re-renders */}
            <div className="tl-playhead" ref={playheadElRef} style={{ left: playheadMs * pxPerMs }}>
              <div className="tl-playhead-head" />
              <div className="tl-playhead-line" style={{ height: RULER_H + tracks.length * TRACK_H }} />
            </div>
          </div>
        </div>

        {/* ── Docked Clip Inspector — right column inside flex body ── */}
        {selectedClip && selectedTrack && inspectorOpen && (
          <div className="tl-inspector">
            <div className="tl-insp-header">
              <h4>Clip Inspector</h4>
              <button className="tl-btn-icon" onClick={() => setSelectedClipId(null)} title="Close inspector"><X size={14} /></button>
            </div>
            <div className="tl-insp-row"><span>Position</span><span>{formatTime(selectedClip.position_ms)}</span></div>
            <div className="tl-insp-row"><span>Duration</span><span>{formatTime(getClipDuration(selectedClip))}</span></div>
            <div className="tl-insp-row"><span>Track</span><span style={{ color: getTrackColor(selectedTrack.type).text }}>{selectedTrack.name}{selectedTrack.locked ? ' (locked)' : ''}</span></div>

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
              <button onClick={() => splitClip(selectedClip.id)} disabled={!!selectedTrack.locked}><Scissors size={11} /> Split</button>
              <button onClick={() => duplicateClip(selectedClip.id)} disabled={!!selectedTrack.locked}><Copy size={11} /> Dup</button>
              <button onClick={() => copyClip(selectedClip.id, false)}><Copy size={11} /> Copy</button>
              <button onClick={() => copyClip(selectedClip.id, true)} disabled={!!selectedTrack.locked}><Scissors size={11} /> Cut</button>
              <button className="danger" onClick={() => deleteClip(selectedClip.id)} disabled={!!selectedTrack.locked}><Trash2 size={11} /> Del</button>
            </div>
          </div>
        )}
      </div>

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

// ── ClipWaveform ──
// Renders a peak waveform from the cached AudioBuffer onto a canvas. If the
// buffer hasn't been loaded yet, requests a load and shows a subtle placeholder.
const ClipWaveform = React.memo(function ClipWaveform({
  assetId, width, color, trimStartMs, trimEndMs, audioBuffersRef, requestLoad, onLoaded,
}: {
  assetId: string;
  width: number;
  color: string;
  trimStartMs: number;
  trimEndMs: number;
  audioBuffersRef: React.MutableRefObject<Map<string, AudioBuffer>>;
  requestLoad: (assetId: string) => Promise<AudioBuffer | null>;
  onLoaded: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const HEIGHT = 60;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, HEIGHT);

    const buffer = audioBuffersRef.current.get(assetId);
    if (!buffer) {
      // Kick off load — re-render once available.
      requestLoad(assetId).then(buf => { if (buf) onLoaded(); });
      return;
    }

    // Compute peaks across the visible portion (respecting trim).
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);
    const trimStartSamples = Math.floor((trimStartMs / 1000) * sampleRate);
    const trimEndSamples = Math.floor((trimEndMs / 1000) * sampleRate);
    const startIdx = Math.max(0, trimStartSamples);
    const endIdx = Math.max(startIdx + 1, channelData.length - trimEndSamples);
    const totalSamples = endIdx - startIdx;
    if (totalSamples <= 0) return;

    const samplesPerPixel = Math.max(1, Math.floor(totalSamples / width));
    const mid = HEIGHT / 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55;
    for (let x = 0; x < width; x++) {
      const sStart = startIdx + x * samplesPerPixel;
      const sEnd = Math.min(endIdx, sStart + samplesPerPixel);
      let min = 1, max = -1;
      for (let i = sStart; i < sEnd; i++) {
        const v = channelData[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yTop = mid - max * mid * 0.92;
      const yBot = mid - min * mid * 0.92;
      const h = Math.max(1, yBot - yTop);
      ctx.fillRect(x, yTop, 1, h);
    }
    // Subtle center line for very quiet clips
    ctx.globalAlpha = 0.18;
    ctx.fillRect(0, mid - 0.5, width, 1);
  }, [assetId, width, color, trimStartMs, trimEndMs, audioBuffersRef, requestLoad, onLoaded]);

  return <canvas ref={canvasRef} className="tl-clip-wave" style={{ width, height: HEIGHT }} />;
});

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
  background: linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-elevated) 100%);
  border-bottom: 1px solid var(--border-default);
  cursor: ew-resize;
  user-select: none;
  box-shadow: 0 1px 0 rgba(0,0,0,0.15);
}
.tl-ruler:hover { background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-surface) 100%); }
[data-scrubbing="true"] .tl-ruler { background: rgba(91,141,239,0.08); }

/* Marker pins on the ruler */
.tl-marker-pin {
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: rgb(251,146,60);
  border-radius: 1px;
  pointer-events: auto;
  cursor: pointer;
  z-index: 6;
}
.tl-marker-pin::before {
  content: '';
  position: absolute;
  top: -2px;
  left: -3px;
  width: 8px;
  height: 8px;
  background: rgb(251,146,60);
  border-radius: 50% 50% 0 50%;
  transform: rotate(-45deg);
}
.tl-marker-pin-label {
  position: absolute;
  top: 14px;
  left: 6px;
  font-size: 9px;
  color: rgb(251,146,60);
  white-space: nowrap;
  pointer-events: none;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}

/* Loop region indicators */
.tl-loop-bar {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: none;
  border-radius: 0;
  z-index: 4;
}
.tl-loop-bar.on {
  background: rgba(91,141,239,0.32);
  border-left: 2px solid var(--accent);
  border-right: 2px solid var(--accent);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.tl-loop-bar.off {
  background: rgba(148,163,184,0.16);
  border-left: 2px dashed rgba(148,163,184,0.5);
  border-right: 2px dashed rgba(148,163,184,0.5);
}
.tl-loop-region {
  position: absolute;
  pointer-events: none;
  z-index: 4;
  border-radius: 0;
}
.tl-loop-region.on {
  background: linear-gradient(180deg, rgba(91,141,239,0.10), rgba(91,141,239,0.04));
  border-left: 1px dashed rgba(91,141,239,0.6);
  border-right: 1px dashed rgba(91,141,239,0.6);
}
.tl-loop-region.off {
  background: rgba(148,163,184,0.05);
  border-left: 1px dashed rgba(148,163,184,0.4);
  border-right: 1px dashed rgba(148,163,184,0.4);
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
  /* Subtle vertical grid lines for cleaner alignment perception */
  background-image: linear-gradient(to right, rgba(255,255,255,0.025) 1px, transparent 1px);
  background-size: 100px 100%;
  background-position: 0 0;
}
.tl-lane.locked {
  background-image:
    linear-gradient(to right, rgba(255,255,255,0.025) 1px, transparent 1px),
    repeating-linear-gradient(45deg, rgba(255,255,255,0.02) 0 8px, rgba(0,0,0,0.10) 8px 16px);
  cursor: not-allowed;
}

/* ── Chapter Marker guide lines ── */
.tl-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(251,146,60,0.18);
  pointer-events: none;
  z-index: 1;
}

/* ── Clips ──
   Note: --clip-color and --clip-hover are gradient strings (linear-gradient(...))
   defined in TRACK_COLORS, so they are used directly as the background value
   (not embedded as color stops in another gradient and not passed to color-mix). */
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
  transition: border-color 120ms, box-shadow 120ms, transform 120ms;
  box-shadow: 0 1px 2px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
}
.tl-clip::before {
  /* Top accent stripe in track color */
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--clip-accent, var(--clip-border));
  opacity: 0.7;
  pointer-events: none;
}
.tl-clip:hover, .tl-clip.hovered {
  background: var(--clip-hover);
  border-color: var(--clip-border);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08);
}
.tl-clip.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 4px 16px rgba(91,141,239,0.3), inset 0 1px 0 rgba(255,255,255,0.1);
  z-index: 3;
}
.tl-clip.multi {
  border-color: var(--purple);
  border-style: dashed;
}
.tl-clip.locked {
  cursor: not-allowed;
  opacity: 0.85;
}
.tl-clip.locked::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(45deg, rgba(0,0,0,0.0) 0 6px, rgba(0,0,0,0.12) 6px 12px);
  pointer-events: none;
}
.tl-clip:active { cursor: grabbing; }

/* Waveform canvas inside clip */
.tl-clip-wave {
  position: absolute;
  inset: 2px 0 0 0;
  pointer-events: none;
  opacity: 0.85;
  mix-blend-mode: screen;
}

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
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  height: 100%;
  gap: 4px;
  pointer-events: none;
  z-index: 2;
}
.tl-clip-label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255,255,255,0.95);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  letter-spacing: 0.1px;
}
.tl-clip-meta {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}
.tl-clip-chip {
  font-size: 9px;
  font-weight: 700;
  color: rgba(255,255,255,0.92);
  background: rgba(0,0,0,0.45);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: monospace;
  letter-spacing: 0.2px;
}
.tl-clip-chip.warn { color: var(--warning); }

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
  will-change: left;
}
.tl-playhead-head {
  width: 14px;
  height: 14px;
  background: linear-gradient(180deg, #f87171, #dc2626);
  transform: translateX(-7px);
  clip-path: polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%);
  box-shadow: 0 2px 6px rgba(239,68,68,0.5);
}
.tl-playhead-line {
  width: 1.5px;
  background: linear-gradient(180deg, #ef4444 0%, rgba(239,68,68,0.6) 100%);
  transform: translateX(-0.75px);
  box-shadow: 0 0 6px rgba(239,68,68,0.4);
}

`;
const timelineStyles3 = `
/* ── Inspector — docked in flex ── */
.tl-inspector {
  flex: 0 0 280px;
  width: 280px;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-strong);
  padding: 14px 14px 18px 14px;
  overflow-y: auto;
  box-shadow: -4px 0 12px rgba(0,0,0,0.18);
  align-self: stretch;
}
.tl-btn-icon.locked {
  color: var(--warning);
  background: rgba(251,191,36,0.12);
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
