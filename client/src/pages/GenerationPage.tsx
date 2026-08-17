import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { generation } from '../services/api';
import { toast } from '../components/Toast';
import { Zap, Loader, Square, CheckCircle, XCircle, Clock, BookOpen, ChevronDown, ChevronRight } from 'lucide-react';

interface ChapterStatus {
  chapter_id: string;
  title: string;
  sort_order: number;
  total_segments: number;
  with_audio: number;
  ready_to_generate: number;
  missing_audio: number;
}

interface JobInfo {
  id: string;
  scope: string;
  status: string;
  total_segments: number;
  completed_segments: number;
  cached_segments: number;
  failed_segments: number;
  skipped_segments: number;
  errors: string[];
  current_chapter: string | null;
  current_segment: string | null;
  started_at: string | null;
  completed_at: string | null;
  clips_created?: number;
  markers_created?: number;
  total_duration_ms?: number;
}

export function GenerationPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [chapters, setChapters] = useState<ChapterStatus[]>([]);
  const [totals, setTotals] = useState({ total_segments: 0, with_audio: 0, ready_to_generate: 0, missing_audio: 0 });
  const [jobs, setJobs] = useState<any[]>([]);
  const [activeJob, setActiveJob] = useState<JobInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
  const [regenerate, setRegenerate] = useState(false);
  const [expandedErrors, setExpandedErrors] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [autoPopulate, setAutoPopulate] = useState(true);
  const [resuming, setResuming] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    if (!bookId) return;
    try {
      const data = await generation.status(bookId);
      setChapters(data.chapters);
      setTotals(data.totals);
      setJobs(data.jobs);
      const running = data.jobs.find((j: any) => j.status === 'running');
      if (running) {
        pollJob(running.id);
      } else {
        const interrupted = data.jobs.find((j: any) => j.status === 'interrupted');
        if (interrupted) {
          setActiveJob({ ...interrupted, errors: JSON.parse(interrupted.errors || '[]'), scope_ids: interrupted.scope_ids ? JSON.parse(interrupted.scope_ids) : null });
        }
      }
    } catch (err: any) {
      toast.error(`Failed to load status: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const pollJob = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      if (!bookId) return;
      try {
        const job = await generation.job(bookId, jobId);
        setActiveJob(job);
        if (job.status !== 'running') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setGenerating(false);
          loadStatus();
        }
      } catch { /* ignore poll errors */ }
    };
    poll();
    pollRef.current = setInterval(poll, 1500);
  }, [bookId, loadStatus]);

  const handleStartBook = async () => {
    if (!bookId) return;
    setGenerating(true);
    try {
      const { job_id } = await generation.start(bookId, { scope: 'book', regenerate, auto_populate: autoPopulate });
      toast.success('Generation started for entire book');
      pollJob(job_id);
    } catch (err: any) {
      setGenerating(false);
      toast.error(err.message);
    }
  };

  const handleStartChapters = async () => {
    if (!bookId || selectedChapters.size === 0) {
      toast.error('Please select at least one chapter first');
      return;
    }
    setGenerating(true);
    try {
      const ids = Array.from(selectedChapters);
      const { job_id } = await generation.start(bookId, {
        scope: 'chapter',
        scope_ids: ids,
        regenerate,
        auto_populate: autoPopulate,
      });
      const names = chapters
        .filter(c => selectedChapters.has(c.chapter_id))
        .map(c => c.title)
        .slice(0, 3)
        .join(', ');
      const suffix = selectedChapters.size > 3 ? ` +${selectedChapters.size - 3} more` : '';
      toast.success(`Generating: ${names}${suffix}`);
      pollJob(job_id);
    } catch (err: any) {
      setGenerating(false);
      toast.error(err.message);
    }
  };

  const handleCancel = async () => {
    if (!bookId || !activeJob) return;
    try {
      await generation.cancel(bookId, activeJob.id);
      toast.success('Cancelling generation...');
    } catch (err: any) { toast.error(err.message); }
  };

  const handleResume = async () => {
    if (!bookId || !activeJob) return;
    setResuming(true);
    try {
      const { job_id, remaining_segments } = await generation.resume(bookId, activeJob.id);
      toast.success(`Resuming generation — ${remaining_segments} segment${remaining_segments === 1 ? '' : 's'} remaining`);
      pollJob(job_id);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setResuming(false);
    }
  };

  const toggleChapter = (id: string) => {
    const ch = chapters.find(c => c.chapter_id === id);
    if (ch && ch.total_segments === 0) return; // can't select unparsed chapters
    setSelectedChapters(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedChapters(new Set(chapters.filter(c => c.total_segments > 0).map(c => c.chapter_id)));
  const selectNone = () => setSelectedChapters(new Set());
  const selectMissing = () => {
    const missing = chapters.filter(c => c.missing_audio > 0 && c.total_segments > 0).map(c => c.chapter_id);
    if (missing.length === 0) {
      toast.info('All chapters already have audio');
      return;
    }
    setSelectedChapters(new Set(missing));
  };

  const isRunning = activeJob?.status === 'running';
  const isInterrupted = activeJob?.status === 'interrupted';
  const jobProgress = activeJob && activeJob.total_segments > 0
    ? ((activeJob.completed_segments + activeJob.cached_segments + activeJob.failed_segments + activeJob.skipped_segments) / activeJob.total_segments) * 100
    : 0;

  const canGenerate = !isRunning && !generating;
  const bookDisabled = !canGenerate || totals.total_segments === 0;
  const chapterDisabled = !canGenerate || selectedChapters.size === 0;

  if (loading) {
    return (
      <div style={S.container}>
        <div style={S.loading}><Loader size={20} className="spin" /> Loading generation status...</div>
      </div>
    );
  }

  return (
    <div style={S.container}>
      {/* Header */}
      <div style={S.header}>
        <h1 style={S.title}><Zap size={20} /> Generate narration</h1>
        <p style={S.subtitle}>Create narration for the whole audiobook, selected chapters, or only the sections you want to refine.</p>
      </div>

      {/* Stats cards */}
      <div style={S.cards}>
        <div style={S.card}>
          <div style={S.cardLabel}>Total paragraphs</div>
          <div style={S.cardValue}>{totals.total_segments}</div>
        </div>
        <div style={{ ...S.card, borderColor: 'rgba(74,222,128,0.3)' }}>
          <div style={S.cardLabel}>Audio ready</div>
          <div style={{ ...S.cardValue, color: '#4ade80' }}>{totals.with_audio}</div>
        </div>
        <div style={{ ...S.card, borderColor: 'rgba(251,191,36,0.3)' }}>
          <div style={S.cardLabel}>Needs audio</div>
          <div style={{ ...S.cardValue, color: '#fbbf24' }}>{totals.missing_audio}</div>
        </div>
        <div style={{ ...S.card, borderColor: 'rgba(91,141,239,0.3)' }}>
          <div style={S.cardLabel}>Ready to create</div>
          <div style={{ ...S.cardValue, color: '#5b8def' }}>{totals.ready_to_generate}</div>
        </div>
      </div>

      {/* Book progress */}
      {totals.total_segments > 0 && (
        <div style={S.overallProgress}>
          <div style={S.progressLabel}>
            <span>Book Progress</span>
            <span>{totals.with_audio}/{totals.total_segments} segments ({Math.round((totals.with_audio / totals.total_segments) * 100)}%)</span>
          </div>
          <div style={S.progressTrack}>
            <div style={{ ...S.progressFill, width: `${(totals.with_audio / totals.total_segments) * 100}%` }} />
          </div>
        </div>
      )}

      {/* Active job panel */}
      {activeJob && (
        <div style={{ ...S.jobPanel, borderColor: isRunning ? 'rgba(91,141,239,0.4)' : isInterrupted ? 'rgba(251,191,36,0.4)' : activeJob.status === 'completed' ? 'rgba(74,222,128,0.4)' : 'rgba(239,68,68,0.4)' }}>
          <div style={S.jobHeader}>
            <div style={S.jobTitle}>
              {isRunning ? <Loader size={14} className="spin" /> : activeJob.status === 'completed' ? <CheckCircle size={14} style={{ color: '#4ade80' }} /> : <XCircle size={14} style={{ color: isInterrupted ? '#fbbf24' : '#ef4444' }} />}
              <span>Generation Job — {activeJob.scope === 'book' ? 'Entire Book' : activeJob.scope === 'chapter' ? 'Selected Chapters' : 'Selected Segments'}</span>
              <span style={{ ...S.statusBadge, background: isRunning ? 'rgba(91,141,239,0.2)' : isInterrupted ? 'rgba(251,191,36,0.2)' : activeJob.status === 'completed' ? 'rgba(74,222,128,0.2)' : 'rgba(239,68,68,0.2)', color: isRunning ? '#5b8def' : isInterrupted ? '#fbbf24' : activeJob.status === 'completed' ? '#4ade80' : '#ef4444' }}>
                {activeJob.status}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {isRunning && (
                <button onClick={handleCancel} style={S.cancelBtn}><Square size={12} /> Cancel</button>
              )}
              {isInterrupted && (
                <button onClick={handleResume} disabled={resuming} style={S.secondaryBtn}>
                  {resuming ? <Loader size={12} className="spin" /> : <Zap size={12} />} Resume
                </button>
              )}
              {!isRunning && (
                <button onClick={() => setActiveJob(null)} style={S.ghostBtn}>Dismiss</button>
              )}
            </div>
          </div>
          {isInterrupted && (
            <p style={{ fontSize: 11, color: '#fbbf24', margin: '0 0 8px' }}>
              This job was interrupted by a server restart. Progress up to this point is safe — click Resume to continue with the remaining segments.
            </p>
          )}

          <div style={S.progressTrack}>
            <div style={{ ...S.progressFill, width: `${jobProgress}%`, background: isRunning ? '#5b8def' : activeJob.status === 'completed' ? '#4ade80' : '#ef4444' }} />
          </div>

          <div style={S.jobStats}>
            <span>✅ {activeJob.completed_segments} generated</span>
            <span>💾 {activeJob.cached_segments} cached</span>
            <span>⏭️ {activeJob.skipped_segments} skipped</span>
            <span>❌ {activeJob.failed_segments} failed</span>
            <span style={{ color: '#666' }}>of {activeJob.total_segments} total</span>
          </div>

          {activeJob.status === 'completed' && !!activeJob.clips_created && (
            <div style={S.currentWork}>
              🎬 Auto-arranged {activeJob.clips_created} clip{activeJob.clips_created !== 1 ? 's' : ''} onto the timeline ({activeJob.markers_created} chapter marker{activeJob.markers_created !== 1 ? 's' : ''}).
            </div>
          )}

          {isRunning && activeJob.current_chapter && (
            <div style={S.currentWork}>
              Currently: <strong>{activeJob.current_chapter}</strong>
              {activeJob.current_segment && <span style={{ color: '#666' }}> — {activeJob.current_segment}...</span>}
            </div>
          )}

          {activeJob.errors.length > 0 && (
            <div style={S.errorsSection}>
              <button onClick={() => setExpandedErrors(!expandedErrors)} style={S.errorsToggle}>
                {expandedErrors ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {activeJob.errors.length} error(s)
              </button>
              {expandedErrors && (
                <div style={S.errorsList}>
                  {activeJob.errors.map((e, i) => <div key={i} style={S.errorItem}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Generation Actions ── */}
      <div style={S.actionsPanel}>
        <div style={S.actionsTop}>
          <button
            onClick={handleStartBook}
            disabled={bookDisabled}
            style={{
              ...S.primaryBtn,
              ...(bookDisabled ? S.btnDisabled : {}),
            }}
          >
            {generating && !isRunning ? <Loader size={14} className="spin" /> : <Zap size={14} />}
            {regenerate ? 'Regenerate full audiobook' : 'Generate full audiobook'}
          </button>

          <button
            onClick={handleStartChapters}
            disabled={chapterDisabled}
            style={{
              ...S.secondaryBtn,
              ...(chapterDisabled ? S.btnDisabled : {}),
            }}
          >
            {generating && !isRunning ? <Loader size={14} className="spin" /> : <BookOpen size={14} />}
            {selectedChapters.size > 0
              ? `${regenerate ? 'Regenerate' : 'Generate'} ${selectedChapters.size} Chapter${selectedChapters.size !== 1 ? 's' : ''}`
              : 'Select Chapters Below'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' as const }}>
          <label style={S.checkboxLabel}>
            <input type="checkbox" checked={regenerate} onChange={(e) => setRegenerate(e.target.checked)} />
            Regenerate existing audio (overwrite)
          </label>
          <label style={S.checkboxLabel} title="When the job finishes, automatically arrange the generated audio onto the timeline (no manual populate step needed for long books)">
            <input type="checkbox" checked={autoPopulate} onChange={(e) => setAutoPopulate(e.target.checked)} />
            Auto-arrange on timeline when done
          </label>
        </div>

        {selectedChapters.size > 0 && (
          <div style={S.selectionInfo}>
            {selectedChapters.size} chapter{selectedChapters.size !== 1 ? 's' : ''} selected:{' '}
            {chapters
              .filter(c => selectedChapters.has(c.chapter_id))
              .slice(0, 5)
              .map(c => c.title)
              .join(', ')}
            {selectedChapters.size > 5 && ` +${selectedChapters.size - 5} more`}
          </div>
        )}
      </div>

      {/* ── Chapter List ── */}
      <div style={S.chapterSection}>
        <div style={S.chapterHeader}>
          <h2 style={S.sectionTitle}>Chapters</h2>
          <div style={S.selectBtns}>
            <button onClick={selectAll} style={S.linkBtn}>Select All</button>
            <button onClick={selectMissing} style={S.linkBtn}>Select Missing</button>
            <button onClick={selectNone} style={S.linkBtn}>Clear</button>
          </div>
        </div>

        <div style={S.chapterList}>
          {chapters.map((ch) => {
            const pct = ch.total_segments > 0 ? Math.round((ch.with_audio / ch.total_segments) * 100) : 0;
            const isComplete = ch.with_audio === ch.total_segments && ch.total_segments > 0;
            const selected = selectedChapters.has(ch.chapter_id);
            const unparsed = ch.total_segments === 0;

            return (
              <div
                key={ch.chapter_id}
                style={{ ...S.chapterRow, ...(selected ? S.chapterRowSelected : {}), ...(unparsed ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
                onClick={() => toggleChapter(ch.chapter_id)}
                title={unparsed ? 'This chapter has no segments. Parse it first in the Manuscript tab.' : undefined}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={unparsed}
                  onChange={() => {}}
                  style={{ cursor: unparsed ? 'not-allowed' : 'pointer', flexShrink: 0, width: 16, height: 16 }}
                />
                <div style={S.chapterInfo}>
                  <div style={S.chapterTitle}>
                    {isComplete && <CheckCircle size={12} style={{ color: '#4ade80', flexShrink: 0 }} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.title}</span>
                  </div>
                  <div style={S.chapterMeta}>
                    {unparsed
                      ? <span style={{ color: '#ef4444' }}>Not parsed — go to Manuscript tab</span>
                      : <>
                          {ch.with_audio}/{ch.total_segments} segments · {ch.ready_to_generate} ready
                          {ch.missing_audio > 0 && <span style={{ color: '#fbbf24' }}> · {ch.missing_audio} missing</span>}
                        </>
                    }
                  </div>
                </div>
                <div style={S.chapterProgress}>
                  <div style={S.miniTrack}>
                    <div style={{ ...S.miniFill, width: `${pct}%`, background: isComplete ? '#4ade80' : '#5b8def' }} />
                  </div>
                  <span style={S.pctLabel(isComplete)}>{pct}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent jobs */}
      {jobs.length > 0 && (
        <div style={S.historySection}>
          <h2 style={S.sectionTitle}><Clock size={14} /> Generation history</h2>
          <div style={S.jobList}>
            {jobs.filter(j => j.id !== activeJob?.id).slice(0, 5).map((j: any) => (
              <div key={j.id} style={S.historyRow}>
                <span style={{ ...S.statusDot, background: j.status === 'completed' ? '#4ade80' : j.status === 'failed' ? '#ef4444' : '#fbbf24' }} />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 70 }}>{j.scope === 'book' ? 'Full Book' : j.scope === 'chapter' ? 'Chapters' : 'Segments'}</span>
                <span style={{ fontSize: 11, color: '#666', flex: 1 }}>
                  {j.completed_segments + j.cached_segments}/{j.total_segments} done
                  {j.failed_segments > 0 && `, ${j.failed_segments} failed`}
                </span>
                <span style={{ fontSize: 10, color: '#555' }}>
                  {j.completed_at ? new Date(j.completed_at).toLocaleString() : j.started_at ? new Date(j.started_at).toLocaleString() : ''}
                </span>
                <button onClick={() => { setActiveJob({ ...j, errors: JSON.parse(j.errors || '[]'), scope_ids: j.scope_ids ? JSON.parse(j.scope_ids) : null }); }} style={S.ghostBtn}>View</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const S: Record<string, any> = {
  container: { padding: '28px 28px 48px', maxWidth: 900, margin: '0 auto' },
  loading: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-tertiary)', padding: 40, justifyContent: 'center' },
  header: { marginBottom: 24 },
  title: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8, margin: 0, letterSpacing: '-0.3px' },
  subtitle: { fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4, margin: 0 },

  // Stats cards
  cards: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 },
  card: { background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '14px 16px' },
  cardLabel: { fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 },
  cardValue: { fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' },

  // Progress
  overallProgress: { marginBottom: 24 },
  progressLabel: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 },
  progressTrack: { height: 6, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--success)', borderRadius: 3, transition: 'width 0.3s ease' },

  // Job panel
  jobPanel: { background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 16, marginBottom: 24 },
  jobHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12 },
  jobTitle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flexWrap: 'wrap' as const },
  statusBadge: { fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' as const },
  jobStats: { display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, flexWrap: 'wrap' as const },
  currentWork: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8, padding: '6px 10px', background: 'var(--bg-deep)', borderRadius: 6 },
  cancelBtn: { display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '5px 12px', fontSize: 11, cursor: 'pointer', fontWeight: 500, whiteSpace: 'nowrap' as const },
  errorsSection: { marginTop: 10 },
  errorsToggle: { display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--danger)', fontSize: 11, cursor: 'pointer', padding: 0 },
  errorsList: { marginTop: 6, maxHeight: 150, overflowY: 'auto' as const, background: 'var(--bg-deep)', borderRadius: 6, padding: 8 },
  errorItem: { fontSize: 10, color: 'var(--danger)', padding: '2px 0', borderBottom: '1px solid var(--border-subtle)' },

  // Actions panel
  actionsPanel: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 10,
    padding: 16,
    marginBottom: 24,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  actionsTop: {
    display: 'flex',
    gap: 10,
    alignItems: 'stretch',
    flexWrap: 'wrap' as const,
  },
  primaryBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    background: '#2d5a27',
    color: '#8f8',
    border: '1px solid rgba(74,222,128,0.3)',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 150ms',
    whiteSpace: 'nowrap' as const,
  },
  secondaryBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    background: 'rgba(91,141,239,0.1)',
    color: '#5b8def',
    border: '1px solid rgba(91,141,239,0.3)',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 150ms',
    whiteSpace: 'nowrap' as const,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
    pointerEvents: 'none' as const,
  },
  ghostBtn: {
    background: 'none',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-tertiary)',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  selectionInfo: {
    fontSize: 11,
    color: '#5b8def',
    padding: '8px 12px',
    background: 'rgba(91,141,239,0.06)',
    borderRadius: 6,
    border: '1px solid rgba(91,141,239,0.15)',
    lineHeight: 1.5,
  },

  // Chapter list
  chapterSection: { marginBottom: 24 },
  chapterHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, margin: 0 },
  selectBtns: { display: 'flex', gap: 12 },
  linkBtn: { background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', padding: 0, textDecoration: 'underline' },
  chapterList: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  chapterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    background: 'var(--bg-base)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'all 150ms',
  },
  chapterRowSelected: {
    borderColor: 'rgba(91,141,239,0.4)',
    background: 'rgba(91,141,239,0.05)',
  },
  chapterInfo: { flex: 1, minWidth: 0, overflow: 'hidden' },
  chapterTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    overflow: 'hidden',
  },
  chapterMeta: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 },
  chapterProgress: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    minWidth: 120,
    justifyContent: 'flex-end',
  },
  miniTrack: { width: 80, height: 4, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden' },
  miniFill: { height: '100%', borderRadius: 2, transition: 'width 0.3s ease' },
  pctLabel: (isComplete: boolean): React.CSSProperties => ({
    fontSize: 11,
    color: isComplete ? 'var(--success)' : 'var(--text-tertiary)',
    minWidth: 32,
    textAlign: 'right',
  }),

  // History
  historySection: { marginTop: 24 },
  jobList: { display: 'flex', flexDirection: 'column' as const, gap: 4, marginTop: 8 },
  historyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    background: 'var(--bg-base)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
  },
  statusDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
};
