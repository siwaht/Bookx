import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { characters as charsApi, elevenlabs, ttsProviders } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { toast } from '../components/Toast';
import type { Character, ElevenLabsVoice, TTSProviderName } from '../types';
import { Plus, Search, Play, Trash2, Mic, CheckCircle, Hash, Loader, Globe, X, Zap, Wand2 } from 'lucide-react';

const PROVIDER_LABELS: Record<TTSProviderName, string> = {
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI TTS',
  google: 'Google Cloud TTS',
  amazon: 'Amazon Polly',
  deepgram: 'Deepgram Aura',
};

const PROVIDER_COLORS: Record<TTSProviderName, string> = {
  elevenlabs: '#5b8def',
  openai: '#10a37f',
  google: '#4285f4',
  amazon: '#ff9900',
  deepgram: '#13ef93',
};

export function VoicesPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const capabilities = useAppStore((s) => s.capabilities);
  const [characterList, setCharacterList] = useState<Character[]>([]);
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [selectedChar, setSelectedChar] = useState<Character | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'narrator' | 'character'>('character');

  // Voice ID lookup (ElevenLabs)
  const [voiceIdInput, setVoiceIdInput] = useState('');
  const [voiceIdLooking, setVoiceIdLooking] = useState(false);
  const [voiceIdResult, setVoiceIdResult] = useState<any | null>(null);
  const [voiceIdError, setVoiceIdError] = useState('');

  // Library search (ElevenLabs)
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryResults, setLibraryResults] = useState<any[]>([]);
  const [librarySearching, setLibrarySearching] = useState(false);
  const [libraryGender, setLibraryGender] = useState('');
  const [libraryLanguage, setLibraryLanguage] = useState('');

  // Multi-provider
  const [providers, setProviders] = useState<Array<{ name: TTSProviderName; displayName: string; configured: boolean }>>([]);
  const [activeProvider, setActiveProvider] = useState<TTSProviderName>('elevenlabs');
  const [providerVoices, setProviderVoices] = useState<any[]>([]);
  const [loadingProviderVoices, setLoadingProviderVoices] = useState(false);

  // Auto-assign voices
  const [autoAssigning, setAutoAssigning] = useState(false);

  const loadCharacters = async () => {
    if (!bookId) return;
    try {
      const data = await charsApi.list(bookId);
      setCharacterList(Array.isArray(data) ? data : []);
    } catch (err) { console.error('Failed to load characters:', err); }
  };

  const loadVoices = async () => {
    try {
      const data = await elevenlabs.voices();
      setVoices(Array.isArray(data) ? data : []);
    } catch (err) { console.error('Failed to load voices:', err); }
  };

  const loadProviders = async () => {
    try {
      const data = await ttsProviders.list();
      setProviders(data as any);
    } catch (err) { console.error('Failed to load providers:', err); }
  };

  const loadProviderVoices = async (provider: TTSProviderName) => {
    if (provider === 'elevenlabs') return; // handled separately
    setLoadingProviderVoices(true);
    try {
      const data = await ttsProviders.voices(provider);
      setProviderVoices(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(`Failed to load ${provider} voices:`, err);
      setProviderVoices([]);
    } finally {
      setLoadingProviderVoices(false);
    }
  };

  useEffect(() => { loadCharacters(); loadVoices(); loadProviders(); }, [bookId]);

  useEffect(() => {
    if (activeProvider !== 'elevenlabs') loadProviderVoices(activeProvider);
  }, [activeProvider]);

  const handleCreate = async () => {
    if (!bookId || !newName.trim()) return;
    const char = await charsApi.create(bookId, { name: newName, role: newRole });
    setNewName(''); setShowCreate(false);
    setCharacterList([...characterList, char]);
    setSelectedChar(char);
  };

  const handleAutoAssignVoices = async () => {
    if (!bookId) return;
    const unassigned = characterList.filter((c) => !c.voice_id);
    if (unassigned.length === 0) {
      toast.info('All characters already have voices assigned.');
      return;
    }
    setAutoAssigning(true);
    try {
      const result = await charsApi.autoAssignVoices(bookId);
      if (result.assigned > 0) {
        toast.success(`Assigned voices to ${result.assigned} character${result.assigned > 1 ? 's' : ''}. You can modify any assignment below.`);
        // Refresh the full character list from server
        const refreshed = await charsApi.list(bookId);
        const list = Array.isArray(refreshed) ? refreshed : [];
        setCharacterList(list);
        // Update selected char if it was one of the assigned
        if (selectedChar) {
          const updated = list.find((c: any) => c.id === selectedChar.id);
          if (updated) setSelectedChar(updated);
        }
      } else {
        toast.info('No voices could be assigned. Check that you have TTS providers configured in Settings.');
      }
    } catch (err: any) {
      toast.error(`Auto-assign failed: ${err.message}`);
    } finally {
      setAutoAssigning(false);
    }
  };

  const handleUpdate = async (field: string, value: any) => {
    if (!bookId || !selectedChar) return;
    await charsApi.update(bookId, selectedChar.id, { [field]: value });
    const updated = { ...selectedChar, [field]: value };
    setSelectedChar(updated);
    setCharacterList(characterList.map((c) => (c.id === updated.id ? updated : c)));
  };

  const handleDelete = async (id: string) => {
    if (!bookId) return;
    await charsApi.delete(bookId, id);
    setCharacterList(characterList.filter((c) => c.id !== id));
    if (selectedChar?.id === id) setSelectedChar(null);
  };

  const assignVoice = async (voiceId: string, voiceName: string, provider?: TTSProviderName) => {
    if (!bookId || !selectedChar) return;
    const updates: any = { voice_id: voiceId, voice_name: voiceName };
    if (provider) updates.tts_provider = provider;
    await charsApi.update(bookId, selectedChar.id, updates);
    const updated = { ...selectedChar, ...updates };
    setSelectedChar(updated);
    setCharacterList(characterList.map((c) => (c.id === updated.id ? updated : c)));
  };

  const assignSharedVoice = async (voice: any) => {
    if (!bookId || !selectedChar) return;
    if (!voice.public_owner_id) {
      await assignVoice(voice.voice_id, voice.name, 'elevenlabs');
      return;
    }
    try {
      const result = await elevenlabs.addSharedVoice(voice.public_owner_id, voice.voice_id, voice.name);
      await assignVoice(result.voice_id, voice.name, 'elevenlabs');
      loadVoices();
    } catch (err: any) {
      console.warn('Failed to add shared voice, trying direct assign:', err.message);
      await assignVoice(voice.voice_id, voice.name, 'elevenlabs');
    }
  };

  const handleVoiceIdLookup = async () => {
    const id = voiceIdInput.trim();
    if (!id) return;
    setVoiceIdLooking(true); setVoiceIdError(''); setVoiceIdResult(null);
    try {
      const voice = await elevenlabs.getVoice(id);
      setVoiceIdResult(voice.sharing ? { ...voice, _isShared: true } : voice);
    } catch (err: any) {
      setVoiceIdError(err.message || 'Voice not found');
    } finally { setVoiceIdLooking(false); }
  };

  const handleLibrarySearch = async () => {
    if (!libraryQuery.trim() && !libraryGender && !libraryLanguage) return;
    setLibrarySearching(true);
    try {
      const result = await elevenlabs.searchLibrary({ q: libraryQuery.trim(), gender: libraryGender, language: libraryLanguage, page_size: 30 });
      setLibraryResults(result.voices || []);
    } catch (err: any) { toast.error(`Library search failed: ${err.message}`); }
    finally { setLibrarySearching(false); }
  };

  const filteredVoices = voiceSearch
    ? voices.filter((v) => v.name.toLowerCase().includes(voiceSearch.toLowerCase()) || v.voice_id.toLowerCase().includes(voiceSearch.toLowerCase()))
    : voices.slice(0, 20);

  const filteredProviderVoices = voiceSearch
    ? providerVoices.filter((v: any) => v.name?.toLowerCase().includes(voiceSearch.toLowerCase()) || v.voiceId?.toLowerCase().includes(voiceSearch.toLowerCase()))
    : providerVoices;

  const models = capabilities?.models || [];
  const charsWithVoice = characterList.filter((c) => c.voice_id);
  const charsWithoutVoice = characterList.filter((c) => !c.voice_id);
  const configuredProviders = providers.filter((p) => p.configured);

  return (
    <div style={styles.container}>
      {/* Left: Character List */}
      <div style={styles.charPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.title}>🎭 Characters</h3>
          <button onClick={() => setShowCreate(true)} style={styles.addBtn} title="Add character"><Plus size={16} /></button>
        </div>
        {characterList.length > 0 && (
          <div style={styles.progressBar}>
            <span style={{ fontSize: 11, color: charsWithoutVoice.length === 0 ? '#8f8' : '#888' }}>
              {charsWithVoice.length}/{characterList.length} voices assigned
            </span>
            {charsWithoutVoice.length === 0 && <CheckCircle size={12} color="#8f8" />}
          </div>
        )}
        {characterList.length > 0 && charsWithoutVoice.length > 0 && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <button onClick={handleAutoAssignVoices} disabled={autoAssigning}
              style={{ ...styles.autoAssignBtn, opacity: autoAssigning ? 0.6 : 1 }}
              title="Automatically assign distinct voices to all characters without one">
              {autoAssigning ? <Loader size={12} /> : <Wand2 size={12} />}
              {autoAssigning ? 'Assigning...' : `Auto-assign ${charsWithoutVoice.length} voice${charsWithoutVoice.length > 1 ? 's' : ''}`}
            </button>
          </div>
        )}
        {showCreate && (
          <div style={styles.createForm}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (e.g. Narrator, Alice)" style={styles.input} autoFocus aria-label="Character name" />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as any)} style={styles.input} aria-label="Role">
              <option value="narrator">Narrator</option>
              <option value="character">Character</option>
            </select>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={handleCreate} style={styles.submitBtn}>Add</button>
              <button onClick={() => setShowCreate(false)} style={styles.cancelBtn}>Cancel</button>
            </div>
          </div>
        )}
        {characterList.map((char) => (
          <div key={char.id} onClick={() => setSelectedChar(char)}
            style={{ ...styles.charItem, background: selectedChar?.id === char.id ? '#2a2a2a' : 'transparent', borderLeft: `3px solid ${selectedChar?.id === char.id ? '#4A90D9' : 'transparent'}` }}>
            <div style={styles.charItemTop}>
              <span style={{ color: '#ddd', fontSize: 14 }}>{char.name}</span>
              {char.voice_id ? <CheckCircle size={12} color="#8f8" /> : <Mic size={12} color="#555" />}
            </div>
            <span style={{ color: '#666', fontSize: 11 }}>
              {char.role}{char.voice_name ? ` · ${char.voice_name}` : ' · no voice yet'}
              {char.voice_id && char.tts_provider && char.tts_provider !== 'elevenlabs' && (
                <span style={{ color: PROVIDER_COLORS[char.tts_provider], marginLeft: 4, fontSize: 9, background: '#1a1a2a', padding: '1px 5px', borderRadius: 3 }}>
                  {PROVIDER_LABELS[char.tts_provider]}
                </span>
              )}
            </span>
            <button onClick={(e) => { e.stopPropagation(); handleDelete(char.id); }} style={styles.delBtn} aria-label={`Delete ${char.name}`}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {characterList.length === 0 && !showCreate && (
          <div style={styles.emptyState}>
            <Mic size={28} color="#444" />
            <p style={styles.emptyTitle}>No characters yet</p>
            <p style={styles.emptyHint}>Create a character and assign a voice from any configured TTS provider.</p>
            <button onClick={() => setShowCreate(true)} style={styles.emptyBtn}><Plus size={14} /> Create First Character</button>
          </div>
        )}
      </div>

      {/* Right: Voice Settings */}
      <div style={styles.settingsPanel}>
        {selectedChar ? (
          <>
            <div style={styles.settingsHeader}>
              <h3 style={styles.title}>{selectedChar.name}</h3>
              <span style={styles.settingsRole}>{selectedChar.role}</span>
            </div>

            <div style={styles.section}>
              <label style={styles.sectionLabel}>1. Choose a Voice</label>

              {/* Currently assigned voice */}
              {selectedChar.voice_id && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg-deep)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                  <CheckCircle size={12} color="var(--success)" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{selectedChar.voice_name || 'Unknown'}</span>
                    <span style={{ fontSize: 10, color: PROVIDER_COLORS[selectedChar.tts_provider || 'elevenlabs'], marginLeft: 8 }}>
                      {PROVIDER_LABELS[selectedChar.tts_provider || 'elevenlabs']}
                    </span>
                  </div>
                  <button onClick={async () => {
                    if (!bookId || !selectedChar) return;
                    await charsApi.update(bookId, selectedChar.id, { voice_id: null, voice_name: null });
                    const updated = { ...selectedChar, voice_id: null, voice_name: null };
                    setSelectedChar(updated as any);
                    setCharacterList(characterList.map((c) => (c.id === updated.id ? updated : c)) as any);
                  }} style={{ background: 'none', border: '1px solid rgba(239,68,68,0.15)', color: 'var(--danger)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <X size={10} /> Clear
                  </button>
                </div>
              )}

              {/* Provider tabs */}
              <div style={styles.providerTabs}>
                {configuredProviders.map((p) => (
                  <button key={p.name} onClick={() => setActiveProvider(p.name as TTSProviderName)}
                    style={{ ...styles.providerTab, ...(activeProvider === p.name ? { background: PROVIDER_COLORS[p.name as TTSProviderName] + '22', color: PROVIDER_COLORS[p.name as TTSProviderName], borderColor: PROVIDER_COLORS[p.name as TTSProviderName] + '44' } : {}) }}>
                    <Zap size={10} /> {p.displayName}
                  </button>
                ))}
              </div>

              {activeProvider === 'elevenlabs' ? (
                <>
                  {/* Voice ID lookup */}
                  <div style={styles.voiceIdRow}>
                    <Hash size={14} color="#9B59B6" />
                    <input value={voiceIdInput} onChange={(e) => setVoiceIdInput(e.target.value)}
                      placeholder="Paste ElevenLabs voice ID" style={styles.searchInput}
                      onKeyDown={(e) => e.key === 'Enter' && handleVoiceIdLookup()} aria-label="Voice ID" />
                    <button onClick={handleVoiceIdLookup} disabled={voiceIdLooking || !voiceIdInput.trim()} style={styles.lookupBtn}>
                      {voiceIdLooking ? <Loader size={12} /> : 'Lookup'}
                    </button>
                  </div>
                  {voiceIdResult && (
                    <div style={styles.voiceIdResult}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ color: '#ddd', fontSize: 13 }}>{voiceIdResult.name}</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {voiceIdResult.preview_url && (
                            <button onClick={() => new Audio(voiceIdResult.preview_url).play()} style={styles.previewBtn} title="Preview"><Play size={12} /></button>
                          )}
                          <button onClick={async () => {
                            if (voiceIdResult._isShared && voiceIdResult.public_owner_id) await assignSharedVoice(voiceIdResult);
                            else assignVoice(voiceIdResult.voice_id, voiceIdResult.name, 'elevenlabs');
                            setVoiceIdResult(null); setVoiceIdInput('');
                          }} style={styles.assignIdBtn}><CheckCircle size={12} /> Assign</button>
                        </div>
                      </div>
                    </div>
                  )}
                  {voiceIdError && <p style={{ color: '#e55', fontSize: 11 }}>{voiceIdError}</p>}

                  {/* My Voices / Library toggle */}
                  <div style={styles.voiceSearch}>
                    <Search size={14} color="#666" />
                    <input value={voiceSearch} onChange={(e) => setVoiceSearch(e.target.value)}
                      placeholder="Search voices..." style={styles.searchInput} aria-label="Search voices" />
                    <button onClick={handleLibrarySearch} style={{ ...styles.lookupBtn, background: '#9B59B6', fontSize: 10 }}>
                      <Globe size={10} /> Library
                    </button>
                  </div>

                  <div style={styles.voiceList}>
                    {/* Library results first if any */}
                    {libraryResults.length > 0 && (
                      <>
                        <div style={{ padding: '4px 12px', fontSize: 10, color: '#9B59B6', fontWeight: 600 }}>LIBRARY RESULTS</div>
                        {libraryResults.map((v) => (
                          <div key={v.voice_id} style={{ ...styles.voiceItem }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ color: '#ddd', fontSize: 13 }}>{v.name}</span>
                              <span style={{ color: '#9B59B6', fontSize: 9, marginLeft: 6, background: '#2a1a3a', padding: '1px 5px', borderRadius: 3 }}>shared</span>
                            </div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              {v.preview_url && <button onClick={(e) => { e.stopPropagation(); new Audio(v.preview_url).play(); }} style={styles.previewBtn}><Play size={12} /></button>}
                              <button onClick={() => assignSharedVoice(v)} style={styles.assignIdBtn}><CheckCircle size={12} /> Assign</button>
                            </div>
                          </div>
                        ))}
                        <div style={{ padding: '4px 12px', fontSize: 10, color: '#666', fontWeight: 600, marginTop: 8 }}>MY VOICES</div>
                      </>
                    )}
                    {filteredVoices.map((v) => (
                      <div key={v.voice_id} onClick={() => assignVoice(v.voice_id, v.name, 'elevenlabs')}
                        style={{ ...styles.voiceItem, background: selectedChar.voice_id === v.voice_id ? '#1a3a5c' : '#1a1a1a' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: '#ddd', fontSize: 13 }}>{v.name}</span>
                          <span style={{ color: '#555', fontSize: 10, marginLeft: 6, fontFamily: 'monospace' }}>{v.voice_id.slice(0, 8)}...</span>
                        </div>
                        <span style={{ color: '#666', fontSize: 11 }}>{v.category}</span>
                        {v.preview_url && (
                          <button onClick={(e) => { e.stopPropagation(); new Audio(v.preview_url!).play(); }} style={styles.previewBtn} aria-label={`Preview ${v.name}`}><Play size={12} /></button>
                        )}
                      </div>
                    ))}
                    {filteredVoices.length === 0 && <p style={{ color: '#555', fontSize: 12, padding: 12 }}>No voices found. Check your ElevenLabs API key.</p>}
                  </div>
                </>
              ) : (
                /* Other providers */
                <>
                  <div style={styles.voiceSearch}>
                    <Search size={14} color={PROVIDER_COLORS[activeProvider]} />
                    <input value={voiceSearch} onChange={(e) => setVoiceSearch(e.target.value)}
                      placeholder={`Search ${PROVIDER_LABELS[activeProvider]} voices...`} style={styles.searchInput} aria-label="Search voices" />
                  </div>
                  <div style={styles.voiceList}>
                    {loadingProviderVoices ? (
                      <div style={{ padding: 20, textAlign: 'center' }}><Loader size={16} color={PROVIDER_COLORS[activeProvider]} /></div>
                    ) : (
                      filteredProviderVoices.map((v: any) => (
                        <div key={v.voiceId} onClick={() => assignVoice(v.voiceId, v.name, activeProvider)}
                          style={{ ...styles.voiceItem, background: selectedChar.voice_id === v.voiceId && selectedChar.tts_provider === activeProvider ? '#1a3a5c' : '#1a1a1a' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ color: '#ddd', fontSize: 13 }}>{v.name}</span>
                            {v.gender && <span style={{ color: '#666', fontSize: 10, marginLeft: 6 }}>{v.gender}</span>}
                            {v.language && <span style={{ color: '#555', fontSize: 10, marginLeft: 4 }}>{v.language}</span>}
                          </div>
                          {v.category && <span style={{ color: PROVIDER_COLORS[activeProvider], fontSize: 10, background: PROVIDER_COLORS[activeProvider] + '15', padding: '1px 6px', borderRadius: 3 }}>{v.category}</span>}
                          {v.description && <span style={{ color: '#555', fontSize: 10, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.description}</span>}
                        </div>
                      ))
                    )}
                    {!loadingProviderVoices && filteredProviderVoices.length === 0 && (
                      <p style={{ color: '#555', fontSize: 12, padding: 12 }}>No voices available. Check your {PROVIDER_LABELS[activeProvider]} API key in Settings.</p>
                    )}
                  </div>
                </>
              )}
            </div>

            <div style={styles.section}>
              <label style={styles.sectionLabel}>2. Fine-tune Settings</label>
              <p style={styles.sectionHint}>Adjust voice parameters. Available settings depend on the TTS provider.</p>

              {(selectedChar.tts_provider || 'elevenlabs') === 'elevenlabs' && (
                <>
                  <label style={styles.label}>Model</label>
                  <select value={selectedChar.model_id} onChange={(e) => handleUpdate('model_id', e.target.value)} style={styles.input} aria-label="TTS model">
                    {models.map((m) => <option key={m.model_id} value={m.model_id}>{m.name || m.model_id}</option>)}
                    {models.length === 0 && <option value="eleven_v3">Eleven v3</option>}
                  </select>

                  <label style={styles.label}>Stability: {selectedChar.stability.toFixed(2)}</label>
                  <input type="range" min="0" max="1" step="0.05" value={selectedChar.stability}
                    onChange={(e) => handleUpdate('stability', parseFloat(e.target.value))} style={styles.slider} aria-label="Stability" />

                  <label style={styles.label}>Similarity: {selectedChar.similarity_boost.toFixed(2)}</label>
                  <input type="range" min="0" max="1" step="0.05" value={selectedChar.similarity_boost}
                    onChange={(e) => handleUpdate('similarity_boost', parseFloat(e.target.value))} style={styles.slider} aria-label="Similarity" />

                  <label style={styles.label}>Style: {selectedChar.style.toFixed(2)}</label>
                  <input type="range" min="0" max="1" step="0.05" value={selectedChar.style}
                    onChange={(e) => handleUpdate('style', parseFloat(e.target.value))} style={styles.slider} aria-label="Style" />

                  <label style={styles.checkLabel}>
                    <input type="checkbox" checked={!!selectedChar.speaker_boost}
                      onChange={(e) => handleUpdate('speaker_boost', e.target.checked ? 1 : 0)} />
                    Speaker Boost
                  </label>
                </>
              )}

              {(selectedChar.tts_provider || 'elevenlabs') === 'openai' && (
                <>
                  <label style={styles.label}>Model</label>
                  <select value={selectedChar.model_id} onChange={(e) => handleUpdate('model_id', e.target.value)} style={styles.input} aria-label="OpenAI TTS model">
                    <option value="gpt-4o-mini-tts">GPT-4o Mini TTS</option>
                    <option value="tts-1">TTS-1 (fast)</option>
                    <option value="tts-1-hd">TTS-1 HD (quality)</option>
                  </select>
                </>
              )}

              <label style={styles.label}>Speed: {selectedChar.speed.toFixed(2)}</label>
              <input type="range" min="0.5" max="2.0" step="0.05" value={selectedChar.speed}
                onChange={(e) => handleUpdate('speed', parseFloat(e.target.value))} style={styles.slider} aria-label="Speed" />
            </div>

            <div style={styles.section}>
              <label style={styles.sectionLabel}>3. Test Voice</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input id="preview-text" placeholder="Type sample text to preview..."
                  style={{ ...styles.input, flex: 1 }} aria-label="Preview text"
                  defaultValue="The quick brown fox jumps over the lazy dog." />
                <button onClick={async () => {
                  const input = document.getElementById('preview-text') as HTMLInputElement;
                  if (!input?.value || !selectedChar.voice_id) return;
                  try {
                    const provider = selectedChar.tts_provider || 'elevenlabs';
                    if (provider === 'elevenlabs') {
                      const result = await elevenlabs.tts({
                        text: input.value, voice_id: selectedChar.voice_id, model_id: selectedChar.model_id,
                        voice_settings: { stability: selectedChar.stability, similarity_boost: selectedChar.similarity_boost, style: selectedChar.style, use_speaker_boost: !!selectedChar.speaker_boost },
                        book_id: bookId,
                      });
                      new Audio(`/api/audio/${result.audio_asset_id}`).play();
                    } else {
                      const result = await ttsProviders.generate({
                        provider, text: input.value, voice_id: selectedChar.voice_id,
                        model_id: selectedChar.model_id, speed: selectedChar.speed, book_id: bookId,
                      });
                      new Audio(`/api/audio/${result.audio_asset_id}`).play();
                    }
                  } catch (err: any) { toast.error(`Preview failed: ${err.message}`); }
                }}
                  style={{ ...styles.submitBtn, opacity: selectedChar.voice_id ? 1 : 0.5 }}
                  disabled={!selectedChar.voice_id}>
                  <Play size={14} /> Preview
                </button>
              </div>
            </div>
          </>
        ) : (
          <div style={styles.emptySettings}>
            <p style={styles.emptyTitle}>← Select a character to configure its voice</p>
            <p style={styles.emptyHint}>
              Assign voices from ElevenLabs, OpenAI, Google Cloud TTS, or Amazon Polly.
              Configure API keys in Settings to enable providers.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', gap: 12, height: 'calc(100vh - 48px)', padding: 4 },
  charPanel: { width: 300, background: 'var(--bg-surface)', borderRadius: 14, overflow: 'auto', display: 'flex', flexDirection: 'column', border: '1px solid var(--border-subtle)' },
  panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' },
  title: { fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 },
  addBtn: { background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 11 },
  progressBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px', borderBottom: '1px solid var(--border-subtle)', gap: 6 },
  createForm: { padding: 14, display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' },
  input: { padding: '9px 14px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
  submitBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  cancelBtn: { padding: '9px 14px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer', fontSize: 12 },
  charItem: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px', cursor: 'pointer', position: 'relative' },
  charItemTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  delBtn: { position: 'absolute', right: 12, top: 12, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' },
  emptyState: { padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' },
  emptyTitle: { fontSize: 13, color: '#888' },
  emptyHint: { fontSize: 11, color: '#555', lineHeight: 1.5 },
  emptyBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12 },
  settingsPanel: { flex: 1, background: 'var(--bg-surface)', borderRadius: 14, overflow: 'auto', padding: 20, border: '1px solid var(--border-subtle)' },
  settingsHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  settingsRole: { fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '3px 10px', borderRadius: 20 },
  section: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 },
  sectionLabel: { fontSize: 12, color: 'var(--accent)', fontWeight: 600 },
  sectionHint: { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 },
  label: { fontSize: 11, color: '#888', marginTop: 4 },
  slider: { width: '100%', accentColor: 'var(--accent)' },
  checkLabel: { fontSize: 12, color: '#aaa', display: 'flex', alignItems: 'center', gap: 8 },
  providerTabs: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  providerTab: { display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 11, fontWeight: 500, background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 20, cursor: 'pointer' },
  voiceIdRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' },
  voiceIdResult: { padding: 10, background: '#1a2a1a', borderRadius: 8, border: '1px solid #2a3a2a' },
  voiceSearch: { display: 'flex', alignItems: 'center', gap: 8 },
  searchInput: { flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 12, outline: 'none' },
  lookupBtn: { display: 'flex', alignItems: 'center', gap: 4, padding: '7px 14px', background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' },
  voiceList: { maxHeight: 280, overflow: 'auto', borderRadius: 8, border: '1px solid var(--border-subtle)' },
  voiceItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #1a1a1a' },
  previewBtn: { background: 'none', border: '1px solid #333', color: '#888', borderRadius: 6, padding: '4px 6px', cursor: 'pointer', display: 'flex' },
  assignIdBtn: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#1a3a1a', color: '#8f8', border: '1px solid #2a4a2a', borderRadius: 6, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' },
  voiceTag: { fontSize: 9, color: '#888', background: '#1a1a1a', padding: '1px 5px', borderRadius: 3 },
  emptySettings: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, textAlign: 'center', padding: 40 },
  autoAssignBtn: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 14px', background: 'linear-gradient(135deg, #6C3483 0%, #4A90D9 100%)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 500, justifyContent: 'center' },
};
