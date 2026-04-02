import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { backgroundBoost, chapters as chaptersApi } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { toast } from '../components/Toast';
import type { BoostScene, BoostAmbience, BoostSFX, BoostPreset, BoostTransition, Chapter } from '../types';
import {
  Sparkles, Music, Trash2, ChevronDown, ChevronRight,
  Loader2, Zap, Check, Brain, Film, Waves, AudioLines, Play,
  RotateCcw, CheckCircle2, Layers, SlidersHorizontal,
  ArrowRightLeft, Volume2, VolumeX, Clapperboard,
} from 'lucide-react';

/* ── Mood color + icon maps ── */
const MOOD_COLORS: Record<string, string> = {
  romantic: '#EC4899', action: '#EF4444', suspense: '#F59E0B', horror: '#7C3AED',
  peaceful: '#10B981', melancholic: '#6366F1', epic: '#F97316', comedic: '#FBBF24',
  mysterious: '#8B5CF6', dramatic: '#DC2626', tense: '#D97706', joyful: '#34D399',
  chase: '#F43F5E', battle: '#B91C1C', exploration: '#0EA5E9',
};
const MOOD_ICONS: Record<string, string> = {
  romantic: '💕', action: '⚔️', suspense: '😰', horror: '👻', peaceful: '🌿',
  melancholic: '😢', epic: '🏔️', comedic: '😄', mysterious: '🔮', dramatic: '🎭',
  tense: '😬', joyful: '🎉', chase: '🏃', battle: '⚔️', exploration: '🧭',
};
const DEFAULT_MOOD_COLOR = '#6366F1';
const DEFAULT_MOOD_ICON = '🎵';

/* ── Preset labels + icons ── */
const PRESET_LABELS: Record<string, { icon: string; label: string; desc: string }> = {
  dialogue_heavy: { icon: '💬', label: 'Dialogue', desc: 'Conversation-focused, music low' },
  action_sequence: { icon: '💥', label: 'Action', desc: 'Fast-paced, loud SFX, driving music' },
  quiet_tension: { icon: '🤫', label: 'Tension', desc: 'Near-silence, sparse sounds, low drone' },
  exploration: { icon: '🧭', label: 'Explore', desc: 'Moderate ambience, curious music' },
  emotional_climax: { icon: '😭', label: 'Climax', desc: 'Swelling music, minimal SFX' },
  establishing_shot: { icon: '🎬', label: 'Establish', desc: 'Rich ambience, scene-setting' },
  chase: { icon: '🏃', label: 'Chase', desc: 'Urgent music, running, breathing' },
  battle: { icon: '⚔️', label: 'Battle', desc: 'Layered SFX chaos, war drums' },
  intimate: { icon: '🤝', label: 'Intimate', desc: 'Very quiet, close sounds' },
  comedic: { icon: '😄', label: 'Comedy', desc: 'Playful music, exaggerated SFX' },
  horror: { icon: '👻', label: 'Horror', desc: 'Silence, stingers, whispers' },
  montage: { icon: '🎞️', label: 'Montage', desc: 'Music-driven, quick SFX hits' },
};

const TRANSITION_LABELS: Record<string, { icon: string; label: string }> = {
  crossfade: { icon: '🔀', label: 'Crossfade' },
  hard_cut: { icon: '✂️', label: 'Hard Cut' },
  sting: { icon: '⚡', label: 'Sting' },
  fade_to_silence: { icon: '🔇', label: 'Fade → Silence' },
  swell: { icon: '🌊', label: 'Swell' },
};

/* ── Provider / model metadata ── */
interface ProviderMeta {
  providers: Record<string, { models: { id: string; label: string }[]; hasKey: boolean }>;
  currentProvider: string | null;
  currentModel: string | null;
}

