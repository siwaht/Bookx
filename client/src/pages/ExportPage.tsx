import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { exportBook } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { ValidationResult } from '../types';
import { Download, CheckCircle, XCircle, Loader, Package, Mic } from 'lucide-react';

export function ExportPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const book = useAppStore((s) => s.currentBook);
  const isPodcast = book?.project_type === 'podcast';
  const [target, setTarget] = useState<'acx' | 'podcast'>(isPodcast ? 'podcast' : 'acx');
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ export_id: string; status: string; validation: ValidationResult } | null>(null);

  const handleExport = async () => {
    if (!bookId) return;
    setExporting(true);
    try {
      const data = await exportBook.start(bookId, target);
      setResult(data);
    } catch (err: any) { alert(`Export failed: ${err.message}`); }
    finally { setExporting(false); }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>📦 Export</h2>
        <p style={styles.subtitle}>Package your rendered audio for distribution</p>
      </div>

      {/* Target selector */}
      <div style={styles.targetRow}>
        <button onClick={() => { setTarget('acx'); setResult(null); }}
          style={{ ...styles.targetBtn, ...(target === 'acx' ? styles.targetActive : {}) }}>
          <Package size={14} /> ACX / Audible
        </button>
        <button onClick={() => { setTarget('podcast'); setResult(null); }}
          style={{ ...styles.targetBtn, ...(target === 'podcast' ? styles.targetActive : {}) }}>
          <Mic size={14} /> Podcast
        </button>
      </div>

      {target === 'acx' ? (
        <>
          <div style={styles.prereqBox}>
            <h4 style={{ color: '#D4A843', marginBottom: 8 }}>Before exporting (ACX)</h4>
            <p style={styles.prereqText}>Make sure you've completed these steps:</p>
            <div style={styles.prereqList}>
              <span style={styles.prereqItem}>✓ All chapters have generated audio</span>
              <span style={styles.prereqItem}>✓ Timeline is populated with clips</span>
              <span style={styles.prereqItem}>✓ Render completed successfully</span>
              <span style={styles.prereqItem}>✓ QC report shows all chapters passing</span>
            </div>
          </div>
          <div style={styles.specCard}>
            <h4 style={{ color: '#fff', marginBottom: 12 }}>ACX Package Contents</h4>
            <ul style={{ color: '#aaa', fontSize: 13, paddingLeft: 20, lineHeight: 2 }}>
              <li>Per-chapter MP3 files (192kbps CBR, 44.1kHz)</li>
              <li>ACX-compliant file naming convention</li>
              <li>Metadata CSV with chapter info</li>
              <li>Cover art (if set)</li>
              <li>Everything bundled in a single ZIP</li>
            </ul>
          </div>
        </>
      ) : (
        <>
          <div style={styles.prereqBox}>
            <h4 style={{ color: '#D4A843', marginBottom: 8 }}>Before exporting (Podcast)</h4>
            <p style={styles.prereqText}>Make sure you've completed these steps:</p>
            <div style={styles.prereqList}>
              <span style={styles.prereqItem}>✓ All episodes have generated audio</span>
              <span style={styles.prereqItem}>✓ Render completed successfully</span>
            </div>
          </div>
          <div style={styles.specCard}>
            <h4 style={{ color: '#fff', marginBottom: 12 }}>Podcast Package Contents</h4>
            <ul style={{ color: '#aaa', fontSize: 13, paddingLeft: 20, lineHeight: 2 }}>
              <li>Per-episode MP3 files (192kbps, 44.1kHz)</li>
              <li>Episode metadata JSON (for RSS feed generation)</li>
              <li>Cover art (if set)</li>
              <li>Everything bundled in a single ZIP</li>
            </ul>
          </div>
        </>
      )}

      <button onClick={handleExport} disabled={exporting} style={styles.exportBtn}>
        {exporting ? <Loader size={18} /> : <Package size={18} />}
        {exporting ? 'Exporting...' : target === 'acx' ? 'Export ACX Package' : 'Export Podcast Package'}
      </button>

      {result && (
        <div style={styles.resultSection}>
          <h4 style={{ color: '#fff', marginBottom: 12 }}>Pre-flight Validation</h4>
          <p style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>
            These checks verify your audiobook meets ACX requirements before packaging.
          </p>
          {result.validation.checks.map((check, i) => (
            <div key={i} style={styles.checkRow}>
              {check.pass ? <CheckCircle size={16} color="#8f8" /> : <XCircle size={16} color="#f88" />}
              <span style={{ color: check.pass ? '#8f8' : '#f88', fontSize: 14 }}>{check.name}</span>
              <span style={{ color: '#666', fontSize: 12, marginLeft: 'auto' }}>{check.message}</span>
            </div>
          ))}

          {result.status === 'completed' && (
            <a href={exportBook.downloadUrl(bookId!, result.export_id)} style={styles.downloadBtn} download>
              <Download size={18} /> Download ZIP
            </a>
          )}

          {result.status === 'validation_failed' && (
            <div style={styles.failBox}>
              <XCircle size={16} color="#f88" />
              <p style={{ color: '#f88', fontSize: 14 }}>
                Fix the issues above before exporting. Go back to Step 4 (QC & Render) to re-render and verify.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 700, display: 'flex', flexDirection: 'column', gap: 20, padding: 24 },
  header: { marginBottom: 4 },
  title: { fontSize: 20, color: '#fff' },
  subtitle: { fontSize: 13, color: '#555', marginTop: 4 },
  targetRow: { display: 'flex', gap: 8 },
  targetBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', background: '#1a1a1a', color: '#888', border: '1px solid #222', borderRadius: 8, cursor: 'pointer', fontSize: 13 },
  targetActive: { background: '#1e2a3a', color: '#4A90D9', borderColor: '#4A90D9' },
  prereqBox: { padding: 16, background: '#1a1a0f', borderRadius: 10, border: '1px solid #2a2a1a' },
  prereqText: { fontSize: 12, color: '#888', marginBottom: 8 },
  prereqList: { display: 'flex', flexDirection: 'column', gap: 4 },
  prereqItem: { fontSize: 12, color: '#8a8a5a' },
  specCard: { padding: 20, background: '#1a1a1a', borderRadius: 12 },
  exportBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '14px 28px', background: '#4A90D9', color: '#fff', border: 'none',
    borderRadius: 8, cursor: 'pointer', fontSize: 16, alignSelf: 'flex-start',
  },
  resultSection: { padding: 20, background: '#1a1a1a', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #222' },
  downloadBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '14px 28px', background: '#2d5a27', color: '#8f8', border: 'none',
    borderRadius: 8, cursor: 'pointer', fontSize: 16, textDecoration: 'none', marginTop: 16,
  },
  failBox: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, background: '#2a1a1a', borderRadius: 8 },
};
