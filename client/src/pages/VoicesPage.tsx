import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { characters as charsApi, elevenlabs } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Character, ElevenLabsVoice } from '../types';
import { Plus, Search, Play, Trash2, Mic, CheckCircle, Hash, Loader, Globe, Library } from 'lucide-react';

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

  // Voice ID lookup
  const [voiceIdInput, setVoiceIdInput] = useState('');
  const [voiceIdLooking, setVoiceIdLooking] = useState(false);
  const [voiceIdResult, setVoiceIdResult] = useState<any | null>(null);
  const [voiceIdError, setVoiceIdError] = useState('');

  // Library search
  const [voiceTab, setVoiceTab] = useState<'my' | 'library'>('my');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryResults, setLibraryResults] = useState<any[]>([]);
  const [librarySearching, setLibrarySearching] = useState(false);
  const [libraryGender, setLibraryGender] = useState('');
  const [libraryLanguage, setLibraryLanguage] = useState('');

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
    } catch (err) { console.error('Failed to load voices (check ElevenLabs API key):', err); }
  };

  useEffect(() => { loadCharacters(); loadVoices(); }, [bookId]);

  const handleCreate = async () => {
    if (!bookId || !newName.trim()) return;
    const char = await charsApi.create(bookId, { name: newName, role: newRole });
    setNewName(''); setShowCreate(false);
    setCharacterList([...characterList, char]);
    setSelectedChar(char);
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

  // Assign voice by object (from search or ID lookup)
  const assignVoice = async (voiceId: string, voiceName: string) => {
    if (!bookId || !selectedChar) return;
    await charsApi.update(bookId, selectedChar.id, { voice_id: voiceId, voice_name: voiceName });
    const updated = { ...selectedChar, voice_id: voiceId, voice_name: voiceName };
    setSelectedChar(updated);
    setCharacterList(characterList.map((c) => (c.id === updated.id ? updated : c)));
  };

  // Look up voice by ID
  const handleVoiceIdLookup = async () => {
    const id = voiceIdInput.trim();
    if (!id) return;
    setVoiceIdLooking(true);
    setVoiceIdError('');
    setVoiceIdResult(null);
    try {
      const voice = await elevenlabs.getVoice(id);
      if (voice.sharing) {
        // Shared voice — user may need to add it to their library first
        setVoiceIdResult({ ...voice, _isShared: true });
      } else {
        setVoiceIdResult(voice);
      }
    } catch (err: any) {
      // Parse error message for cleaner display
      let msg = err.message || 'Voice not found';
      try {
        const parsed = JSON.parse(msg);
        msg = parsed.error || parsed.message || msg;
      } catch { /* not JSON, use as-is */ }
      setVoiceIdError(msg);
    } finally {
      setVoiceIdLooking(false);
    }
  };

  // Search the shared voice library
  const handleLibrarySearch = async () => {
    if (!libraryQuery.trim() && !libraryGender && !libraryLanguage) return;
    setLibrarySearching(true);
    try {
      const result = await elevenlabs.searchLibrary({
        q: libraryQuery.trim(),
        gender: libraryGender,
        language: libraryLanguage,
        page_size: 30,
      });
      setLibraryResults(result.voices || []);
    } catch (err: any) {
      alert(`Library search failed: ${err.message}`);
    } finally {
      setLibrarySearching(false);
    }
  };

  const filteredVoices = voiceSearch
    ? voices.filter((v) =>
        v.name.toLowerCase().includes(voiceSearch.toLowerCase()) ||
        v.voice_id.toLowerCase().includes(voiceSearch.toLowerCase())
      )
    : voices.slice(0, 20);

  const models = capabilities?.models || [];
  const charsWithVoice = characterList.filter((c) => c.voice_id);
  const charsWithoutVoice = characterList.filter((c) => !c.voice_id);

  return (
    <div style={styles.container}>
      {/* ── Left: Character List ── */}
      <div style={styles.charPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.title}>🎭 Characters</h3>
          <button onClick={() => setShowCreate(true)} style={styles.addBtn} title="Add a new character or narrator">
            <Plus size={16} />
          </button>
        </div>

        {/* Progress summary */}
        {characterList.length > 0 && (
          <div style={styles.progressBar}>
            <span style={{ fontSize: 11, color: charsWithoutVoice.length === 0 ? '#8f8' : '#888' }}>
              {charsWithVoice.length}/{characterList.length} voices assigned
            </span>
            {charsWithoutVoice.length === 0 && <CheckCircle size={12} color="#8f8" />}
          </div>
        )}

        {showCreate && (
          <div style={styles.createForm}>
            <p style={styles.formHint}>Add a narrator or character. You'll assign an ElevenLabs voice next.</p>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (e.g. Narrator, Alice)" style={styles.input} autoFocus aria-label="Character name" />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as any)} style={styles.input} aria-label="Character role">
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
            <p style={styles.emptyHint}>Create at least one character (usually a "Narrator") and assign an ElevenLabs voice to it.</p>
            <p style={styles.emptyHint}>Characters are used in Step 1 (Manuscript) to assign voices to text segments.</p>
            <button onClick={() => setShowCreate(true)} style={styles.emptyBtn}>
              <Plus size={14} /> Create First Character
            </button>
          </div>
        )}
      </div>

      {/* ── Right: Voice Settings ── */}
      <div style={styles.settingsPanel}>
        {selectedChar ? (
          <>
            <div style={styles.settingsHeader}>
              <h3 style={styles.title}>{selectedChar.name}</h3>
              <span style={styles.settingsRole}>{selectedChar.role}</span>
            </div>

            <div style={styles.section}>
              <label style={styles.sectionLabel}>1. Choose a Voice</label>
              <p style={styles.sectionHint}>Search by name or paste a voice ID directly from ElevenLabs.</p>

              {/* Voice ID lookup */}
              <div style={styles.voiceIdRow}>
                <Hash size={14} color="#9B59B6" />
                <input value={voiceIdInput} onChange={(e) => setVoiceIdInput(e.target.value)}
                  placeholder="Paste voice ID (e.g. 21m00Tcm4TlvDq8ikWAM)"
                  style={styles.searchInput}
                  onKeyDown={(e) => e.key === 'Enter' && handleVoiceIdLookup()}
                  aria-label="Voice ID" />
                <button onClick={handleVoiceIdLookup} disabled={voiceIdLooking || !voiceIdInput.trim()}
                  style={styles.lookupBtn}>
                  {voiceIdLooking ? <Loader size={12} /> : 'Lookup'}
                </button>
              </div>
              {voiceIdResult && (
                <div style={styles.voiceIdResult}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <span style={{ color: '#ddd', fontSize: 13 }}>{voiceIdResult.name}</span>
                      <span style={{ color: '#666', fontSize: 11, marginLeft: 8 }}>{voiceIdResult.category || ''}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {voiceIdResult.preview_url && (
                        <button onClick={() => new Audio(voiceIdResult.preview_url).play()}
                          style={styles.previewBtn} title="Preview"><Play size={12} /></button>
                      )}
                      <button onClick={() => {
                        assignVoice(voiceIdResult.voice_id, voiceIdResult.name);
                        setVoiceIdResult(null); setVoiceIdInput('');
                      }} style={styles.assignIdBtn}>
                        <CheckCircle size={12} /> Assign
                      </button>
                    </div>
                  </div>
                  {voiceIdResult._isShared && (
                    <p style={{ fontSize: 10, color: '#D97A4A', marginTop: 4 }}>
                      This is a shared/community voice. You can assign it, but you may need to add it to your ElevenLabs library for TTS to work.
                    </p>
                  )}
                  {voiceIdResult.labels && Object.keys(voiceIdResult.labels).length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                      {Object.entries(voiceIdResult.labels).map(([k, v]) => (
                        <span key={k} style={styles.voiceTag}>{k}: {v as string}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {voiceIdError && <p style={{ color: '#e55', fontSize: 11 }}>{voiceIdError}</p>}

              {/* Voice source tabs */}
              <div style={styles.voiceTabs}>
                <button onClick={() => setVoiceTab('my')}
                  style={{ ...styles.voiceTabBtn, ...(voiceTab === 'my' ? styles.voiceTabActive : {}) }}>
                  <Mic size={12} /> My Voices ({voices.length})
                </button>
                <button onClick={() => setVoiceTab('library')}
                  style={{ ...styles.voiceTabBtn, ...(voiceTab === 'library' ? styles.voiceTabActive : {}) }}>
                  <Globe size={12} /> Voice Library
                </button>
              </div>

              {voiceTab === 'my' ? (
                <>
                  {/* Name search (my voices) */}
                  <div style={styles.voiceSearch}>
                    <Search size={14} color="#666" />
                    <input value={voiceSearch} onChange={(e) => setVoiceSearch(e.target.value)}
                      placeholder="Search your voices by name or ID..." style={styles.searchInput} aria-label="Search voices" />
                  </div>
                  <div style={styles.voiceList}>
                    {filteredVoices.map((v) => (
                      <div key={v.voice_id}
                        onClick={() => assignVoice(v.voice_id, v.name)}
                        style={{ ...styles.voiceItem, background: selectedChar.voice_id === v.voice_id ? '#1a3a5c' : '#1a1a1a', borderLeft: selectedChar.voice_id === v.voice_id ? '3px solid #4A90D9' : '3px solid transparent' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: '#ddd', fontSize: 13 }}>{v.name}</span>
                          <span style={{ color: '#555', fontSize: 10, marginLeft: 6, fontFamily: 'monospace' }}>{v.voice_id.slice(0, 8)}...</span>
                        </div>
                        <span style={{ color: '#666', fontSize: 11 }}>{v.category}</span>
                        {v.preview_url && (
                          <button onClick={(e) => { e.stopPropagation(); new Audio(v.preview_url!).play(); }}
                            style={styles.previewBtn} aria-label={`Preview ${v.name}`} title="Preview this voice">
                            <Play size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                    {filteredVoices.length === 0 && (
                      <p style={{ color: '#555', fontSize: 12, padding: 12 }}>
                        {voiceSearch ? 'No voices match. Try the Voice Library tab or paste a voice ID.' : 'No voices loaded. Check your ElevenLabs API key.'}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Library search */}
                  <div style={styles.voiceSearch}>
                    <Search size={14} color="#9B59B6" />
                    <input value={libraryQuery} onChange={(e) => setLibraryQuery(e.target.value)}
                      placeholder="Search voices by name, accent, style..."
                      style={styles.searchInput}
                      onKeyDown={(e) => e.key === 'Enter' && handleLibrarySearch()}
                      aria-label="Search voice library" />
                    <button onClick={handleLibrarySearch} disabled={librarySearching}
                      style={{ ...styles.lookupBtn, background: '#9B59B6' }}>
                      {librarySearching ? <Loader size={12} /> : 'Search'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, padding: '0 0 4px' }}>
                    <select value={libraryGender} onChange={(e) => setLibraryGender(e.target.value)}
                      style={{ ...styles.filterSelect }} aria-label="Filter by gender">
                      <option value="">Any gender</option>
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="neutral">Neutral</option>
                    </select>
                    <select value={libraryLanguage} onChange={(e) => setLibraryLanguage(e.target.value)}
                      style={{ ...styles.filterSelect }} aria-label="Filter by language">
                      <option value="">Any language</option>
                      <option value="en">English</option>
                      <option value="es">Spanish</option>
                      <option value="fr">French</option>
                      <option value="de">German</option>
                      <option value="it">Italian</option>
                      <option value="pt">Portuguese</option>
                      <option value="ja">Japanese</option>
                      <option value="ko">Korean</option>
                      <option value="zh">Chinese</option>
                    </select>
                  </div>
                  <div style={styles.voiceList}>
                    {libraryResults.map((v) => (
                      <div key={v.voice_id} style={{ ...styles.voiceItem, background: selectedChar.voice_id === v.voice_id ? '#1a3a5c' : '#1a1a1a', borderLeft: selectedChar.voice_id === v.voice_id ? '3px solid #4A90D9' : '3px solid transparent' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: '#ddd', fontSize: 13 }}>{v.name}</span>
                            <span style={{ color: '#9B59B6', fontSize: 9, background: '#2a1a3a', padding: '1px 5px', borderRadius: 3 }}>shared</span>
                          </div>
                          {v.description && <span style={{ color: '#555', fontSize: 10, display: 'block', marginTop: 2 }}>{v.description.slice(0, 80)}{v.description.length > 80 ? '...' : ''}</span>}
                          {v.labels && Object.keys(v.labels).length > 0 && (
                            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
                              {Object.entries(v.labels).slice(0, 5).map(([k, val]) => (
                                <span key={k} style={styles.voiceTag}>{k}: {val as string}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                          {v.preview_url && (
                            <button onClick={(e) => { e.stopPropagation(); new Audio(v.preview_url).play(); }}
                              style={styles.previewBtn} aria-label={`Preview ${v.name}`} title="Preview">
                              <Play size={12} />
                            </button>
                          )}
                          <button onClick={() => assignVoice(v.voice_id, v.name)}
                            style={styles.assignIdBtn} title="Assign this voice">
                            <CheckCircle size={12} /> Assign
                          </button>
                        </div>
                      </div>
                    ))}
                    {libraryResults.length === 0 && !librarySearching && (
                      <p style={{ color: '#555', fontSize: 12, padding: 12, textAlign: 'center' }}>
                        Search the ElevenLabs community voice library. Try "deep narrator", "young female", etc.
                      </p>
                    )}
                    {librarySearching && (
                      <div style={{ padding: 20, textAlign: 'center' }}>
                        <Loader size={16} color="#9B59B6" />
                        <p style={{ color: '#888', fontSize: 11, marginTop: 6 }}>Searching library...</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div style={styles.section}>
              <label style={styles.sectionLabel}>2. Fine-tune Settings</label>
              <p style={styles.sectionHint}>Adjust voice parameters. Defaults work well for most cases.</p>

              <label style={styles.label}>Model</label>
              <select value={selectedChar.model_id} onChange={(e) => handleUpdate('model_id', e.target.value)}
                style={styles.input} aria-label="TTS model">
                {models.map((m) => <option key={m.model_id} value={m.model_id}>{m.name || m.model_id}</option>)}
                {models.length === 0 && <option value="eleven_v3">Eleven v3</option>}
              </select>

              <label style={styles.label}>Stability: {selectedChar.stability.toFixed(2)}</label>
              <input type="range" min="0" max="1" step="0.05" value={selectedChar.stability}
                onChange={(e) => handleUpdate('stability', parseFloat(e.target.value))} style={styles.slider} aria-label="Stability" />

              <label style={styles.label}>Similarity: {selectedChar.similarity_boost.toFixed(2)}</label>
              <input type="range" min="0" max="1" step="0.05" value={selectedChar.similarity_boost}
                onChange={(e) => handleUpdate('similarity_boost', parseFloat(e.target.value))} style={styles.slider} aria-label="Similarity boost" />

              <label style={styles.label}>Style: {selectedChar.style.toFixed(2)}</label>
              <input type="range" min="0" max="1" step="0.05" value={selectedChar.style}
                onChange={(e) => handleUpdate('style', parseFloat(e.target.value))} style={styles.slider} aria-label="Style exaggeration" />

              <label style={styles.label}>Speed: {selectedChar.speed.toFixed(2)}</label>
              <input type="range" min="0.5" max="2.0" step="0.05" value={selectedChar.speed}
                onChange={(e) => handleUpdate('speed', parseFloat(e.target.value))} style={styles.slider} aria-label="Speed" />

              <label style={styles.checkLabel}>
                <input type="checkbox" checked={!!selectedChar.speaker_boost}
                  onChange={(e) => handleUpdate('speaker_boost', e.target.checked ? 1 : 0)} />
                Speaker Boost
              </label>
            </div>

            <div style={styles.section}>
              <label style={styles.sectionLabel}>3. Test Voice</label>
              <p style={styles.sectionHint}>Preview how this voice sounds with your settings before generating the full book.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input id="preview-text" placeholder="Type sample text to preview..."
                  style={{ ...styles.input, flex: 1 }} aria-label="Preview text"
                  defaultValue="The quick brown fox jumps over the lazy dog." />
                <button onClick={async () => {
                    const input = document.getElementById('preview-text') as HTMLInputElement;
                    if (!input?.value || !selectedChar.voice_id) return;
                    try {
                      const result = await elevenlabs.tts({
                        text: input.value, voice_id: selectedChar.voice_id, model_id: selectedChar.model_id,
                        voice_settings: { stability: selectedChar.stability, similarity_boost: selectedChar.similarity_boost, style: selectedChar.style, use_speaker_boost: !!selectedChar.speaker_boost },
                        book_id: bookId,
                      });
                      new Audio(`/api/audio/${result.audio_asset_id}`).play();
                    } catch (err: any) { alert(`Preview failed: ${err.message}`); }
                  }}
                  style={{ ...styles.submitBtn, opacity: selectedChar.voice_id ? 1 : 0.5 }}
                  disabled={!selectedChar.voice_id} title={selectedChar.voice_id ? 'Generate and play preview' : 'Select a voice first'}>
                  <Play size={14} /> Preview
                </button>
              </div>
            </div>
          </>
        ) : (
          <div style={styles.emptySettings}>
            <p style={styles.emptyTitle}>← Select a character to configure its voice</p>
            <p style={styles.emptyHint}>Each character needs an ElevenLabs voice assigned. You can fine-tune stability, similarity, style, and speed.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', gap: 16, height: 'calc(100vh - 48px)' },
  charPanel: { width: 300, background: '#1a1a1a', borderRadius: 12, overflow: 'auto', display: 'flex', flexDirection: 'column' },
  panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #222' },
  title: { fontSize: 14, color: '#fff' },
  addBtn: { background: '#333', border: 'none', color: '#aaa', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' },
  progressBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px', borderBottom: '1px solid #222', gap: 6 },
  createForm: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid #222', background: '#151515' },
  formHint: { fontSize: 11, color: '#555', lineHeight: 1.4 },
  input: { padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0f0f0f', color: '#fff', fontSize: 13, outline: 'none' },
  submitBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  cancelBtn: { padding: '8px 12px', background: '#1e1e1e', color: '#888', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  charItem: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px', cursor: 'pointer', position: 'relative' },
  charItemTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  delBtn: { position: 'absolute', right: 12, top: 12, background: 'none', border: 'none', color: '#555', cursor: 'pointer' },
  emptyState: { padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', flex: 1, justifyContent: 'center' },
  emptyTitle: { fontSize: 14, color: '#888', fontWeight: 500 },
  emptyHint: { fontSize: 12, color: '#555', lineHeight: 1.5, maxWidth: 260 },
  emptyBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, marginTop: 8 },
  settingsPanel: { flex: 1, background: '#1a1a1a', borderRadius: 12, padding: 20, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 },
  settingsHeader: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, paddingBottom: 12, borderBottom: '1px solid #222' },
  settingsRole: { fontSize: 12, color: '#666', background: '#222', padding: '2px 8px', borderRadius: 4 },
  section: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0', borderBottom: '1px solid #1e1e1e' },
  sectionLabel: { fontSize: 13, color: '#4A90D9', fontWeight: 500 },
  sectionHint: { fontSize: 11, color: '#555', lineHeight: 1.4, marginBottom: 4 },
  label: { fontSize: 12, color: '#888', marginTop: 4 },
  checkLabel: { fontSize: 13, color: '#aaa', display: 'flex', alignItems: 'center', gap: 8 },
  slider: { width: '100%', accentColor: '#4A90D9' },
  voiceSearch: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#0f0f0f', borderRadius: 6, border: '1px solid #333' },
  searchInput: { flex: 1, background: 'transparent', border: 'none', color: '#fff', outline: 'none', fontSize: 13 },
  voiceIdRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#0f0f0f', borderRadius: 6, border: '1px solid #3a2a5a' },
  lookupBtn: {
    padding: '4px 12px', background: '#9B59B6', color: '#fff', border: 'none',
    borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' as const,
    display: 'flex', alignItems: 'center', gap: 4,
  },
  voiceIdResult: {
    padding: 10, background: '#1a1a2a', borderRadius: 6, border: '1px solid #3a2a5a',
  },
  assignIdBtn: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px',
    background: '#2d5a27', color: '#8f8', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11,
  },
  voiceTag: { fontSize: 9, color: '#888', background: '#222', padding: '1px 6px', borderRadius: 3 },
  voiceList: { maxHeight: 200, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
  voiceItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#ddd' },
  previewBtn: { background: 'none', border: 'none', color: '#4A90D9', cursor: 'pointer', padding: 4 },
  voiceTabs: { display: 'flex', gap: 4, marginTop: 4 },
  voiceTabBtn: {
    display: 'flex', alignItems: 'center', gap: 5, flex: 1, padding: '6px 10px',
    background: '#222', color: '#888', border: '1px solid #333', borderRadius: 6,
    cursor: 'pointer', fontSize: 11, justifyContent: 'center',
  },
  voiceTabActive: { background: '#1a2a3a', color: '#4A90D9', borderColor: '#4A90D9' },
  filterSelect: {
    flex: 1, padding: '4px 8px', background: '#0f0f0f', color: '#aaa', border: '1px solid #333',
    borderRadius: 4, fontSize: 11, outline: 'none',
  },
  emptySettings: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center' },
};
