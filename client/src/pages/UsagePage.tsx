import React, { useEffect, useState } from 'react';
import { usageStats } from '../services/api';
import { BarChart3, Zap, HardDrive, Clock } from 'lucide-react';

interface LocalUsage {
  total_characters_used: number;
  total_generations: number;
  total_assets: number;
  total_size_bytes: number;
  per_book: Array<{ id: string; title: string; characters_used: number; generations: number; assets: number; size_bytes: number }>;
  recent_activity: Array<{ action: string; details: string; characters_used: number; created_at: string }>;
}

interface ElevenLabsUsage {
  character_count?: number;
  character_limit?: number;
  next_character_count_reset_unix?: number;
  [key: string]: any;
}

export function UsagePage() {
  const [local, setLocal] = useState<LocalUsage | null>(null);
  const [elUsage, setElUsage] = useState<ElevenLabsUsage | null>(null);
  const [elError, setElError] = useState('');

  useEffect(() => {
    usageStats.local().then(setLocal).catch(console.error);
    usageStats.elevenlabs().then(setElUsage).catch((e) => setElError(e.message));
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatNum = (n: number) => n.toLocaleString();

  const charPercent = elUsage?.character_limit
    ? Math.round(((elUsage.character_count || 0) / elUsage.character_limit) * 100)
    : null;

  const resetDate = elUsage?.next_character_count_reset_unix
    ? new Date(elUsage.next_character_count_reset_unix * 1000).toLocaleDateString()
    : null;

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.title}>📊 Usage & Costs</h2>
        <p style={S.subtitle}>Track your ElevenLabs API usage and local generation stats</p>
      </div>

      {/* ElevenLabs subscription info */}
      <div style={S.section}>
        <h3 style={S.sectionTitle}>ElevenLabs Subscription</h3>
        {elError ? (
          <p style={{ color: '#a66', fontSize: 12 }}>Could not fetch ElevenLabs usage: {elError}</p>
        ) : elUsage ? (
          <div style={S.cards}>
            <div style={S.card}>
              <div style={S.cardLabel}>Characters Used</div>
              <div style={S.cardValue}>{formatNum(elUsage.character_count || 0)}</div>
              {elUsage.character_limit && (
                <>
                  <div style={S.cardSub}>of {formatNum(elUsage.character_limit)} limit</div>
                  <div style={S.progressBar}>
                    <div style={{ ...S.progressFill, width: `${Math.min(charPercent || 0, 100)}%`, background: (charPercent || 0) > 80 ? '#e55' : '#4A90D9' }} />
                  </div>
                  <div style={S.cardSub}>{charPercent}% used</div>
                </>
              )}
            </div>
            {resetDate && (
              <div style={S.card}>
                <div style={S.cardLabel}>Resets On</div>
                <div style={S.cardValue}>{resetDate}</div>
              </div>
            )}
            {elUsage.tier && (
              <div style={S.card}>
                <div style={S.cardLabel}>Tier</div>
                <div style={S.cardValue}>{elUsage.tier}</div>
              </div>
            )}
          </div>
        ) : (
          <p style={{ color: '#555', fontSize: 12 }}>Loading...</p>
        )}
      </div>

      {/* Local stats */}
      {local && (
        <>
          <div style={S.section}>
            <h3 style={S.sectionTitle}>Local Generation Stats</h3>
            <div style={S.cards}>
              <div style={S.card}>
                <Zap size={16} color="#D97A4A" />
                <div style={S.cardLabel}>Characters Sent to TTS</div>
                <div style={S.cardValue}>{formatNum(local.total_characters_used)}</div>
              </div>
              <div style={S.card}>
                <BarChart3 size={16} color="#4A90D9" />
                <div style={S.cardLabel}>Total Generations</div>
                <div style={S.cardValue}>{formatNum(local.total_generations)}</div>
              </div>
              <div style={S.card}>
                <HardDrive size={16} color="#8f8" />
                <div style={S.cardLabel}>Audio Files</div>
                <div style={S.cardValue}>{local.total_assets}</div>
                <div style={S.cardSub}>{formatBytes(local.total_size_bytes)}</div>
              </div>
            </div>
          </div>

          {local.per_book.length > 0 && (
            <div style={S.section}>
              <h3 style={S.sectionTitle}>Per Project</h3>
              <div style={S.table}>
                <div style={S.tableHeader}>
                  <span style={{ flex: 2 }}>Project</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Characters</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Generations</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Files</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Size</span>
                </div>
                {local.per_book.map((b) => (
                  <div key={b.id} style={S.tableRow}>
                    <span style={{ flex: 2, color: '#ddd' }}>{b.title}</span>
                    <span style={{ flex: 1, textAlign: 'right', color: '#D97A4A' }}>{formatNum(b.characters_used)}</span>
                    <span style={{ flex: 1, textAlign: 'right', color: '#4A90D9' }}>{b.generations}</span>
                    <span style={{ flex: 1, textAlign: 'right', color: '#8f8' }}>{b.assets}</span>
                    <span style={{ flex: 1, textAlign: 'right', color: '#888' }}>{formatBytes(b.size_bytes)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {local.recent_activity.length > 0 && (
            <div style={S.section}>
              <h3 style={S.sectionTitle}>Recent Activity</h3>
              <div style={S.activityList}>
                {local.recent_activity.map((a, i) => (
                  <div key={i} style={S.activityRow}>
                    <Clock size={10} color="#444" />
                    <span style={S.activityAction}>{a.action.replace('_', ' ')}</span>
                    {a.characters_used > 0 && <span style={S.activityChars}>{a.characters_used} chars</span>}
                    <span style={S.activityTime}>{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { padding: '24px 32px', maxWidth: 900, overflow: 'auto', height: 'calc(100vh - 48px)' },
  header: { marginBottom: 24 },
  title: { fontSize: 20, color: '#fff' },
  subtitle: { fontSize: 12, color: '#555', marginTop: 4 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 14, color: '#4A90D9', marginBottom: 12 },
  cards: { display: 'flex', gap: 12, flexWrap: 'wrap' as const },
  card: { padding: 16, background: '#141414', borderRadius: 10, border: '1px solid #1e1e1e', minWidth: 160, display: 'flex', flexDirection: 'column' as const, gap: 4 },
  cardLabel: { fontSize: 11, color: '#666' },
  cardValue: { fontSize: 22, color: '#ddd', fontWeight: 600 },
  cardSub: { fontSize: 11, color: '#555' },
  progressBar: { width: '100%', height: 6, background: '#222', borderRadius: 3, overflow: 'hidden' as const, marginTop: 4 },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s' },
  table: { background: '#141414', borderRadius: 10, border: '1px solid #1e1e1e', overflow: 'hidden' as const },
  tableHeader: { display: 'flex', padding: '10px 14px', borderBottom: '1px solid #222', fontSize: 11, color: '#666' },
  tableRow: { display: 'flex', padding: '10px 14px', borderBottom: '1px solid #1a1a1a', fontSize: 12 },
  activityList: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  activityRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 11 },
  activityAction: { color: '#aaa', textTransform: 'capitalize' as const },
  activityChars: { color: '#D97A4A', background: '#2a1a0a', padding: '1px 6px', borderRadius: 3, fontSize: 10 },
  activityTime: { color: '#444', marginLeft: 'auto' },
};
