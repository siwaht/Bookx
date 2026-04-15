import React, { useEffect, useState, useCallback, useRef } from 'react';
import { bookAgent } from '../services/api';
import type { BookAgentJob, BookAgentProvider, BookRating } from '../types';
import {
  Upload, Play, Square, Trash2, Download, RefreshCw, ChevronDown, ChevronRight,
  BookOpen, Star, FileText, MessageSquare, Clock, CheckCircle, XCircle, Loader,
  AlertTriangle, Sparkles, Eye, ArrowLeft, Send, Copy, Lightbulb, Settings,
  BarChart3, Zap
} from 'lucide-react';

// ── Rating Display Component ──
function RatingCard({ title, rating, compact }: { title: string; rating: BookRating | null; compact?: boolean }) {
  if (!rating?.ratings) return null;
  const entries = Object.entries(rating.ratings);
  const overall = rating.ratings.overall;

  const scoreColor = (s: number) =>
    s >= 8 ? '#4ade80' : s >= 6 ? '#facc15' : s >= 4 ? '#fb923c' : '#f87171';

  if (compact) {
    return (
      <div style={styles.ratingCompact}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        {overall && (
          <span style={{ fontSize: 20, fontWeight: 700, color: scoreColor(overall.score) }}>
            {overall.score}/10
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={styles.ratingCard}>
      <h4 style={{ margin: '0 0 12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Star size={16} /> {title}
        {overall && (
          <span style={{ marginLeft: 'auto', fontSize: 22, fontWeight: 700, color: scoreColor(overall.score) }}>
            {overall.score}/10
          </span>
        )}
      </h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
        {entries.filter(([k]) => k !== 'overall').map(([key, val]) => (
          <div key={key} style={styles.ratingItem}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                {key.replace(/_/g, ' ')}
              </span>
              <span style={{ fontWeight: 700, color: scoreColor(val.score), fontSize: 14 }}>{val.score}</span>
            </div>
            <div style={styles.ratingBar}>
              <div style={{ ...styles.ratingBarFill, width: `${val.score * 10}%`, background: scoreColor(val.score) }} />
            </div>
            {val.comment && <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>{val.comment}</p>}
          </div>
        ))}
      </div>
      {rating.summary && <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>{rating.summary}</p>}
      {rating.strengths && rating.strengths.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#4ade80' }}>Strengths: </span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{rating.strengths.join(', ')}</span>
        </div>
      )}
      {rating.weaknesses && rating.weaknesses.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#fb923c' }}>Areas to improve: </span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{rating.weaknesses.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

// ── Status Badge ──
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    queued: { bg: 'rgba(250,204,21,0.15)', text: '#facc15' },
    running: { bg: 'rgba(96,165,250,0.15)', text: '#60a5fa' },
    completed: { bg: 'rgba(74,222,128,0.15)', text: '#4ade80' },
    failed: { bg: 'rgba(248,113,113,0.15)', text: '#f87171' },
    cancelled: { bg: 'rgba(156,163,175,0.15)', text: '#9ca3af' },
    pending: { bg: 'rgba(156,163,175,0.15)', text: '#9ca3af' },
  };
  const c = colors[status] || colors.pending;
  const icons: Record<string, React.ReactNode> = {
    queued: <Clock size={12} />,
    running: <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />,
    completed: <CheckCircle size={12} />,
    failed: <XCircle size={12} />,
    cancelled: <Square size={12} />,
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: c.bg, color: c.text }}>
      {icons[status]} {status}
    </span>
  );
}

// ── Main Page Component ──
export function BookAgentPage() {
  const [jobs, setJobs] = useState<BookAgentJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<BookAgentJob | null>(null);
  const [providers, setProviders] = useState<BookAgentProvider[]>([]);
  const [promptGuide, setPromptGuide] = useState<any>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Upload form state
  const [file, setFile] = useState<File | null>(null);
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('gpt-4o');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [outputFormat, setOutputFormat] = useState('epub');
  const [temperature, setTemperature] = useState(0.7);
  const [uploading, setUploading] = useState(false);

  // Follow-up state
  const [followUpText, setFollowUpText] = useState('');
  const [followUpReRate, setFollowUpReRate] = useState(true);
  const [submittingFollowUp, setSubmittingFollowUp] = useState(false);

  // Logs state
  const [logs, setLogs] = useState<any[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  // Chapter viewer
  const [viewingChapter, setViewingChapter] = useState<any>(null);
  const [chapterLoading, setChapterLoading] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const data = await bookAgent.jobs();
      setJobs(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadJobDetail = useCallback(async (jobId: string) => {
    try {
      const data = await bookAgent.job(jobId);
      setSelectedJob(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadJobs();
    bookAgent.models().then(d => setProviders(d.providers)).catch(() => {});
    bookAgent.promptGuide().then(setPromptGuide).catch(() => {});
  }, [loadJobs]);

  // Poll for active jobs
  useEffect(() => {
    const hasActive = jobs.some(j => j.status === 'running' || j.status === 'queued') ||
      (selectedJob && (selectedJob.status === 'running' || selectedJob.status === 'queued'));

    if (hasActive) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        loadJobs();
        if (selectedJob) loadJobDetail(selectedJob.id);
      }, 3000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobs, selectedJob, loadJobs, loadJobDetail]);

  const handleUpload = async () => {
    if (!file || !instructions.trim()) return;
    setUploading(true);
    setError('');
    try {
      await bookAgent.upload(file, {
        instructions,
        provider,
        model,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        output_format: outputFormat,
        temperature,
      });
      setShowUpload(false);
      setFile(null);
      setInstructions('');
      await loadJobs();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleFollowUp = async () => {
    if (!selectedJob || !followUpText.trim()) return;
    setSubmittingFollowUp(true);
    try {
      await bookAgent.followUp(selectedJob.id, {
        instructions: followUpText,
        re_rate: followUpReRate,
      });
      setFollowUpText('');
      await loadJobDetail(selectedJob.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmittingFollowUp(false);
    }
  };

  const handleCancel = async (jobId: string) => {
    try {
      await bookAgent.cancel(jobId);
      await loadJobs();
      if (selectedJob?.id === jobId) await loadJobDetail(jobId);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (jobId: string) => {
    if (!confirm('Delete this job and all its data?')) return;
    try {
      await bookAgent.delete(jobId);
      if (selectedJob?.id === jobId) setSelectedJob(null);
      await loadJobs();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const loadLogs = async (jobId: string) => {
    try {
      const data = await bookAgent.logs(jobId);
      setLogs(data);
      setShowLogs(true);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const loadChapter = async (jobId: string, index: number) => {
    setChapterLoading(true);
    try {
      const data = await bookAgent.chapter(jobId, index);
      setViewingChapter(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setChapterLoading(false);
    }
  };

  const selectedProvider = providers.find(p => p.id === provider);

  // ── Render ──
  return (
    <div style={styles.page}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {selectedJob && (
            <button onClick={() => { setSelectedJob(null); setViewingChapter(null); setShowLogs(false); }} style={styles.backBtn}>
              <ArrowLeft size={16} />
            </button>
          )}
          <BookOpen size={24} style={{ color: 'var(--accent)' }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 20, color: 'var(--text-primary)' }}>Book Editor Agent</h1>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>
              Upload a book, give instructions, and let the AI agent edit it 24/7
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowGuide(!showGuide)} style={styles.btnSecondary}>
            <Lightbulb size={14} /> Prompt Guide
          </button>
          <button onClick={() => setShowUpload(!showUpload)} style={styles.btnPrimary}>
            <Upload size={14} /> New Job
          </button>
        </div>
      </div>

      {error && (
        <div style={styles.errorBanner}>
          <AlertTriangle size={14} /> {error}
          <button onClick={() => setError('')} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', marginLeft: 'auto' }}>×</button>
        </div>
      )}

      {/* Prompt Guide Panel */}
      {showGuide && promptGuide && (
        <div style={styles.panel}>
          <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lightbulb size={16} /> {promptGuide.guide.title}
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>{promptGuide.guide.description}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
            {promptGuide.guide.templates.map((t: any, i: number) => (
              <div key={i} style={styles.templateCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{t.name}</span>
                  <button onClick={() => { setInstructions(t.prompt); setShowUpload(true); setShowGuide(false); }}
                    style={{ ...styles.btnSmall, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Copy size={11} /> Use
                  </button>
                </div>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{t.prompt}</p>
                <span style={styles.categoryBadge}>{t.category}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, padding: 10, background: 'rgba(96,165,250,0.08)', borderRadius: 8 }}>
            <strong style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Tips:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: 'var(--text-tertiary)' }}>
              {promptGuide.guide.tips.map((tip: string, i: number) => <li key={i} style={{ marginBottom: 2 }}>{tip}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* Upload Panel */}
      {showUpload && (
        <div style={styles.panel}>
          <h3 style={{ margin: '0 0 12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} /> Start New Editing Job
          </h3>

          <div style={styles.formGrid}>
            {/* File Upload */}
            <div style={styles.formGroup}>
              <label style={styles.label}>Book File (EPUB, PDF, TXT, DOCX)</label>
              <div
                style={{ ...styles.dropZone, borderColor: file ? 'var(--accent)' : 'var(--border)' }}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
              >
                <input type="file" accept=".epub,.pdf,.txt,.docx" onChange={e => setFile(e.target.files?.[0] || null)}
                  style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                {file ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FileText size={20} style={{ color: 'var(--accent)' }} />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{file.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{(file.size / 1024 / 1024).toFixed(2)} MB</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
                    <Upload size={24} style={{ marginBottom: 4 }} />
                    <div style={{ fontSize: 13 }}>Drop your book here or click to browse</div>
                    <div style={{ fontSize: 11 }}>EPUB, PDF, TXT, DOCX up to 100MB</div>
                  </div>
                )}
              </div>
            </div>

            {/* Instructions */}
            <div style={styles.formGroup}>
              <label style={styles.label}>
                Editing Instructions
                <button onClick={() => { setShowGuide(true); }} style={{ ...styles.btnSmall, marginLeft: 8, fontSize: 11 }}>
                  <Lightbulb size={10} /> Templates
                </button>
              </label>
              <textarea
                value={instructions}
                onChange={e => setInstructions(e.target.value)}
                placeholder="Describe what you want the agent to do with your book. Be specific about style, tone, and what to preserve..."
                style={styles.textarea}
                rows={5}
              />
            </div>

            {/* Model Config */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={styles.formGroup}>
                <label style={styles.label}>AI Provider</label>
                <select value={provider} onChange={e => {
                  setProvider(e.target.value);
                  const p = providers.find(pp => pp.id === e.target.value);
                  if (p?.models?.[0]) setModel(p.models[0]);
                }} style={styles.select}>
                  {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Model</label>
                {selectedProvider?.models?.length ? (
                  <select value={model} onChange={e => setModel(e.target.value)} style={styles.select}>
                    {selectedProvider.models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input value={model} onChange={e => setModel(e.target.value)} placeholder="Model name" style={styles.input} />
                )}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={styles.formGroup}>
                <label style={styles.label}>API Key {selectedProvider?.env_key && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>(or set {selectedProvider.env_key})</span>}</label>
                <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..." style={styles.input} />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Output Format</label>
                <select value={outputFormat} onChange={e => setOutputFormat(e.target.value)} style={styles.select}>
                  <option value="epub">EPUB</option>
                  <option value="txt">Plain Text</option>
                </select>
              </div>
            </div>

            {selectedProvider?.supports_base_url && (
              <div style={styles.formGroup}>
                <label style={styles.label}>Custom API Base URL</label>
                <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1/chat/completions" style={styles.input} />
              </div>
            )}

            <div style={styles.formGroup}>
              <label style={styles.label}>Temperature: {temperature}</label>
              <input type="range" min="0" max="1" step="0.1" value={temperature} onChange={e => setTemperature(parseFloat(e.target.value))}
                style={{ width: '100%' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)' }}>
                <span>Precise (0)</span><span>Creative (1)</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowUpload(false)} style={styles.btnSecondary}>Cancel</button>
            <button onClick={handleUpload} disabled={!file || !instructions.trim() || uploading} style={styles.btnPrimary}>
              {uploading ? <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Starting...</> : <><Zap size={14} /> Start Agent</>}
            </button>
          </div>
        </div>
      )}

      {/* Job Detail View */}
      {selectedJob ? (
        <JobDetailView
          job={selectedJob}
          logs={logs}
          showLogs={showLogs}
          viewingChapter={viewingChapter}
          chapterLoading={chapterLoading}
          followUpText={followUpText}
          followUpReRate={followUpReRate}
          submittingFollowUp={submittingFollowUp}
          onFollowUpTextChange={setFollowUpText}
          onFollowUpReRateChange={setFollowUpReRate}
          onSubmitFollowUp={handleFollowUp}
          onCancel={handleCancel}
          onDelete={handleDelete}
          onLoadLogs={loadLogs}
          onToggleLogs={() => setShowLogs(!showLogs)}
          onLoadChapter={loadChapter}
          onCloseChapter={() => setViewingChapter(null)}
        />
      ) : (
        /* Jobs List */
        <div>
          {loading ? (
            <div style={styles.emptyState}><Loader size={24} style={{ animation: 'spin 1s linear infinite' }} /> Loading...</div>
          ) : jobs.length === 0 ? (
            <div style={styles.emptyState}>
              <BookOpen size={48} style={{ color: 'var(--text-tertiary)', marginBottom: 12 }} />
              <h3 style={{ margin: '0 0 8px', color: 'var(--text-secondary)' }}>No editing jobs yet</h3>
              <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 13 }}>
                Upload a book and give the agent instructions to get started.
              </p>
              <button onClick={() => setShowUpload(true)} style={{ ...styles.btnPrimary, marginTop: 16 }}>
                <Upload size={14} /> Upload Your First Book
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {jobs.map(job => (
                <div key={job.id} style={styles.jobCard} onClick={() => loadJobDetail(job.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                    <FileText size={20} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {job.original_filename}
                        </span>
                        <StatusBadge status={job.status} />
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.instructions.slice(0, 100)}{job.instructions.length > 100 ? '...' : ''}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, display: 'flex', gap: 12 }}>
                        <span>{job.total_chapters} chapters</span>
                        <span>{job.total_words?.toLocaleString()} words</span>
                        <span>{job.provider}/{job.model}</span>
                        <span>{new Date(job.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    {job.status === 'running' && (
                      <div style={{ width: 60, textAlign: 'center' }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{job.progress}%</div>
                        <div style={{ ...styles.progressBar, marginTop: 4 }}>
                          <div style={{ ...styles.progressFill, width: `${job.progress}%` }} />
                        </div>
                      </div>
                    )}
                    {job.post_edit_rating && (
                      <RatingCard title="" rating={job.post_edit_rating} compact />
                    )}
                    <ChevronRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── Job Detail View ──
function JobDetailView({
  job, logs, showLogs, viewingChapter, chapterLoading,
  followUpText, followUpReRate, submittingFollowUp,
  onFollowUpTextChange, onFollowUpReRateChange, onSubmitFollowUp,
  onCancel, onDelete, onLoadLogs, onToggleLogs, onLoadChapter, onCloseChapter,
}: {
  job: BookAgentJob;
  logs: any[];
  showLogs: boolean;
  viewingChapter: any;
  chapterLoading: boolean;
  followUpText: string;
  followUpReRate: boolean;
  submittingFollowUp: boolean;
  onFollowUpTextChange: (v: string) => void;
  onFollowUpReRateChange: (v: boolean) => void;
  onSubmitFollowUp: () => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onLoadLogs: (id: string) => void;
  onToggleLogs: () => void;
  onLoadChapter: (jobId: string, index: number) => void;
  onCloseChapter: () => void;
}) {
  const isActive = job.status === 'running' || job.status === 'queued';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Job Header */}
      <div style={styles.panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: '0 0 4px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileText size={18} /> {job.original_filename}
              <StatusBadge status={job.status} />
            </h3>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', gap: 12 }}>
              <span>{job.total_chapters} chapters</span>
              <span>{job.total_words?.toLocaleString()} words</span>
              <span>{job.provider}/{job.model}</span>
              <span>Created {new Date(job.created_at).toLocaleString()}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {isActive && (
              <button onClick={() => onCancel(job.id)} style={styles.btnDanger}><Square size={12} /> Cancel</button>
            )}
            {job.status === 'completed' && (
              <a href={bookAgent.downloadUrl(job.id)} style={{ ...styles.btnPrimary, textDecoration: 'none' }}>
                <Download size={12} /> Download
              </a>
            )}
            <button onClick={() => onLoadLogs(job.id)} style={styles.btnSecondary}><Eye size={12} /> Logs</button>
            <button onClick={() => onDelete(job.id)} style={styles.btnDanger}><Trash2 size={12} /></button>
          </div>
        </div>

        {/* Progress */}
        {isActive && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
              <span>
                {job.current_phase === 'rating_original' && 'Rating original book...'}
                {job.current_phase === 'editing' && `Editing chapter ${job.current_chapter}/${job.total_chapters}...`}
                {job.current_phase === 'rating_edited' && 'Rating edited book...'}
                {job.current_phase === 'generating_report' && 'Generating report...'}
                {job.current_phase === 'building_output' && 'Building output file...'}
                {!job.current_phase && 'Starting...'}
              </span>
              <span>{job.progress}%</span>
            </div>
            <div style={styles.progressBar}>
              <div style={{ ...styles.progressFill, width: `${job.progress}%`, transition: 'width 0.5s ease' }} />
            </div>
          </div>
        )}

        {/* Instructions */}
        <div style={{ padding: 10, background: 'rgba(96,165,250,0.06)', borderRadius: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 4 }}>INSTRUCTIONS</div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{job.instructions}</p>
        </div>

        {job.error_message && (
          <div style={{ padding: 10, background: 'rgba(248,113,113,0.1)', borderRadius: 8, color: '#f87171', fontSize: 13 }}>
            <AlertTriangle size={14} style={{ marginRight: 4 }} /> {job.error_message}
          </div>
        )}
      </div>

      {/* Ratings Comparison */}
      {(job.pre_edit_rating || job.post_edit_rating) && (
        <div style={{ display: 'grid', gridTemplateColumns: job.pre_edit_rating && job.post_edit_rating ? '1fr 1fr' : '1fr', gap: 12 }}>
          {job.pre_edit_rating && <RatingCard title="Before Editing" rating={job.pre_edit_rating} />}
          {job.post_edit_rating && <RatingCard title="After Editing" rating={job.post_edit_rating} />}
        </div>
      )}

      {/* Chapters */}
      {job.chapters && job.chapters.length > 0 && (
        <div style={styles.panel}>
          <h4 style={{ margin: '0 0 8px', color: 'var(--text-primary)' }}>Chapters ({job.chapters.length})</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {job.chapters.map((ch, i) => {
              const task = job.tasks?.find(t => t.chapter_index === i);
              return (
                <div key={ch.id} style={styles.chapterRow} onClick={() => onLoadChapter(job.id, i)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                    {task && <StatusBadge status={task.status} />}
                    <span style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{ch.title}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    <span>{ch.original_length?.toLocaleString()} → {ch.edited_length?.toLocaleString() || '—'} chars</span>
                    {ch.changes_summary && <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.changes_summary}</span>}
                  </div>
                  <Eye size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chapter Viewer Modal */}
      {viewingChapter && (
        <div style={styles.panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h4 style={{ margin: 0, color: 'var(--text-primary)' }}>{viewingChapter.title}</h4>
            <button onClick={onCloseChapter} style={styles.btnSecondary}>Close</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 4 }}>ORIGINAL</div>
              <div style={styles.textViewer}>{viewingChapter.original_text}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#4ade80', marginBottom: 4 }}>EDITED</div>
              <div style={{ ...styles.textViewer, borderColor: 'rgba(74,222,128,0.3)' }}>
                {viewingChapter.edited_text || 'Not yet edited'}
              </div>
            </div>
          </div>
          {viewingChapter.changes_summary && (
            <div style={{ marginTop: 8, padding: 8, background: 'rgba(96,165,250,0.06)', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>Changes:</strong> {viewingChapter.changes_summary}
            </div>
          )}
        </div>
      )}

      {/* Follow-ups */}
      {job.followups && job.followups.length > 0 && (
        <div style={styles.panel}>
          <h4 style={{ margin: '0 0 8px', color: 'var(--text-primary)' }}>Follow-up Edits</h4>
          {job.followups.map((f: any) => (
            <div key={f.id} style={{ padding: 10, background: 'var(--bg-card)', borderRadius: 8, marginBottom: 8, border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <StatusBadge status={f.status} />
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{new Date(f.created_at).toLocaleString()}</span>
              </div>
              <p style={{ margin: '4px 0', fontSize: 13, color: 'var(--text-secondary)' }}>{f.instructions}</p>
              {f.status === 'running' && (
                <div style={styles.progressBar}>
                  <div style={{ ...styles.progressFill, width: `${f.progress}%` }} />
                </div>
              )}
              {f.result_rating && <RatingCard title="Updated Rating" rating={f.result_rating} compact />}
            </div>
          ))}
        </div>
      )}

      {/* Follow-up Input */}
      {job.status === 'completed' && (
        <div style={styles.panel}>
          <h4 style={{ margin: '0 0 8px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquare size={16} /> Follow-up Instructions
          </h4>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-tertiary)' }}>
            Give additional instructions to further refine the book. The agent will re-process all chapters.
          </p>
          <textarea
            value={followUpText}
            onChange={e => onFollowUpTextChange(e.target.value)}
            placeholder="e.g., Make the dialogue more natural, fix the pacing in chapters 3-5, add more sensory details..."
            style={styles.textarea}
            rows={3}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={followUpReRate} onChange={e => onFollowUpReRateChange(e.target.checked)} />
              Re-rate book after changes
            </label>
            <button onClick={onSubmitFollowUp} disabled={!followUpText.trim() || submittingFollowUp} style={styles.btnPrimary}>
              {submittingFollowUp ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
              Submit Follow-up
            </button>
          </div>
        </div>
      )}

      {/* Logs */}
      {showLogs && (
        <div style={styles.panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h4 style={{ margin: 0, color: 'var(--text-primary)' }}>Agent Logs</h4>
            <button onClick={onToggleLogs} style={styles.btnSecondary}>Close</button>
          </div>
          <div style={{ maxHeight: 300, overflow: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
            {logs.map((log: any) => (
              <div key={log.id} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{new Date(log.created_at).toLocaleTimeString()}</span>
                <span style={{
                  color: log.level === 'error' ? '#f87171' : log.level === 'warn' ? '#facc15' : 'var(--text-secondary)',
                  fontWeight: log.level === 'error' ? 600 : 400,
                }}>{log.message}</span>
              </div>
            ))}
            {logs.length === 0 && <div style={{ color: 'var(--text-tertiary)', padding: 12, textAlign: 'center' }}>No logs yet</div>}
          </div>
        </div>
      )}
    </div>
  );
}


// ── Styles ──
const styles: Record<string, React.CSSProperties> = {
  page: {
    padding: 24,
    maxWidth: 1100,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  backBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '6px 8px',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    display: 'flex',
    alignItems: 'center',
  },
  panel: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 16,
  },
  btnPrimary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  btnSecondary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontWeight: 500,
    fontSize: 13,
    cursor: 'pointer',
  },
  btnDanger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid rgba(248,113,113,0.3)',
    background: 'rgba(248,113,113,0.1)',
    color: '#f87171',
    fontWeight: 500,
    fontSize: 12,
    cursor: 'pointer',
  },
  btnSmall: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    fontSize: 11,
    cursor: 'pointer',
  },
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderRadius: 8,
    background: 'rgba(248,113,113,0.1)',
    border: '1px solid rgba(248,113,113,0.3)',
    color: '#f87171',
    fontSize: 13,
  },
  formGrid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    display: 'flex',
    alignItems: 'center',
  },
  input: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-deep)',
    color: 'var(--text-primary)',
    fontSize: 13,
    outline: 'none',
  },
  select: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-deep)',
    color: 'var(--text-primary)',
    fontSize: 13,
    outline: 'none',
  },
  textarea: {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-deep)',
    color: 'var(--text-primary)',
    fontSize: 13,
    outline: 'none',
    resize: 'vertical' as const,
    fontFamily: 'inherit',
    lineHeight: 1.5,
  },
  dropZone: {
    position: 'relative' as const,
    padding: 24,
    borderRadius: 10,
    border: '2px dashed var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 80,
    transition: 'border-color 0.2s',
  },
  templateCard: {
    padding: 10,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-deep)',
  },
  categoryBadge: {
    display: 'inline-block',
    marginTop: 6,
    padding: '1px 6px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    background: 'rgba(96,165,250,0.12)',
    color: 'var(--accent)',
    textTransform: 'uppercase' as const,
  },
  jobCard: {
    padding: '12px 16px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    background: 'var(--border)',
    overflow: 'hidden' as const,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    background: 'var(--accent)',
    transition: 'width 0.3s ease',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
    color: 'var(--text-tertiary)',
  },
  ratingCard: {
    padding: 16,
    borderRadius: 12,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
  },
  ratingCompact: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 2,
    padding: '4px 12px',
  },
  ratingItem: {
    padding: 8,
    borderRadius: 6,
    background: 'var(--bg-deep)',
  },
  ratingBar: {
    height: 3,
    borderRadius: 2,
    background: 'var(--border)',
    marginTop: 4,
    overflow: 'hidden' as const,
  },
  ratingBarFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
  chapterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid transparent',
    transition: 'background 0.15s',
    background: 'var(--bg-deep)',
  },
  textViewer: {
    maxHeight: 400,
    overflow: 'auto',
    padding: 12,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-deep)',
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap' as const,
    fontFamily: 'Georgia, serif',
  },
};
