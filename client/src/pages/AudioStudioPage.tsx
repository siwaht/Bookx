import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { elevenlabs, audioUrl, audioDownloadUrl, audioAssets, timeline as timelineApi, uploadAudio } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { Wand2, Music, Volume2, Loader, Plus, Clock, Repeat, Upload, Download, Trash2, Edit3, Check, X, FolderOpen } from 'lucide-react';

interface GeneratedAsset {
  id: string;
  type: 'sfx' | 'music' | 'imported';
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
  const [activeTab, setActiveTab] = useState<'sfx' | 'music' | 'v3tags' | 'import' | 'library'>('sfx');

  // Library state
  const [libraryAssets, setLibraryAssets] = useState<any[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadLibrary = useCallback(async () => {
    if (!bookId) return;
    setLibraryLoading(true);
    try {
      const data = await audioAssets.listLibrary(bookId);
      setLibraryAssets(data);
    } catch (err) { console.error('Failed to load library:', err); }
    finally { setLibraryLoading(false); }
  }, [bookId]);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  const handleRename = async (assetId: string) => {
    if (!renameValue.trim()) return;
    await audioAssets.rename(assetId, renameValue.trim());
    setRenamingId(null);
    loadLibrary();
  };

  const handleDeleteAsset = async (assetId: string) => {
    if (!confirm('Delete this audio asset? This will also remove it from the timeline.')) return;
    setDeletingId(assetId);
    try {
      await audioAssets.delete(assetId);
      setLibraryAssets((prev) => prev.filter((a) => a.id !== assetId));
    } catch (err: any) { alert(`Delete failed: ${err.message}`); }
    finally { setDeletingId(null); }
  };

  // Import state
  const [uploading, setUploading] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

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
    finally { setSfxGenerating(false); loadLibrary(); }
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
    finally { setMusicGenerating(false); loadLibrary(); }
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

  const handleImportAudio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !bookId) return;
    setUploading(true);
    try {
      const result = await uploadAudio(bookId, file, file.name);
      setGenerated((prev) => [{
        id: Date.now().toString(),
        type: 'imported',
        prompt: file.name,
        audio_asset_id: result.audio_asset_id,
        cached: false,
      }, ...prev]);
    } catch (err: any) { alert(`Upload failed: ${err.message}`); }
    finally { setUploading(false); if (importFileRef.current) importFileRef.current.value = ''; }
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
          <button onClick={() => setActiveTab('import')}
            style={{ ...styles.tab, ...(activeTab === 'import' ? styles.tabActive : {}) }}>
            <Upload size={14} /> Import Audio
          </button>
          <button onClick={() => setActiveTab('library')}
            style={{ ...styles.tab, ...(activeTab === 'library' ? styles.tabActive : {}) }}>
            <FolderOpen size={14} /> Library
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

        {/* ── Import Audio Tab ── */}
        {activeTab === 'import' && (
          <div style={styles.genPanel}>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>Import Audio Files</label>
              <p style={styles.hint}>
                Upload existing audio files (recorded narration, intros, outros, pre-made effects) to use on the timeline.
                Supported formats: MP3, WAV, OGG, M4A, FLAC, AAC.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
              <button onClick={() => importFileRef.current?.click()} disabled={uploading}
                style={styles.generateBtn}>
                {uploading ? <Loader size={16} /> : <Upload size={16} />}
                {uploading ? 'Uploading...' : 'Choose Audio File'}
              </button>
              <input ref={importFileRef} type="file" accept=".mp3,.wav,.ogg,.m4a,.flac,.aac"
                onChange={handleImportAudio} hidden aria-label="Import audio file" />
              <p style={styles.hint}>Uploaded files appear in the Generated Audio panel on the right, where you can preview and place them on the timeline.</p>
            </div>
          </div>
        )}

