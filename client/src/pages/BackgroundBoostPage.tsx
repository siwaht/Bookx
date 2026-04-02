import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { backgroundBoost, chapters as chaptersApi } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { toast } from '../components/Toast';
import type { BoostScene, Chapter } from '../types';
import {
  Sparkles, Music, Wind, Volume2, Trash2, ChevronDown, ChevronRight,
  Loader2, Zap, Check, Brain, Film, Waves, AudioLines, Play,
  RotateCcw, CheckCircle2, Circle, Layers, SlidersHorizontal
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

/* ═══════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════ */
export function BackgroundBoostPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const caps = useAppStore((s) => s.capabilities);

  const [scenes, setScenes] = useState<BoostScene[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [genM, setGenM] = useState(true);
  const [genA, setGenA] = useState(true);
  const [genS, setGenS] = useState(true);
  const [selChapters, setSelChapters] = useState<Set<string>>(new Set());
  const [md, setMd] = useState<{
    providers: Record<string, { models: { id: string; label: string }[]; hasKey: boolean }>;
    currentProvider: string | null;
    currentModel: string | null;
  } | null>(null);
  const [prov, setProv] = useState('');
  const [model, setModel] = useState('');

  /* ── Data loading ── */
  const load = useCallback(async () => {
    if (!bookId) return;
    try { setScenes(await backgroundBoost.scenes(bookId)); } catch {}
  }, [bookId]);

  const loadCh = useCallback(async () => {
    if (!bookId) return;
    try { setChapters(await chaptersApi.list(bookId)); } catch {}
  }, [bookId]);

  const loadMd = useCallback(async () => {
    if (!bookId) return;
    try {
      const d = await backgroundBoost.models(bookId);
      setMd(d);
      if (d.currentProvider) setProv(d.currentProvider);
      if (d.currentModel) setModel(d.currentModel);
    } catch {}
  }, [bookId]);

  useEffect(() => { load(); loadCh(); loadMd(); }, [load, loadCh, loadMd]);

  const avail = (prov && md?.providers[prov]?.models) || [];
  useEffect(() => {
    if (prov && avail.length > 0 && !avail.find(m => m.id === model)) setModel(avail[0].id);
  }, [prov, avail, model]);

  /* ── Actions ── */
  const analyze = async () => {
    if (!bookId) return;
    setAnalyzing(true);
    try {
      const chapterIds = selChapters.size > 0 ? Array.from(selChapters) : undefined;
      const r = await backgroundBoost.analyze(bookId, {
        chapterIds, provider: prov || undefined, model: model || undefined,
      });
      toast.success(`Analyzed ${r.chapters_analyzed} chapter${r.chapters_analyzed !== 1 ? 's' : ''} → ${r.total_scenes} scenes`);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setAnalyzing(false); }
  };

  const generate = async () => {
    if (!bookId) return;
    setGenerating(true);
    try {
      const ids = selected.size > 0 ? Array.from(selected) : undefined;
      const r = await backgroundBoost.generate(bookId, {
        scene_ids: ids, generate_music: genM, generate_ambience: genA, generate_sfx: genS,
      });
      toast.success(`Generated ${r.music_generated + r.ambience_generated + r.sfx_generated} clips, placed ${r.clips_created} on timeline`);
      if (r.errors?.length) toast.error(`${r.errors.length} errors`);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setGenerating(false); }
  };

  const clear = async () => {
    if (!bookId || !confirm('Remove all Background Boost scenes and clips?')) return;
    try {
      await backgroundBoost.clear(bookId, true);
      setScenes([]);
      toast.success('Cleared');
    } catch (e: any) { toast.error(e.message); }
  };

  const delScene = async (id: string) => {
    if (!bookId) return;
    try {
      await backgroundBoost.deleteScene(bookId, id);
      setScenes(p => p.filter(s => s.id !== id));
    } catch (e: any) { toast.error(e.message); }
  };

  const updScene = async (id: string, u: any) => {
    if (!bookId) return;
    try {
      const r = await backgroundBoost.updateScene(bookId, id, u);
      setScenes(p => p.map(s => s.id === id ? r : s));
    } catch (e: any) { toast.error(e.message); }
  };

  const toggle = (id: string) =>
    setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  /* ── Stats ── */
  const stats = useMemo(() => ({
    sfx: scenes.reduce((s, sc) => s + (sc.sfx?.length || 0), 0),
    amb: scenes.reduce((s, sc) => s + (sc.ambience?.length || 0), 0),
    mus: scenes.filter(s => s.music_prompt).length,
    generated: scenes.filter(s => s.status === 'generated').length,
  }), [scenes]);

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
              AI-powered cinematic sound design — music, ambience, and SFX crafted from your scenes
            </p>
          </div>
          {scenes.length > 0 && (
            <button onClick={clear} style={S.clearBtn} title="Clear all scenes">
              <RotateCcw size={13} /> Reset
            </button>
          )}
        </div>

        {/* Stats bar */}
        {scenes.length > 0 && (
          <div style={S.statsBar}>
            <StatPill icon={<Film size={12} />} label="Scenes" value={scenes.length} color="var(--accent)" />
            <StatPill icon={<Music size={12} />} label="Music" value={stats.mus} color="#8B5CF6" />
            <StatPill icon={<Waves size={12} />} label="Ambient" value={stats.amb} color="#10B981" />
            <StatPill icon={<AudioLines size={12} />} label="SFX" value={stats.sfx} color="#F59E0B" />
            <StatPill icon={<CheckCircle2 size={12} />} label="Generated" value={stats.generated} color="var(--success)" />
          </div>
        )}
      </div>

      {/* ── Step 1: Analyze ── */}
      <StepCard step={1} title="Analyze Scenes" subtitle="AI reads your manuscript to detect mood shifts, sound cues, and cinematic moments" icon={<Brain size={16} />} done={scenes.length > 0}>
        <div style={S.featureCallout}>
          <div style={S.featureGrid}>
            <FeatureTag icon="🎵" label="Music cues" />
            <FeatureTag icon="🌿" label="Ambient layers" />
            <FeatureTag icon="🔊" label="Sound effects" />
            <FeatureTag icon="🎭" label="Mood detection" />
          </div>
        </div>

        {md && (
          <div style={S.providerRow}>
            <div style={S.fieldGroup}>
              <label style={S.fieldLabel}>
                <Brain size={10} /> Provider
              </label>
              <select value={prov} onChange={e => setProv(e.target.value)} style={S.select}>
                <option value="">Auto-detect</option>
                {Object.entries(md.providers).map(([k, v]) => (
                  <option key={k} value={k} disabled={!v.hasKey}>
                    {k.charAt(0).toUpperCase() + k.slice(1)}{!v.hasKey ? ' (no key)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={S.fieldGroup}>
              <label style={S.fieldLabel}>Model</label>
              <select value={model} onChange={e => setModel(e.target.value)} style={S.select} disabled={!prov}>
                {!prov && <option value="">Default</option>}
                {avail.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>
        )}

        {chapters.length > 0 && (
          <div style={S.chapterSection}>
            <div style={S.chapterHeader}>
              <span style={S.fieldLabel}>Chapters to analyze</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {selChapters.size > 0 && (
                  <button onClick={() => setSelChapters(new Set())} style={S.tinyBtn}>Clear</button>
                )}
                <button onClick={() => setSelChapters(new Set(chapters.map(c => c.id)))} style={S.tinyBtn}>All</button>
              </div>
            </div>
            <div style={S.chapterGrid}>
              {chapters.map((ch, i) => {
                const isSel = selChapters.has(ch.id);
                return (
                  <button
                    key={ch.id}
                    onClick={() => setSelChapters(p => {
                      const n = new Set(p); n.has(ch.id) ? n.delete(ch.id) : n.add(ch.id); return n;
                    })}
                    style={{
                      ...S.chapterChip,
                      borderColor: isSel ? 'var(--accent)' : 'var(--border-subtle)',
                      background: isSel ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                      color: isSel ? 'var(--accent)' : 'var(--text-secondary)',
                      fontWeight: isSel ? 600 : 400,
                    }}
                  >
                    {isSel && <Check size={10} />}
                    {ch.title || `Ch ${i + 1}`}
                  </button>
                );
              })}
            </div>
            {selChapters.size > 0 && (
              <p style={S.selectionHint}>
                {selChapters.size} of {chapters.length} selected
              </p>
            )}
          </div>
        )}

        <button
          onClick={analyze}
          disabled={analyzing || chapters.length === 0}
          style={{
            ...S.actionBtn,
            background: analyzing || chapters.length === 0
              ? 'var(--bg-elevated)'
              : 'linear-gradient(135deg, var(--accent), #6d9af5)',
            color: analyzing || chapters.length === 0 ? 'var(--text-muted)' : '#fff',
          }}
        >
          {analyzing
            ? <><Loader2 size={15} className="spinner" /> Analyzing scenes...</>
            : <><Zap size={15} /> Analyze {selChapters.size > 0 ? `${selChapters.size} Chapter${selChapters.size !== 1 ? 's' : ''}` : `All ${chapters.length} Chapter${chapters.length !== 1 ? 's' : ''}`}</>
          }
        </button>
        {chapters.length === 0 && (
          <p style={S.emptyHint}>Import a manuscript first to get started.</p>
        )}
      </StepCard>

      {/* ── Step 2: Scene Breakdown ── */}
      {scenes.length > 0 && (
        <StepCard
          step={2}
          title={`Scene Breakdown`}
          subtitle={`${scenes.length} scene${scenes.length !== 1 ? 's' : ''} detected across your manuscript`}
          icon={<Layers size={16} />}
          done={stats.generated === scenes.length && scenes.length > 0}
          headerRight={
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setSelected(new Set(scenes.map(s => s.id)))}
                style={S.tinyBtn}
              >Select All</button>
              {selected.size > 0 && (
                <button onClick={() => setSelected(new Set())} style={S.tinyBtn}>Deselect</button>
              )}
            </div>
          }
        >
          <div style={S.sceneList} className="stagger-children">
            {scenes.map(sc => (
              <SceneCard
                key={sc.id}
                scene={sc}
                exp={expanded === sc.id}
                sel={selected.has(sc.id)}
                onExp={() => setExpanded(expanded === sc.id ? null : sc.id)}
                onSel={() => toggle(sc.id)}
                onDel={() => delScene(sc.id)}
                onUpd={u => updScene(sc.id, u)}
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
          subtitle={`Generate audio for ${selected.size > 0 ? `${selected.size} selected` : 'all'} scenes and place on timeline`}
          icon={<Play size={16} />}
        >
          <div style={S.genGrid}>
            <GenToggle
              checked={genM}
              onChange={setGenM}
              icon={<Music size={15} />}
              label="Music"
              count={stats.mus}
              color="#8B5CF6"
              warning={!caps?.hasMusic ? 'Needs ElevenLabs' : undefined}
            />
            <GenToggle
              checked={genA}
              onChange={setGenA}
              icon={<Waves size={15} />}
              label="Ambience"
              count={stats.amb}
              color="#10B981"
              warning={!caps?.hasSFX ? 'Needs ElevenLabs' : undefined}
            />
            <GenToggle
              checked={genS}
              onChange={setGenS}
              icon={<AudioLines size={15} />}
              label="SFX"
              count={stats.sfx}
              color="#F59E0B"
              warning={!caps?.hasSFX ? 'Needs ElevenLabs' : undefined}
            />
          </div>

          <button
            onClick={generate}
            disabled={generating}
            style={{
              ...S.actionBtn,
              background: generating
                ? 'var(--bg-elevated)'
                : 'linear-gradient(135deg, #8B5CF6, #6366F1)',
              color: generating ? 'var(--text-muted)' : '#fff',
            }}
          >
            {generating
              ? <><Loader2 size={15} className="spinner" /> Generating audio...</>
              : <><Sparkles size={15} /> Generate {selected.size > 0 ? `${selected.size} Scenes` : 'All Scenes'}</>
            }
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

function StatPill({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 20, background: `${color}11`, border: `1px solid ${color}22` }}>
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
        <div style={{
          ...S.stepNum,
          background: done ? 'var(--success)' : 'var(--accent)',
        }}>
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
        <div style={{ textAlign: 'left' as const }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: checked ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{label}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{count} clip{count !== 1 ? 's' : ''}</div>
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
function SceneCard({ scene: sc, exp, sel, onExp, onSel, onDel, onUpd }: {
  scene: BoostScene; exp: boolean; sel: boolean;
  onExp: () => void; onSel: () => void; onDel: () => void; onUpd: (u: any) => void;
}) {
  const c = MOOD_COLORS[sc.mood] || '#6366F1';

  return (
    <div style={{
      ...S.sceneCard,
      borderColor: sel ? `${c}44` : 'var(--border-subtle)',
      background: sel ? `${c}06` : 'var(--bg-base)',
    }}>
      {/* Color accent strip */}
      <div style={{ position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 3, background: c, borderRadius: '3px 0 0 3px' }} />

      <div style={S.sceneHdr} onClick={onExp}>
        <button
          onClick={e => { e.stopPropagation(); onSel(); }}
          style={{
            ...S.checkBtn,
            borderColor: sel ? c : 'var(--border-default)',
            background: sel ? c : 'transparent',
          }}
          aria-label={sel ? 'Deselect scene' : 'Select scene'}
        >
          {sel && <Check size={10} color="#fff" />}
        </button>

        <span style={{ fontSize: 18, lineHeight: 1 }}>{MOOD_ICONS[sc.mood] || '🎵'}</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.sceneTitle}>{sc.title}</div>
          <div style={S.sceneMeta}>
            <span style={{ ...S.moodBadge, background: `${c}18`, color: c }}>{sc.mood}</span>
            <IntensityBar value={sc.intensity} color={c} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Seg {sc.segment_start}–{sc.segment_end}</span>
          </div>
        </div>

        <div style={S.badges}>
          {sc.music_prompt && <span style={{ ...S.tag, background: '#8B5CF618', color: '#8B5CF6' }}><Music size={9} /> Music</span>}
          {(sc.ambience?.length || 0) > 0 && <span style={{ ...S.tag, background: '#10B98118', color: '#10B981' }}><Waves size={9} /> {sc.ambience.length}</span>}
          {(sc.sfx?.length || 0) > 0 && <span style={{ ...S.tag, background: '#F59E0B18', color: '#F59E0B' }}><AudioLines size={9} /> {sc.sfx.length}</span>}
          {sc.status === 'generated' && <span style={{ ...S.tag, background: 'var(--success-subtle)', color: 'var(--success)' }}><CheckCircle2 size={9} /> Done</span>}
        </div>

        <span style={{ color: 'var(--text-muted)', display: 'flex', transition: 'transform 200ms ease' }}>
          {exp ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>

        <button onClick={e => { e.stopPropagation(); onDel(); }} style={S.iconBtn} title="Delete scene" aria-label="Delete scene">
          <Trash2 size={13} />
        </button>
      </div>

      {exp && (
        <div style={S.sceneBody}>
          {sc.music_prompt && (
            <LayerSection icon={<Music size={14} />} title="Background Music" color="#8B5CF6">
              <div style={S.promptBox}>{sc.music_prompt}</div>
              <div style={S.controlRow}>
                <SliderControl label="Volume" value={Math.round(sc.music_volume * 100)} suffix="%" onChange={v => onUpd({ music_volume: v / 100 })} />
                <NumberControl label="Fade In" value={sc.music_fade_in_ms} suffix="ms" onChange={v => onUpd({ music_fade_in_ms: v })} />
                <NumberControl label="Fade Out" value={sc.music_fade_out_ms} suffix="ms" onChange={v => onUpd({ music_fade_out_ms: v })} />
              </div>
            </LayerSection>
          )}

          {sc.ambience?.length > 0 && (
            <LayerSection icon={<Waves size={14} />} title={`Ambient (${sc.ambience.length})`} color="#10B981">
              {sc.ambience.map((a, i) => (
                <div key={i} style={S.subItem}>
                  <div style={S.promptBox}>{a.prompt}</div>
                  <div style={S.controlRow}>
                    <SliderControl
                      label="Vol"
                      value={Math.round(a.volume * 100)}
                      suffix="%"
                      onChange={v => {
                        const u = [...sc.ambience];
                        u[i] = { ...u[i], volume: v / 100 };
                        onUpd({ ambience: u });
                      }}
                    />
                    {a.loop && <span style={{ ...S.tag, background: '#10B98118', color: '#10B981', fontSize: 9 }}>🔁 Loop</span>}
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{a.duration_hint_seconds}s</span>
                  </div>
                </div>
              ))}
            </LayerSection>
          )}

          {sc.sfx?.length > 0 && (
            <LayerSection icon={<AudioLines size={14} />} title={`SFX (${sc.sfx.length})`} color="#F59E0B">
              {sc.sfx.map((fx, i) => (
                <div key={i} style={S.subItem}>
                  <div style={S.promptBox}>{fx.prompt}</div>
                  <div style={S.controlRow}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      @ Seg {fx.at_segment} · {fx.position}{fx.offset_hint_ms ? ` +${fx.offset_hint_ms}ms` : ''} · {fx.duration_hint_seconds}s
                    </span>
                    <SliderControl
                      label="Vol"
                      value={Math.round(fx.volume * 100)}
                      suffix="%"
                      onChange={v => {
                        const u = [...sc.sfx];
                        u[i] = { ...u[i], volume: v / 100 };
                        onUpd({ sfx: u });
                      }}
                    />
                  </div>
                </div>
              ))}
            </LayerSection>
          )}

          {sc.voice_mood && (
            <LayerSection icon={<SlidersHorizontal size={14} />} title="Voice Mood" color="var(--text-tertiary)">
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, fontStyle: 'italic', lineHeight: 1.5 }}>
                "{sc.voice_mood}"
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
  return (
    <div style={{ width: 48, height: 4, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden', display: 'inline-block' }}>
      <div style={{ width: `${value * 100}%`, background: color, height: '100%', borderRadius: 3, transition: 'width 300ms ease' }} />
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
        type="range" min="0" max="100"
        value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        style={S.slider}
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
        type="number" value={value} min={0} max={10000} step={500}
        onChange={e => onChange(parseInt(e.target.value) || 0)}
        style={S.numInput}
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
    background: 'var(--danger-subtle)',
    color: 'var(--danger)',
    border: '1px solid rgba(248,113,113,0.15)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    flexShrink: 0,
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
};
