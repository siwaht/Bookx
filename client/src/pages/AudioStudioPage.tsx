import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { elevenlabs, audioUrl, timeline as timelineApi } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { Wand2, Music, Volume2, Play, Loader, Plus, Clock, Repeat } from 'lucide-react';

interface GeneratedAsset {
  id: string;
  type: 'sfx' | 'music';
  prompt: string;
  audio_asset_id: string;
  cached: boolean;
}

const SFX_PRESETS = [
  'Footsteps on gravel, then a metallic door opens',
  'Thunder rumbling in the distance',
  'Wind whistling through trees, followed by leaves rustling',
  'Glass shattering on concrete',
  'Heavy wooden door creaking open slowly',
  'Rain falling on a tin roof',
  'Campfire crackling with occasional pops',
  'Clock ticking in a quiet room',
  'Sword being drawn from a sheath',
  'Horse galloping on a dirt road',
  'Ocean waves crashing on rocks',
  'Crowd murmuring in a large hall',
];

const MUSIC_PRESETS = [
  'Gentle piano melody, reflective and melancholic, suitable for audiobook intro',
  'Soft ambient strings, warm and hopeful, cinematic underscore',
  'Mysterious dark orchestral, suspenseful, minor key',
  'Upbeat acoustic guitar, cheerful folk feel',
  'Epic orchestral crescendo, triumphant brass and timpani',
  'Quiet solo cello, intimate and emotional',
  'Jazz lounge piano, smooth and relaxed, late night feel',
  'Ethereal choir pad, spiritual and vast',
];

const V3_TAG_CATEGORIES = [
  {
    name: 'Emotions',
    tags: ['happy', 'sad', 'angry', 'fearful', 'excited', 'melancholic', 'romantic', 'mysterious',
      'anxious', 'confident', 'nostalgic', 'playful', 'serious', 'tender', 'dramatic'],
  },
  {
    name: 'Vocal Effects',
    tags: ['whisper', 'shout', 'gasp', 'sigh', 'laugh', 'sob', 'yawn', 'cough',
      'chuckle', 'giggle', 'growl', 'murmur', 'panting', 'clears throat'],
  },
  {
    name: 'Styles',
    tags: ['conversational', 'formal', 'theatrical', 'monotone', 'breathy', 'crisp',
      'commanding', 'gentle', 'intimate', 'distant', 'warm', 'cold'],
  },
  {
    name: 'Narrative',
    tags: ['storytelling tone', 'voice-over style', 'documentary style', 'bedtime story',
      'dramatic pause', 'suspense build-up', 'inner monologue', 'flashback tone'],
  },
  {
    name: 'Rhythm',
    tags: ['slow', 'fast', 'dramatic pause', 'pauses for effect', 'staccato',
      'measured', 'rushed', 'languid', 'building tension'],
  },
  {
    name: 'Environments',
    tags: ['forest morning', 'city street', 'cafe ambient', 'rain heavy', 'library ambient',
      'church ambient', 'campfire crackle', 'ocean waves'],
  },
];

