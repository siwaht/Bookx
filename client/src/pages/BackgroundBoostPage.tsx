import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { backgroundBoost, chapters as chaptersApi } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { toast } from '../components/Toast';
import type { BoostScene, Chapter } from '../types';
import { Sparkles, Music, Wind, Volume2, Trash2, ChevronDown, ChevronRight, Loader2, Zap, Settings2, Check, Brain } from 'lucide-react';

const MC: Record<string, string> = { romantic:'#EC4899',action:'#EF4444',suspense:'#F59E0B',horror:'#7C3AED',peaceful:'#10B981',melancholic:'#6366F1',epic:'#F97316',comedic:'#FBBF24',mysterious:'#8B5CF6',dramatic:'#DC2626',tense:'#D97706',joyful:'#34D399',chase:'#F43F5E',battle:'#B91C1C',exploration:'#0EA5E9' };
const MI: Record<string, string> = { romantic:'💕',action:'⚔️',suspense:'😰',horror:'👻',peaceful:'🌿',melancholic:'😢',epic:'🏔️',comedic:'😄',mysterious:'🔮',dramatic:'🎭',tense:'😬',joyful:'🎉',chase:'🏃',battle:'⚔️',exploration:'🧭' };

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
  const [md, setMd] = useState<{ providers: Record<string, { models: { id: string; label: string }[]; hasKey: boolean }>; currentProvider: string | null; currentModel: string | null } | null>(null);
  const [prov, setProv] = useState('');
  const [model, setModel] = useState('');

  const load = useCallback(async () => { if (!bookId) return; try { setScenes(await backgroundBoost.scenes(bookId)); } catch {} }, [bookId]);
  const loadCh = useCallback(async () => { if (!bookId) return; try { setChapters(await chaptersApi.list(bookId)); } catch {} }, [bookId]);
  const loadMd = useCallback(async () => { if (!bookId) return; try { const d = await backgroundBoost.models(bookId); setMd(d); if (d.currentProvider) setProv(d.currentProvider); if (d.currentModel) setModel(d.currentModel); } catch {} }, [bookId]);
  useEffect(() => { load(); loadCh(); loadMd(); }, [load, loadCh, loadMd]);
  const avail = (prov && md?.providers[prov]?.models) || [];
  useEffect(() => { if (prov && avail.length > 0 && !avail.find(m => m.id === model)) setModel(avail[0].id); }, [prov, avail, model]);

  const analyze = async () => { if (!bookId) return; setAnalyzing(true); try { const chapterIds = selChapters.size > 0 ? Array.from(selChapters) : undefined; const r = await backgroundBoost.analyze(bookId, { chapterIds, provider: prov || undefined, model: model || undefined }); toast.success(`Analyzed ${r.chapters_analyzed} chapter${r.chapters_analyzed !== 1 ? 's' : ''} → ${r.total_scenes} scenes`); await load(); } catch (e: any) { toast.error(e.message); } finally { setAnalyzing(false); } };
  const generate = async () => { if (!bookId) return; setGenerating(true); try { const ids = selected.size > 0 ? Array.from(selected) : undefined; const r = await backgroundBoost.generate(bookId, { scene_ids: ids, generate_music: genM, generate_ambience: genA, generate_sfx: genS }); toast.success(`Generated ${r.music_generated + r.ambience_generated + r.sfx_generated} clips, placed ${r.clips_created} on timeline`); if (r.errors?.length) toast.error(`${r.errors.length} errors`); await load(); } catch (e: any) { toast.error(e.message); } finally { setGenerating(false); } };
  const clear = async () => { if (!bookId || !confirm('Remove all Background Boost scenes and clips?')) return; try { await backgroundBoost.clear(bookId, true); setScenes([]); toast.success('Cleared'); } catch (e: any) { toast.error(e.message); } };
  const delScene = async (id: string) => { if (!bookId) return; try { await backgroundBoost.deleteScene(bookId, id); setScenes(p => p.filter(s => s.id !== id)); } catch (e: any) { toast.error(e.message); } };
  const updScene = async (id: string, u: any) => { if (!bookId) return; try { const r = await backgroundBoost.updateScene(bookId, id, u); setScenes(p => p.map(s => s.id === id ? r : s)); } catch (e: any) { toast.error(e.message); } };
  const toggle = (id: string) => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const tSfx = scenes.reduce((s, sc) => s + (sc.sfx?.length || 0), 0);
  const tAmb = scenes.reduce((s, sc) => s + (sc.ambience?.length || 0), 0);
  const tMus = scenes.filter(s => s.music_prompt).length;

  return (
    <div style={S.container}>
      <div style={S.header}><div style={S.headerLeft}><Sparkles size={20} style={{ color: 'var(--accent)' }} /><div><h1 style={S.title}>Background Boost</h1><p style={S.subtitle}>AI cinematic sound design — music, ambience, and SFX from your scenes</p></div></div>
        {scenes.length > 0 && <button onClick={clear} style={S.dangerBtn}><Trash2 size={13} /> Clear All</button>}
      </div>
      <div style={S.card}><div style={S.cardHeader}><div style={S.stepBadge}>1</div><div><h2 style={S.cardTitle}>Analyze Scenes</h2><p style={S.cardDesc}>AI reads every segment — footsteps, ambient wind, music mood shifts, and more</p></div></div>
        <div style={S.cardBody}>
          <div style={S.infoBox}><span style={{ fontSize: 14 }}>🎬</span><span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4 }}>Full cinematic sound design — footsteps on gravel, tea being sipped, wind whistling, swords clashing, doors creaking. Music shifts with mood — romantic piano for love scenes, intense drums for battles, eerie drones for mystery. Everything placed on timeline with proper volume and spacing.</span></div>
          {md && <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 140 }}><label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}><Brain size={10} style={{ marginRight: 3, verticalAlign: 'middle' }} />Provider</label>
              <select value={prov} onChange={e => setProv(e.target.value)} style={S.select}><option value="">Auto-detect</option>{Object.entries(md.providers).map(([k, v]) => <option key={k} value={k} disabled={!v.hasKey}>{k.charAt(0).toUpperCase() + k.slice(1)}{!v.hasKey ? ' (no key)' : ''}</option>)}</select></div>
            <div style={{ flex: 1, minWidth: 160 }}><label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Model</label>
              <select value={model} onChange={e => setModel(e.target.value)} style={S.select} disabled={!prov}>{!prov && <option value="">Default</option>}{avail.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
          </div>}
          {chapters.length > 0 && <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>Chapters to analyze</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {selChapters.size > 0 && <button onClick={() => setSelChapters(new Set())} style={{ ...S.ghostBtn, padding: '2px 8px', fontSize: 10 }}>Clear</button>}
                <button onClick={() => setSelChapters(new Set(chapters.map(c => c.id)))} style={{ ...S.ghostBtn, padding: '2px 8px', fontSize: 10 }}>All</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 120, overflowY: 'auto', padding: '6px 0' }}>
              {chapters.map((ch, i) => {
                const isSel = selChapters.has(ch.id);
                return <button key={ch.id} onClick={() => setSelChapters(p => { const n = new Set(p); n.has(ch.id) ? n.delete(ch.id) : n.add(ch.id); return n; })} style={{ padding: '4px 10px', fontSize: 11, borderRadius: 'var(--radius-sm)', border: isSel ? '1px solid var(--accent)' : '1px solid var(--border-subtle)', background: isSel ? 'var(--accent-subtle)' : 'var(--bg-elevated)', color: isSel ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer', fontWeight: isSel ? 600 : 400, whiteSpace: 'nowrap' }}>{ch.title || `Ch ${i + 1}`}</button>;
              })}
            </div>
            {selChapters.size > 0 && <p style={{ fontSize: 10, color: 'var(--accent)', marginTop: 4, fontWeight: 500 }}>{selChapters.size} of {chapters.length} chapter{chapters.length !== 1 ? 's' : ''} selected — only these will be analyzed</p>}
          </div>}
          <button onClick={analyze} disabled={analyzing || chapters.length === 0} style={{ ...S.primaryBtn, opacity: analyzing || chapters.length === 0 ? 0.5 : 1 }}>
            {analyzing ? <><Loader2 size={14} className="spin" /> Analyzing...</> : <><Zap size={14} /> Analyze {selChapters.size > 0 ? `${selChapters.size} Chapter${selChapters.size !== 1 ? 's' : ''}` : `All ${chapters.length} Chapter${chapters.length !== 1 ? 's' : ''}`}</>}
          </button>
          {chapters.length === 0 && <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Import a manuscript first.</p>}
        </div>
      </div>
      {scenes.length > 0 && (<>
        <div style={S.card}><div style={S.cardHeader}><div style={S.stepBadge}>2</div><div style={{ flex: 1 }}><h2 style={S.cardTitle}>Scene Breakdown ({scenes.length} scenes)</h2><p style={S.cardDesc}>{tMus} music · {tAmb} ambient · {tSfx} SFX</p></div>
          <button onClick={() => setSelected(new Set(scenes.map(s => s.id)))} style={S.ghostBtn}>Select All</button>
          {selected.size > 0 && <button onClick={() => setSelected(new Set())} style={S.ghostBtn}>Deselect</button>}
        </div>
          <div style={S.sceneList}>{scenes.map(sc => <SceneCard key={sc.id} scene={sc} exp={expanded === sc.id} sel={selected.has(sc.id)} onExp={() => setExpanded(expanded === sc.id ? null : sc.id)} onSel={() => toggle(sc.id)} onDel={() => delScene(sc.id)} onUpd={u => updScene(sc.id, u)} />)}</div>
        </div>
        <div style={S.card}><div style={S.cardHeader}><div style={S.stepBadge}>3</div><div><h2 style={S.cardTitle}>Generate & Place on Timeline</h2><p style={S.cardDesc}>Generate for {selected.size > 0 ? `${selected.size} selected` : 'all'} scenes</p></div></div>
          <div style={S.cardBody}>
            <div style={S.genOpts}>
              <label style={S.chk}><input type="checkbox" checked={genM} onChange={e => setGenM(e.target.checked)} /><Music size={13} /> Music ({tMus}){!caps?.hasMusic && <span style={S.warn}>Needs ElevenLabs</span>}</label>
              <label style={S.chk}><input type="checkbox" checked={genA} onChange={e => setGenA(e.target.checked)} /><Wind size={13} /> Ambience ({tAmb}){!caps?.hasSFX && <span style={S.warn}>Needs ElevenLabs</span>}</label>
              <label style={S.chk}><input type="checkbox" checked={genS} onChange={e => setGenS(e.target.checked)} /><Volume2 size={13} /> SFX ({tSfx}){!caps?.hasSFX && <span style={S.warn}>Needs ElevenLabs</span>}</label>
            </div>
            <button onClick={generate} disabled={generating} style={{ ...S.primaryBtn, background: 'linear-gradient(135deg, #8B5CF6, #6366F1)', opacity: generating ? 0.5 : 1 }}>
              {generating ? <><Loader2 size={14} className="spin" /> Generating...</> : <><Sparkles size={14} /> Generate {selected.size > 0 ? `${selected.size} Scenes` : 'All'}</>}
            </button>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>Placed on Boost tracks with volume, fades, spacing. Adjust in Timeline.</p>
          </div>
        </div>
      </>)}
    </div>
  );
}