        {/* ── Library Tab ── */}
        {activeTab === 'library' && (
          <div style={styles.genPanel}>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>Saved Audio Library</label>
              <p style={styles.hint}>
                All your generated SFX, music, and imported audio files. Preview, rename, download, or reuse them on the timeline.
              </p>
            </div>

            {libraryLoading && <div style={{ color: '#888', fontSize: 12 }}><Loader size={14} /> Loading...</div>}

            {!libraryLoading && libraryAssets.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: '#555', fontSize: 13 }}>
                No audio assets yet. Generate SFX or music, or import audio files.
              </div>
            )}

            {!libraryLoading && libraryAssets.length > 0 && (() => {
              const sfxAssets = libraryAssets.filter((a) => a.type === 'sfx');
              const musicAssets = libraryAssets.filter((a) => a.type === 'music');
              const importedAssets = libraryAssets.filter((a) => a.type === 'imported');

              const renderAssetCard = (asset: any) => {
                const isRenaming = renamingId === asset.id;
                const isDeleting = deletingId === asset.id;
                const displayName = asset.name || (asset.generation_params ? (JSON.parse(asset.generation_params || '{}').prompt || asset.id.slice(0, 8)) : asset.id.slice(0, 8));
                const durationSec = asset.duration_ms ? (asset.duration_ms / 1000).toFixed(1) : '?';
                const sizeMb = asset.file_size_bytes ? (asset.file_size_bytes / (1024 * 1024)).toFixed(2) : '?';

                return (
                  <div key={asset.id} style={{
                    padding: 12, background: 'var(--bg-deep)', borderRadius: 10, border: '1px solid var(--border-subtle)',
                    display: 'flex', flexDirection: 'column', gap: 8, opacity: isDeleting ? 0.4 : 1,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {isRenaming ? (
                        <div style={{ flex: 1, display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                            style={{ flex: 1, padding: '4px 8px', background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6, fontSize: 12, outline: 'none' }}
                            autoFocus onKeyDown={(e) => { if (e.key === 'Enter') handleRename(asset.id); if (e.key === 'Escape') setRenamingId(null); }}
                            aria-label="Rename asset" />
                          <button onClick={() => handleRename(asset.id)} style={styles.presetBtn}><Check size={11} /></button>
                          <button onClick={() => setRenamingId(null)} style={styles.presetBtn}><X size={11} /></button>
                        </div>
                      ) : (
                        <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {displayName}
                        </span>
                      )}
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{durationSec}s · {sizeMb}MB</span>
                    </div>

                    <audio src={audioUrl(asset.id)} controls style={{ width: '100%', height: 32 }} />

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => { setRenamingId(asset.id); setRenameValue(asset.name || displayName); }}
                        style={styles.presetBtn}><Edit3 size={10} /> Rename</button>
                      <a href={audioDownloadUrl(asset.id)} download
                        style={{ ...styles.presetBtn, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Download size={10} /> Download
                      </a>
                      <button onClick={() => handlePlaceOnTimeline({ id: asset.id, type: asset.type, prompt: displayName, audio_asset_id: asset.id, cached: false })}
                        disabled={placingId === asset.id}
                        style={{ ...styles.presetBtn, background: 'var(--success-subtle)', color: 'var(--success)', borderColor: 'rgba(74,222,128,0.12)' }}>
                        <Plus size={10} /> {placingId === asset.id ? '...' : 'Place on Timeline'}
                      </button>
                      <button onClick={() => handleDeleteAsset(asset.id)}
                        style={{ ...styles.presetBtn, color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.12)' }}>
                        <Trash2 size={10} /> Delete
                      </button>
                    </div>
                  </div>
                );
              };

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {/* Sound Effects */}
                  {sfxAssets.length > 0 && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <Wand2 size={14} color="var(--success)" />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--success)' }}>Sound Effects</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({sfxAssets.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {sfxAssets.map(renderAssetCard)}
                      </div>
                    </div>
                  )}

                  {/* Music */}
                  {musicAssets.length > 0 && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <Music size={14} color="var(--accent)" />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>Music</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({musicAssets.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {musicAssets.map(renderAssetCard)}
                      </div>
                    </div>
                  )}

                  {/* Imported */}
                  {importedAssets.length > 0 && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <Upload size={14} color="var(--warning)" />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--warning)' }}>Imported</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({importedAssets.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {importedAssets.map(renderAssetCard)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
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
  header: { padding: '18px 24px 0' },
  title: { fontSize: 18, color: 'var(--text-primary)', fontWeight: 600, letterSpacing: '-0.3px' },
  subtitle: { fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 },
  tabs: { display: 'flex', gap: 4, padding: '14px 24px', borderBottom: '1px solid var(--border-subtle)' },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
    background: 'var(--bg-surface)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 10,
    cursor: 'pointer', fontSize: 12, fontWeight: 500,
  },
  tabActive: { background: 'var(--accent-subtle)', color: 'var(--accent)', borderColor: 'rgba(91,141,239,0.25)' },
  badge: { fontSize: 9, background: 'var(--accent)', color: '#fff', padding: '1px 6px', borderRadius: 20, fontWeight: 600 },
  content: { flex: 1, overflow: 'auto', padding: '18px 24px' },
  genPanel: { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 800 },
  section: { display: 'flex', flexDirection: 'column', gap: 6 },
  sectionLabel: { fontSize: 13, color: 'var(--accent)', fontWeight: 600 },
  hint: { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 },
  code: { background: 'var(--accent-subtle)', color: 'var(--accent)', padding: '2px 8px', borderRadius: 5, fontSize: 11 },
  promptInput: {
    padding: 14, borderRadius: 10, border: '1px solid var(--border-default)', background: 'var(--bg-deep)',
    color: 'var(--text-primary)', fontSize: 14, lineHeight: 1.6, outline: 'none', resize: 'vertical', fontFamily: 'inherit',
  },
  controlsRow: { display: 'flex', gap: 20, flexWrap: 'wrap' },
  control: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 },
  controlLabel: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-tertiary)' },
  numInput: {
    padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-deep)',
    color: 'var(--text-primary)', fontSize: 13, outline: 'none', width: 80,
  },
  slider: { width: '100%', accentColor: 'var(--accent)' },
  sliderHint: { fontSize: 10, color: 'var(--text-muted)' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' },
  generateBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '11px 24px', background: 'var(--accent)', color: '#fff', border: 'none',
    borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 500, alignSelf: 'flex-start',
    boxShadow: '0 2px 10px rgba(91,141,239,0.2)',
  },
  presetsSection: { marginTop: 8 },
  presetsLabel: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, display: 'block' },
  presetGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  presetBtn: {
    padding: '7px 14px', background: 'var(--bg-surface)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)',
    borderRadius: 8, cursor: 'pointer', fontSize: 11, textAlign: 'left', maxWidth: 280,
  },
  warningBox: { padding: 14, background: 'var(--warning-subtle)', borderRadius: 10, border: '1px solid rgba(251,191,36,0.1)', color: 'var(--warning)', fontSize: 12 },
  exampleBox: { padding: 18, background: 'var(--bg-base)', borderRadius: 10, border: '1px solid var(--border-subtle)' },
  exampleLabel: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 },
  exampleText: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8, fontFamily: 'Georgia, serif' },
  tagCategory: { marginBottom: 14 },
  tagCategoryLabel: { fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500, marginBottom: 6, display: 'block' },
  tagGrid: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  tagBtn: {
    padding: '5px 12px', background: 'var(--accent-subtle)', color: 'var(--accent)', border: '1px solid rgba(91,141,239,0.12)',
    borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: 'monospace',
  },
  resultsPanel: {
    width: 320, borderLeft: '1px solid var(--border-subtle)', background: 'var(--bg-base)', padding: 14,
    overflow: 'auto', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10,
  },
  resultsPanelTitle: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 4 },
  resultItem: { display: 'flex', flexDirection: 'column', gap: 6, padding: 12, background: 'var(--bg-surface)', borderRadius: 10, border: '1px solid var(--border-subtle)' },
  resultHeader: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  resultType: { fontSize: 9, color: 'var(--success)', padding: '2px 8px', borderRadius: 20, fontWeight: 600, background: 'var(--success-subtle)' },
  resultPrompt: { fontSize: 11, color: 'var(--text-tertiary)', flex: 1, minWidth: 0 },
  cachedBadge: { fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 20 },
  placeBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    padding: '6px 12px', background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid rgba(74,222,128,0.12)',
    borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 500,
  },
};
