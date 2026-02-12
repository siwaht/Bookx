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