export function AudioStudioPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const capabilities = useAppStore((s) => s.capabilities);
  const [activeTab, setActiveTab] = useState<'sfx' | 'music' | 'v3tags'>('sfx');

  // SFX state
  const [sfxPrompt, setSfxPrompt] = useState('');
  const [sfxDuration, setSfxDuration] = useState<number | undefined>(undefined);
  const [sfxInfluence, setSfxInfluence] = useState(0.3);
  const [sfxLoop, setSfxLoop] = useState(false);
  const [sfxGenerating, setSfxGenerating] = useState(false);

  // Music state
  const [musicPrompt, setMusicPrompt] = useState('');
  const [musicDuration, setMusicDuration] = useState(30);
  const [musicInstrumental, setMusicInstrumental] = useState(true);
  const [musicGenerating, setMusicGenerating] = useState(false);

  // Generated assets
  const [generated, setGenerated] = useState<GeneratedAsset[]>([]);
  const [placingId, setPlacingId] = useState<string | null>(null);

  const handleGenerateSFX = async () => {
    if (!sfxPrompt.trim()) return;
    setSfxGenerating(true);
    try {
      const result = await elevenlabs.sfx({
        prompt: sfxPrompt,
        duration_seconds: sfxDuration,
        prompt_influence: sfxInfluence,
        loop: sfxLoop,
        book_id: bookId,
      });
      setGenerated((prev) => [{
        id: Date.now().toString(),
        type: 'sfx',
        prompt: sfxPrompt,
        audio_asset_id: result.audio_asset_id,
        cached: result.cached,
      }, ...prev]);
    } catch (err: any) { alert(`SFX generation failed: ${err.message}`); }
    finally { setSfxGenerating(false); }
  };

  const handleGenerateMusic = async () => {
    if (!musicPrompt.trim()) return;
    setMusicGenerating(true);
    try {
      const result = await elevenlabs.music({
        prompt: musicPrompt,
        music_length_ms: musicDuration * 1000,
        force_instrumental: musicInstrumental,
        book_id: bookId,
      });
      setGenerated((prev) => [{
        id: Date.now().toString(),
        type: 'music',
        prompt: musicPrompt,
        audio_asset_id: result.audio_asset_id,
        cached: result.cached,
      }, ...prev]);
    } catch (err: any) { alert(`Music generation failed: ${err.message}`); }
    finally { setMusicGenerating(false); }
  };

  const handlePlaceOnTimeline = async (asset: GeneratedAsset) => {
    if (!bookId) return;
    setPlacingId(asset.id);
    try {
      // Get existing tracks or create one
      const tracks = await timelineApi.tracks(bookId);
      let targetTrack = tracks.find((t: any) => t.type === asset.type);
      if (!targetTrack) {
        targetTrack = await timelineApi.createTrack(bookId, {
          name: asset.type === 'sfx' ? 'Sound Effects' : 'Music',
          type: asset.type,
        });
      }
      // Find the end position of existing clips on this track
      const existingClips = targetTrack.clips || [];
      const endPos = existingClips.length > 0
        ? Math.max(...existingClips.map((c: any) => c.position_ms + (c.trim_end_ms || 5000)))
        : 0;
      await timelineApi.createClip(bookId, targetTrack.id, {
        audio_asset_id: asset.audio_asset_id,
        position_ms: endPos,
      });
      alert(`Placed "${asset.prompt.slice(0, 40)}..." on ${asset.type} track at ${(endPos / 1000).toFixed(1)}s`);
    } catch (err: any) { alert(`Failed to place on timeline: ${err.message}`); }
    finally { setPlacingId(null); }
  };

  const hasV3 = capabilities?.hasV3;

  return (
    <div style={styles.container}>
      <div style={styles.mainCol}>
        <div style={styles.header}>
          <h2 style={styles.title}>🎵 Audio Studio</h2>
          <p style={styles.subtitle}>Generate sound effects, music, and use v3 audio tags for expressive narration</p>
        </div>

        {/* Tab bar */}
        <div style={styles.tabs}>
          <button onClick={() => setActiveTab('sfx')}
            style={{ ...styles.tab, ...(activeTab === 'sfx' ? styles.tabActive : {}) }}>
            <Wand2 size={14} /> Sound Effects
          </button>
          <button onClick={() => setActiveTab('music')}
            style={{ ...styles.tab, ...(activeTab === 'music' ? styles.tabActive : {}) }}>
            <Music size={14} /> Music
          </button>
          <button onClick={() => setActiveTab('v3tags')}
            style={{ ...styles.tab, ...(activeTab === 'v3tags' ? styles.tabActive : {}) }}>
            <Volume2 size={14} /> V3 Audio Tags {hasV3 && <span style={styles.badge}>v3</span>}
          </button>
        </div>

      <div style={styles.content}>
        {/* ── SFX Tab ── */}
        {activeTab === 'sfx' && (
          <div style={styles.genPanel}>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>Describe the sound effect</label>
              <p style={styles.hint}>Be specific about the sound, timing, and environment. The AI understands audio terminology.</p>
              <textarea value={sfxPrompt} onChange={(e) => setSfxPrompt(e.target.value)}
                placeholder="e.g. Heavy wooden door creaking open slowly, then slamming shut"
                style={styles.promptInput} rows={3} aria-label="Sound effect description" />
            </div>

            <div style={styles.controlsRow}>
              <div style={styles.control}>
                <label style={styles.controlLabel}><Clock size={12} /> Duration (sec)</label>
                <input type="number" min={0.5} max={30} step={0.5}
                  value={sfxDuration ?? ''} onChange={(e) => setSfxDuration(e.target.value ? parseFloat(e.target.value) : undefined)}
                  placeholder="Auto" style={styles.numInput} aria-label="Duration in seconds" />
              </div>
              <div style={styles.control}>
                <label style={styles.controlLabel}>Prompt Influence: {sfxInfluence.toFixed(1)}</label>
                <input type="range" min={0} max={1} step={0.1} value={sfxInfluence}
                  onChange={(e) => setSfxInfluence(parseFloat(e.target.value))} style={styles.slider}
                  aria-label="Prompt influence" />
                <span style={styles.sliderHint}>Low = creative · High = literal</span>
              </div>
              <div style={styles.control}>
                <label style={styles.checkLabel}>
                  <input type="checkbox" checked={sfxLoop} onChange={(e) => setSfxLoop(e.target.checked)} />
                  <Repeat size={12} /> Seamless Loop
                </label>
                <span style={styles.sliderHint}>For ambient/background sounds</span>
              </div>
            </div>

            <button onClick={handleGenerateSFX} disabled={sfxGenerating || !sfxPrompt.trim()} style={styles.generateBtn}>
              {sfxGenerating ? <Loader size={16} /> : <Wand2 size={16} />}
              {sfxGenerating ? 'Generating...' : 'Generate Sound Effect'}
            </button>

            <div style={styles.presetsSection}>
              <label style={styles.presetsLabel}>Quick presets</label>
              <div style={styles.presetGrid}>
                {SFX_PRESETS.map((p, i) => (
                  <button key={i} onClick={() => setSfxPrompt(p)} style={styles.presetBtn}>{p}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Music Tab ── */}
        {activeTab === 'music' && (
          <div style={styles.genPanel}>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>Describe the music</label>
              <p style={styles.hint}>Include genre, mood, instruments, tempo, and intended use. The model generates full compositions.</p>
              <textarea value={musicPrompt} onChange={(e) => setMusicPrompt(e.target.value)}
                placeholder="e.g. Gentle piano melody, reflective and melancholic, suitable for audiobook chapter transition"
                style={styles.promptInput} rows={3} aria-label="Music description" />
            </div>

            <div style={styles.controlsRow}>
              <div style={styles.control}>
                <label style={styles.controlLabel}><Clock size={12} /> Duration: {musicDuration}s</label>
                <input type="range" min={3} max={600} step={1} value={musicDuration}
                  onChange={(e) => setMusicDuration(parseInt(e.target.value))} style={styles.slider}
                  aria-label="Music duration" />
                <span style={styles.sliderHint}>3s – 10min</span>
              </div>
              <div style={styles.control}>
                <label style={styles.checkLabel}>
                  <input type="checkbox" checked={musicInstrumental} onChange={(e) => setMusicInstrumental(e.target.checked)} />
                  <Music size={12} /> Force Instrumental
                </label>
                <span style={styles.sliderHint}>No vocals, pure instrumental</span>
              </div>
            </div>

            <button onClick={handleGenerateMusic} disabled={musicGenerating || !musicPrompt.trim()} style={styles.generateBtn}>
              {musicGenerating ? <Loader size={16} /> : <Music size={16} />}
              {musicGenerating ? 'Composing...' : 'Generate Music'}
            </button>

            <div style={styles.presetsSection}>
              <label style={styles.presetsLabel}>Quick presets</label>
              <div style={styles.presetGrid}>
                {MUSIC_PRESETS.map((p, i) => (
                  <button key={i} onClick={() => setMusicPrompt(p)} style={styles.presetBtn}>{p}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── V3 Audio Tags Tab ── */}
        {activeTab === 'v3tags' && (
          <div style={styles.genPanel}>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>ElevenLabs v3 Audio Tags</label>
              {hasV3 ? (
                <p style={styles.hint}>
                  With the v3 model, you can embed audio tags directly in your text to control emotion, style, and effects.
                  Wrap tags in square brackets like <code style={styles.code}>[whispers]</code> or <code style={styles.code}>[excited]</code>.
                  Use them in your manuscript segments for expressive narration.
                </p>
              ) : (
                <div style={styles.warningBox}>
                  <p>Your account doesn't appear to have access to the eleven_v3 model. Audio tags require v3.
                  Check your ElevenLabs subscription tier.</p>
                </div>
              )}
            </div>

            <div style={styles.section}>
              <label style={styles.sectionLabel}>How to use</label>
              <div style={styles.exampleBox}>
                <p style={styles.exampleLabel}>Example text with audio tags:</p>
                <p style={styles.exampleText}>
                  [storytelling tone] Once upon a time, in a land far away, [dramatic pause] there lived a dragon.
                  [whispers] Nobody knew its name. [excited] But one day, a brave knight arrived!
                  [gasp] The dragon turned and [growl] spoke in a voice like thunder.
                </p>
              </div>
              <p style={styles.hint}>
                Copy tags from below and paste them into your manuscript text on the Manuscript page.
                The v3 model will interpret them during TTS generation.
              </p>
            </div>

            {V3_TAG_CATEGORIES.map((cat) => (
              <div key={cat.name} style={styles.tagCategory}>
                <label style={styles.tagCategoryLabel}>{cat.name}</label>
                <div style={styles.tagGrid}>
                  {cat.tags.map((tag) => (
                    <button key={tag} onClick={() => navigator.clipboard.writeText(`[${tag}]`)}
                      style={styles.tagBtn} title={`Click to copy [${tag}] to clipboard`}>
                      [{tag}]
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>{/* end mainCol */}

      {/* ── Generated Assets Panel ── */}
      {generated.length > 0 && (
        <div style={styles.resultsPanel}>
          <h3 style={styles.resultsPanelTitle}>Generated Audio ({generated.length})</h3>
          {generated.map((asset) => (
            <div key={asset.id} style={styles.resultItem}>
              <div style={styles.resultHeader}>
                <span style={{ ...styles.resultType, background: asset.type === 'sfx' ? '#2a3a1a' : '#1a2a3a' }}>
                  {asset.type.toUpperCase()}
                </span>
                <span style={styles.resultPrompt}>{asset.prompt.slice(0, 60)}{asset.prompt.length > 60 ? '...' : ''}</span>
                {asset.cached && <span style={styles.cachedBadge}>cached</span>}
              </div>
              <audio src={audioUrl(asset.audio_asset_id)} controls style={{ width: '100%', height: 32 }} />
              <button onClick={() => handlePlaceOnTimeline(asset)} disabled={placingId === asset.id}
                style={styles.placeBtn} title="Add this clip to the timeline">
                <Plus size={12} /> {placingId === asset.id ? 'Placing...' : 'Place on Timeline'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', height: 'calc(100vh - 48px)', overflow: 'hidden' },
  mainCol: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 },
  header: { padding: '16px 24px 0' },
  title: { fontSize: 20, color: '#fff' },
  subtitle: { fontSize: 13, color: '#555', marginTop: 4 },
  tabs: { display: 'flex', gap: 4, padding: '12px 24px', borderBottom: '1px solid #222' },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
    background: '#1a1a1a', color: '#888', border: '1px solid #222', borderRadius: 8,
    cursor: 'pointer', fontSize: 13, transition: 'all 0.2s',
  },
  tabActive: { background: '#1e2a3a', color: '#4A90D9', borderColor: '#4A90D9' },
  badge: { fontSize: 9, background: '#4A90D9', color: '#fff', padding: '1px 5px', borderRadius: 4, fontWeight: 600 },
  content: { flex: 1, overflow: 'auto', padding: '16px 24px' },
  genPanel: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 800 },
  section: { display: 'flex', flexDirection: 'column', gap: 6 },
  sectionLabel: { fontSize: 14, color: '#4A90D9', fontWeight: 500 },
  hint: { fontSize: 12, color: '#666', lineHeight: 1.5 },
  code: { background: '#1e2a3a', color: '#4A90D9', padding: '1px 6px', borderRadius: 4, fontSize: 12 },
  promptInput: {
    padding: 12, borderRadius: 8, border: '1px solid #333', background: '#0f0f0f',
    color: '#ddd', fontSize: 14, lineHeight: 1.6, outline: 'none', resize: 'vertical', fontFamily: 'inherit',
  },
  controlsRow: { display: 'flex', gap: 20, flexWrap: 'wrap' },
  control: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 },
  controlLabel: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#888' },
  numInput: {
    padding: '6px 10px', borderRadius: 6, border: '1px solid #333', background: '#0f0f0f',
    color: '#ddd', fontSize: 13, outline: 'none', width: 80,
  },
  slider: { width: '100%', accentColor: '#4A90D9' },
  sliderHint: { fontSize: 10, color: '#555' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#aaa', cursor: 'pointer' },
  generateBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '12px 24px', background: '#4A90D9', color: '#fff', border: 'none',
    borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 500, alignSelf: 'flex-start',
  },
  presetsSection: { marginTop: 8 },
  presetsLabel: { fontSize: 12, color: '#666', marginBottom: 8, display: 'block' },
  presetGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  presetBtn: {
    padding: '6px 12px', background: '#1a1a1a', color: '#888', border: '1px solid #222',
    borderRadius: 6, cursor: 'pointer', fontSize: 11, textAlign: 'left', maxWidth: 280,
    transition: 'border-color 0.2s',
  },
  warningBox: { padding: 12, background: '#2a2a1a', borderRadius: 8, border: '1px solid #3a3a1a', color: '#aa8', fontSize: 13 },
  exampleBox: { padding: 16, background: '#111', borderRadius: 8, border: '1px solid #222' },
  exampleLabel: { fontSize: 11, color: '#666', marginBottom: 8 },
  exampleText: { fontSize: 13, color: '#bbb', lineHeight: 1.8, fontFamily: 'Georgia, serif' },
  tagCategory: { marginBottom: 12 },
  tagCategoryLabel: { fontSize: 13, color: '#aaa', fontWeight: 500, marginBottom: 6, display: 'block' },
  tagGrid: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  tagBtn: {
    padding: '4px 10px', background: '#1e2a3a', color: '#6a9ad0', border: '1px solid #2a3a5a',
    borderRadius: 4, cursor: 'pointer', fontSize: 11, fontFamily: 'monospace',
  },
  resultsPanel: {
    width: 320, borderLeft: '1px solid #222', background: '#111', padding: 12,
    overflow: 'auto', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10,
  },
  resultsPanelTitle: { fontSize: 13, color: '#fff', marginBottom: 4 },
  resultItem: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, background: '#1a1a1a', borderRadius: 8 },
  resultHeader: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  resultType: { fontSize: 9, color: '#8f8', padding: '2px 6px', borderRadius: 3, fontWeight: 600 },
  resultPrompt: { fontSize: 11, color: '#888', flex: 1, minWidth: 0 },
  cachedBadge: { fontSize: 9, color: '#666', background: '#222', padding: '1px 5px', borderRadius: 3 },
  placeBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    padding: '5px 10px', background: '#2d5a27', color: '#8f8', border: 'none',
    borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },
};