function SceneCard({ scene: sc, exp, sel, onExp, onSel, onDel, onUpd }: { scene: BoostScene; exp: boolean; sel: boolean; onExp: () => void; onSel: () => void; onDel: () => void; onUpd: (u: any) => void }) {
  const c = MC[sc.mood] || '#6366F1';
  return (
    <div style={{ ...S.sceneCard, borderLeft: `3px solid ${c}`, background: sel ? 'var(--accent-subtle)' : 'var(--bg-base)' }}>
      <div style={S.sceneHdr} onClick={onExp}>
        <input type="checkbox" checked={sel} onChange={e => { e.stopPropagation(); onSel(); }} onClick={e => e.stopPropagation()} style={{ accentColor: 'var(--accent)' }} />
        {exp ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ fontSize: 16 }}>{MI[sc.mood] || '🎵'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.sceneTitle}>{sc.title}</div>
          <div style={S.sceneMeta}>
            <span style={{ ...S.moodBadge, background: c + '22', color: c }}>{sc.mood}</span>
            <span style={S.intBar}><span style={{ width: `${sc.intensity * 100}%`, background: c, height: '100%', borderRadius: 3, display: 'block' }} /></span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Seg {sc.segment_start}–{sc.segment_end}</span>
          </div>
        </div>
        <div style={S.badges}>
          {sc.music_prompt && <span style={{ ...S.tag, background: '#8B5CF622', color: '#8B5CF6' }}>🎵 Music</span>}
          {(sc.ambience?.length || 0) > 0 && <span style={{ ...S.tag, background: '#10B98122', color: '#10B981' }}>🌿 {sc.ambience.length}</span>}
          {(sc.sfx?.length || 0) > 0 && <span style={{ ...S.tag, background: '#F59E0B22', color: '#F59E0B' }}>🔊 {sc.sfx.length}</span>}
          {sc.status === 'generated' && <span style={{ ...S.tag, background: '#10B98122', color: '#10B981' }}><Check size={10} /> Done</span>}
        </div>
        <button onClick={e => { e.stopPropagation(); onDel(); }} style={S.iconBtn}><Trash2 size={12} /></button>
      </div>
      {exp && <div style={S.sceneBody}>
        {sc.music_prompt && <div style={S.layer}><div style={S.layerHdr}><Music size={13} style={{ color: '#8B5CF6' }} /><span style={S.layerT}>Background Music</span></div>
          <div style={S.prompt}>{sc.music_prompt}</div>
          <div style={S.ctrls}><label style={S.ml}>Vol <input type="range" min="0" max="100" value={Math.round(sc.music_volume * 100)} onChange={e => onUpd({ music_volume: parseInt(e.target.value) / 100 })} style={S.sl} /><span style={S.sv}>{Math.round(sc.music_volume * 100)}%</span></label>
            <label style={S.ml}>Fade In <input type="number" value={sc.music_fade_in_ms} min={0} max={10000} step={500} onChange={e => onUpd({ music_fade_in_ms: parseInt(e.target.value) || 0 })} style={S.ni} /> ms</label>
            <label style={S.ml}>Fade Out <input type="number" value={sc.music_fade_out_ms} min={0} max={10000} step={500} onChange={e => onUpd({ music_fade_out_ms: parseInt(e.target.value) || 0 })} style={S.ni} /> ms</label></div></div>}
        {sc.ambience?.length > 0 && <div style={S.layer}><div style={S.layerHdr}><Wind size={13} style={{ color: '#10B981' }} /><span style={S.layerT}>Ambient ({sc.ambience.length})</span></div>
          {sc.ambience.map((a, i) => <div key={i} style={S.sub}><div style={S.prompt}>{a.prompt}</div><div style={S.ctrls}><label style={S.ml}>Vol <input type="range" min="0" max="100" value={Math.round(a.volume * 100)} onChange={e => { const u = [...sc.ambience]; u[i] = { ...u[i], volume: parseInt(e.target.value) / 100 }; onUpd({ ambience: u }); }} style={S.sl} /><span style={S.sv}>{Math.round(a.volume * 100)}%</span></label>{a.loop && <span style={{ ...S.tag, background: '#10B98122', color: '#10B981', fontSize: 9 }}>🔁</span>}<span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{a.duration_hint_seconds}s</span></div></div>)}</div>}
        {sc.sfx?.length > 0 && <div style={S.layer}><div style={S.layerHdr}><Volume2 size={13} style={{ color: '#F59E0B' }} /><span style={S.layerT}>SFX ({sc.sfx.length})</span></div>
          {sc.sfx.map((fx, i) => <div key={i} style={S.sub}><div style={S.prompt}>{fx.prompt}</div><div style={S.ctrls}><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>@ Seg {fx.at_segment} · {fx.position}{fx.offset_hint_ms ? ` +${fx.offset_hint_ms}ms` : ''} · {fx.duration_hint_seconds}s</span><label style={S.ml}>Vol <input type="range" min="0" max="100" value={Math.round(fx.volume * 100)} onChange={e => { const u = [...sc.sfx]; u[i] = { ...u[i], volume: parseInt(e.target.value) / 100 }; onUpd({ sfx: u }); }} style={S.sl} /><span style={S.sv}>{Math.round(fx.volume * 100)}%</span></label></div></div>)}</div>}
        {sc.voice_mood && <div style={S.layer}><div style={S.layerHdr}><Settings2 size={13} style={{ color: 'var(--text-tertiary)' }} /><span style={S.layerT}>Voice Mood</span></div><p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, fontStyle: 'italic' }}>"{sc.voice_mood}"</p></div>}
      </div>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: { padding: '24px 32px', maxWidth: 900, margin: '0 auto' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 16 },
  headerLeft: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  title: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', margin: 0 },
  subtitle: { fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0', lineHeight: 1.4 },
  card: { background: 'var(--bg-base)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', marginBottom: 16, overflow: 'hidden' },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' },
  cardTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 },
  cardDesc: { fontSize: 11, color: 'var(--text-tertiary)', margin: '2px 0 0' },
  cardBody: { padding: '16px 20px' },
  stepBadge: { width: 26, height: 26, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  primaryBtn: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  dangerBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'none', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  ghostBtn: { background: 'none', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)', padding: '5px 12px', borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: 'pointer' },
  iconBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex' },
  infoBox: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: 'var(--accent-subtle)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(91,141,239,0.1)', marginBottom: 16 },
  select: { width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' },
  sceneList: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  sceneCard: { borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', overflow: 'hidden' },
  sceneHdr: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', userSelect: 'none' as const },
  sceneTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },
  sceneMeta: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 },
  moodBadge: { fontSize: 9, padding: '1px 8px', borderRadius: 10, fontWeight: 600, textTransform: 'capitalize' as const },
  intBar: { width: 40, height: 4, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden', display: 'inline-block' },
  badges: { display: 'flex', gap: 4, flexShrink: 0 },
  tag: { fontSize: 9, padding: '2px 7px', borderRadius: 8, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' as const },
  sceneBody: { padding: '0 14px 14px', display: 'flex', flexDirection: 'column' as const, gap: 12 },
  layer: { background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', display: 'flex', flexDirection: 'column' as const, gap: 8 },
  layerHdr: { display: 'flex', alignItems: 'center', gap: 6 },
  layerT: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' },
  prompt: { fontSize: 11, color: 'var(--text-primary)', background: 'var(--bg-base)', padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', lineHeight: 1.4 },
  ctrls: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const },
  ml: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 },
  sl: { width: 60, height: 4, accentColor: 'var(--accent)' },
  sv: { fontSize: 10, color: 'var(--text-tertiary)', minWidth: 28 },
  ni: { width: 55, padding: '2px 4px', fontSize: 10, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3, color: 'var(--text-primary)' },
  sub: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  genOpts: { display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' as const },
  chk: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', fontWeight: 500 },
  warn: { fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#F59E0B22', color: '#F59E0B', fontWeight: 500 },
};
