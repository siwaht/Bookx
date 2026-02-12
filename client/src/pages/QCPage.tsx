import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { render } from '../services/api';
import type { RenderJob, QCChapterReport } from '../types';
import { Play, CheckCircle, XCircle, Loader, AlertTriangle } from 'lucide-react';

export function QCPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [job, setJob] = useState<RenderJob | null>(null);
  const [rendering, setRendering] = useState(false);

  const startRender = async () => {
    if (!bookId) return;
    setRendering(true);
    try {
      const { job_id } = await render.start(bookId, { type: 'full' });
      pollJob(job_id);
    } catch (err: any) {
      alert(`Render failed: ${err.message}`);
      setRendering(false);
    }
  };

  const pollJob = async (jobId: string) => {
    if (!bookId) return;
    const poll = setInterval(async () => {
      try {
        const status = await render.status(bookId, jobId);
        setJob(status);
        if (status.status === 'completed' || status.status === 'failed') {
          clearInterval(poll);
          setRendering(false);
        }
      } catch { clearInterval(poll); setRendering(false); }
    }, 2000);
  };

  const qcReport = job?.qc_report;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>🔍 QC & Render</h2>
          <p style={styles.subtitle}>Render your audiobook and check it meets ACX/Audible technical specs</p>
        </div>
        <button onClick={startRender} disabled={rendering} style={styles.renderBtn}>
          {rendering ? <Loader size={16} /> : <Play size={16} />}
          {rendering ? `Rendering... ${job?.progress?.toFixed(0) || 0}%` : 'Render Full Book'}
        </button>
      </div>

      {job?.status === 'failed' && (
        <div style={styles.errorBox}>
          <XCircle size={18} color="#ff6b6b" />
          <span>Render failed: {job.error_message}</span>
        </div>
      )}

      {qcReport && (
        <div style={styles.report}>
          <div style={{
            ...styles.overallBadge,
            background: qcReport.overall_pass ? '#1a3a1a' : '#3a1a1a',
            color: qcReport.overall_pass ? '#8f8' : '#f88',
          }}>
            {qcReport.overall_pass ? <CheckCircle size={18} /> : <XCircle size={18} />}
            {qcReport.overall_pass ? 'All chapters pass ACX specs — ready to export' : 'Some chapters have issues — see details below'}
          </div>

          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Chapter</th>
                <th style={styles.th}>Duration</th>
                <th style={styles.th}>RMS (dB)</th>
                <th style={styles.th}>Peak (dB)</th>
                <th style={styles.th}>LUFS</th>
                <th style={styles.th}>Noise Floor</th>
                <th style={styles.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {qcReport.chapters.map((ch: QCChapterReport) => (
                <tr key={ch.chapter_id}>
                  <td style={styles.td}>{ch.chapter_title}</td>
                  <td style={styles.td}>{formatDuration(ch.duration_seconds)}</td>
                  <td style={{ ...styles.td, color: ch.rms_db >= -23 && ch.rms_db <= -18 ? '#8f8' : '#f88' }}>{ch.rms_db.toFixed(1)}</td>
                  <td style={{ ...styles.td, color: ch.true_peak_db <= -3 ? '#8f8' : '#f88' }}>{ch.true_peak_db.toFixed(1)}</td>
                  <td style={styles.td}>{ch.lufs.toFixed(1)}</td>
                  <td style={{ ...styles.td, color: ch.noise_floor_db <= -60 ? '#8f8' : '#f88' }}>{ch.noise_floor_db.toFixed(1)}</td>
                  <td style={styles.td}>
                    {ch.acx_pass ? <span style={{ color: '#8f8' }}>✓ Pass</span> : <span style={{ color: '#f88' }}>✗ Fail</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {qcReport.chapters.some((ch: QCChapterReport) => ch.issues.length > 0) && (
            <div style={styles.issuesSection}>
              <h4 style={{ color: '#f88', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={14} /> Issues to Fix
              </h4>
              {qcReport.chapters.filter((ch: QCChapterReport) => ch.issues.length > 0).map((ch: QCChapterReport) => (
                <div key={ch.chapter_id} style={styles.issueGroup}>
                  <strong style={{ color: '#ddd' }}>{ch.chapter_title}:</strong>
                  <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                    {ch.issues.map((issue, i) => <li key={i} style={{ color: '#f88', fontSize: 13 }}>{issue}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!qcReport && !rendering && (
        <div style={styles.emptyState}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🎛️</div>
          <h3 style={{ color: '#ccc', fontSize: 16, marginBottom: 8 }}>Ready to render</h3>
          <p style={styles.emptyText}>
            Rendering combines all your timeline audio into per-chapter files and runs quality checks against ACX specs.
          </p>
          <p style={styles.emptyText}>
            Make sure you've completed the previous steps: import manuscript, assign voices, generate audio, and populate the timeline.
          </p>
          <p style={{ color: '#555', fontSize: 12, marginTop: 12 }}>
            Click "Render Full Book" above to start.
          </p>
        </div>
      )}

      <div style={styles.specBox}>
        <h4 style={{ color: '#888', marginBottom: 8 }}>📋 ACX/Audible Technical Requirements</h4>
        <ul style={{ color: '#666', fontSize: 13, paddingLeft: 20, lineHeight: 2 }}>
          <li>MP3, 192kbps CBR, 44.1kHz</li>
          <li>RMS level: -23 dB to -18 dB</li>
          <li>True peak: ≤ -3 dB</li>
          <li>Noise floor: ≤ -60 dB</li>
          <li>Each chapter as a separate file</li>
          <li>Opening and closing credits required</li>
        </ul>
        <p style={{ color: '#555', fontSize: 11, marginTop: 8 }}>
          Values outside these ranges will be flagged in the QC report above.
        </p>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 20, padding: 24 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { fontSize: 20, color: '#fff' },
  subtitle: { fontSize: 13, color: '#555', marginTop: 4 },
  renderBtn: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap',
  },
  errorBox: {
    display: 'flex', alignItems: 'center', gap: 8, padding: 16,
    background: '#2a1a1a', borderRadius: 8, color: '#f88', fontSize: 14,
  },
  report: { display: 'flex', flexDirection: 'column', gap: 16 },
  overallBadge: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderRadius: 8, fontSize: 15,
  },
  table: { width: '100%', borderCollapse: 'collapse', background: '#1a1a1a', borderRadius: 8, overflow: 'hidden' },
  th: { padding: '10px 14px', textAlign: 'left', fontSize: 12, color: '#888', borderBottom: '1px solid #222' },
  td: { padding: '10px 14px', fontSize: 13, color: '#ddd', borderBottom: '1px solid #1f1f1f' },
  issuesSection: { padding: 16, background: '#1a1a1a', borderRadius: 8 },
  issueGroup: { marginBottom: 8 },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 20px', textAlign: 'center' },
  emptyText: { color: '#666', fontSize: 13, maxWidth: 480, lineHeight: 1.6, marginBottom: 4 },
  specBox: { padding: 16, background: '#1a1a1a', borderRadius: 8, marginTop: 8 },
};
