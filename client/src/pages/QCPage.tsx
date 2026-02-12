import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { render } from '../services/api';
import type { RenderJob, QCChapterReport } from '../types';
import { Play, CheckCircle, XCircle, Loader } from 'lucide-react';

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
      } catch {
        clearInterval(poll);
        setRendering(false);
      }
    }, 2000);
  };

  const qcReport = job?.qc_report;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>QC & Render</h2>
        <button onClick={startRender} disabled={rendering} style={styles.renderBtn}>
          {rendering ? <Loader size={16} className="spin" /> : <Play size={16} />}
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
            {qcReport.overall_pass ? 'All chapters pass ACX specs' : 'Some chapters have issues'}
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
                  <td style={styles.td}>{ch.rms_db.toFixed(1)}</td>
                  <td style={styles.td}>{ch.true_peak_db.toFixed(1)}</td>
                  <td style={styles.td}>{ch.lufs.toFixed(1)}</td>
                  <td style={styles.td}>{ch.noise_floor_db.toFixed(1)}</td>
                  <td style={styles.td}>
                    {ch.acx_pass ? (
                      <span style={{ color: '#8f8' }}>✓ Pass</span>
                    ) : (
                      <span style={{ color: '#f88' }}>✗ Fail</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {qcReport.chapters.some((ch: QCChapterReport) => ch.issues.length > 0) && (
            <div style={styles.issuesSection}>
              <h4 style={{ color: '#f88', marginBottom: 8 }}>Issues</h4>
              {qcReport.chapters
                .filter((ch: QCChapterReport) => ch.issues.length > 0)
                .map((ch: QCChapterReport) => (
                  <div key={ch.chapter_id} style={styles.issueGroup}>
                    <strong style={{ color: '#ddd' }}>{ch.chapter_title}:</strong>
                    <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                      {ch.issues.map((issue, i) => (
                        <li key={i} style={{ color: '#f88', fontSize: 13 }}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {!qcReport && !rendering && (
        <p style={{ color: '#555', textAlign: 'center', padding: 60 }}>
          Click "Render Full Book" to generate audio and run QC analysis
        </p>
      )}

      <div style={styles.specBox}>
        <h4 style={{ color: '#888', marginBottom: 8 }}>ACX/Audible Specs</h4>
        <ul style={{ color: '#666', fontSize: 13, paddingLeft: 20, lineHeight: 2 }}>
          <li>MP3, 192kbps CBR, 44.1kHz</li>
          <li>RMS: -23 dB to -18 dB</li>
          <li>Peak: ≤ -3 dB</li>
          <li>Noise floor: ≤ -60 dB</li>
          <li>Each chapter as separate file</li>
          <li>Opening and closing credits required</li>
        </ul>
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
  container: { maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 20 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, color: '#fff' },
  renderBtn: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
    background: '#4A90D9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14,
  },
  errorBox: {
    display: 'flex', alignItems: 'center', gap: 8, padding: 16,
    background: '#2a1a1a', borderRadius: 8, color: '#f88', fontSize: 14,
  },
  report: { display: 'flex', flexDirection: 'column', gap: 16 },
  overallBadge: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px',
    borderRadius: 8, fontSize: 15,
  },
  table: { width: '100%', borderCollapse: 'collapse', background: '#1a1a1a', borderRadius: 8, overflow: 'hidden' },
  th: { padding: '10px 14px', textAlign: 'left', fontSize: 12, color: '#888', borderBottom: '1px solid #222' },
  td: { padding: '10px 14px', fontSize: 13, color: '#ddd', borderBottom: '1px solid #1f1f1f' },
  issuesSection: { padding: 16, background: '#1a1a1a', borderRadius: 8 },
  issueGroup: { marginBottom: 8 },
  specBox: { padding: 16, background: '#1a1a1a', borderRadius: 8, marginTop: 16 },
};
