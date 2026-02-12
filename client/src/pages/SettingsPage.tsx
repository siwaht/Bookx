import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { settings as settingsApi, elevenlabs } from '../services/api';
import { Key, Eye, EyeOff, Save, Trash2, Check, ArrowLeft, Wifi, WifiOff, Loader } from 'lucide-react';

interface ApiKeyConfig {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
}

const API_KEYS: ApiKeyConfig[] = [
  { key: 'elevenlabs_api_key', label: 'ElevenLabs', placeholder: 'xi-...', hint: 'Required for TTS, SFX, and music generation' },
  { key: 'deepgram_api_key', label: 'Deepgram', placeholder: 'dg-...', hint: 'For speech-to-text and transcription' },
  { key: 'openai_api_key', label: 'OpenAI', placeholder: 'sk-...', hint: 'GPT models for AI script parsing' },
  { key: 'mistral_api_key', label: 'Mistral', placeholder: 'mist-...', hint: 'Mistral models for AI script parsing' },
  { key: 'gemini_api_key', label: 'Google Gemini', placeholder: 'AIza...', hint: 'Gemini models for AI script parsing' },
];

const LLM_PROVIDERS = [
  { value: '', label: 'Auto-detect (use first available)' },
  { value: 'openai', label: 'OpenAI (GPT-4o-mini)' },
  { value: 'mistral', label: 'Mistral (Small)' },
  { value: 'gemini', label: 'Google Gemini (Flash)' },
];

