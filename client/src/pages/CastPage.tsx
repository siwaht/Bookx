import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Check, ChevronDown, FolderOpen, Layers, Loader, Mic, Pause, Play, Plus,
  Sparkles, Trash2, UserPlus, Volume2, Wand2, Zap,
} from 'lucide-react';
import { aiParse, audioUrl, characters as charsApi, elevenlabs, ttsProviders } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { toast } from '../components/Toast';
import { Collapsible } from '../components/ui/Collapsible';
import { Modal } from '../components/ui/Modal';
import { Button, IconButton } from '../components/ui/Button';
import { clampLines, field, icon, text, weight } from '../components/ui/tokens';
import { SavedCastsModal } from '../components/SavedCastsModal';
import { PROVIDER_COLORS, PROVIDER_LABELS, VoicePicker } from '../components/VoicePicker';
import type { Character, TTSProviderName } from '../types';

type Role = 'narrator' | 'character' | 'host' | 'guest';

const ROLE_LABELS: Record<Role, string> = {
  narrator: 'Narrator',
  character: 'Character',
  host: 'Host',
  guest: 'Guest',
};

const AUDIOBOOK_ROLES: Role[] = ['narrator', 'character'];
const PODCAST_ROLES: Role[] = ['host', 'guest', 'narrator', 'character'];

const DEFAULT_SAMPLE = 'The quick brown fox jumps over the lazy dog.';

