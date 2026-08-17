import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Check, Download, Edit3, FolderOpen, Loader, Music, Plus, Repeat, Sparkles,
  Trash2, Upload, Wand2, X,
} from 'lucide-react';
import {
  audioAssets, audioDownloadUrl, audioUrl, elevenlabs,
  timeline as timelineApi, uploadAudio,
} from '../services/api';
import { useAppStore } from '../stores/appStore';
import { toast } from '../components/Toast';
import { Modal } from '../components/ui/Modal';
import { Segmented } from '../components/ui/Segmented';
import { Button, IconButton } from '../components/ui/Button';
import { field, icon as iconSize, text, weight } from '../components/ui/tokens';

type Tab = 'music' | 'sfx' | 'library';
type AssetKind = 'sfx' | 'music' | 'imported';

interface FreshAsset {
  key: string;
  kind: AssetKind;
  label: string;
  assetId: string;
  cached: boolean;
}

const SFX_PRESETS = [
  'Heavy wooden door creaking open slowly',
  'Footsteps on gravel, then a metal door opens',
  'Thunder rumbling in the distance',
  'Rain falling on a tin roof',
  'Campfire crackling with occasional pops',
  'Glass shattering on concrete',
  'Wind whistling through trees',
  'Sword drawn from a sheath',
  'Clock ticking in a quiet room',
  'Crowd murmuring in a large hall',
];

const MUSIC_PRESETS = [
  'Gentle piano, reflective and melancholic',
  'Soft ambient strings, warm and hopeful',
  'Mysterious dark orchestral, suspenseful',
  'Epic orchestral crescendo, triumphant brass',
  'Quiet solo cello, intimate and emotional',
  'Jazz lounge piano, smooth late-night feel',
  'Upbeat acoustic guitar, cheerful folk',
  'Ethereal choir pad, spiritual and vast',
];

/**
 * Bookends get their own presets because they carry an extra behaviour: they're
 * placed on the timeline automatically (intro at 0, outro at the end).
 */
const BOOKEND_PRESETS: Array<{
  label: string; prompt: string; seconds: number; place: 'start' | 'end';
}> = [
  { label: 'Book intro', prompt: 'Gentle orchestral intro, warm strings building slowly, cinematic and inviting', seconds: 10, place: 'start' },
  { label: 'Book outro', prompt: 'Soft piano outro, reflective and peaceful, fading gently', seconds: 8, place: 'end' },
  { label: 'Chapter break', prompt: 'Brief musical transition, soft harp and strings', seconds: 4, place: 'start' },
  { label: 'Podcast intro', prompt: 'Upbeat modern podcast intro, electronic beats with synth melody, energetic', seconds: 8, place: 'start' },
  { label: 'Podcast outro', prompt: 'Chill podcast outro, lo-fi beats fading out, relaxed', seconds: 6, place: 'end' },
  { label: 'Dramatic sting', prompt: 'Short dramatic orchestral sting, tension and impact', seconds: 3, place: 'start' },
];

const EXPRESSION_TAGS: Array<{ group: string; tags: string[] }> = [
  { group: 'Emotion', tags: ['happy', 'sad', 'angry', 'fearful', 'excited', 'melancholic', 'romantic', 'mysterious', 'anxious', 'confident', 'nostalgic', 'playful', 'serious', 'tender', 'dramatic'] },
  { group: 'Voice', tags: ['whisper', 'shout', 'gasp', 'sigh', 'laugh', 'sob', 'chuckle', 'giggle', 'growl', 'murmur', 'panting', 'clears throat'] },
  { group: 'Style', tags: ['conversational', 'formal', 'theatrical', 'monotone', 'breathy', 'commanding', 'gentle', 'intimate', 'warm', 'cold'] },
  { group: 'Narration', tags: ['storytelling tone', 'voice-over style', 'documentary style', 'bedtime story', 'dramatic pause', 'suspense build-up', 'inner monologue', 'flashback tone'] },
  { group: 'Pace', tags: ['slow', 'fast', 'pauses for effect', 'staccato', 'measured', 'rushed', 'building tension'] },
];

