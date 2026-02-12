import React, { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { pronunciation, characters as charsApi } from '../services/api';
import type { Character } from '../types';
import { Plus, Trash2, Check, X, BookOpen, Edit3 } from 'lucide-react';

interface PronunciationRule {
  id: string;
  word: string;
  phoneme: string | null;
  alias: string | null;
  character_id: string | null;
  character_name: string | null;
}

export function PronunciationPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [rules, setRules] = useState<PronunciationRule[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [word, setWord] = useState('');
  const [phoneme, setPhoneme] = useState('');
  const [alias, setAlias] = useState('');
  const [charId, setCharId] = useState('');
  const [mode, setMode] = useState<'alias' | 'phoneme'>('alias');

  // Test state
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState('');
  const [testCharId, setTestCharId] = useState('');

  const load = useCallback(async () => {
    if (!bookId) return;
    const [r, c] = await Promise.all([pronunciation.list(bookId), charsApi.list(bookId)]);
    setRules(r);
    setCharacters(c);
  }, [bookId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!bookId || !word.trim()) return;
    if (mode === 'alias' && !alias.trim()) return;
    if (mode === 'phoneme' && !phoneme.trim()) return;
    await pronunciation.create(bookId, {
      word: word.trim(),
      phoneme: mode === 'phoneme' ? phoneme.trim() : undefined,
      alias: mode === 'alias' ? alias.trim() : undefined,
      character_id: charId || undefined,
    });
    resetForm();
    load();
  };

  const handleUpdate = async (ruleId: string) => {
    if (!bookId || !word.trim()) return;
    await pronunciation.update(bookId, ruleId, {
      word: word.trim(),
      phoneme: mode === 'phoneme' ? phoneme.trim() || null : null,
      alias: mode === 'alias' ? alias.trim() || null : null,
      character_id: charId || null,
    });
    resetForm();
    load();
  };

  const handleDelete = async (ruleId: string) => {
    if (!bookId || !confirm('Delete this pronunciation rule?')) return;
    await pronunciation.delete(bookId, ruleId);
    load();
  };

  const handleTest = async () => {
    if (!bookId || !testText.trim()) return;
    const result = await pronunciation.apply(bookId, testText, testCharId || undefined);
    setTestResult(result.processed);
  };

  const startEdit = (rule: PronunciationRule) => {
    setEditingId(rule.id);
    setWord(rule.word);
    setPhoneme(rule.phoneme || '');
    setAlias(rule.alias || '');
    setCharId(rule.character_id || '');
    setMode(rule.alias ? 'alias' : 'phoneme');
    setAdding(false);
  };

  const resetForm = () => {
    setAdding(false);
    setEditingId(null);
    setWord('');
    setPhoneme('');
    setAlias('');
    setCharId('');
  };

  return (
    <div style={S.container}>
      <div style={S.main}>
        <div style={S.header}>
          <h2 style={S.title}>📝 Pronunciation Rules</h2>
          <p style={S.subtitle}>Define how specific words should be pronounced. Use aliases for simple replacements or IPA phonemes for precise control.</p>
        </div>

        <div style={S.toolbar}>
          <button onClick={() => { resetForm(); setAdding(true); }} style={S.addBtn}>
            <Plus size={13} /> Add Rule
          </button>
          <span style={S.count}>{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
        </div>

        {/* Add/Edit form */}
        {(adding || editingId) && (
          <div style={S.form}>
            <div style={S.formRow}>
              <div style={S.field}>
                <label style={S.label}>Word / Phrase</label>
                <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="e.g. Hermione"
                  style={S.input} autoFocus aria-label="Word or phrase" />
              </div>
              <div style={S.field}>
                <label style={S.label}>Type</label>
                <div style={S.modeToggle}>
                  <button onClick={() => setMode('alias')}
                    style={{ ...S.modeBtn, ...(mode === 'alias' ? S.modeBtnActive : {}) }}>Alias</button>
                  <button onClick={() => setMode('phoneme')}
                    style={{ ...S.modeBtn, ...(mode === 'phoneme' ? S.modeBtnActive : {}) }}>IPA Phoneme</button>
                </div>
              </div>
            </div>
            <div style={S.formRow}>
              {mode === 'alias' ? (
                <div style={S.field}>
                  <label style={S.label}>Reads as (alias)</label>
                  <input value={alias} onChange={(e) => setAlias(e.target.value)}
                    placeholder="e.g. Her-my-oh-nee" style={S.input} aria-label="Alias pronunciation" />
                  <span style={S.hint}>The text that will replace the word before TTS</span>
                </div>
              ) : (
                <div style={S.field}>
                  <label style={S.label}>IPA Phoneme</label>
                  <input value={phoneme} onChange={(e) => setPhoneme(e.target.value)}
                    placeholder="e.g. hɜːˈmaɪ.ə.niː" style={S.input} aria-label="IPA phoneme" />
                  <span style={S.hint}>International Phonetic Alphabet notation</span>
                </div>
              )}
              <div style={S.field}>
                <label style={S.label}>Character (optional)</label>
                <select value={charId} onChange={(e) => setCharId(e.target.value)} style={S.select}
                  aria-label="Character scope">
                  <option value="">All characters (global)</option>
                  {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <span style={S.hint}>Apply only to a specific character's lines</span>
              </div>
            </div>
            <div style={S.formActions}>
              {editingId ? (
                <button onClick={() => handleUpdate(editingId)} style={S.saveBtn}><Check size={12} /> Update</button>
              ) : (
                <button onClick={handleAdd} style={S.saveBtn} disabled={!word.trim()}><Check size={12} /> Add</button>
              )}
              <button onClick={resetForm} style={S.cancelBtn}><X size={12} /> Cancel</button>
            </div>
          </div>
        )}

        {/* Rules list */}
        <div style={S.list}>
          {rules.map((rule) => (
            <div key={rule.id} style={S.ruleRow}>
              <div style={S.ruleWord}>{rule.word}</div>
              <div style={S.ruleArrow}>→</div>
              <div style={S.ruleValue}>
                {rule.alias ? (
                  <span style={S.aliasTag}>alias: {rule.alias}</span>
                ) : (
                  <span style={S.phonemeTag}>IPA: {rule.phoneme}</span>
                )}
              </div>
              {rule.character_name && (
                <span style={S.charTag}>{rule.character_name}</span>
              )}
              {!rule.character_id && (
                <span style={S.globalTag}>global</span>
              )}
              <div style={S.ruleActions}>
                <button onClick={() => startEdit(rule)} style={S.iconBtn}><Edit3 size={12} /></button>
                <button onClick={() => handleDelete(rule.id)} style={S.iconBtn}><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
          {rules.length === 0 && !adding && (
            <div style={S.empty}>
              <BookOpen size={24} color="#444" />
              <p style={{ color: '#888', fontSize: 13 }}>No pronunciation rules yet</p>
              <p style={{ color: '#555', fontSize: 11 }}>Add rules for character names, place names, or any words the TTS mispronounces.</p>
            </div>
          )}
        </div>
      </div>

      {/* Test panel */}
      <div style={S.testPanel}>
        <h3 style={S.testTitle}>🔊 Test Rules</h3>
        <p style={S.testHint}>Paste text to see how pronunciation rules will transform it before TTS.</p>
        <select value={testCharId} onChange={(e) => setTestCharId(e.target.value)} style={S.select}
          aria-label="Test character">
          <option value="">All rules (global)</option>
          {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <textarea value={testText} onChange={(e) => setTestText(e.target.value)}
          placeholder="Type or paste text here..." style={S.testInput} rows={4} aria-label="Test text" />
        <button onClick={handleTest} disabled={!testText.trim() || rules.length === 0} style={S.testBtn}>
          Apply Rules
        </button>
        {testResult && (
          <div style={S.testResult}>
            <label style={S.label}>Result:</label>
            <div style={S.resultBox}>{testResult}</div>
          </div>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: { display: 'flex', height: 'calc(100vh - 48px)', gap: 6, padding: 4 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 },
  header: { padding: '16px 20px 0' },
  title: { fontSize: 16, color: 'var(--text-primary)', fontWeight: 600 },
  subtitle: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)' },
  addBtn: { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 16px', background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid rgba(74,222,128,0.12)', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 500 },
  count: { fontSize: 11, color: 'var(--text-muted)' },
  form: { padding: '16px 20px', background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 12 },
  formRow: { display: 'flex', gap: 16, flexWrap: 'wrap' as const },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 4, flex: 1, minWidth: 200 },
  label: { fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 500 },
  hint: { fontSize: 10, color: 'var(--text-muted)' },
  input: { padding: '9px 14px', background: 'var(--bg-deep)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 13, outline: 'none' },
  select: { padding: '9px 14px', background: 'var(--bg-deep)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12, outline: 'none' },
  modeToggle: { display: 'flex', gap: 4 },
  modeBtn: { padding: '6px 14px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer', fontSize: 11 },
  modeBtnActive: { background: 'var(--accent-subtle)', color: 'var(--accent)', borderColor: 'rgba(91,141,239,0.25)' },
  formActions: { display: 'flex', gap: 8 },
  saveBtn: { display: 'flex', alignItems: 'center', gap: 4, padding: '7px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  cancelBtn: { display: 'flex', alignItems: 'center', gap: 4, padding: '7px 16px', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer', fontSize: 12 },
  list: { flex: 1, overflow: 'auto', padding: '8px 20px' },
  ruleRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12 },
  ruleWord: { color: 'var(--text-primary)', fontWeight: 500, minWidth: 120, fontFamily: 'monospace' },
  ruleArrow: { color: 'var(--text-muted)' },
  ruleValue: { flex: 1 },
  aliasTag: { color: 'var(--success)', fontSize: 11, background: 'var(--success-subtle)', padding: '3px 10px', borderRadius: 20 },
  phonemeTag: { color: 'var(--purple)', fontSize: 11, background: 'var(--purple-subtle)', padding: '3px 10px', borderRadius: 20, fontFamily: 'monospace' },
  charTag: { fontSize: 10, color: 'var(--accent)', background: 'var(--accent-subtle)', padding: '2px 8px', borderRadius: 20 },
  globalTag: { fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 20 },
  ruleActions: { display: 'flex', gap: 4 },
  iconBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 },
  empty: { padding: 40, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 8, textAlign: 'center' as const },
  testPanel: { width: 300, background: 'var(--bg-surface)', borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column' as const, gap: 10, overflow: 'auto', border: '1px solid var(--border-subtle)' },
  testTitle: { fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 },
  testHint: { fontSize: 11, color: 'var(--text-muted)' },
  testInput: { padding: 12, background: 'var(--bg-deep)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12, outline: 'none', resize: 'vertical' as const, fontFamily: 'inherit' },
  testBtn: { padding: '9px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  testResult: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  resultBox: { padding: 12, background: 'var(--bg-deep)', color: 'var(--success)', border: '1px solid rgba(74,222,128,0.1)', borderRadius: 8, fontSize: 12, lineHeight: 1.6, fontFamily: 'monospace', whiteSpace: 'pre-wrap' as const },
};
