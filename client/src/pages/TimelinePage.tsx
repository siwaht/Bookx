import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { timeline as timelineApi, audioUrl } from '../services/api';
import type { Track, Clip, ChapterMarker } from '../types';
import { Plus, Play, Pause, Square, Volume2, VolumeX, SkipBack } from 'lucide-react';

const TRACK_HEIGHT = 72;
const RULER_HEIGHT = 28;
const HEADER_WIDTH = 180;
const DEFAULT_PX_PER_MS = 0.05; // 50px per second

export function TimelinePage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [markers, setMarkers] = useState<ChapterMarker[]>([]);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playStartRef = useRef<number>(0);
  const playOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);
  const audioBufferCache = useRef<Map<string, AudioBuffer>>(new Map());

  const pxPerMs = DEFAULT_PX_PER_MS * zoom;

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

  // Compute total timeline duration
  const totalDurationMs = Math.max(
    60000,
    ...tracks.flatMap((t) => t.clips?.map((c) => c.position_ms + (c.trim_end_ms || 5000)) || [0]),
    ...markers.map((m) => m.position_ms + 5000),
  );

  // ── WebAudio Playback ──

  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
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

    // Pre-load all clip audio buffers
    const allClips = tracks.flatMap((t) =>
      (t.muted ? [] : (t.clips || [])).map((c) => ({ ...c, trackGain: t.gain, trackType: t.type }))
    );

    const buffers = new Map<string, AudioBuffer>();
    await Promise.all(
      allClips.map(async (clip) => {
        try {
          const buf = await fetchAudioBuffer(clip.audio_asset_id);
          buffers.set(clip.id, buf);
        } catch { /* skip clips that fail to load */ }
      })
    );

    const startTime = ctx.currentTime;
    const offsetSec = currentTimeMs / 1000;
    playStartRef.current = startTime;
    playOffsetRef.current = offsetSec;

    // Schedule each clip
    for (const clip of allClips) {
      const buf = buffers.get(clip.id);
      if (!buf) continue;

      const clipStartSec = clip.position_ms / 1000;
      const trimStartSec = (clip.trim_start_ms || 0) / 1000;
      const clipDuration = buf.duration - trimStartSec;

      if (clipStartSec + clipDuration < offsetSec) continue; // clip already passed

      const source = ctx.createBufferSource();
      source.buffer = buf;

      const gainNode = ctx.createGain();
      const clipGainDb = (clip.gain || 0) + (clip.trackGain || 0);
      gainNode.gain.value = Math.pow(10, clipGainDb / 20);

      // Fade in/out
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

    // Animate playhead
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
      // Capture current time before stopping
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

  const handleStop = () => {
    stopPlayback();
    setCurrentTimeMs(0);
  };

  const handleRewind = () => {
    stopPlayback();
    setCurrentTimeMs(0);
  };

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

      const clips = track.clips || [];
      for (const clip of clips) {
        const clipX = clip.position_ms * pxPerMs;
        // Use audio buffer duration if cached, otherwise estimate
        const cachedBuf = audioBufferCache.current.get(clip.audio_asset_id);
        const durationMs = cachedBuf ? cachedBuf.duration * 1000 : 3000;
        const clipWidth = Math.max(4, durationMs * pxPerMs);

        const isSelected = selectedClip?.id === clip.id;
        const baseColor = track.color || '#4A90D9';

        ctx.fillStyle = track.muted ? '#1a1a1a' : baseColor;
        ctx.globalAlpha = track.muted ? 0.2 : 0.6;
        ctx.fillRect(clipX, y + 4, clipWidth, TRACK_HEIGHT - 8);
        ctx.globalAlpha = 1;

        // Waveform placeholder (simple bars)
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

    // Playhead triangle
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(playheadX - 6, 0);
    ctx.lineTo(playheadX + 6, 0);
    ctx.lineTo(playheadX, 8);
    ctx.fill();
  }, [tracks, markers, currentTimeMs, zoom, pxPerMs, totalDurationMs, selectedClip]);

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

  // Click on canvas to set playhead or select clip
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scrollLeft = scrollRef.current?.scrollLeft || 0;
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top;

    const clickTimeMs = x / pxPerMs;

    // Check if clicking on a clip
    const trackIndex = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
    if (trackIndex >= 0 && trackIndex < tracks.length) {
      const track = tracks[trackIndex];
      const clickedClip = (track.clips || []).find((clip) => {
        const cachedBuf = audioBufferCache.current.get(clip.audio_asset_id);
        const durationMs = cachedBuf ? cachedBuf.duration * 1000 : 3000;
        return clickTimeMs >= clip.position_ms && clickTimeMs <= clip.position_ms + durationMs;
      });
      if (clickedClip) {
        setSelectedClip(clickedClip);
        return;
      }
    }

    setSelectedClip(null);
    if (!playing) {
      setCurrentTimeMs(clickTimeMs);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, [stopPlayback]);

  const formatTime = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    const frac = Math.floor((ms % 1000) / 100);
    return `${mins}:${String(secs).padStart(2, '0')}.${frac}`;
  };

  const totalClips = tracks.reduce((sum, t) => sum + (t.clips?.length || 0), 0);

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div style={styles.transportGroup}>
          <button onClick={handleRewind} style={styles.transportBtn} aria-label="Rewind">
            <SkipBack size={16} />
          </button>
          <button onClick={handlePlayPause} style={{ ...styles.transportBtn, background: playing ? '#c44' : '#4A90D9' }} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button onClick={handleStop} style={styles.transportBtn} aria-label="Stop">
            <Square size={16} />
          </button>
        </div>
        <span style={styles.timeDisplay}>{formatTime(currentTimeMs)}</span>
        <span style={styles.infoText}>{tracks.length} tracks · {totalClips} clips</span>
        <div style={styles.zoomControl}>
          <span style={{ fontSize: 11, color: '#666' }}>Zoom</span>
          <input type="range" min="0.1" max="4" step="0.1" value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))} style={{ width: 80 }}
            aria-label="Timeline zoom" />
          <span style={{ fontSize: 11, color: '#666' }}>{zoom.toFixed(1)}x</span>
        </div>
        <div style={styles.addTrackGroup}>
          <button onClick={() => addTrack('narration')} style={styles.addTrackBtn}>+ Narration</button>
          <button onClick={() => addTrack('dialogue')} style={styles.addTrackBtn}>+ Dialogue</button>
          <button onClick={() => addTrack('sfx')} style={styles.addTrackBtn}>+ SFX</button>
          <button onClick={() => addTrack('music')} style={styles.addTrackBtn}>+ Music</button>
        </div>
      </div>

      <div style={styles.timelineArea}>
        <div style={styles.trackHeaders}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid #222' }} />
          {tracks.map((track) => (
            <div key={track.id} style={styles.trackHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: track.color || '#4A90D9' }} />
                <span style={{ color: '#ccc', fontSize: 12 }}>{track.name}</span>
              </div>
              <div style={styles.trackControls}>
                <button onClick={() => toggleMute(track)} style={{ ...styles.ctrlBtn, color: track.muted ? '#f66' : '#666' }}
                  aria-label={track.muted ? 'Unmute' : 'Mute'} title={track.muted ? 'Unmute' : 'Mute'}>
                  {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <button onClick={() => toggleSolo(track)}
                  style={{ ...styles.ctrlBtn, color: track.solo ? '#ff0' : '#666', fontSize: 10, fontWeight: 'bold' }}
                  aria-label={track.solo ? 'Unsolo' : 'Solo'} title="Solo">
                  S
                </button>
              </div>
              <span style={{ fontSize: 10, color: '#444' }}>{track.clips?.length || 0} clips</span>
            </div>
          ))}
        </div>
        <div ref={scrollRef} style={styles.canvasWrapper}>
          <canvas ref={canvasRef} onClick={handleCanvasClick} style={styles.canvas} />
        </div>
      </div>

      {selectedClip && (
        <div style={styles.clipInspector}>
          <h4 style={{ color: '#fff', fontSize: 13, marginBottom: 8 }}>Clip Properties</h4>
          <div style={styles.inspectorRow}>
            <span>Position</span>
            <span>{formatTime(selectedClip.position_ms)}</span>
          </div>
          <div style={styles.inspectorRow}>
            <span>Gain (dB)</span>
            <span>{selectedClip.gain.toFixed(1)}</span>
          </div>
          <div style={styles.inspectorRow}>
            <span>Fade In</span>
            <span>{selectedClip.fade_in_ms}ms</span>
          </div>
          <div style={styles.inspectorRow}>
            <span>Fade Out</span>
            <span>{selectedClip.fade_out_ms}ms</span>
          </div>
        </div>
      )}

      {tracks.length === 0 && (
        <p style={{ color: '#444', textAlign: 'center', padding: 40 }}>
          Add tracks above, or use "Send to Timeline" from the Manuscript page to auto-populate
        </p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)' },
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
  addTrackGroup: { display: 'flex', gap: 3, marginLeft: 'auto' },
  addTrackBtn: {
    padding: '4px 10px', background: '#1e1e1e', color: '#777', border: '1px solid #2a2a2a',
    borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },
  timelineArea: { display: 'flex', flex: 1, overflow: 'hidden', background: '#0f0f0f' },
  trackHeaders: { width: HEADER_WIDTH, flexShrink: 0, background: '#121212', borderRight: '1px solid #222', overflow: 'hidden' },
  trackHeader: {
    height: TRACK_HEIGHT, padding: '6px 10px', borderBottom: '1px solid #1e1e1e',
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4,
  },
  trackControls: { display: 'flex', gap: 4 },
  ctrlBtn: { background: 'none', border: '1px solid #333', borderRadius: 3, cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center' },
  canvasWrapper: { flex: 1, overflow: 'auto' },
  canvas: { display: 'block', cursor: 'crosshair' },
  clipInspector: {
    padding: 12, background: '#161616', borderTop: '1px solid #222',
    display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap',
  },
  inspectorRow: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#888' },
};