export function AudioStudioPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const capabilities = useAppStore((s) => s.capabilities);
  const [tab, setTab] = useState<Tab>('music');
  const [showTags, setShowTags] = useState(false);

  // Music
  const [musicPrompt, setMusicPrompt] = useState('');
  const [musicSeconds, setMusicSeconds] = useState(30);
  const [instrumental, setInstrumental] = useState(true);
  const [musicBusy, setMusicBusy] = useState(false);
  const [bookendBusy, setBookendBusy] = useState<string | null>(null);

  // SFX
  const [sfxPrompt, setSfxPrompt] = useState('');
  const [sfxSeconds, setSfxSeconds] = useState<number | undefined>(undefined);
  const [sfxLoop, setSfxLoop] = useState(false);
  const [sfxBusy, setSfxBusy] = useState(false);

  // Results + library
  const [fresh, setFresh] = useState<FreshAsset[]>([]);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [library, setLibrary] = useState<any[]>([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadLibrary = useCallback(async () => {
    if (!bookId) return;
    setLibraryBusy(true);
    try {
      setLibrary(await audioAssets.listLibrary(bookId));
    } catch {
      /* non-critical */
    } finally {
      setLibraryBusy(false);
    }
  }, [bookId]);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  const addFresh = (kind: AssetKind, label: string, assetId: string, cached: boolean) => {
    setFresh((prev) => [{ key: `${assetId}-${Date.now()}`, kind, label, assetId, cached }, ...prev].slice(0, 6));
  };

  /** Find (or create) the right track, then drop the clip after whatever's already there. */
  const placeOnTimeline = async (kind: AssetKind, assetId: string, label: string, uiKey: string) => {
    if (!bookId) return;
    setPlacingId(uiKey);
    try {
      const trackType = kind === 'imported' ? 'imported' : kind;
      const tracks = await timelineApi.tracks(bookId);
      let track = tracks.find((t: any) => t.type === trackType);
      if (!track) {
        const names: Record<string, string> = { sfx: 'Sound Effects', music: 'Music', imported: 'Imported' };
        track = await timelineApi.createTrack(bookId, { name: names[trackType], type: trackType });
      }
      const clips = track.clips || [];
      const endPos = clips.length > 0
        ? Math.max(...clips.map((c: any) => c.position_ms + (c.asset_duration_ms || c.trim_end_ms || 5000)))
        : 0;
      await timelineApi.createClip(bookId, track.id, { audio_asset_id: assetId, position_ms: endPos });
      toast.success(`Added "${label.slice(0, 40)}" at ${(endPos / 1000).toFixed(1)}s.`);
    } catch (err: any) {
      toast.error(`Could not place it on the timeline: ${err.message}`);
    } finally {
      setPlacingId(null);
    }
  };

  const handleGenerateMusic = async () => {
    if (!musicPrompt.trim()) return;
    setMusicBusy(true);
    try {
      const result = await elevenlabs.music({
        prompt: musicPrompt,
        music_length_ms: musicSeconds * 1000,
        force_instrumental: instrumental,
        book_id: bookId,
      });
      addFresh('music', musicPrompt, result.audio_asset_id, result.cached);
    } catch (err: any) {
      toast.error(`Music generation failed: ${err.message}`);
    } finally {
      setMusicBusy(false);
      loadLibrary();
    }
  };

  const handleGenerateSFX = async () => {
    if (!sfxPrompt.trim()) return;
    setSfxBusy(true);
    try {
      const result = await elevenlabs.sfx({
        prompt: sfxPrompt,
        duration_seconds: sfxSeconds,
        loop: sfxLoop,
        book_id: bookId,
      });
      addFresh('sfx', sfxPrompt, result.audio_asset_id, result.cached);
    } catch (err: any) {
      toast.error(`Sound effect failed: ${err.message}`);
    } finally {
      setSfxBusy(false);
      loadLibrary();
    }
  };

  /** Bookends are generated and positioned in one action. */
  const handleBookend = async (preset: typeof BOOKEND_PRESETS[number]) => {
    if (!bookId) return;
    setBookendBusy(preset.label);
    try {
      const result = await elevenlabs.music({
        prompt: `${preset.prompt}, ${preset.seconds} seconds`,
        music_length_ms: preset.seconds * 1000,
        force_instrumental: true,
        book_id: bookId,
      });
      addFresh('music', preset.label, result.audio_asset_id, result.cached);

      const tracks = await timelineApi.tracks(bookId);
      let track = tracks.find((t: any) => t.type === 'music');
      if (!track) track = await timelineApi.createTrack(bookId, { name: 'Music', type: 'music' });

      if (preset.place === 'start') {
        await timelineApi.createClip(bookId, track.id, {
          audio_asset_id: result.audio_asset_id,
          position_ms: 0,
          notes: preset.label,
          fade_in_ms: 500,
          fade_out_ms: 1000,
        });
        toast.success(`${preset.label} placed at the start of the timeline.`);
      } else {
        const allClips = tracks.flatMap((t: any) => t.clips || []);
        const endMs = allClips.length > 0
          ? Math.max(...allClips.map((c: any) => c.position_ms + (c.asset_duration_ms || c.trim_end_ms || 5000)))
          : 0;
        await timelineApi.createClip(bookId, track.id, {
          audio_asset_id: result.audio_asset_id,
          position_ms: Math.max(0, endMs - 1000),
          notes: preset.label,
          fade_in_ms: 1000,
          fade_out_ms: 500,
        });
        toast.success(`${preset.label} placed at the end (${(endMs / 1000).toFixed(1)}s).`);
      }
    } catch (err: any) {
      toast.error(`${preset.label} failed: ${err.message}`);
    } finally {
      setBookendBusy(null);
      loadLibrary();
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !bookId) return;
    setUploading(true);
    try {
      const result = await uploadAudio(bookId, file, file.name);
      addFresh('imported', file.name, result.audio_asset_id, false);
      toast.success(`Imported ${file.name}.`);
      await loadLibrary();
      setTab('library');
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleRename = async (assetId: string) => {
    if (!renameValue.trim()) return;
    try {
      await audioAssets.rename(assetId, renameValue.trim());
      setRenamingId(null);
      loadLibrary();
    } catch (err: any) {
      toast.error(`Rename failed: ${err.message}`);
    }
  };

  const handleDeleteAsset = async (assetId: string) => {
    if (!confirm('Delete this audio? It will also be removed from the timeline.')) return;
    setDeletingId(assetId);
    try {
      await audioAssets.delete(assetId);
      setLibrary((prev) => prev.filter((a) => a.id !== assetId));
    } catch (err: any) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const assetLabel = (asset: any): string => {
    if (asset.name) return asset.name;
    try {
      const params = JSON.parse(asset.generation_params || '{}');
      if (params.prompt) return params.prompt;
    } catch { /* fall through */ }
    return asset.id.slice(0, 8);
  };

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={{ minWidth: 0 }}>
          <h1 style={S.h1}>Sound</h1>
          <p style={S.sub}>Background music and sound effects for this project.</p>
        </div>
        <Button onClick={() => setShowTags(true)} icon={<Sparkles size={iconSize.sm} />}>
          Expression tags
        </Button>
      </header>

      <div style={S.tabRow}>
        <Segmented
          ariaLabel="Sound section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'music', label: 'Music', icon: <Music size={iconSize.sm} /> },
            { value: 'sfx', label: 'Sound effects', icon: <Wand2 size={iconSize.sm} /> },
            { value: 'library', label: 'Library', icon: <FolderOpen size={iconSize.sm} />, count: library.length },
          ]}
        />
      </div>

      {/* ── Music ── */}
      {tab === 'music' && (
        <section style={S.panel}>
          <textarea
            value={musicPrompt}
            onChange={(e) => setMusicPrompt(e.target.value)}
            placeholder="Describe the music — genre, mood, instruments. e.g. gentle piano, reflective, for a chapter transition"
            style={S.textarea}
            rows={3}
            aria-label="Music description"
          />

          <div style={S.controlRow}>
            <label style={S.inlineControl}>
              <span style={S.controlLabel}>Length</span>
              <input
                type="range"
                min={3}
                max={300}
                value={musicSeconds}
                onChange={(e) => setMusicSeconds(parseInt(e.target.value))}
                style={S.slider}
                aria-label="Music length in seconds"
              />
              <span style={S.controlValue}>{musicSeconds}s</span>
            </label>
            <label style={S.checkLabel}>
              <input type="checkbox" checked={instrumental} onChange={(e) => setInstrumental(e.target.checked)} />
              Instrumental only
            </label>
            <Button
              variant="primary"
              onClick={handleGenerateMusic}
              loading={musicBusy}
              disabled={!musicPrompt.trim()}
              icon={<Music size={iconSize.sm} />}
              style={{ marginLeft: 'auto' }}
            >
              {musicBusy ? 'Composing…' : 'Generate'}
            </Button>
          </div>

          <PresetRow label="Start from" presets={MUSIC_PRESETS} onPick={setMusicPrompt} />

          <div style={S.divider} />

          <div>
            <div style={S.groupLabel}>
              Intros & outros
              <span style={S.groupHint}>Generated and placed on the timeline for you</span>
            </div>
            <div style={S.chipWrap}>
              {BOOKEND_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => handleBookend(p)}
                  disabled={bookendBusy !== null}
                  style={S.bookendBtn}
                  title={p.prompt}
                >
                  {bookendBusy === p.label ? <Loader size={11} className="spin" /> : null}
                  <span style={{ fontWeight: 600 }}>{p.label}</span>
                  <span style={S.bookendMeta}>
                    {p.seconds}s · {p.place === 'start' ? 'at start' : 'at end'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <FreshStrip
            fresh={fresh}
            placingId={placingId}
            onPlace={placeOnTimeline}
            onDismiss={(key) => setFresh((prev) => prev.filter((f) => f.key !== key))}
          />
        </section>
      )}

      {/* ── Sound effects ── */}
      {tab === 'sfx' && (
        <section style={S.panel}>
          <textarea
            value={sfxPrompt}
            onChange={(e) => setSfxPrompt(e.target.value)}
            placeholder="Describe the sound. e.g. heavy wooden door creaking open, then slamming shut"
            style={S.textarea}
            rows={3}
            aria-label="Sound effect description"
          />

          <div style={S.controlRow}>
            <label style={S.inlineControl}>
              <span style={S.controlLabel}>Length</span>
              <input
                type="number"
                min={0.5}
                max={30}
                step={0.5}
                value={sfxSeconds ?? ''}
                onChange={(e) => setSfxSeconds(e.target.value ? parseFloat(e.target.value) : undefined)}
                placeholder="Auto"
                style={S.numInput}
                aria-label="Sound effect length in seconds"
              />
            </label>
            <label style={S.checkLabel}>
              <input type="checkbox" checked={sfxLoop} onChange={(e) => setSfxLoop(e.target.checked)} />
              <Repeat size={11} /> Seamless loop
            </label>
            <Button
              variant="primary"
              onClick={handleGenerateSFX}
              loading={sfxBusy}
              disabled={!sfxPrompt.trim()}
              icon={<Wand2 size={iconSize.sm} />}
              style={{ marginLeft: 'auto' }}
            >
              {sfxBusy ? 'Generating…' : 'Generate'}
            </Button>
          </div>

          <PresetRow label="Start from" presets={SFX_PRESETS} onPick={setSfxPrompt} />

          <FreshStrip
            fresh={fresh}
            placingId={placingId}
            onPlace={placeOnTimeline}
            onDismiss={(key) => setFresh((prev) => prev.filter((f) => f.key !== key))}
          />
        </section>
      )}

      {/* ── Library ── */}
      {tab === 'library' && (
        <section style={S.panel}>
          <div style={S.libraryBar}>
            <p style={S.libraryHint}>
              Everything you've generated or imported. Reuse any of it on the timeline.
            </p>
            <Button onClick={() => fileRef.current?.click()} loading={uploading} icon={<Upload size={iconSize.sm} />}>
              {uploading ? 'Uploading…' : 'Import audio'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".mp3,.wav,.ogg,.m4a,.flac,.aac"
              onChange={handleUpload}
              hidden
              aria-label="Import an audio file"
            />
          </div>

          {libraryBusy && library.length === 0 && (
            <div style={S.stateBox}><Loader size={13} className="spin" /> Loading…</div>
          )}

          {!libraryBusy && library.length === 0 && (
            <div style={S.stateBox}>
              Nothing here yet. Generate music or a sound effect, or import a file you already have.
            </div>
          )}

          {library.length > 0 && (
            <div style={S.assetList}>
              {library.map((asset) => {
                const label = assetLabel(asset);
                const renaming = renamingId === asset.id;
                const durationSec = asset.duration_ms ? (asset.duration_ms / 1000).toFixed(1) : '?';
                return (
                  <div
                    key={asset.id}
                    style={{ ...S.assetRow, opacity: deletingId === asset.id ? 0.4 : 1 }}
                  >
                    <div style={S.assetTop}>
                      <span
                        style={{
                          ...S.kindTag,
                          color: KIND_COLORS[asset.type as AssetKind] || 'var(--text-tertiary)',
                          background: `${KIND_HEX[asset.type as AssetKind] || '#888'}14`,
                        }}
                      >
                        {asset.type}
                      </span>

                      {renaming ? (
                        <>
                          <input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRename(asset.id);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            style={S.renameInput}
                            autoFocus
                            aria-label="New name"
                          />
                          <IconButton size="sm" label="Save name" onClick={() => handleRename(asset.id)}>
                            <Check size={iconSize.sm} />
                          </IconButton>
                          <IconButton size="sm" label="Cancel rename" onClick={() => setRenamingId(null)}>
                            <X size={iconSize.sm} />
                          </IconButton>
                        </>
                      ) : (
                        <>
                          <span style={S.assetName}>{label}</span>
                          <span style={S.assetMeta}>{durationSec}s</span>
                        </>
                      )}
                    </div>

                    <audio src={audioUrl(asset.id)} controls style={{ width: '100%' }} />

                    <div style={S.assetActions}>
                      <Button
                        size="sm"
                        variant="subtle"
                        loading={placingId === asset.id}
                        onClick={() => placeOnTimeline(asset.type, asset.id, label, asset.id)}
                        icon={<Plus size={iconSize.xs} />}
                      >
                        Add to timeline
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setRenamingId(asset.id); setRenameValue(label); }}
                        icon={<Edit3 size={iconSize.xs} />}
                      >
                        Rename
                      </Button>
                      <a href={audioDownloadUrl(asset.id)} download style={S.downloadLink}>
                        <Download size={iconSize.xs} /> Download
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteAsset(asset.id)}
                        icon={<Trash2 size={iconSize.xs} />}
                        style={{ color: 'var(--danger)' }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ── Expression tags reference ── */}
      <Modal
        open={showTags}
        onClose={() => setShowTags(false)}
        width={620}
        title="Expression tags"
        subtitle="Drop these into your manuscript text to steer delivery. Click one to copy it."
      >
        {!capabilities?.hasV3 && (
          <div style={S.warnBox}>
            Your ElevenLabs plan doesn't show access to the v3 model. Tags only take effect on v3.
          </div>
        )}

        <div style={S.exampleBox}>
          [storytelling tone] Once upon a time, [dramatic pause] there lived a dragon.
          [whispers] Nobody knew its name.
        </div>

        {EXPRESSION_TAGS.map((group) => (
          <div key={group.group} style={{ marginTop: 16 }}>
            <div style={S.groupLabel}>{group.group}</div>
            <div style={S.chipWrap}>
              {group.tags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => {
                    navigator.clipboard.writeText(`[${tag}]`);
                    toast.info(`Copied [${tag}]`, 1500);
                  }}
                  style={S.tagBtn}
                >
                  [{tag}]
                </button>
              ))}
            </div>
          </div>
        ))}
      </Modal>
    </div>
  );
}

// ── Local pieces ──

const KIND_COLORS: Record<AssetKind, string> = {
  sfx: 'var(--success)',
  music: 'var(--accent)',
  imported: 'var(--warning)',
};
const KIND_HEX: Record<AssetKind, string> = {
  sfx: '#4ade80',
  music: '#5b8def',
  imported: '#fbbf24',
};

function PresetRow({
  label, presets, onPick,
}: { label: string; presets: string[]; onPick: (p: string) => void }) {
  return (
    <div>
      <div style={S.groupLabel}>{label}</div>
      <div style={S.chipWrap}>
        {presets.map((p) => (
          <button key={p} onClick={() => onPick(p)} style={S.presetBtn} title={p}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Just-generated results, inline under the controls. This replaces the old
 * always-there 320px side rail, which duplicated the Library.
 */
function FreshStrip({
  fresh, placingId, onPlace, onDismiss,
}: {
  fresh: FreshAsset[];
  placingId: string | null;
  onPlace: (kind: AssetKind, assetId: string, label: string, uiKey: string) => void;
  onDismiss: (key: string) => void;
}) {
  if (fresh.length === 0) return null;
  return (
    <div>
      <div style={S.divider} />
      <div style={S.groupLabel}>
        Just generated
        <span style={S.groupHint}>Also saved to your Library</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {fresh.map((f) => (
          <div key={f.key} style={S.freshRow}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span
                style={{
                  ...S.kindTag,
                  color: KIND_COLORS[f.kind],
                  background: `${KIND_HEX[f.kind]}14`,
                }}
              >
                {f.kind}
              </span>
              <span style={S.assetName}>{f.label}</span>
              {f.cached && <span style={S.cachedTag}>reused</span>}
              <IconButton
                size="sm"
                label="Dismiss"
                onClick={() => onDismiss(f.key)}
                style={{ marginLeft: 'auto' }}
              >
                <X size={iconSize.sm} />
              </IconButton>
            </div>
            <audio src={audioUrl(f.assetId)} controls style={{ width: '100%' }} />
            <Button
              size="sm"
              variant="subtle"
              loading={placingId === f.key}
              onClick={() => onPlace(f.kind, f.assetId, f.label, f.key)}
              icon={<Plus size={iconSize.xs} />}
              style={{ alignSelf: 'flex-start' }}
            >
              Add to timeline
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { padding: '28px 32px 56px', maxWidth: 960, margin: '0 auto' },

  header: {
    display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
    gap: 20, flexWrap: 'wrap', marginBottom: 20,
  },
  h1: { fontSize: text.heading, fontWeight: weight.semibold, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.03em' },
  sub: { fontSize: text.label, color: 'var(--text-tertiary)', margin: '5px 0 0' },

  tabRow: { marginBottom: 20 },

  panel: {
    display: 'flex', flexDirection: 'column', gap: 22, padding: 24,
    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-lg)',
  },

  textarea: {
    ...field,
    padding: 16,
    minHeight: 92,
    lineHeight: 1.65,
    resize: 'vertical',
  },

  controlRow: { display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' },
  inlineControl: { display: 'flex', alignItems: 'center', gap: 11 },
  controlLabel: { fontSize: text.label, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' },
  controlValue: {
    fontSize: text.label, color: 'var(--text-secondary)', minWidth: 42,
    fontVariantNumeric: 'tabular-nums', fontWeight: weight.medium,
  },
  slider: { width: 170 },
  numInput: { ...field, width: 92 },
  checkLabel: {
    display: 'flex', alignItems: 'center', gap: 9, fontSize: text.label,
    color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
  },

  divider: { height: 1, background: 'var(--border-subtle)', margin: '4px 0 20px' },
  groupLabel: {
    display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
    fontSize: text.micro, fontWeight: weight.semibold, color: 'var(--text-secondary)',
    textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 11,
  },
  groupHint: {
    fontSize: text.meta, fontWeight: weight.normal, color: 'var(--text-muted)',
    textTransform: 'none', letterSpacing: 0,
  },
  chipWrap: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  presetBtn: {
    padding: '9px 15px', minHeight: 36, background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)',
    borderRadius: 20, cursor: 'pointer', fontSize: text.label, textAlign: 'left',
    maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  bookendBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 9, padding: '10px 16px',
    minHeight: 40, background: 'var(--bg-elevated)', color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: text.label,
  },
  bookendMeta: { fontSize: text.meta, color: 'var(--text-muted)' },

  libraryBar: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  libraryHint: { flex: 1, minWidth: 220, fontSize: text.label, color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.55 },

  stateBox: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '22px 18px',
    fontSize: text.body, color: 'var(--text-tertiary)', background: 'var(--bg-deep)',
    border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', lineHeight: 1.6,
  },

  assetList: { display: 'flex', flexDirection: 'column', gap: 12 },
  assetRow: {
    display: 'flex', flexDirection: 'column', gap: 11, padding: 16,
    background: 'var(--bg-deep)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
  },
  assetTop: { display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 },
  kindTag: {
    fontSize: text.micro, fontWeight: weight.semibold, padding: '3px 9px', borderRadius: 20,
    flexShrink: 0, textTransform: 'uppercase', letterSpacing: 0.4,
  },
  assetName: {
    flex: 1, minWidth: 0, fontSize: text.body, color: 'var(--text-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  assetMeta: { fontSize: text.meta, color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  cachedTag: {
    fontSize: text.micro, color: 'var(--text-muted)', background: 'var(--bg-elevated)',
    padding: '3px 9px', borderRadius: 20, flexShrink: 0,
  },
  renameInput: { ...field, flex: 1, background: 'var(--bg-base)' },
  assetActions: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  downloadLink: {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px',
    minHeight: 32, borderRadius: 'var(--radius-md)', border: '1px solid transparent',
    color: 'var(--text-secondary)', fontSize: text.label, fontWeight: weight.semibold,
    textDecoration: 'none',
  },

  freshRow: {
    display: 'flex', flexDirection: 'column', gap: 11, padding: 16,
    background: 'var(--bg-deep)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
  },

  warnBox: {
    padding: 16, marginBottom: 18, background: 'var(--warning-subtle)',
    border: '1px solid rgba(251,191,36,0.16)', borderRadius: 'var(--radius-md)',
    color: 'var(--warning)', fontSize: text.label, lineHeight: 1.6,
  },
  exampleBox: {
    padding: 18, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)', fontSize: text.body, lineHeight: 1.85,
    color: 'var(--text-secondary)', fontFamily: 'Georgia, serif',
  },
  tagBtn: {
    padding: '7px 13px', minHeight: 34, background: 'var(--accent-subtle)', color: 'var(--accent)',
    border: '1px solid rgba(91,141,239,0.16)', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: text.label, fontFamily: 'monospace',
  },
};