export function SettingsPage() {
  const navigate = useNavigate();
  const [stored, setStored] = useState<Record<string, { masked: string; updated_at: string }>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [defaultProvider, setDefaultProvider] = useState('');
  const [connTest, setConnTest] = useState<{
    testing: boolean;
    result: null | { connected: boolean; error?: string; tier?: string; character_count?: number; character_limit?: number; key_last4?: string };
  }>({ testing: false, result: null });

  const testElevenLabsConnection = async () => {
    setConnTest({ testing: true, result: null });
    try {
      const result = await elevenlabs.testConnection();
      setConnTest({ testing: false, result });
    } catch (err: any) {
      setConnTest({ testing: false, result: { connected: false, error: err.message } });
    }
  };

  const load = async () => {
    try {
      const data = await settingsApi.getAll();
      setStored(data);
      if (data.default_llm_provider) {
        setDefaultProvider(data.default_llm_provider.masked || '');
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async (key: string) => {
    const value = inputs[key];
    if (!value?.trim()) return;
    setSaving(key);
    try {
      await settingsApi.set(key, value.trim());
      setInputs((p) => ({ ...p, [key]: '' }));
      setSaved(key);
      setTimeout(() => setSaved(null), 2000);
      load();
    } catch (err: any) {
      alert(`Failed to save: ${err.message}`);
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm('Remove this API key?')) return;
    await settingsApi.delete(key);
    load();
  };

  const handleProviderChange = async (value: string) => {
    setDefaultProvider(value);
    await settingsApi.set('default_llm_provider', value);
    load();
  };

  return (
    <div style={S.page}>
      <div style={S.container}>
        <button onClick={() => navigate('/')} style={S.backBtn}>
          <ArrowLeft size={16} /> Back to Projects
        </button>

        <h1 style={S.title}>⚙️ Settings</h1>
        <p style={S.subtitle}>Manage your API keys and preferences. Keys are stored locally in your database and never sent to third parties.</p>

        <div style={S.section}>
          <h2 style={S.sectionTitle}>API Keys</h2>
          <p style={S.sectionHint}>Add your API keys to enable AI features. At minimum, you need an ElevenLabs key for audio generation and one LLM key (OpenAI, Mistral, or Gemini) for AI script parsing.</p>

          {API_KEYS.map((cfg) => {
            const isStored = !!stored[cfg.key]?.masked;
            const isElevenLabs = cfg.key === 'elevenlabs_api_key';
            return (
              <div key={cfg.key} style={S.keyRow}>
                <div style={S.keyHeader}>
                  <Key size={14} style={{ color: '#4A90D9' }} />
                  <span style={S.keyLabel}>{cfg.label}</span>
                  {isStored && (
                    <span style={S.storedBadge}>
                      <Check size={10} /> {stored[cfg.key].masked}
                    </span>
                  )}
                </div>
                <p style={S.keyHint}>{cfg.hint}</p>
                <div style={S.keyInputRow}>
                  <div style={S.inputWrapper}>
                    <input
                      type={showKey[cfg.key] ? 'text' : 'password'}
                      value={inputs[cfg.key] || ''}
                      onChange={(e) => setInputs((p) => ({ ...p, [cfg.key]: e.target.value }))}
                      placeholder={isStored ? 'Enter new key to replace...' : cfg.placeholder}
                      style={S.input}
                      aria-label={`${cfg.label} API key`}
                    />
                    <button onClick={() => setShowKey((p) => ({ ...p, [cfg.key]: !p[cfg.key] }))}
                      style={S.eyeBtn} aria-label="Toggle visibility">
                      {showKey[cfg.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button onClick={() => handleSave(cfg.key)}
                    disabled={!inputs[cfg.key]?.trim() || saving === cfg.key}
                    style={{ ...S.saveBtn, ...(saved === cfg.key ? { background: '#2d5a27', color: '#8f8' } : {}) }}>
                    {saving === cfg.key ? 'Saving...' : saved === cfg.key ? 'Saved' : <><Save size={13} /> Save</>}
                  </button>
                  {isStored && (
                    <button onClick={() => handleDelete(cfg.key)} style={S.deleteBtn} title="Remove key">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>

                {/* ElevenLabs Connection Test */}
                {isElevenLabs && isStored && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <button onClick={testElevenLabsConnection} disabled={connTest.testing}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
                        background: '#1a2a3a', color: '#4A90D9', border: '1px solid #2a3a5a',
                        borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500, alignSelf: 'flex-start',
                      }}>
                      {connTest.testing ? <Loader size={13} /> : <Wifi size={13} />}
                      {connTest.testing ? 'Testing...' : 'Test Connection'}
                    </button>
                    {connTest.result && (
                      <div style={{
                        padding: 12, borderRadius: 8,
                        background: connTest.result.connected ? '#0a1a0a' : '#1a0a0a',
                        border: `1px solid ${connTest.result.connected ? '#1a3a1a' : '#3a1a1a'}`,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          {connTest.result.connected ? (
                            <>
                              <Wifi size={16} color="#4a4" />
                              <span style={{ color: '#8f8', fontSize: 13, fontWeight: 600 }}>Connected</span>
                            </>
                          ) : (
                            <>
                              <WifiOff size={16} color="#a44" />
                              <span style={{ color: '#f88', fontSize: 13, fontWeight: 600 }}>Connection Failed</span>
                            </>
                          )}
                        </div>
                        {connTest.result.connected ? (
                          <div style={{ fontSize: 11, color: '#888', lineHeight: 1.6 }}>
                            <div>Tier: <span style={{ color: '#aaa' }}>{connTest.result.tier}</span></div>
                            <div>Characters: <span style={{ color: '#aaa' }}>{connTest.result.character_count?.toLocaleString()} / {connTest.result.character_limit?.toLocaleString()}</span></div>
                            <div>Key: <span style={{ color: '#aaa' }}>{connTest.result.key_last4}</span></div>
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: '#f88', lineHeight: 1.6 }}>
                            {connTest.result.error}
                            {connTest.result.key_last4 && <div style={{ color: '#888', marginTop: 4 }}>Key used: {connTest.result.key_last4}</div>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={S.section}>
          <h2 style={S.sectionTitle}>Default LLM Provider</h2>
          <p style={S.sectionHint}>Choose which LLM to use for AI script parsing (character detection, segment assignment, SFX/music suggestions).</p>
          <select value={defaultProvider} onChange={(e) => handleProviderChange(e.target.value)}
            style={S.select} aria-label="Default LLM provider">
            {LLM_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { padding: '32px 40px', maxWidth: 800, margin: '0 auto', minHeight: '100vh' },
  container: { display: 'flex', flexDirection: 'column', gap: 32 },
  backBtn: {
    display: 'flex', alignItems: 'center', gap: 6, background: 'none',
    border: 'none', color: '#4A90D9', cursor: 'pointer', padding: 0, fontSize: 13,
    marginBottom: -16,
  },
  title: { fontSize: 24, color: '#e0e0e0' },
  subtitle: { fontSize: 13, color: '#555', lineHeight: 1.6, marginTop: 4 },
  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  sectionTitle: { fontSize: 16, color: '#4A90D9', fontWeight: 500 },
  sectionHint: { fontSize: 12, color: '#666', lineHeight: 1.5 },
  keyRow: {
    padding: 16, background: '#141414', borderRadius: 10,
    border: '1px solid #1e1e1e', display: 'flex', flexDirection: 'column', gap: 8,
  },
  keyHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  keyLabel: { fontSize: 14, color: '#ddd', fontWeight: 500 },
  storedBadge: {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
    color: '#6a6', background: '#1a2a1a', padding: '2px 8px', borderRadius: 4,
  },
  keyHint: { fontSize: 11, color: '#555' },
  keyInputRow: { display: 'flex', gap: 8, alignItems: 'center' },
  inputWrapper: { flex: 1, position: 'relative' as const },
  input: {
    width: '100%', padding: '10px 36px 10px 12px', borderRadius: 8,
    border: '1px solid #2a2a2a', background: '#0a0a0a', color: '#ddd',
    fontSize: 13, outline: 'none', fontFamily: 'monospace',
  },
  eyeBtn: {
    position: 'absolute' as const, right: 8, top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', color: '#555', cursor: 'pointer', padding: 4,
  },
  saveBtn: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 8,
    cursor: 'pointer', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' as const,
  },
  deleteBtn: {
    background: 'none', border: '1px solid #2a2222', color: '#a66',
    borderRadius: 6, cursor: 'pointer', padding: '6px 8px', display: 'flex',
  },
  select: {
    padding: '10px 14px', borderRadius: 8, border: '1px solid #2a2a2a',
    background: '#0a0a0a', color: '#ddd', fontSize: 13, outline: 'none', maxWidth: 320,
  },
};
