import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { characters as charsApi, elevenlabs } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Character, ElevenLabsVoice } from '../types';
import { Plus, Search, Play, Trash2 } from 'lucide-react';

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

  const loadCharacters = async () => {
    if (!bookId) return;
    try {
      const data = await charsApi.list(bookId);
      setCharacterList(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load characters:', err);
    }
  };

  const loadVoices = async () => {
    try {
      const data = await elevenlabs.voices();
      setVoices(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load voices (check ElevenLabs API key):', err);
    }
  };

  useEffect(() => { loadCharacters(); loadVoices(); }, [bookId]);

  const handleCreate = async () => {
    if (!bookId || !newName.trim()) return;
    const char = await charsApi.create(bookId, { name: newName, role: newRole });
    setNewName('');
    setShowCreate(false);
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

  const filteredVoices = voiceSearch
    ? voices.filter((v) => v.name.toLowerCase().includes(voiceSearch.toLowerCase()))
    : voices.slice(0, 20);

  const models = capabilities?.models || [];

  return (
    <div style={styles.container}>
      <div style={styles.charPanel}>
        <div style={styles.panelHeader}>
          <h3 style={styles.title}>Characters</h3>
          <button onClick={() => setShowCreate(true)} style={styles.addBtn}><Plus size={16} /></button>
        </div>

        {showCreate && (
          <div style={styles.createForm}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" style={styles.input} aria-label="Character name" />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as any)} style={styles.input} aria-label="Character role">
              <option value="narrator">Narrator</option>
              <option value="character">Character</option>
            </select>
            <button onClick={handleCreate} style={styles.submitBtn}>Add</button>
          </div>
        )}

        {characterList.map((char) => (
          <div
            key={char.id}
            onClick={() => setSelectedChar(char)}
            style={{
              ...styles.charItem,
              background: selectedChar?.id === char.id ? '#2a2a2a' : 'transparent',
              borderLeft: `3px solid ${selectedChar?.id === char.id ? '#4A90D9' : 'transparent'}`,
            }}
          >
            <span style={{ color: '#ddd', fontSize: 14 }}>{char.name}</span>
            <span style={{ color: '#666', fontSize: 11 }}>{char.role} {char.voice_name ? `• ${char.voice_name}` : ''}</span>
            <button onClick={(e) => { e.stopPropagation(); handleDelete(char.id); }} style={styles.delBtn} aria-label={`Delete ${char.name}`}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div style={styles.settingsPanel}>
        {selectedChar ? (
          <>
            <h3 style={styles.title}>{selectedChar.name} — Voice Settings</h3>

            <label style={styles.label}>Voice</label>
            <div style={styles.voiceSearch}>
              <Search size={14} color="#666" />
              <input
                value={voiceSearch} onChange={(e) => setVoiceSearch(e.target.value)}
                placeholder="Search voices..." style={styles.searchInput}
                aria-label="Search voices"
              />
            </div>
            <div style={styles.voiceList}>
              {filteredVoices.map((v) => (
                <div
                  key={v.voice_id}
                  onClick={() => { handleUpdate('voice_id', v.voice_id); handleUpdate('voice_name', v.name); }}
                  style={{
                    ...styles.voiceItem,
                    background: selectedChar.voice_id === v.voice_id ? '#1a3a5c' : '#1a1a1a',
                  }}
                >
                  <span>{v.name}</span>
                  <span style={{ color: '#666', fontSize: 11 }}>{v.category}</span>
                  {v.preview_url && (
                    <button
                      onClick={(e) => { e.stopPropagation(); new Audio(v.preview_url!).play(); }}
                      style={styles.previewBtn} aria-label={`Preview ${v.name}`}
                    >
                      <Play size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <label style={styles.label}>Model</label>
            <select
              value={selectedChar.model_id}
              onChange={(e) => handleUpdate('model_id', e.target.value)}
              style={styles.input}
              aria-label="TTS model"
            >
              {models.map((m) => (
                <option key={m.model_id} value={m.model_id}>{m.name || m.model_id}</option>
              ))}
              {models.length === 0 && <option value="eleven_v3">Eleven v3</option>}
            </select>

            <label style={styles.label}>Stability: {selectedChar.stability.toFixed(2)}</label>
            <input type="range" min="0" max="1" step="0.05" value={selectedChar.stability}
              onChange={(e) => handleUpdate('stability', parseFloat(e.target.value))} style={styles.slider}
              aria-label="Stability" />

            <label style={styles.label}>Similarity: {selectedChar.similarity_boost.toFixed(2)}</label>
            <input type="range" min="0" max="1" step="0.05" value={selectedChar.similarity_boost}
              onChange={(e) => handleUpdate('similarity_boost', parseFloat(e.target.value))} style={styles.slider}
              aria-label="Similarity boost" />

            <label style={styles.label}>Style: {selectedChar.style.toFixed(2)}</label>
            <input type="range" min="0" max="1" step="0.05" value={selectedChar.style}
              onChange={(e) => handleUpdate('style', parseFloat(e.target.value))} style={styles.slider}
              aria-label="Style exaggeration" />

            <label style={styles.label}>Speed: {selectedChar.speed.toFixed(2)}</label>
            <input type="range" min="0.5" max="2.0" step="0.05" value={selectedChar.speed}
              onChange={(e) => handleUpdate('speed', parseFloat(e.target.value))} style={styles.slider}
              aria-label="Speed" />

            <label style={styles.checkLabel}>
              <input type="checkbox" checked={!!selectedChar.speaker_boost}
                onChange={(e) => handleUpdate('speaker_boost', e.target.checked ? 1 : 0)} />
              Speaker Boost
            </label>

            <div style={{ marginTop: 16, borderTop: '1px solid #222', paddingTop: 12 }}>
              <label style={styles.label}>Test Voice</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                  id="preview-text"
                  placeholder="Type sample text to preview..."
                  style={{ ...styles.input, flex: 1 }}
                  aria-label="Preview text"
                  defaultValue="The quick brown fox jumps over the lazy dog."
                />
                <button
                  onClick={async () => {
                    const input = document.getElementById('preview-text') as HTMLInputElement;
                    if (!input?.value || !selectedChar.voice_id) return;
                    try {
                      const result = await elevenlabs.tts({
                        text: input.value,
                        voice_id: selectedChar.voice_id,
                        model_id: selectedChar.model_id,
                        voice_settings: {
                          stability: selectedChar.stability,
                          similarity_boost: selectedChar.similarity_boost,
                          style: selectedChar.style,
                          use_speaker_boost: !!selectedChar.speaker_boost,
                        },
                        book_id: bookId,
                      });
                      const audio = new Audio(`/api/audio/${result.audio_asset_id}`);
                      audio.play();
                    } catch (err: any) {
                      alert(`Preview failed: ${err.message}`);
                    }
                  }}
                  style={styles.submitBtn}
                  disabled={!selectedChar.voice_id}
                >
                  Preview
                </button>
              </div>
            </div>
          </>
        ) : (
          <p style={{ color: '#555' }}>Select a character to configure voice settings</p>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', gap: 16, height: 'calc(100vh - 48px)' },
  charPanel: { width: 280, background: '#1a1a1a', borderRadius: 12, overflow: 'auto' },
  panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #222' },
  title: { fontSize: 14, color: '#fff' },
  addBtn: { background: '#333', border: 'none', color: '#aaa', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' },
  createForm: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid #222' },
  input: { padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0f0f0f', color: '#fff', fontSize: 13, outline: 'none' },
  submitBtn: { padding: '8px 12px', background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  charItem: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px', cursor: 'pointer', position: 'relative' },
  delBtn: { position: 'absolute', right: 12, top: 12, background: 'none', border: 'none', color: '#555', cursor: 'pointer' },
  settingsPanel: { flex: 1, background: '#1a1a1a', borderRadius: 12, padding: 20, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 },
  label: { fontSize: 12, color: '#888', marginTop: 8 },
  checkLabel: { fontSize: 13, color: '#aaa', display: 'flex', alignItems: 'center', gap: 8 },
  slider: { width: '100%', accentColor: '#4A90D9' },
  voiceSearch: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#0f0f0f', borderRadius: 6, border: '1px solid #333' },
  searchInput: { flex: 1, background: 'transparent', border: 'none', color: '#fff', outline: 'none', fontSize: 13 },
  voiceList: { maxHeight: 200, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
  voiceItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#ddd' },
  previewBtn: { background: 'none', border: 'none', color: '#4A90D9', cursor: 'pointer', padding: 4 },
};
