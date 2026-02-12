import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { exportBook } from '../services/api';
import type { ValidationResult } from '../types';
import { Download, CheckCircle, XCircle, Loader } from 'lucide-react';

export function ExportPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ export_id: string; status: string; validation: ValidationResult } | null>(null);

  const handleExport = async () => {
    if (!bookId) return;
    setExporting(true);
    try {
      const data = await exportBook.start(bookId, 'acx');
      setResult(data);
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Export — ACX/Audible</h2>

      <div style={styles.specCard}>
        <h4 style={{ color: '#fff', marginBottom: 12 }}>ACX Package Contents</h4>
        <ul style={{ color: '#aaa', fontSize: 13, paddingLeft: 20, lineHeight: 2 }}>
          <li>Per-chapter MP3 files (192kbps CBR, 44.1kHz)</li>
          <li>ACX-compliant file naming</li>
          <li>Metadata CSV</li>
          <li>Cover art (if set)</li>
          <li>All files in a single ZIP download</li>
        </ul>
      </div>

      <button onClick={handleExport} disabled={exporting} style={styles.exportBtn}>
        {exporting ? <Loader size={18} /> : <Download size={18} />}
        {exporting ? 'Exporting...' : 'Export ACX Package'}
      </button>

      {result && (
        <div style={styles.resultSection}>
          <h4 style={{ color: '#fff', marginBottom: 12 }}>Pre-flight Checks</h4>
          {result.validation.checks.map((check, i) => (
            <div key={i} style={styles.checkRow}>
              {check.pass ? <CheckCircle size={16} color="#8f8" /> : <XCircle size={16} color="#f88" />}
              <span style={{ color: check.pass ? '#8f8' : '#f88', fontSize: 14 }}>{check.name}</span>
              <span style={{ color: '#666', fontSize: 12, marginLeft: 'auto' }}>{check.message}</span>
            </div>
          ))}

          {result.status === 'completed' && (
            <a
              href={exportBook.downloadUrl(bookId!, result.export_id)}
              style={styles.downloadBtn}
              download
            >
              <Download size={18} /> Download ZIP
            </a>
          )}

          {result.status === 'validation_failed' && (
            <p style={{ color: '#f88', marginTop: 16, fontSize: 14 }}>
              Fix the issues above before exporting. Render the book first, then ensure QC passes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 700, display: 'flex', flexDirection: 'column', gap: 20 },
  title: { fontSize: 20, color: '#fff' },
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
};
