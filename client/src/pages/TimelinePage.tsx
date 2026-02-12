import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, elevenlabs, audioUrl, render, saveProject, downloadProjectUrl } from '../services/api';
import type { Track, Clip, ChapterMarker } from '../types';
import {
  Play, Pause, SkipBack, ZoomIn, ZoomOut, Plus, Trash2, Volume2, VolumeX,
  Save, Download, Scissors, Copy, Clipboard, Undo2, Redo2, HelpCircle, X,
  Music, Wand2, Loader,
} from 'lucide-react';

type DragMode = 'move' | 'trimStart' | 'trimEnd';

interface ClipboardData {
  clip: Clip;
  trackId: string;
  cut: boolean;
}

interface ContextMenu {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
}

const TRACK_H = 60;
const HEADER_W = 160;
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

  // Quick-add panel
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
    });
    skipSnap.current = true;
    loadTracks();
  };