/* ═══════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════ */
export function BackgroundBoostPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const capabilities = useAppStore((s) => s.capabilities);

  /* ── State ── */
  const [scenes, setScenes] = useState<BoostScene[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [providerMeta, setProviderMeta] = useState<ProviderMeta | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');

  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
  const [expandedScene, setExpandedScene] = useState<string | null>(null);
  const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set());
  const [generateMusic, setGenerateMusic] = useState(true);
  const [generateAmbience, setGenerateAmbience] = useState(true);
  const [generateSfx, setGenerateSfx] = useState(true);

  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  /* ── Derived ── */
  const availableModels = (provider && providerMeta?.providers[provider]?.models) || [];
  const canAnalyze = !analyzing && chapters.length > 0;

  const stats = useMemo(() => ({
    sfx: scenes.reduce((sum, s) => sum + (s.sfx?.length || 0), 0),
    ambience: scenes.reduce((sum, s) => sum + (s.ambience?.length || 0), 0),
    music: scenes.filter((s) => s.music_prompt).length,
    generated: scenes.filter((s) => s.status === 'generated').length,
    ducking: scenes.filter((s) => s.duck_during_dialogue).length,
    transitions: scenes.filter((s) => s.transition_to_next && s.transition_to_next !== 'crossfade').length,
  }), [scenes]);

  /* ── Data loading ── */
  const loadScenes = useCallback(async () => {
    if (!bookId) return;
    try {
      setScenes(await backgroundBoost.scenes(bookId));
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load scenes');
    }
  }, [bookId]);

  const loadChapters = useCallback(async () => {
    if (!bookId) return;
    try {
      setChapters(await chaptersApi.list(bookId));
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load chapters');
    }
  }, [bookId]);

  const loadProviderMeta = useCallback(async () => {
    if (!bookId) return;
    try {
      const data = await backgroundBoost.models(bookId);
      setProviderMeta(data);
      if (data.currentProvider) setProvider(data.currentProvider);
      if (data.currentModel) setModel(data.currentModel);
    } catch {
      // Provider metadata is optional — degrade gracefully
    }
  }, [bookId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadScenes(), loadChapters(), loadProviderMeta()])
      .finally(() => setLoading(false));
  }, [loadScenes, loadChapters, loadProviderMeta]);

  // Reset model when provider changes and current model isn't available
  useEffect(() => {
    if (provider && availableModels.length > 0 && !availableModels.find((m) => m.id === model)) {
      setModel(availableModels[0].id);
    }
  }, [provider, availableModels, model]);

  /* ── Actions ── */
  const handleAnalyze = async () => {
    if (!bookId || !canAnalyze) return;
    setAnalyzing(true);
    try {
      const chapterIds = selectedChapters.size > 0 ? Array.from(selectedChapters) : undefined;
      const result = await backgroundBoost.analyze(bookId, {
        chapterIds,
        provider: provider || undefined,
        model: model || undefined,
      });
      toast.success(
        `Analyzed ${result.chapters_analyzed} chapter${result.chapters_analyzed !== 1 ? 's' : ''} → ${result.total_scenes} scenes`,
      );
      await loadScenes();
    } catch (err: any) {
      toast.error(err.message ?? 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleGenerate = async () => {
    if (!bookId || generating) return;
    setGenerating(true);
    try {
      const sceneIds = selectedScenes.size > 0 ? Array.from(selectedScenes) : undefined;
      const result = await backgroundBoost.generate(bookId, {
        scene_ids: sceneIds,
        generate_music: generateMusic,
        generate_ambience: generateAmbience,
        generate_sfx: generateSfx,
      });
      const totalGenerated = result.music_generated + result.ambience_generated + result.sfx_generated;
      toast.success(`Generated ${totalGenerated} clips, placed ${result.clips_created} on timeline`);
      if (result.errors?.length) {
        toast.error(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''} during generation`);
      }
      await loadScenes();
    } catch (err: any) {
      toast.error(err.message ?? 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleClear = async () => {
    if (!bookId) return;
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    try {
      await backgroundBoost.clear(bookId, true);
      setScenes([]);
      setSelectedScenes(new Set());
      toast.success('All scenes and clips cleared');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to clear');
    } finally {
      setConfirmingClear(false);
    }
  };

  const handleDeleteScene = async (id: string) => {
    if (!bookId) return;
    try {
      await backgroundBoost.deleteScene(bookId, id);
      setScenes((prev) => prev.filter((s) => s.id !== id));
      setSelectedScenes((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to delete scene');
    }
  };

  const handleUpdateScene = async (id: string, updates: Partial<BoostScene>) => {
    if (!bookId) return;
    try {
      const updated = await backgroundBoost.updateScene(bookId, id, updates);
      setScenes((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to update scene');
    }
  };

  const toggleSceneSelection = (id: string) =>
    setSelectedScenes((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleChapterSelection = (id: string) =>
    setSelectedChapters((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  /* ── Render ── */
  if (loading) {
    return (
      <div style={{ ...S.page, alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <Loader2 size={24} className="spinner" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  const allScenesGenerated = stats.generated === scenes.length && scenes.length > 0;

  return (
    <div style={S.page}>
      {/* ── Hero header ── */}
      <div style={S.hero}>
        <div style={S.heroGlow} />
        <div style={S.heroContent}>
          <div style={S.heroIcon}>
            <Sparkles size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <h1 style={S.heroTitle}>Background Boost</h1>
            <p style={S.heroSub}>
              AI-powered cinematic sound design — music, ambience, SFX, transitions, and ducking crafted from your scenes
            </p>
          </div>
          {scenes.length > 0 && (
            <button
              onClick={handleClear}
              onBlur={() => setConfirmingClear(false)}
              style={{
                ...S.clearBtn,
                background: confirmingClear ? 'var(--danger)' : 'var(--danger-subtle)',
                color: confirmingClear ? '#fff' : 'var(--danger)',
              }}
              aria-label="Clear all scenes and clips"
            >
              <RotateCcw size={13} /> {confirmingClear ? 'Confirm Reset' : 'Reset'}
            </button>
          )}
        </div>

        {scenes.length > 0 && (
          <div style={S.statsBar}>
            <StatPill icon={<Film size={12} />} label="Scenes" value={scenes.length} color="var(--accent)" />
            <StatPill icon={<Music size={12} />} label="Music" value={stats.music} color="#8B5CF6" />
            <StatPill icon={<Waves size={12} />} label="Ambient" value={stats.ambience} color="#10B981" />
            <StatPill icon={<AudioLines size={12} />} label="SFX" value={stats.sfx} color="#F59E0B" />
            {stats.ducking > 0 && (
              <StatPill icon={<VolumeX size={12} />} label="Ducking" value={stats.ducking} color="#6366F1" />
            )}
            <StatPill icon={<CheckCircle2 size={12} />} label="Generated" value={stats.generated} color="var(--success)" />
          </div>
        )}
      </div>

      {/* ── Step 1: Analyze ── */}
      <StepCard
        step={1}
        title="Analyze Scenes"
        subtitle="AI reads your manuscript to detect mood shifts, sound cues, and cinematic moments"
        icon={<Brain size={16} />}
        done={scenes.length > 0}
      >
        <div style={S.featureCallout}>
          <div style={S.featureGrid}>
            <FeatureTag icon="🎵" label="Music cues" />
            <FeatureTag icon="🌿" label="Ambient layers" />
            <FeatureTag icon="🔊" label="Sound effects" />
            <FeatureTag icon="🎭" label="Mood detection" />
            <FeatureTag icon="🔀" label="Scene transitions" />
            <FeatureTag icon="🔉" label="Auto-ducking" />
            <FeatureTag icon="🎬" label="Scene presets" />
            <FeatureTag icon="💬" label="Dialogue-aware" />
          </div>
        </div>

        {providerMeta && (
          <div style={S.providerRow}>
            <div style={S.fieldGroup}>
              <label style={S.fieldLabel}>
                <Brain size={10} /> Provider
              </label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={S.select}
                aria-label="AI provider"
              >
                <option value="">Auto-detect</option>
                {Object.entries(providerMeta.providers).map(([key, meta]) => (
                  <option key={key} value={key} disabled={!meta.hasKey}>
                    {key.charAt(0).toUpperCase() + key.slice(1)}
                    {!meta.hasKey ? ' (no key)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={S.fieldGroup}>
              <label style={S.fieldLabel}>Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={S.select}
                disabled={!provider}
                aria-label="AI model"
              >
                {!provider && <option value="">Default</option>}
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {chapters.length > 0 && (
          <div style={S.chapterSection}>
            <div style={S.chapterHeader}>
              <span style={S.fieldLabel}>Chapters to analyze</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {selectedChapters.size > 0 && (
                  <button onClick={() => setSelectedChapters(new Set())} style={S.tinyBtn}>
                    Clear
                  </button>
                )}
                <button
                  onClick={() => setSelectedChapters(new Set(chapters.map((c) => c.id)))}
                  style={S.tinyBtn}
                >
                  All
                </button>
              </div>
            </div>
            <div style={S.chapterGrid}>
              {chapters.map((ch, i) => {
                const isSelected = selectedChapters.has(ch.id);
                return (
                  <button
                    key={ch.id}
                    onClick={() => toggleChapterSelection(ch.id)}
                    style={{
                      ...S.chapterChip,
                      borderColor: isSelected ? 'var(--accent)' : 'var(--border-subtle)',
                      background: isSelected ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                      color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
                      fontWeight: isSelected ? 600 : 400,
                    }}
                    aria-pressed={isSelected}
                  >
                    {isSelected && <Check size={10} />}
                    {ch.title || `Ch ${i + 1}`}
                  </button>
                );
              })}
            </div>
            {selectedChapters.size > 0 && (
              <p style={S.selectionHint}>
                {selectedChapters.size} of {chapters.length} selected
              </p>
            )}
          </div>
        )}

        <button
          onClick={handleAnalyze}
          disabled={!canAnalyze}
          style={{
            ...S.actionBtn,
            background: canAnalyze
              ? 'linear-gradient(135deg, var(--accent), #6d9af5)'
              : 'var(--bg-elevated)',
            color: canAnalyze ? '#fff' : 'var(--text-muted)',
          }}
        >
          {analyzing ? (
            <><Loader2 size={15} className="spinner" /> Analyzing scenes...</>
          ) : (
            <><Zap size={15} /> Analyze {
              selectedChapters.size > 0
                ? `${selectedChapters.size} Chapter${selectedChapters.size !== 1 ? 's' : ''}`
                : `All ${chapters.length} Chapter${chapters.length !== 1 ? 's' : ''}`
            }</>
          )}
        </button>
        {chapters.length === 0 && (
          <p style={S.emptyHint}>Import a manuscript first to get started.</p>
        )}
      </StepCard>

      {/* ── Step 2: Scene Breakdown ── */}
      {scenes.length > 0 && (
        <StepCard
          step={2}
          title="Scene Breakdown"
          subtitle={`${scenes.length} scene${scenes.length !== 1 ? 's' : ''} detected across your manuscript`}
          icon={<Layers size={16} />}
          done={allScenesGenerated}
          headerRight={
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setSelectedScenes(new Set(scenes.map((s) => s.id)))}
                style={S.tinyBtn}
              >
                Select All
              </button>
              {selectedScenes.size > 0 && (
                <button onClick={() => setSelectedScenes(new Set())} style={S.tinyBtn}>
                  Deselect
                </button>
              )}
            </div>
          }
        >
          <div style={S.sceneList} className="stagger-children">
            {scenes.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                isExpanded={expandedScene === scene.id}
                isSelected={selectedScenes.has(scene.id)}
                onToggleExpand={() => setExpandedScene(expandedScene === scene.id ? null : scene.id)}
                onToggleSelect={() => toggleSceneSelection(scene.id)}
                onDelete={() => handleDeleteScene(scene.id)}
                onUpdate={(updates) => handleUpdateScene(scene.id, updates)}
              />
            ))}
          </div>
        </StepCard>
      )}

      {/* ── Step 3: Generate ── */}
      {scenes.length > 0 && (
        <StepCard
          step={3}
          title="Generate & Place"
          subtitle={`Generate audio for ${selectedScenes.size > 0 ? `${selectedScenes.size} selected` : 'all'} scenes and place on timeline`}
          icon={<Play size={16} />}
        >
          <div style={S.genGrid}>
            <GenToggle
              checked={generateMusic}
              onChange={setGenerateMusic}
              icon={<Music size={15} />}
              label="Music"
              count={stats.music}
              color="#8B5CF6"
              warning={!capabilities?.hasMusic ? 'Needs ElevenLabs' : undefined}
            />
            <GenToggle
              checked={generateAmbience}
              onChange={setGenerateAmbience}
              icon={<Waves size={15} />}
              label="Ambience"
              count={stats.ambience}
              color="#10B981"
              warning={!capabilities?.hasSFX ? 'Needs ElevenLabs' : undefined}
            />
            <GenToggle
              checked={generateSfx}
              onChange={setGenerateSfx}
              icon={<AudioLines size={15} />}
              label="SFX"
              count={stats.sfx}
              color="#F59E0B"
              warning={!capabilities?.hasSFX ? 'Needs ElevenLabs' : undefined}
            />
          </div>

          <button
            onClick={handleGenerate}
            disabled={generating}
            style={{
              ...S.actionBtn,
              background: generating
                ? 'var(--bg-elevated)'
                : 'linear-gradient(135deg, #8B5CF6, #6366F1)',
              color: generating ? 'var(--text-muted)' : '#fff',
            }}
          >
            {generating ? (
              <><Loader2 size={15} className="spinner" /> Generating audio...</>
            ) : (
              <><Sparkles size={15} /> Generate {
                selectedScenes.size > 0 ? `${selectedScenes.size} Scenes` : 'All Scenes'
              }</>
            )}
          </button>
          <p style={S.emptyHint}>
            Audio will be placed on dedicated Boost tracks with volume, fades, and spacing. Fine-tune in Timeline.
          </p>
        </StepCard>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════ */

function StatPill({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: number; color: string;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 12px', borderRadius: 20,
      background: `${color}11`, border: `1px solid ${color}22`,
    }}>
      <span style={{ color, display: 'flex' }}>{icon}</span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

function FeatureTag({ icon, label }: { icon: string; label: string }) {
  return (
    <div style={S.featureTag}>
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
    </div>
  );
}

function StepCard({ step, title, subtitle, icon, done, headerRight, children }: {
  step: number; title: string; subtitle: string; icon: React.ReactNode;
  done?: boolean; headerRight?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div style={S.stepCard} className="animate-in">
      <div style={S.stepHeader}>
        <div style={{ ...S.stepNum, background: done ? 'var(--success)' : 'var(--accent)' }}>
          {done ? <Check size={13} /> : step}
        </div>
        <span style={{ display: 'flex', color: 'var(--text-muted)' }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={S.stepTitle}>{title}</h2>
          <p style={S.stepSub}>{subtitle}</p>
        </div>
        {headerRight}
      </div>
      <div style={S.stepBody}>{children}</div>
    </div>
  );
}

function GenToggle({ checked, onChange, icon, label, count, color, warning }: {
  checked: boolean; onChange: (v: boolean) => void; icon: React.ReactNode;
  label: string; count: number; color: string; warning?: string;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        ...S.genCard,
        borderColor: checked ? `${color}44` : 'var(--border-subtle)',
        background: checked ? `${color}08` : 'var(--bg-base)',
      }}
      aria-pressed={checked}
      aria-label={`${checked ? 'Disable' : 'Enable'} ${label} generation`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: checked ? `${color}18` : 'var(--bg-elevated)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: checked ? color : 'var(--text-muted)',
        }}>
          {icon}
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{
            fontSize: 12, fontWeight: 600,
            color: checked ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}>
            {label}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
            {count} clip{count !== 1 ? 's' : ''}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {warning && <span style={S.warnBadge}>{warning}</span>}
        <div style={{
          width: 18, height: 18, borderRadius: 4,
          border: checked ? `2px solid ${color}` : '2px solid var(--border-default)',
          background: checked ? color : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {checked && <Check size={11} color="#fff" />}
        </div>
      </div>
    </button>
  );
}

/* ═══════════════════════════════════════════
   Scene Card
   ═══════════════════════════════════════════ */
function SceneCard({ scene, isExpanded, isSelected, onToggleExpand, onToggleSelect, onDelete, onUpdate }: {
  scene: BoostScene; isExpanded: boolean; isSelected: boolean;
  onToggleExpand: () => void; onToggleSelect: () => void;
  onDelete: () => void; onUpdate: (updates: Partial<BoostScene>) => void;
}) {
  const moodColor = MOOD_COLORS[scene.mood] || DEFAULT_MOOD_COLOR;
  const presetInfo = PRESET_LABELS[scene.preset] || PRESET_LABELS.establishing_shot;
  const transitionInfo = TRANSITION_LABELS[scene.transition_to_next] || TRANSITION_LABELS.crossfade;

  const updateAmbienceVolume = (index: number, volume: number) => {
    const updated = [...scene.ambience];
    updated[index] = { ...updated[index], volume: volume / 100 };
    onUpdate({ ambience: updated });
  };

  const updateSfxVolume = (index: number, volume: number) => {
    const updated = [...scene.sfx];
    updated[index] = { ...updated[index], volume: volume / 100 };
    onUpdate({ sfx: updated });
  };

  return (
    <div style={{
      ...S.sceneCard,
      borderColor: isSelected ? `${moodColor}44` : 'var(--border-subtle)',
      background: isSelected ? `${moodColor}06` : 'var(--bg-base)',
    }}>
      {/* Color accent strip */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: 3, background: moodColor, borderRadius: '3px 0 0 3px',
      }} />

      <div style={S.sceneHdr} onClick={onToggleExpand}>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          style={{
            ...S.checkBtn,
            borderColor: isSelected ? moodColor : 'var(--border-default)',
            background: isSelected ? moodColor : 'transparent',
          }}
          aria-label={isSelected ? 'Deselect scene' : 'Select scene'}
          aria-pressed={isSelected}
        >
          {isSelected && <Check size={10} color="#fff" />}
        </button>

        <span style={{ fontSize: 18, lineHeight: 1 }}>
          {MOOD_ICONS[scene.mood] || DEFAULT_MOOD_ICON}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.sceneTitle}>{scene.title}</div>
          <div style={S.sceneMeta}>
            <span style={{ ...S.moodBadge, background: `${moodColor}18`, color: moodColor }}>
              {scene.mood}
            </span>
            <span style={{ ...S.tag, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 9 }}>
              {presetInfo.icon} {presetInfo.label}
            </span>
            <IntensityBar value={scene.intensity} color={moodColor} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Seg {scene.segment_start}–{scene.segment_end}
            </span>
          </div>
        </div>

        <div style={S.badges}>
          {scene.music_prompt && (
            <span style={{ ...S.tag, background: '#8B5CF618', color: '#8B5CF6' }}>
              <Music size={9} /> Music
            </span>
          )}
          {(scene.ambience?.length || 0) > 0 && (
            <span style={{ ...S.tag, background: '#10B98118', color: '#10B981' }}>
              <Waves size={9} /> {scene.ambience.length}
            </span>
          )}
          {(scene.sfx?.length || 0) > 0 && (
            <span style={{ ...S.tag, background: '#F59E0B18', color: '#F59E0B' }}>
              <AudioLines size={9} /> {scene.sfx.length}
            </span>
          )}
          {scene.duck_during_dialogue && (
            <span style={{ ...S.tag, background: '#6366F118', color: '#6366F1' }}>
              <VolumeX size={9} /> Duck
            </span>
          )}
          <span style={{ ...S.tag, background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: 9 }}>
            {transitionInfo.icon} {transitionInfo.label}
          </span>
          {scene.status === 'generated' && (
            <span style={{ ...S.tag, background: 'var(--success-subtle)', color: 'var(--success)' }}>
              <CheckCircle2 size={9} /> Done
            </span>
          )}
          {scene.status === 'partial' && (
            <span style={{ ...S.tag, background: '#F59E0B18', color: '#F59E0B' }}>
              ⚠️ Partial
            </span>
          )}
        </div>

        <span style={{ color: 'var(--text-muted)', display: 'flex', transition: 'transform 200ms ease' }}>
          {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>

        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={S.iconBtn}
          aria-label={`Delete scene: ${scene.title}`}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {isExpanded && (
        <div style={S.sceneBody}>
          {/* Scene Settings: Preset, Transition, Ducking */}
          <div style={S.sceneSettingsRow}>
            <div style={S.settingGroup}>
              <label style={S.fieldLabel}><Clapperboard size={10} /> Preset</label>
              <select
                value={scene.preset || 'establishing_shot'}
                onChange={(e) => onUpdate({ preset: e.target.value as BoostPreset })}
                style={S.selectSmall}
                aria-label="Scene preset"
              >
                {Object.entries(PRESET_LABELS).map(([key, info]) => (
                  <option key={key} value={key}>{info.icon} {info.label}</option>
                ))}
              </select>
            </div>
            <div style={S.settingGroup}>
              <label style={S.fieldLabel}><ArrowRightLeft size={10} /> Transition</label>
              <select
                value={scene.transition_to_next || 'crossfade'}
                onChange={(e) => onUpdate({ transition_to_next: e.target.value as BoostTransition })}
                style={S.selectSmall}
                aria-label="Scene transition"
              >
                {Object.entries(TRANSITION_LABELS).map(([key, info]) => (
                  <option key={key} value={key}>{info.icon} {info.label}</option>
                ))}
              </select>
            </div>
            <div style={S.settingGroup}>
              <label style={S.fieldLabel}>⏱️ Duration</label>
              <input
                type="number"
                value={scene.transition_duration_ms || 2000}
                min={0}
                max={10000}
                step={250}
                onChange={(e) => onUpdate({ transition_duration_ms: parseInt(e.target.value, 10) || 2000 })}
                style={S.numInput}
                aria-label="Transition duration"
              />
            </div>
            <button
              onClick={() => onUpdate({ duck_during_dialogue: !scene.duck_during_dialogue })}
              style={{
                ...S.duckToggle,
                borderColor: scene.duck_during_dialogue ? '#6366F144' : 'var(--border-subtle)',
                background: scene.duck_during_dialogue ? '#6366F10C' : 'var(--bg-base)',
                color: scene.duck_during_dialogue ? '#6366F1' : 'var(--text-muted)',
              }}
              aria-pressed={scene.duck_during_dialogue}
              aria-label="Toggle auto-ducking"
            >
              {scene.duck_during_dialogue ? <VolumeX size={12} /> : <Volume2 size={12} />}
              <span style={{ fontSize: 11, fontWeight: 500 }}>
                {scene.duck_during_dialogue ? 'Ducking ON' : 'Ducking OFF'}
              </span>
            </button>
          </div>

          {/* Ducking controls (shown when ducking is enabled) */}
          {scene.duck_during_dialogue && (
            <div style={{ ...S.layer, background: '#6366F108', border: '1px solid #6366F118' }}>
              <div style={S.layerHdr}>
                <span style={{ color: '#6366F1', display: 'flex' }}><VolumeX size={14} /></span>
                <span style={S.layerTitle}>Auto-Ducking (during dialogue)</span>
              </div>
              <div style={S.controlRow}>
                <SliderControl
                  label="Music duck"
                  value={Math.abs(scene.duck_music_db ?? 8)}
                  suffix="dB"
                  onChange={(v) => onUpdate({ duck_music_db: -v })}
                />
                <SliderControl
                  label="Ambience duck"
                  value={Math.abs(scene.duck_ambience_db ?? 4)}
                  suffix="dB"
                  onChange={(v) => onUpdate({ duck_ambience_db: -v })}
                />
              </div>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                Music and ambience will automatically lower when narration plays, then restore after.
              </p>
            </div>
          )}

          {scene.music_prompt && (
            <LayerSection icon={<Music size={14} />} title="Background Music" color="#8B5CF6">
              <div style={S.promptBox}>{scene.music_prompt}</div>
              <div style={S.controlRow}>
                <SliderControl
                  label="Volume"
                  value={Math.round(scene.music_volume * 100)}
                  suffix="%"
                  onChange={(v) => onUpdate({ music_volume: v / 100 })}
                />
                <NumberControl
                  label="Fade In"
                  value={scene.music_fade_in_ms}
                  suffix="ms"
                  onChange={(v) => onUpdate({ music_fade_in_ms: v })}
                />
                <NumberControl
                  label="Fade Out"
                  value={scene.music_fade_out_ms}
                  suffix="ms"
                  onChange={(v) => onUpdate({ music_fade_out_ms: v })}
                />
              </div>
            </LayerSection>
          )}

          {scene.ambience?.length > 0 && (
            <LayerSection icon={<Waves size={14} />} title={`Ambient (${scene.ambience.length})`} color="#10B981">
              {scene.ambience.map((amb: BoostAmbience, i: number) => (
                <div key={i} style={S.subItem}>
                  <div style={S.promptBox}>{amb.prompt}</div>
                  <div style={S.controlRow}>
                    <SliderControl
                      label="Vol"
                      value={Math.round(amb.volume * 100)}
                      suffix="%"
                      onChange={(v) => updateAmbienceVolume(i, v)}
                    />
                    {amb.layer && (
                      <span style={{ ...S.tag, background: '#10B98118', color: '#10B981', fontSize: 9 }}>
                        {amb.layer === 'primary' ? '🔵' : amb.layer === 'secondary' ? '🟢' : '✨'} {amb.layer}
                      </span>
                    )}
                    {amb.loop && (
                      <span style={{ ...S.tag, background: '#10B98118', color: '#10B981', fontSize: 9 }}>
                        🔁 Loop
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {amb.duration_hint_seconds}s
                    </span>
                  </div>
                </div>
              ))}
            </LayerSection>
          )}

          {scene.sfx?.length > 0 && (
            <LayerSection icon={<AudioLines size={14} />} title={`SFX (${scene.sfx.length})`} color="#F59E0B">
              {scene.sfx.map((fx: BoostSFX, i: number) => (
                <div key={i} style={S.subItem}>
                  <div style={S.promptBox}>{fx.prompt}</div>
                  <div style={S.controlRow}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      @ Seg {fx.at_segment} · {fx.position}
                      {fx.offset_hint_ms ? ` +${fx.offset_hint_ms}ms` : ''} · {fx.duration_hint_seconds}s
                    </span>
                    {fx.category && (
                      <span style={{ ...S.tag, background: '#F59E0B18', color: '#F59E0B', fontSize: 9 }}>
                        {fx.category}
                      </span>
                    )}
                    <SliderControl
                      label="Vol"
                      value={Math.round(fx.volume * 100)}
                      suffix="%"
                      onChange={(v) => updateSfxVolume(i, v)}
                    />
                  </div>
                </div>
              ))}
            </LayerSection>
          )}

          {scene.voice_mood && (
            <LayerSection icon={<SlidersHorizontal size={14} />} title="Voice Mood" color="var(--text-tertiary)">
              <p style={{
                fontSize: 12, color: 'var(--text-secondary)',
                margin: 0, fontStyle: 'italic', lineHeight: 1.5,
              }}>
                "{scene.voice_mood}"
              </p>
            </LayerSection>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Micro-components ── */

function IntensityBar({ value, color }: { value: number; color: string }) {
  const percentage = Math.min(Math.max(value, 0), 1) * 100;
  return (
    <div
      style={{
        width: 48, height: 4, background: 'var(--bg-elevated)',
        borderRadius: 3, overflow: 'hidden', display: 'inline-block',
      }}
      role="meter"
      aria-label="Intensity"
      aria-valuenow={percentage}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div style={{
        width: `${percentage}%`, background: color,
        height: '100%', borderRadius: 3, transition: 'width 300ms ease',
      }} />
    </div>
  );
}

function LayerSection({ icon, title, color, children }: {
  icon: React.ReactNode; title: string; color: string; children: React.ReactNode;
}) {
  return (
    <div style={S.layer}>
      <div style={S.layerHdr}>
        <span style={{ color, display: 'flex' }}>{icon}</span>
        <span style={S.layerTitle}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function SliderControl({ label, value, suffix, onChange }: {
  label: string; value: number; suffix: string; onChange: (v: number) => void;
}) {
  return (
    <label style={S.sliderLabel}>
      {label}
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        style={S.slider}
        aria-label={`${label} slider`}
      />
      <span style={S.sliderVal}>{value}{suffix}</span>
    </label>
  );
}

function NumberControl({ label, value, suffix, onChange }: {
  label: string; value: number; suffix: string; onChange: (v: number) => void;
}) {
  return (
    <label style={S.sliderLabel}>
      {label}
      <input
        type="number"
        value={value}
        min={0}
        max={10000}
        step={100}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        style={S.numInput}
        aria-label={`${label} input`}
      />
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{suffix}</span>
    </label>
  );
}

/* ═══════════════════════════════════════════
   Styles
   ═══════════════════════════════════════════ */
const S: Record<string, React.CSSProperties> = {
  page: {
    padding: '24px 32px 48px',
    maxWidth: 920,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },

  /* Hero */
  hero: {
    position: 'relative',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--bg-base)',
    border: '1px solid var(--border-subtle)',
    padding: '24px 28px 20px',
    overflow: 'hidden',
  },
  heroGlow: {
    position: 'absolute',
    top: -60,
    right: -60,
    width: 200,
    height: 200,
    borderRadius: '50%',
    background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  heroContent: {
    position: 'relative',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 16,
    zIndex: 1,
  },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: 'linear-gradient(135deg, var(--accent-subtle), rgba(139,92,246,0.12))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--accent)',
    flexShrink: 0,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
    letterSpacing: '-0.03em',
  },
  heroSub: {
    fontSize: 13,
    color: 'var(--text-tertiary)',
    margin: '4px 0 0',
    lineHeight: 1.5,
  },
  statsBar: {
    position: 'relative',
    display: 'flex',
    gap: 8,
    marginTop: 18,
    flexWrap: 'wrap',
    zIndex: 1,
  },
  clearBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 14px',
    border: '1px solid rgba(248,113,113,0.15)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 150ms ease, color 150ms ease',
  },

  /* Step cards */
  stepCard: {
    background: 'var(--bg-base)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--border-subtle)',
    overflow: 'hidden',
  },
  stepHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '18px 24px',
    borderBottom: '1px solid var(--border-subtle)',
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 8,
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stepTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  },
  stepSub: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    margin: '2px 0 0',
    lineHeight: 1.4,
  },
  stepBody: {
    padding: '20px 24px',
  },

  /* Feature callout */
  featureCallout: {
    padding: '14px 16px',
    background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-subtle)',
    marginBottom: 18,
  },
  featureGrid: {
    display: 'flex',
    gap: 16,
    flexWrap: 'wrap',
  },
  featureTag: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },

  /* Provider row */
  providerRow: {
    display: 'flex',
    gap: 12,
    marginBottom: 18,
    flexWrap: 'wrap',
  },
  fieldGroup: {
    flex: 1,
    minWidth: 150,
  },
  fieldLabel: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginBottom: 5,
  },
  select: {
    width: '100%',
    padding: '8px 12px',
    fontSize: 12,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    outline: 'none',
    cursor: 'pointer',
  },

  /* Chapter selection */
  chapterSection: { marginBottom: 18 },
  chapterHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  chapterGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    maxHeight: 130,
    overflowY: 'auto',
    padding: '4px 0',
  },
  chapterChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 12px',
    fontSize: 11,
    borderRadius: 20,
    border: '1px solid',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    background: 'none',
    transition: 'border-color 150ms ease, background 150ms ease',
  },
  selectionHint: {
    fontSize: 11,
    color: 'var(--accent)',
    marginTop: 6,
    fontWeight: 500,
  },
  tinyBtn: {
    background: 'none',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-tertiary)',
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 10,
    cursor: 'pointer',
    fontWeight: 500,
  },

  /* Action button */
  actionBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '11px 24px',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(91,141,239,0.15)',
    transition: 'opacity 150ms ease',
  },
  emptyHint: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 8,
    lineHeight: 1.5,
  },

  /* Generate grid */
  genGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: 10,
    marginBottom: 18,
  },
  genCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid',
    cursor: 'pointer',
    background: 'none',
    width: '100%',
    textAlign: 'left',
    transition: 'border-color 150ms ease, background 150ms ease',
  },
  warnBadge: {
    fontSize: 9,
    padding: '2px 7px',
    borderRadius: 10,
    background: '#F59E0B18',
    color: '#F59E0B',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },

  /* Scene list */
  sceneList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  sceneCard: {
    position: 'relative',
    borderRadius: 'var(--radius-md)',
    border: '1px solid',
    overflow: 'hidden',
    transition: 'border-color 200ms ease, background 200ms ease',
  },
  sceneHdr: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 14px 12px 18px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  checkBtn: {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: '2px solid',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
  },
  sceneTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    lineHeight: 1.3,
  },
  sceneMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  moodBadge: {
    fontSize: 10,
    padding: '2px 9px',
    borderRadius: 12,
    fontWeight: 600,
    textTransform: 'capitalize',
  },
  badges: {
    display: 'flex',
    gap: 5,
    flexShrink: 0,
  },
  tag: {
    fontSize: 10,
    padding: '3px 8px',
    borderRadius: 10,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 6,
    borderRadius: 6,
    display: 'flex',
    opacity: 0.6,
  },

  /* Scene body */
  sceneBody: {
    padding: '4px 18px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    borderTop: '1px solid var(--border-subtle)',
  },
  layer: {
    background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-md)',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  layerHdr: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  layerTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
  },
  promptBox: {
    fontSize: 12,
    color: 'var(--text-primary)',
    background: 'var(--bg-base)',
    padding: '8px 12px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    lineHeight: 1.5,
  },
  controlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    flexWrap: 'wrap',
  },
  subItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sliderLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: 'var(--text-muted)',
    fontWeight: 500,
    cursor: 'pointer',
  },
  slider: {
    width: 64,
    height: 4,
    accentColor: 'var(--accent)',
  },
  sliderVal: {
    fontSize: 10,
    color: 'var(--text-tertiary)',
    minWidth: 30,
    fontVariantNumeric: 'tabular-nums',
  },
  numInput: {
    width: 58,
    padding: '3px 6px',
    fontSize: 11,
    background: 'var(--bg-base)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    textAlign: 'center',
  },

  /* Scene settings row */
  sceneSettingsRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 10,
    flexWrap: 'wrap',
    padding: '8px 0 4px',
  },
  settingGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 100,
  },
  selectSmall: {
    padding: '5px 8px',
    fontSize: 11,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    outline: 'none',
    cursor: 'pointer',
  },
  duckToggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    border: '1px solid',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    background: 'none',
    transition: 'border-color 150ms ease, background 150ms ease, color 150ms ease',
    marginBottom: 0,
    alignSelf: 'flex-end',
  },
};