/** Stable per-character colour so rows stay recognisable between visits. */
const AVATAR_COLORS = [
  ['#5b8def', '#7c6cf5'], ['#a78bfa', '#f472b6'], ['#2dd4bf', '#4ade80'],
  ['#fbbf24', '#fb923c'], ['#f87171', '#fb7185'], ['#38bdf8', '#818cf8'],
  ['#4ade80', '#2dd4bf'], ['#c084fc', '#a78bfa'],
];
function avatarGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 997;
  const [a, b] = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function CastPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const book = useAppStore((s) => s.currentBook);
  const capabilities = useAppStore((s) => s.capabilities);
  const isPodcast = book?.project_type === 'podcast';
  const roleOptions = isPodcast ? PODCAST_ROLES : AUDIOBOOK_ROLES;
  const noun = isPodcast ? 'speaker' : 'character';

  const [cast, setCast] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [autoCasting, setAutoCasting] = useState(false);
  const [autoPickingId, setAutoPickingId] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [showCastLibrary, setShowCastLibrary] = useState(false);
  const [pickerFor, setPickerFor] = useState<Character | null>(null);
  const [confirmDetect, setConfirmDetect] = useState(false);

  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<Role>(isPodcast ? 'host' : 'narrator');

  const [sample, setSample] = useState(DEFAULT_SAMPLE);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const voiced = useMemo(() => cast.filter((c) => c.voice_id), [cast]);
  const unvoiced = useMemo(() => cast.filter((c) => !c.voice_id), [cast]);

  const load = useCallback(async () => {
    if (!bookId) return;
    try {
      const data = await charsApi.list(bookId);
      setCast(Array.isArray(data) ? data : []);
    } catch (err: any) {
      toast.error(`Could not load the cast: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setNewRole(isPodcast ? 'host' : 'narrator'); }, [isPodcast]);

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
  }, []);
  useEffect(() => stopPreview, [stopPreview]);

  // ── Mutations ──

  const patch = async (id: string, updates: Partial<Character>) => {
    if (!bookId) return;
    setCast((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } as Character : c)));
    try {
      await charsApi.update(bookId, id, updates);
    } catch (err: any) {
      toast.error(err.message || 'Could not save that change');
      load();
    }
  };

  const handleAdd = async () => {
    if (!bookId || !newName.trim()) return;
    try {
      const created: Character = await charsApi.create(bookId, { name: newName.trim(), role: newRole });
      setNewName('');
      setShowAdd(false);
      await load();
      setExpandedId(created.id);
      if (created.remembered && created.voice_name) {
        toast.success(`Added ${created.name} — reused their saved voice, ${created.voice_name}.`);
      } else {
        toast.success(`Added ${created.name}. Pick a voice, or use Auto-cast.`);
      }
    } catch (err: any) {
      toast.error(err.message || `Could not add that ${noun}`);
    }
  };

  const handleDelete = async (char: Character) => {
    if (!bookId) return;
    if (!confirm(`Remove ${char.name} from the cast?`)) return;
    try {
      await charsApi.delete(bookId, char.id);
      setCast((prev) => prev.filter((c) => c.id !== char.id));
      if (expandedId === char.id) setExpandedId(null);
    } catch (err: any) {
      toast.error(err.message || 'Could not remove them');
    }
  };

  const handleAutoCast = async (characterIds?: string[]) => {
    if (!bookId) return;
    const single = characterIds?.length === 1;
    if (single) setAutoPickingId(characterIds![0]);
    else setAutoCasting(true);
    try {
      const result = await charsApi.autoAssignVoices(bookId, { characterIds });
      if (result.assigned > 0) {
        const recalled = result.remembered_from_casting ?? 0;
        toast.success(
          `Cast ${result.assigned} voice${result.assigned === 1 ? '' : 's'}.` +
            (recalled > 0 ? ` ${recalled} reused from a saved cast.` : '') +
            ' Change any of them below.'
        );
        await load();
      } else {
        toast.info(result.message || 'Nothing left to cast.');
      }
    } catch (err: any) {
      toast.error(err.message || 'Auto-cast failed');
    } finally {
      setAutoCasting(false);
      setAutoPickingId(null);
    }
  };

  /** Re-reads the manuscript with an LLM. Destructive: it rebuilds characters and segments. */
  const handleDetectCharacters = async () => {
    if (!bookId) return;
    setConfirmDetect(false);
    setDetecting(true);
    try {
      const result = await aiParse.parse(bookId);
      toast.success(
        `Found ${result.characters_created} ${noun}${result.characters_created === 1 ? '' : 's'} ` +
          `across ${result.segments_created} lines. Casting voices now…`
      );
      await load();
      await handleAutoCast();
    } catch (err: any) {
      toast.error(err.message || 'Detection failed');
    } finally {
      setDetecting(false);
    }
  };

  const handleAssignVoice = async (voice: { voiceId: string; name: string; provider: TTSProviderName }) => {
    const target = pickerFor;
    if (!target) return;
    await patch(target.id, {
      voice_id: voice.voiceId,
      voice_name: voice.name,
      tts_provider: voice.provider,
    });
    toast.success(`${target.name} now uses ${voice.name}.`);
  };

  /** Speaks this character's own line when there is one, so casting can be judged in context. */
  const handlePreview = async (char: Character) => {
    if (!char.voice_id || !bookId) return;
    if (playingId === char.id) { stopPreview(); return; }
    stopPreview();

    const line = (char.sample_line || '').trim();
    const spoken = (line.length > 8 ? line : sample.trim() || DEFAULT_SAMPLE).slice(0, 400);

    setPreviewingId(char.id);
    try {
      const provider = char.tts_provider || 'elevenlabs';
      const result = provider === 'elevenlabs'
        ? await elevenlabs.tts({
            text: spoken,
            voice_id: char.voice_id,
            model_id: char.model_id,
            voice_settings: {
              stability: char.stability,
              similarity_boost: char.similarity_boost,
              style: char.style,
              use_speaker_boost: !!char.speaker_boost,
              speed: char.speed,
            },
            book_id: bookId,
          })
        : await ttsProviders.generate({
            provider,
            text: spoken,
            voice_id: char.voice_id,
            model_id: char.model_id,
            speed: char.speed,
            book_id: bookId,
          });

      const audio = new Audio(audioUrl(result.audio_asset_id));
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      setPlayingId(char.id);
      await audio.play();
    } catch (err: any) {
      setPlayingId(null);
      toast.error(`Preview failed: ${err.message}`);
    } finally {
      setPreviewingId(null);
    }
  };

  const handleCastApplied = async (result: { updated: number; created: number; castName: string }) => {
    await load();
    const parts = [`${result.updated} matched`];
    if (result.created > 0) parts.push(`${result.created} added`);
    toast.success(`Applied "${result.castName}" — ${parts.join(', ')}.`);
  };

  // ── Render ──

  if (loading) {
    return (
      <div style={S.centered}>
        <Loader size={icon.lg} className="spin" /> Loading cast…
      </div>
    );
  }

  const models = capabilities?.models || [];
  const seriesId = book?.series_id ?? null;

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={{ minWidth: 0 }}>
          <h1 style={S.h1}>Cast</h1>
          <p style={S.sub}>
            {cast.length === 0
              ? `Give every ${noun} a voice.`
              : `${cast.length} ${noun}${cast.length === 1 ? '' : 's'} · ${voiced.length} voiced` +
                (unvoiced.length > 0 ? ` · ${unvoiced.length} still needs a voice` : '')}
          </p>
        </div>

        {cast.length > 0 && (
          <div style={S.headerActions}>
            <Button onClick={() => setShowCastLibrary(true)} icon={<FolderOpen size={icon.sm} />}>
              Cast library
            </Button>
            <Button onClick={() => setShowAdd(true)} icon={<Plus size={icon.sm} />}>
              Add {noun}
            </Button>
            {unvoiced.length > 0 ? (
              <Button
                variant="primary"
                loading={autoCasting}
                onClick={() => handleAutoCast()}
                icon={<Zap size={icon.sm} />}
              >
                Auto-cast {unvoiced.length}
              </Button>
            ) : (
              <span style={S.doneTag}>
                <Check size={icon.sm} /> Fully cast
              </span>
            )}
          </div>
        )}
      </header>

      {/* Volumes: make reusing the previous volume's cast an obvious move. */}
      {cast.length > 0 && (
        <div style={S.seriesBar}>
          <Layers size={icon.sm} color="var(--purple)" style={{ flexShrink: 0 }} />
          <span style={S.seriesText}>
            {seriesId
              ? `Part of a series${book?.series_volume ? ` (volume ${book.series_volume})` : ''}. Voices you assign here are remembered for the other volumes.`
              : 'Working on a multi-volume book? Save this cast, then apply it to the next volume so every character keeps the same voice.'}
          </span>
          <Button size="sm" variant="subtle" onClick={() => setShowCastLibrary(true)} icon={<FolderOpen size={icon.xs} />}>
            {seriesId ? 'Manage casts' : 'Save cast'}
          </Button>
        </div>
      )}

      {/* ── Empty state: the three ways in ── */}
      {cast.length === 0 ? (
        <div style={S.optionGrid}>
          <OptionCard
            icon={<Wand2 size={icon.lg} />}
            accent="var(--accent)"
            title="Cast it for me"
            body={`Read the ${isPodcast ? 'script' : 'manuscript'} with AI, find every ${noun}, then give each one a distinct voice.`}
            action="Detect & cast"
            busy={detecting}
            onClick={() => setConfirmDetect(true)}
          />
          <OptionCard
            icon={<UserPlus size={icon.lg} />}
            accent="var(--teal)"
            title="Add my own"
            body="Name each one yourself and choose their voice by hand. Full control, nothing guessed."
            action={`Add a ${noun}`}
            onClick={() => setShowAdd(true)}
          />
          <OptionCard
            icon={<Layers size={icon.lg} />}
            accent="var(--purple)"
            title="Reuse a cast"
            body="Bring in the voices from an earlier volume, a sequel, or another episode. Matched by name."
            action="Open cast library"
            onClick={() => setShowCastLibrary(true)}
          />
        </div>
      ) : (
        <div style={S.list}>
          {cast.map((char) => {
            const expanded = expandedId === char.id;
            const provider = char.tts_provider || 'elevenlabs';
            return (
              <div key={char.id} style={{ ...S.rowWrap, ...(expanded ? S.rowWrapExpanded : {}) }}>
                <div
                  style={S.row}
                  className="cast-row"
                  onClick={() => setExpandedId(expanded ? null : char.id)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedId(expanded ? null : char.id);
                    }
                  }}
                >
                  <span style={{ ...S.avatar, background: avatarGradient(char.id) }} aria-hidden="true">
                    {char.name.charAt(0).toUpperCase()}
                  </span>

                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={S.nameLine}>
                      <span style={S.name}>{char.name}</span>
                      {char.voice_name ? (
                        <span style={S.voicedBy}>
                          (Voiced by <span style={{ color: PROVIDER_COLORS[provider] }}>{char.voice_name}</span>)
                        </span>
                      ) : (
                        <span style={S.needsVoice}>needs a voice</span>
                      )}
                    </div>
                    <div style={S.quote}>
                      {char.sample_line
                        ? `“${char.sample_line}”`
                        : <span style={{ fontStyle: 'normal', color: 'var(--text-muted)' }}>
                            {ROLE_LABELS[char.role as Role] || char.role}
                            {char.line_count ? ` · ${char.line_count} lines` : ' · no lines assigned yet'}
                          </span>}
                    </div>
                  </div>

                  <div style={S.rowActions} onClick={(e) => e.stopPropagation()}>
                    {char.voice_id ? (
                      <IconButton
                        label={playingId === char.id ? `Stop ${char.name}` : `Hear ${char.name}`}
                        onClick={() => handlePreview(char)}
                        disabled={previewingId === char.id}
                      >
                        {previewingId === char.id ? (
                          <Loader size={icon.sm} className="spin" />
                        ) : playingId === char.id ? (
                          <Pause size={icon.sm} />
                        ) : (
                          <Volume2 size={icon.sm} />
                        )}
                      </IconButton>
                    ) : (
                      <Button size="sm" variant="subtle" onClick={() => setPickerFor(char)} icon={<Mic size={icon.xs} />}>
                        Choose voice
                      </Button>
                    )}
                    <IconButton
                      label={`Remove ${char.name}`}
                      className="cast-row-delete"
                      onClick={() => handleDelete(char)}
                    >
                      <Trash2 size={icon.sm} />
                    </IconButton>
                    <ChevronDown
                      size={icon.sm}
                      color="var(--text-muted)"
                      style={{
                        flexShrink: 0,
                        transform: expanded ? 'rotate(180deg)' : 'none',
                        transition: 'transform 150ms var(--ease-out)',
                      }}
                    />
                  </div>
                </div>

                {expanded && (
                  <div style={S.detail}>
                    <div style={S.detailGrid}>
                      <label style={S.fieldWrap}>
                        <span style={S.fieldLabel}>Name</span>
                        <input
                          value={char.name}
                          onChange={(e) => patch(char.id, { name: e.target.value })}
                          style={field}
                          aria-label={`Name of ${char.name}`}
                        />
                      </label>
                      <label style={S.fieldWrap}>
                        <span style={S.fieldLabel}>Role</span>
                        <select
                          value={char.role}
                          onChange={(e) => patch(char.id, { role: e.target.value as Role })}
                          style={{ ...field, cursor: 'pointer' }}
                          aria-label={`Role of ${char.name}`}
                        >
                          {roleOptions.map((r) => (
                            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                          ))}
                        </select>
                      </label>
                      <div style={S.fieldWrap}>
                        <span style={S.fieldLabel}>Voice</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <Button onClick={() => setPickerFor(char)} icon={<Mic size={icon.sm} />} style={{ flex: 1 }}>
                            {char.voice_id ? 'Change' : 'Choose'}
                          </Button>
                          {char.voice_id ? (
                            <Button
                              variant="danger"
                              onClick={() => { stopPreview(); patch(char.id, { voice_id: null, voice_name: null }); }}
                            >
                              Clear
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              loading={autoPickingId === char.id}
                              onClick={() => handleAutoCast([char.id])}
                              icon={<Sparkles size={icon.sm} />}
                            >
                              Auto-pick
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>

                    {char.voice_id && (
                      <div style={S.sampleRow}>
                        <input
                          value={sample}
                          onChange={(e) => setSample(e.target.value)}
                          placeholder={DEFAULT_SAMPLE}
                          style={{ ...field, flex: 1 }}
                          aria-label="Custom preview text"
                        />
                        <Button
                          onClick={() => handlePreview(char)}
                          loading={previewingId === char.id}
                          icon={playingId === char.id ? <Pause size={icon.sm} /> : <Play size={icon.sm} />}
                        >
                          {playingId === char.id ? 'Stop' : 'Preview'}
                        </Button>
                      </div>
                    )}
                    {char.voice_id && char.sample_line && (
                      <p style={S.sampleHint}>
                        The speaker button on the row reads this character's own line instead.
                      </p>
                    )}

                    <Collapsible
                      title="Fine-tune delivery"
                      summary={`${char.model_id || 'default model'} · ${char.speed.toFixed(2)}× speed`}
                    >
                      {provider === 'elevenlabs' && (
                        <>
                          <label style={S.fieldWrap}>
                            <span style={S.fieldLabel}>Model</span>
                            <select
                              value={char.model_id}
                              onChange={(e) => patch(char.id, { model_id: e.target.value })}
                              style={{ ...field, cursor: 'pointer' }}
                              aria-label="TTS model"
                            >
                              {models.map((m) => (
                                <option key={m.model_id} value={m.model_id}>{m.name || m.model_id}</option>
                              ))}
                              {models.length === 0 && <option value="eleven_v3">Eleven v3</option>}
                            </select>
                          </label>
                          <Slider label="Stability" hint="Lower is more expressive, higher is more consistent"
                            value={char.stability} min={0} max={1} step={0.05}
                            onChange={(v) => patch(char.id, { stability: v })} />
                          <Slider label="Similarity" hint="How closely it sticks to the original voice"
                            value={char.similarity_boost} min={0} max={1} step={0.05}
                            onChange={(v) => patch(char.id, { similarity_boost: v })} />
                          <Slider label="Style" hint="Exaggerates the voice's own delivery"
                            value={char.style} min={0} max={1} step={0.05}
                            onChange={(v) => patch(char.id, { style: v })} />
                          <label style={S.checkLabel}>
                            <input
                              type="checkbox"
                              checked={!!char.speaker_boost}
                              onChange={(e) => patch(char.id, { speaker_boost: e.target.checked ? 1 : 0 })}
                            />
                            Speaker boost
                          </label>
                        </>
                      )}

                      {provider === 'openai' && (
                        <label style={S.fieldWrap}>
                          <span style={S.fieldLabel}>Model</span>
                          <select
                            value={char.model_id}
                            onChange={(e) => patch(char.id, { model_id: e.target.value })}
                            style={{ ...field, cursor: 'pointer' }}
                            aria-label="OpenAI TTS model"
                          >
                            <option value="gpt-4o-mini-tts">GPT-4o mini TTS</option>
                            <option value="tts-1">TTS-1 (fast)</option>
                            <option value="tts-1-hd">TTS-1 HD (quality)</option>
                          </select>
                        </label>
                      )}

                      <Slider label="Speed" value={char.speed} min={0.5} max={2} step={0.05}
                        format={(v) => `${v.toFixed(2)}×`}
                        onChange={(v) => patch(char.id, { speed: v })} />
                    </Collapsible>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Dialogs ── */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        width={460}
        title={`Add a ${noun}`}
        subtitle="A voice can be assigned now or later."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <label style={S.fieldWrap}>
            <span style={S.fieldLabel}>Name</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder={isPodcast ? 'e.g. Host, Jordan' : 'e.g. Narrator, Alice'}
              style={field}
              autoFocus
              aria-label="Name"
            />
          </label>
          <label style={S.fieldWrap}>
            <span style={S.fieldLabel}>Role</span>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as Role)}
              style={{ ...field, cursor: 'pointer' }}
              aria-label="Role"
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </label>
          <Button variant="primary" block disabled={!newName.trim()} onClick={handleAdd} icon={<Plus size={icon.sm} />}>
            Add to cast
          </Button>
          <p style={S.modalHint}>
            If this name was cast before — in an earlier volume or another episode — their previous voice comes back automatically.
          </p>
        </div>
      </Modal>

      <Modal
        open={confirmDetect}
        onClose={() => setConfirmDetect(false)}
        width={500}
        title="Detect characters with AI"
        subtitle={`Reads the ${isPodcast ? 'script' : 'manuscript'} and rebuilds the cast.`}
      >
        <p style={S.confirmBody}>
          This re-analyses your text, replaces the current cast, and re-splits it into speaker lines.
          Any manual line assignments will be redone.
        </p>
        <p style={{ ...S.confirmBody, marginTop: 12 }}>
          Voices are cast straight afterwards, and you can change any of them.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <Button variant="primary" onClick={handleDetectCharacters} icon={<Wand2 size={icon.sm} />}>
            Detect &amp; cast
          </Button>
          <Button onClick={() => setConfirmDetect(false)}>Cancel</Button>
        </div>
      </Modal>

      {bookId && (
        <SavedCastsModal
          open={showCastLibrary}
          onClose={() => setShowCastLibrary(false)}
          bookId={bookId}
          voicedCount={voiced.length}
          suggestedName={book?.title ? `${book.title} cast` : 'My cast'}
          seriesId={seriesId}
          seriesName={null}
          onApplied={handleCastApplied}
        />
      )}

      {pickerFor && (
        <VoicePicker
          open
          onClose={() => setPickerFor(null)}
          characterName={pickerFor.name}
          role={pickerFor.role}
          currentVoiceId={pickerFor.voice_id}
          onPick={handleAssignVoice}
        />
      )}
    </div>
  );
}

// ── Local building blocks ──

function OptionCard({
  icon: iconNode, accent, title, body, action, onClick, busy,
}: {
  icon: React.ReactNode; accent: string; title: string; body: string;
  action: string; onClick: () => void; busy?: boolean;
}) {
  return (
    <div style={S.optionCard} className="card-hover">
      <div style={{ ...S.optionIcon, color: accent }}>{iconNode}</div>
      <h3 style={S.optionTitle}>{title}</h3>
      <p style={S.optionBody}>{body}</p>
      <Button block loading={busy} onClick={onClick} style={{ color: accent, marginTop: 4 }}>
        {action}
      </Button>
    </div>
  );
}

function Slider({
  label, hint, value, min, max, step, onChange, format,
}: {
  label: string; hint?: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={S.fieldLabel}>{label}</span>
        <span style={S.sliderValue}>{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%' }}
        aria-label={label}
      />
      {hint && <span style={S.sliderHint}>{hint}</span>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { padding: '28px 32px 56px', maxWidth: 1100, margin: '0 auto' },
  centered: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    padding: 64, color: 'var(--text-tertiary)', fontSize: text.body,
  },

  header: {
    display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
    gap: 20, flexWrap: 'wrap', marginBottom: 20,
  },
  h1: { fontSize: text.heading, fontWeight: weight.semibold, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.03em' },
  sub: { fontSize: text.label, color: 'var(--text-tertiary)', margin: '5px 0 0' },
  headerActions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  doneTag: {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px',
    fontSize: text.label, fontWeight: weight.semibold, color: 'var(--success)',
    background: 'var(--success-subtle)', borderRadius: 'var(--radius-md)',
  },

  seriesBar: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    padding: '13px 16px', marginBottom: 20,
    background: 'var(--purple-subtle)', border: '1px solid rgba(167,139,250,0.18)',
    borderRadius: 'var(--radius-md)',
  },
  seriesText: { flex: 1, minWidth: 220, fontSize: text.label, color: 'var(--text-secondary)', lineHeight: 1.5 },

  optionGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(268px, 1fr))', gap: 18,
  },
  optionCard: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: 26,
    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-lg)',
  },
  optionIcon: {
    width: 48, height: 48, borderRadius: 'var(--radius-md)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-elevated)', marginBottom: 4,
  },
  optionTitle: { fontSize: text.title, fontWeight: weight.semibold, color: 'var(--text-primary)', margin: 0 },
  optionBody: { fontSize: text.label, color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.6, flex: 1 },

  list: {
    display: 'flex', flexDirection: 'column',
    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-lg)', overflow: 'hidden',
  },
  rowWrap: { borderBottom: '1px solid var(--border-subtle)' },
  rowWrapExpanded: { background: 'var(--bg-base)' },
  row: {
    display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px',
    cursor: 'pointer', minHeight: 74,
  },
  avatar: {
    width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: text.strong, fontWeight: weight.bold, color: '#fff',
    textShadow: '0 1px 2px rgba(0,0,0,0.25)',
  },
  nameLine: { display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' },
  name: { fontSize: text.strong, fontWeight: weight.semibold, color: 'var(--text-primary)' },
  voicedBy: { fontSize: text.label, color: 'var(--text-tertiary)' },
  needsVoice: {
    fontSize: text.micro, fontWeight: weight.semibold, color: 'var(--warning)',
    background: 'var(--warning-subtle)', padding: '2px 9px', borderRadius: 20,
  },
  quote: {
    ...clampLines(1),
    fontSize: text.label, color: 'var(--text-secondary)',
    fontStyle: 'italic', marginTop: 4, lineHeight: 1.5,
  },
  rowActions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },

  detail: {
    display: 'flex', flexDirection: 'column', gap: 16,
    padding: '4px 20px 22px 78px',
  },
  detailGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14,
  },
  fieldWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldLabel: { fontSize: text.meta, fontWeight: weight.medium, color: 'var(--text-tertiary)' },
  sampleRow: { display: 'flex', gap: 10, alignItems: 'stretch' },
  sampleHint: { fontSize: text.meta, color: 'var(--text-muted)', margin: 0 },
  sliderValue: { fontSize: text.meta, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' },
  sliderHint: { fontSize: text.meta, color: 'var(--text-muted)' },
  checkLabel: {
    display: 'flex', alignItems: 'center', gap: 10, fontSize: text.label,
    color: 'var(--text-secondary)', cursor: 'pointer',
  },
  modalHint: { fontSize: text.meta, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 },
  confirmBody: { fontSize: text.body, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.65 },
};
