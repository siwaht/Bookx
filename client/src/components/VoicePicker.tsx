import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Globe, Hash, Loader, Pause, Play, Search, Sparkles, X,
} from 'lucide-react';
import { elevenlabs, ttsProviders } from '../services/api';
import { toast } from './Toast';
import type { TTSProviderName, TTSVoice } from '../types';
import { Modal } from './ui/Modal';
import { Chip } from './ui/Segmented';
import { icon as iconSize, text, weight } from './ui/tokens';

export const PROVIDER_LABELS: Record<TTSProviderName, string> = {
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  google: 'Google',
  amazon: 'Polly',
  deepgram: 'Deepgram',
  cartesia: 'Cartesia',
};

export const PROVIDER_COLORS: Record<TTSProviderName, string> = {
  elevenlabs: '#5b8def',
  openai: '#10a37f',
  google: '#4285f4',
  amazon: '#ff9900',
  deepgram: '#13ef93',
  cartesia: '#ff6b6b',
};

export interface PickedVoice {
  voiceId: string;
  name: string;
  provider: TTSProviderName;
}

interface VoicePickerProps {
  open: boolean;
  onClose: () => void;
  /** Who we're casting. Drives the "best for this role" ranking. */
  characterName: string;
  role: string;
  currentVoiceId?: string | null;
  onPick: (voice: PickedVoice) => void | Promise<void>;
}

type GenderFilter = '' | 'male' | 'female';

/**
 * Role-fit score, deliberately mirroring the server's `findBestVoice`
 * heuristics (server/src/lib/voice-casting.ts) so that what the picker
 * recommends and what Auto-cast chooses agree with each other.
 */
function roleFitScore(voice: TTSVoice, role: string): number {
  let score = 0;
  const name = (voice.name || '').toLowerCase();
  const category = (voice.category || '').toLowerCase();
  const labelValues = Object.values(voice.labels || {}).map((l) => String(l).toLowerCase());
  const description = (voice.description || '').toLowerCase();
  const haystack = [...labelValues, description];

  if (role === 'narrator') {
    if (name.includes('narrator') || name.includes('storytell')) score += 10;
    if (category === 'professional' || category === 'narration') score += 5;
    if (haystack.some((l) => l.includes('narrat') || l.includes('storytell') || l.includes('audiobook'))) score += 8;
  }

  if (role === 'character' || role === 'guest' || role === 'host') {
    if (category === 'conversational' || category === 'characters') score += 3;
    if (haystack.some((l) => l.includes('character') || l.includes('conversational'))) score += 4;
  }

  if (role === 'host' && haystack.some((l) => l.includes('podcast') || l.includes('news'))) score += 5;

  return score;
}

/** Short, human descriptors for a voice row: "female · American · narration". */
function voiceTags(voice: TTSVoice): string[] {
  const labels = voice.labels || {};
  const seen = new Set<string>();
  const tags: string[] = [];
  const push = (value?: string | null) => {
    if (!value) return;
    const key = String(value).toLowerCase();
    if (seen.has(key) || key === 'null') return;
    seen.add(key);
    tags.push(String(value));
  };

  push(voice.gender || labels.gender);
  push(labels.accent);
  push(labels.age);
  push(labels.use_case || labels['use case'] || labels.description);
  push(voice.language);
  if (tags.length === 0) push(voice.category);
  return tags.slice(0, 3);
}

