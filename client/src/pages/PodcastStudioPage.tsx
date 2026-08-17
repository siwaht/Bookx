import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { podcast, castings as castingsApi } from '../services/api';
import { toast } from '../components/Toast';
import type { VoiceCasting } from '../types';
import {
  Mic, Wand2, Loader, Users, FolderOpen, Save, ArrowRight, FileText,
  Sparkles, CheckCircle2, RotateCcw,
} from 'lucide-react';

type DetectMethod = 'tags' | 'llm';

interface DetectedSegment { speaker: string; text: string }

/**
 * Podcast Studio: paste a script, let the app detect who's speaking, then
 * either reuse a previously-saved cast (so recurring hosts/guests keep the
 * same voice automatically) or auto-assign fresh voices - and optionally
 * save the result as a new named cast for next time.
 */
export function PodcastStudioPage() {
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [scriptText, setScriptText] = useState('');

  const [detecting, setDetecting] = useState(false);
  const [detectMethod, setDetectMethod] = useState<DetectMethod | null>(null);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [segments, setSegments] = useState<DetectedSegment[]>([]);

  const [castingList, setCastingList] = useState<VoiceCasting[]>([]);
  const [selectedCastingId, setSelectedCastingId] = useState<string>('');
  const [saveAsCastingName, setSaveAsCastingName] = useState('');
  const [creating, setCreating] = useState(false);

  const loadCastings = async () => {
    try {
      const data = await castingsApi.list('podcast');
      setCastingList(Array.isArray(data) ? data : []);
    } catch { /* non-critical */ }
  };

  useEffect(() => { loadCastings(); }, []);

  const handleDetect = async () => {
    if (!scriptText.trim()) { toast.warning('Paste a script first.'); return; }
    setDetecting(true);
    try {
      const result = await podcast.parseScript(scriptText);
      setSpeakers(result.speakers);
      setSegments(result.segments);
      setDetectMethod(result.method);
      toast.success(
        result.method === 'tags'
          ? `Detected ${result.speakers.length} speaker${result.speakers.length === 1 ? '' : 's'} from "Speaker: line" formatting.`
          : `AI detected ${result.speakers.length} speaker${result.speakers.length === 1 ? '' : 's'} (via ${result.provider}).`
      );
    } catch (err: any) {
      toast.error(err.message || 'Speaker detection failed');
    } finally {
      setDetecting(false);
    }
  };

  const handleReset = () => {
    setSpeakers([]);
    setSegments([]);
    setDetectMethod(null);
  };

  const handleCreate = async () => {
    if (!title.trim()) { toast.warning('Give this episode a title.'); return; }
    if (!scriptText.trim()) { toast.warning('Paste a script first.'); return; }
    setCreating(true);
    try {
      const result = await podcast.createEpisode({
        title: title.trim(),
        author: author.trim() || undefined,
        script_text: scriptText,
        segments: segments.length ? segments : undefined,
        speakers: speakers.length ? speakers : undefined,
        casting_id: selectedCastingId || undefined,
        save_as_casting_name: saveAsCastingName.trim() || undefined,
      });
      const memoryHits = result.voice_assignments.filter((a: any) => a.source === 'memory').length;
      let msg = `Episode created with ${result.characters.length} speaker${result.characters.length === 1 ? '' : 's'} and ${result.segments_created} segments.`;
      if (result.casting_applied) msg += ` Applied saved cast (${result.casting_applied.updated} matched).`;
      if (memoryHits > 0) msg += ` ${memoryHits} voice${memoryHits === 1 ? '' : 's'} recalled from memory.`;
      if (result.saved_casting_id) msg += ` Saved as a reusable cast for next time.`;
      toast.success(msg);
      navigate(`/book/${result.book.id}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create episode');
    } finally {
      setCreating(false);
    }
  };

  const canDetect = scriptText.trim().length > 0 && !detecting;
  const canCreate = title.trim().length > 0 && scriptText.trim().length > 0 && !creating;

  return (
    <div style={S.page}>
      <div style={S.hero}>
        <div style={S.heroIcon}><Mic size={22} /></div>
        <div style={{ flex: 1 }}>
          <h1 style={S.heroTitle}>Podcast Studio</h1>
          <p style={S.heroSub}>
            Paste a script, we auto-detect every speaker and cast a unique voice for each one.
            Save the cast once, then reuse it for every future episode with the same hosts/guests.
          </p>
        </div>
      </div>

      {/* ── Step 1: Episode details + script ── */}
      <div style={S.card}>
        <div style={S.cardHeader}>
          <span style={S.stepNum}>1</span>
          <div>
            <h2 style={S.cardTitle}>Episode & Script</h2>
            <p style={S.cardSub}>Paste your script as-is. Lines like "Host: ..." or "ALICE: ..." are detected automatically.</p>
          </div>
        </div>
        <div style={S.cardBody}>
          <div style={S.row}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Episode title"
              style={{ ...S.input, flex: 2 }} aria-label="Episode title" />
            <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Host name (optional)"
              style={{ ...S.input, flex: 1 }} aria-label="Host name" />
          </div>
          <textarea
            value={scriptText}
            onChange={(e) => { setScriptText(e.target.value); handleReset(); }}
            placeholder={'Paste your script here, e.g.:\n\nHost: Welcome back to the show...\nGuest: Thanks for having me!\nHost: So let\'s dive right in...'}
            style={S.textarea}
            aria-label="Podcast script"
          />
          <div style={S.row}>
            <button onClick={handleDetect} disabled={!canDetect} style={{ ...S.actionBtn, opacity: canDetect ? 1 : 0.5 }}>
              {detecting ? <Loader size={14} className="spin" /> : <Wand2 size={14} />}
              {detecting ? 'Detecting speakers...' : 'Detect Speakers'}
            </button>
            {detectMethod && (
              <button onClick={handleReset} style={S.ghostBtn}><RotateCcw size={12} /> Re-detect</button>
            )}
          </div>
        </div>
      </div>

      {/* ── Step 2: Detected speakers preview ── */}
      {speakers.length > 0 && (
        <div style={S.card}>
          <div style={S.cardHeader}>
            <span style={{ ...S.stepNum, background: 'var(--success)' }}><CheckCircle2 size={13} /></span>
            <div>
              <h2 style={S.cardTitle}>Detected Speakers</h2>
              <p style={S.cardSub}>
                {speakers.length} speaker{speakers.length === 1 ? '' : 's'} · {segments.length} segments
                {detectMethod === 'llm' ? ' · AI-detected' : ' · detected from formatting'}
              </p>
            </div>
          </div>
          <div style={S.cardBody}>
            <div style={S.speakerGrid}>
              {speakers.map((sp) => (
                <span key={sp} style={S.speakerChip}><Users size={11} /> {sp}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Step 3: Voice casting ── */}
      <div style={S.card}>
        <div style={S.cardHeader}>
          <span style={S.stepNum}>{speakers.length > 0 ? 3 : 2}</span>
          <div>
            <h2 style={S.cardTitle}>Voice Casting</h2>
            <p style={S.cardSub}>Reuse a saved cast, or leave blank to auto-assign fresh voices (recurring names are recalled automatically either way).</p>
          </div>
        </div>
        <div style={S.cardBody}>
          <div style={S.fieldGroup}>
            <label style={S.fieldLabel}><FolderOpen size={11} /> Reuse a saved cast</label>
            <select value={selectedCastingId} onChange={(e) => setSelectedCastingId(e.target.value)} style={S.select} aria-label="Saved casting">
              <option value="">Auto-assign new voices</option>
              {castingList.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.voiced_count ?? 0} voices)</option>
              ))}
            </select>
          </div>
          <div style={S.fieldGroup}>
            <label style={S.fieldLabel}><Save size={11} /> Save this cast for next time (optional)</label>
            <input value={saveAsCastingName} onChange={(e) => setSaveAsCastingName(e.target.value)}
              placeholder="e.g. 'My Weekly Show Cast'" style={S.input} aria-label="Save casting as" />
          </div>
        </div>
      </div>

      {/* ── Create ── */}
      <div style={S.createBar}>
        <button onClick={handleCreate} disabled={!canCreate} style={{ ...S.createBtn, opacity: canCreate ? 1 : 0.5 }}>
          {creating ? <Loader size={15} className="spin" /> : <Sparkles size={15} />}
          {creating ? 'Creating episode...' : 'Create Episode'}
          {!creating && <ArrowRight size={14} />}
        </button>
        <p style={S.createHint}>
          <FileText size={11} style={{ display: 'inline', verticalAlign: -1 }} /> Creates a podcast project with all speakers and segments ready. You'll land in the editor to generate audio, add SFX/music, and export.
        </p>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { padding: '28px 32px 64px', maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 },
  hero: {
    display: 'flex', alignItems: 'flex-start', gap: 16,
    background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-lg)', padding: '22px 26px',
  },
  heroIcon: {
    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
    background: 'linear-gradient(135deg, var(--purple-subtle), rgba(91,141,239,0.12))',
    display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--purple)',
  },
  heroTitle: { fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.03em' },
  heroSub: { fontSize: 13, color: 'var(--text-tertiary)', margin: '4px 0 0', lineHeight: 1.5 },
  card: { background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' },
  cardHeader: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' },
  stepNum: {
    width: 24, height: 24, borderRadius: 7, background: 'var(--accent)', color: '#fff',
    fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  cardTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 },
  cardSub: { fontSize: 11, color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.4 },
  cardBody: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 },
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  input: {
    padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border-default)',
    background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, outline: 'none',
  },
  textarea: {
    minHeight: 220, padding: 14, borderRadius: 10, border: '1px solid var(--border-default)',
    background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.6,
    outline: 'none', resize: 'vertical', fontFamily: 'inherit',
  },
  actionBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', border: 'none',
    borderRadius: 9, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    background: 'linear-gradient(135deg, var(--accent), #6d9af5)', color: '#fff',
  },
  ghostBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px',
    background: 'none', border: '1px solid var(--border-subtle)', borderRadius: 8,
    color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12,
  },
  speakerGrid: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  speakerChip: {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
    background: 'var(--success-subtle)', color: 'var(--success)', borderRadius: 20, fontSize: 12, fontWeight: 500,
  },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
  fieldLabel: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5 },
  select: {
    padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border-default)',
    background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', cursor: 'pointer',
  },
  createBar: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '8px 0 20px' },
  createBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 28px', border: 'none',
    borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer',
    background: 'linear-gradient(135deg, #8B5CF6, #6366F1)', color: '#fff',
    boxShadow: '0 4px 20px rgba(139,92,246,0.25)',
  },
  createHint: { fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 480, lineHeight: 1.5 },
};