export function VoicePicker({
  open,
  onClose,
  characterName,
  role,
  currentVoiceId,
  onPick,
}: VoicePickerProps) {
  const [allVoices, setAllVoices] = useState<TTSVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<TTSProviderName | ''>('');
  const [gender, setGender] = useState<GenderFilter>('');
  const [assigningId, setAssigningId] = useState<string | null>(null);

  // Extra sources, hidden until asked for.
  const [extra, setExtra] = useState<'' | 'community' | 'id'>('');
  const [communityQuery, setCommunityQuery] = useState('');
  const [communityResults, setCommunityResults] = useState<any[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [voiceIdInput, setVoiceIdInput] = useState('');
  const [voiceIdLoading, setVoiceIdLoading] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingUrl(null);
  }, []);

  const togglePreview = useCallback((url: string) => {
    if (playingUrl === url) {
      stopPreview();
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlayingUrl(url);
    audio.onended = () => setPlayingUrl(null);
    audio.play().catch(() => {
      setPlayingUrl(null);
      toast.error('Could not play that preview.');
    });
  }, [playingUrl, stopPreview]);

  // Load the unified catalog across every configured provider once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    ttsProviders
      .allVoices()
      .then((data) => {
        if (cancelled) return;
        setAllVoices(Array.isArray(data) ? (data as TTSVoice[]) : []);
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err.message || 'Could not load voices');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  // Never leave a preview playing behind a closed dialog.
  useEffect(() => {
    if (!open) stopPreview();
  }, [open, stopPreview]);
  useEffect(() => stopPreview, [stopPreview]);

  const availableProviders = useMemo(() => {
    const names = new Set<TTSProviderName>();
    for (const v of allVoices) if (v.provider) names.add(v.provider);
    return Array.from(names);
  }, [allVoices]);

  const visibleVoices = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = allVoices.filter((v) => {
      if (provider && v.provider !== provider) return false;
      if (gender) {
        const g = String(v.gender || v.labels?.gender || '').toLowerCase();
        if (!g.includes(gender)) return false;
      }
      if (!q) return true;
      const haystack = [
        v.name,
        v.category,
        v.description,
        v.language,
        v.gender,
        ...Object.values(v.labels || {}),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });

    // Best fit for the role first, then alphabetical so the list is stable.
    return filtered
      .map((v) => ({ voice: v, score: roleFitScore(v, role) }))
      .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name))
      .map((x) => x.voice);
  }, [allVoices, provider, gender, query, role]);

  const suggestedCount = useMemo(
    () => visibleVoices.filter((v) => roleFitScore(v, role) > 0).length,
    [visibleVoices, role]
  );

  const assign = async (voice: PickedVoice) => {
    setAssigningId(voice.voiceId);
    try {
      await onPick(voice);
      stopPreview();
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Could not assign that voice');
    } finally {
      setAssigningId(null);
    }
  };

  const handleCommunitySearch = async () => {
    setCommunityLoading(true);
    try {
      const result = await elevenlabs.searchLibrary({
        q: communityQuery.trim(),
        gender: gender || undefined,
        page_size: 24,
      });
      setCommunityResults(result.voices || []);
      if ((result.voices || []).length === 0) toast.info('No community voices matched that search.');
    } catch (err: any) {
      toast.error(err.message || 'Community search failed');
    } finally {
      setCommunityLoading(false);
    }
  };

  /** Community voices must be added to the account before TTS can use them. */
  const assignCommunityVoice = async (voice: any) => {
    setAssigningId(voice.voice_id);
    try {
      let voiceId = voice.voice_id;
      if (voice.public_owner_id) {
        try {
          const added = await elevenlabs.addSharedVoice(voice.public_owner_id, voice.voice_id, voice.name);
          voiceId = added.voice_id;
        } catch {
          // Already in the account, or sharing disabled — fall back to the raw id.
        }
      }
      await onPick({ voiceId, name: voice.name, provider: 'elevenlabs' });
      stopPreview();
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Could not add that voice');
    } finally {
      setAssigningId(null);
    }
  };

  const handleVoiceIdLookup = async () => {
    const id = voiceIdInput.trim();
    if (!id) return;
    setVoiceIdLoading(true);
    try {
      const voice = await elevenlabs.getVoice(id);
      await onPick({ voiceId: voice.voice_id || id, name: voice.name || id, provider: 'elevenlabs' });
      toast.success(`Assigned "${voice.name}" to ${characterName}.`);
      stopPreview();
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'No voice found with that ID');
    } finally {
      setVoiceIdLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={680}
      title={`Choose a voice for ${characterName}`}
      subtitle={
        loading
          ? 'Loading voices from your configured providers…'
          : `${visibleVoices.length} available${suggestedCount > 0 ? ` · best matches for a ${role} first` : ''}`
      }
    >
      <div style={S.controls}>
        <div style={S.searchRow}>
          <Search size={iconSize.sm} color="var(--text-muted)" style={{ flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, accent, or style…"
            style={S.searchInput}
            aria-label="Search voices"
          />
          {query && (
            <button onClick={() => setQuery('')} style={S.clearSearch} aria-label="Clear search">
              <X size={iconSize.sm} />
            </button>
          )}
        </div>

        <div style={S.chipRow}>
          {availableProviders.length > 1 && (
            <>
              <Chip active={provider === ''} onClick={() => setProvider('')}>
                All providers
              </Chip>
              {availableProviders.map((p) => (
                <Chip
                  key={p}
                  active={provider === p}
                  hexColor={PROVIDER_COLORS[p]}
                  onClick={() => setProvider(provider === p ? '' : p)}
                >
                  {PROVIDER_LABELS[p] || p}
                </Chip>
              ))}
              <span style={S.chipDivider} />
            </>
          )}
          <Chip active={gender === 'female'} onClick={() => setGender(gender === 'female' ? '' : 'female')}>
            Female
          </Chip>
          <Chip active={gender === 'male'} onClick={() => setGender(gender === 'male' ? '' : 'male')}>
            Male
          </Chip>
        </div>
      </div>

      {loading && (
        <div style={S.stateBox}>
          <Loader size={iconSize.md} className="spin" /> Loading voices…
        </div>
      )}

      {!loading && loadError && (
        <div style={{ ...S.stateBox, color: 'var(--danger)' }}>{loadError}</div>
      )}

      {!loading && !loadError && visibleVoices.length === 0 && (
        <div style={S.stateBox}>
          {allVoices.length === 0
            ? 'No voices yet. Add a TTS provider API key in Settings, or paste a voice ID below.'
            : 'No voices match those filters.'}
        </div>
      )}

      {!loading && visibleVoices.length > 0 && (
        <div style={S.list}>
          {visibleVoices.map((v) => {
            const isCurrent = currentVoiceId === v.voiceId;
            const fit = roleFitScore(v, role);
            const previewUrl = v.previewUrl || null;
            return (
              <div
                key={`${v.provider}:${v.voiceId}`}
                style={{
                  ...S.row,
                  ...(isCurrent ? S.rowCurrent : {}),
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={S.rowTitleLine}>
                    <span style={S.voiceName}>{v.name}</span>
                    <span
                      style={{
                        ...S.providerTag,
                        color: PROVIDER_COLORS[v.provider] || 'var(--text-tertiary)',
                        background: `${PROVIDER_COLORS[v.provider] || '#888'}14`,
                      }}
                    >
                      {PROVIDER_LABELS[v.provider] || v.provider}
                    </span>
                    {fit > 0 && (
                      <span style={S.fitTag} title={`Well suited to a ${role}`}>
                        <Sparkles size={11} /> good fit
                      </span>
                    )}
                  </div>
                  {voiceTags(v).length > 0 && (
                    <div style={S.tagLine}>{voiceTags(v).join(' · ')}</div>
                  )}
                </div>

                {previewUrl && (
                  <button
                    onClick={() => togglePreview(previewUrl)}
                    style={S.iconBtn}
                    aria-label={playingUrl === previewUrl ? `Stop preview of ${v.name}` : `Preview ${v.name}`}
                  >
                    {playingUrl === previewUrl ? <Pause size={iconSize.sm} /> : <Play size={iconSize.sm} />}
                  </button>
                )}

                {isCurrent ? (
                  <span style={S.currentTag}>
                    <Check size={iconSize.xs} /> In use
                  </span>
                ) : (
                  <button
                    onClick={() => assign({ voiceId: v.voiceId, name: v.name, provider: v.provider })}
                    disabled={assigningId === v.voiceId}
                    style={S.useBtn}
                  >
                    {assigningId === v.voiceId ? <Loader size={iconSize.xs} className="spin" /> : null}
                    Use
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Extra sources, collapsed by default ── */}
      <div style={S.extraBar}>
        <span style={S.extraLabel}>Not here?</span>
        <button
          onClick={() => setExtra(extra === 'community' ? '' : 'community')}
          style={{ ...S.extraBtn, ...(extra === 'community' ? S.extraBtnActive : {}) }}
        >
          <Globe size={iconSize.xs} /> Browse ElevenLabs community
        </button>
        <button
          onClick={() => setExtra(extra === 'id' ? '' : 'id')}
          style={{ ...S.extraBtn, ...(extra === 'id' ? S.extraBtnActive : {}) }}
        >
          <Hash size={iconSize.xs} /> Paste a voice ID
        </button>
      </div>

      {extra === 'id' && (
        <div style={S.extraPanel}>
          <div style={S.searchRow}>
            <Hash size={iconSize.xs} color="var(--purple)" style={{ flexShrink: 0 }} />
            <input
              value={voiceIdInput}
              onChange={(e) => setVoiceIdInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleVoiceIdLookup()}
              placeholder="ElevenLabs voice ID"
              style={S.searchInput}
              aria-label="ElevenLabs voice ID"
            />
            <button
              onClick={handleVoiceIdLookup}
              disabled={voiceIdLoading || !voiceIdInput.trim()}
              style={S.useBtn}
            >
              {voiceIdLoading ? <Loader size={iconSize.xs} className="spin" /> : null}
              Assign
            </button>
          </div>
          <p style={S.extraHint}>Use this for a cloned or private voice that isn't in the list.</p>
        </div>
      )}

      {extra === 'community' && (
        <div style={S.extraPanel}>
          <div style={S.searchRow}>
            <Search size={iconSize.xs} color="var(--purple)" style={{ flexShrink: 0 }} />
            <input
              value={communityQuery}
              onChange={(e) => setCommunityQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCommunitySearch()}
              placeholder="e.g. warm British narrator"
              style={S.searchInput}
              aria-label="Search the ElevenLabs community library"
            />
            <button onClick={handleCommunitySearch} disabled={communityLoading} style={S.useBtn}>
              {communityLoading ? <Loader size={iconSize.xs} className="spin" /> : null}
              Search
            </button>
          </div>

          {communityResults.length > 0 && (
            <div style={{ ...S.list, marginTop: 8 }}>
              {communityResults.map((v) => (
                <div key={v.voice_id} style={S.row}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={S.rowTitleLine}>
                      <span style={S.voiceName}>{v.name}</span>
                      <span style={{ ...S.providerTag, color: 'var(--purple)', background: 'var(--purple-subtle)' }}>
                        community
                      </span>
                    </div>
                    <div style={S.tagLine}>
                      {[v.gender, v.accent, v.age, v.use_case].filter(Boolean).join(' · ') || 'shared voice'}
                    </div>
                  </div>
                  {v.preview_url && (
                    <button
                      onClick={() => togglePreview(v.preview_url)}
                      style={S.iconBtn}
                      aria-label={`Preview ${v.name}`}
                    >
                      {playingUrl === v.preview_url ? <Pause size={iconSize.sm} /> : <Play size={iconSize.sm} />}
                    </button>
                  )}
                  <button
                    onClick={() => assignCommunityVoice(v)}
                    disabled={assigningId === v.voice_id}
                    style={S.useBtn}
                  >
                    {assigningId === v.voice_id ? <Loader size={iconSize.xs} className="spin" /> : null}
                    Use
                  </button>
                </div>
              ))}
            </div>
          )}

          <p style={S.extraHint}>
            Community voices are added to your ElevenLabs account automatically when you pick one.
          </p>
        </div>
      )}
    </Modal>
  );
}

const S: Record<string, React.CSSProperties> = {
  controls: { display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '10px 14px',
    minHeight: 44,
    background: 'var(--bg-deep)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    background: 'none',
    border: 'none',
    outline: 'none',
    color: 'var(--text-primary)',
    fontSize: text.body,
  },
  clearSearch: {
    display: 'flex',
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 2,
  },
  chipRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chipDivider: { width: 1, height: 20, background: 'var(--border-default)', margin: '0 3px' },
  stateBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '22px 18px',
    fontSize: text.body,
    color: 'var(--text-tertiary)',
    background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-subtle)',
    lineHeight: 1.6,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 13,
    padding: '13px 16px',
    minHeight: 62,
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
  },
  rowCurrent: { background: 'var(--accent-subtle)' },
  rowTitleLine: { display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, flexWrap: 'wrap' },
  voiceName: {
    fontSize: text.body,
    fontWeight: weight.medium,
    color: 'var(--text-primary)',
  },
  providerTag: {
    fontSize: text.micro,
    fontWeight: weight.semibold,
    padding: '2px 8px',
    borderRadius: 20,
    flexShrink: 0,
    letterSpacing: 0.3,
  },
  fitTag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: text.micro,
    fontWeight: weight.semibold,
    padding: '2px 8px',
    borderRadius: 20,
    color: 'var(--success)',
    background: 'var(--success-subtle)',
    flexShrink: 0,
  },
  tagLine: { fontSize: text.meta, color: 'var(--text-muted)', marginTop: 4 },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    flexShrink: 0,
    background: 'none',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  useBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '9px 18px',
    minHeight: 36,
    flexShrink: 0,
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    fontSize: text.label,
    fontWeight: weight.semibold,
    cursor: 'pointer',
  },
  currentTag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '7px 14px',
    flexShrink: 0,
    fontSize: text.meta,
    fontWeight: weight.semibold,
    color: 'var(--success)',
    background: 'var(--success-subtle)',
    borderRadius: 20,
  },
  extraBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    marginTop: 20,
    paddingTop: 18,
    borderTop: '1px solid var(--border-subtle)',
  },
  extraLabel: { fontSize: text.label, color: 'var(--text-muted)' },
  extraBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '9px 15px',
    minHeight: 38,
    background: 'none',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-secondary)',
    fontSize: text.label,
    fontWeight: weight.medium,
    cursor: 'pointer',
  },
  extraBtnActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    borderColor: 'var(--border-accent)',
  },
  extraPanel: {
    marginTop: 14,
    padding: 16,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
  },
  extraHint: { fontSize: text.meta, color: 'var(--text-muted)', margin: '12px 0 0', lineHeight: 1.6 },
};
