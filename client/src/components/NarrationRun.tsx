import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { isTerminalJobStatus, type NarrationJobStatus } from "@shared/narration";

/**
 * Live view of a narration run.
 *
 * Everything shown here is derived from stored audio on the server, not from a
 * client-side timer: the percentage is rendered segments over total segments, and
 * the duration is measured from the audio files themselves. That means the number
 * on screen is the number of minutes of book that actually exist.
 */

/** A run is considered stalled when the worker has not checkpointed recently. */
const STALL_WARNING_SECONDS = 90;

const ACTIVE_STATUSES: readonly (NarrationJobStatus | "idle")[] = ["queued", "running"];

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

const statusLabel: Record<NarrationJobStatus | "idle", string> = {
  idle: "Not started",
  queued: "Queued",
  running: "Rendering",
  paused: "Paused",
  completed: "Complete",
  failed: "Needs attention",
  cancelled: "Cancelled",
};

const statusTone: Record<NarrationJobStatus | "idle", string> = {
  idle: "bg-[#eef0ed] text-[#7b8584]",
  queued: "bg-[#e9f0f5] text-[#4a6f85]",
  running: "bg-[#e4f2eb] text-[#397868]",
  paused: "bg-[#fff1dc] text-[#a87528]",
  completed: "bg-[#e4f2eb] text-[#397868]",
  failed: "bg-[#fbe9e4] text-[#a35a44]",
  cancelled: "bg-[#eef0ed] text-[#7b8584]",
};

export function NarrationRun({
  projectId,
  canRender,
  disabledReason,
}: {
  projectId: string;
  /** False for a local preview project that has nothing on the server yet. */
  canRender: boolean;
  disabledReason: string;
}) {
  const utils = trpc.useUtils();
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
  const [showLog, setShowLog] = useState(false);

  const status = trpc.bookx.narrationStatus.useQuery(
    { projectId },
    {
      enabled: canRender,
      // Poll only while there is something to watch, so an idle screen is quiet.
      refetchInterval: query => (ACTIVE_STATUSES.includes(query.state.data?.status ?? "idle") ? 2000 : false),
    },
  );

  const audit = trpc.bookx.auditNarration.useQuery({ projectId }, { enabled: canRender });

  const invalidate = () => {
    utils.bookx.narrationStatus.invalidate({ projectId });
    utils.bookx.auditNarration.invalidate({ projectId });
    utils.bookx.getWorkspace.invalidate({ projectId });
  };

  const onError = (fallback: string) => (error: { message?: string }) => toast.error(error.message || fallback);

  const start = trpc.bookx.startNarration.useMutation({
    onSuccess: result => {
      invalidate();
      toast.success(result.resumed ? "Picking up where the last run stopped." : "Narration started.");
    },
    onError: onError("Bookx could not start narration."),
  });
  const pause = trpc.bookx.pauseNarration.useMutation({
    onSuccess: () => { invalidate(); toast("Pausing after the current segment. Everything rendered is kept."); },
    onError: onError("Bookx could not pause the run."),
  });
  const resume = trpc.bookx.resumeNarration.useMutation({
    onSuccess: () => { invalidate(); toast.success("Resuming just before where it stopped."); },
    onError: onError("Bookx could not resume the run."),
  });
  const cancel = trpc.bookx.cancelNarration.useMutation({
    onSuccess: () => { invalidate(); toast("Run cancelled. Rendered audio is kept."); },
    onError: onError("Bookx could not cancel the run."),
  });
  const retry = trpc.bookx.retryFailedNarration.useMutation({
    onSuccess: result => { invalidate(); toast.success(`Retrying ${result.reset} unrendered segment(s).`); },
    onError: onError("Bookx could not retry the unrendered segments."),
  });

  const data = status.data;
  const jobStatus = data?.status ?? "idle";
  const active = ACTIVE_STATUSES.includes(jobStatus);
  const busy = start.isPending || resume.isPending || retry.isPending;

  const stalled = useMemo(
    () => jobStatus === "running" && (data?.secondsSinceHeartbeat ?? 0) > STALL_WARNING_SECONDS,
    [jobStatus, data?.secondsSinceHeartbeat],
  );

  const chapters = data?.chapters ?? [];
  const chapterIds = useMemo(
    () => (selectedChapters.size ? chapters.filter(c => selectedChapters.has(c.chapterId)).map(c => c.chapterId) : undefined),
    [chapters, selectedChapters],
  );

  const toggleChapter = (chapterId: string) => setSelectedChapters(current => {
    const next = new Set(current);
    if (next.has(chapterId)) next.delete(chapterId);
    else next.add(chapterId);
    return next;
  });

  if (!canRender) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header status="idle" />
        <div className="flex flex-1 items-center justify-center p-9">
          <div className="max-w-md rounded-[22px] border border-dashed border-[#d4ded7] bg-[#fbfcf9] p-7 text-center">
            <Sparkles className="mx-auto mb-4 text-[#a3b3ac]" size={26} />
            <h3 className="font-bold text-[#35494b]">Narration runs on saved projects</h3>
            <p className="mt-2 text-sm leading-6 text-[#748285]">{disabledReason}</p>
          </div>
        </div>
      </div>
    );
  }

  const percent = data?.percent ?? 0;
  const total = data?.totalSegments ?? 0;
  const completed = data?.completedSegments ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        status={jobStatus}
        actions={
          <>
            {jobStatus === "running" || jobStatus === "queued" ? (
              <>
                <button
                  onClick={() => data?.jobId && pause.mutate({ projectId, jobId: data.jobId })}
                  disabled={pause.isPending || data?.stopping}
                  className="btn-soft disabled:opacity-50"
                >
                  <Pause className="mr-1 inline" size={14} /> {data?.stopping ? "Stopping…" : "Pause"}
                </button>
                <button
                  onClick={() => data?.jobId && cancel.mutate({ projectId, jobId: data.jobId })}
                  disabled={cancel.isPending}
                  className="btn-soft disabled:opacity-50"
                >
                  <X className="mr-1 inline" size={14} /> Cancel
                </button>
              </>
            ) : jobStatus === "paused" ? (
              <button
                onClick={() => data?.jobId && resume.mutate({ projectId, jobId: data.jobId })}
                disabled={busy}
                className="btn-primary disabled:opacity-50"
              >
                <Play className="mr-1 inline" size={14} /> Resume
              </button>
            ) : (
              <button
                onClick={() => start.mutate({ projectId, chapterIds })}
                disabled={busy}
                className="btn-primary disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="mr-1 inline animate-spin" size={14} /> : <Sparkles className="mr-1 inline" size={14} />}
                {completed > 0 && completed < total ? "Continue narration" : selectedChapters.size ? `Render ${selectedChapters.size} chapter(s)` : "Render all narration"}
              </button>
            )}
          </>
        }
      />

      <div className="grid flex-1 gap-6 overflow-auto p-6 lg:grid-cols-[minmax(0,1fr)_340px] md:p-9">
        <section className="space-y-5">
          {stalled && (
            <Banner
              tone="warn"
              icon={<TriangleAlert size={16} />}
              title="The provider has gone quiet"
              body={`No progress for ${data?.secondsSinceHeartbeat}s. Bookx is still retrying the current segment with backoff. You can pause and resume later — it will restart just before this point, so nothing overlaps or goes missing.`}
            />
          )}

          {jobStatus === "paused" && (
            <Banner
              tone="info"
              icon={<Pause size={16} />}
              title="Paused and safe to leave"
              body={`${completed} of ${total} segments are rendered and stored. Resuming re-renders the segment that was in flight plus the one before it, so the join is clean.`}
            />
          )}

          {jobStatus === "failed" && (data?.failures.length ?? 0) > 0 && (
            <Banner
              tone="error"
              icon={<AlertCircle size={16} />}
              title={`${data?.failures.length} segment(s) did not render`}
              body="Everything else is intact. Retrying re-renders only the missing segments."
              action={
                <button onClick={() => retry.mutate({ projectId })} disabled={retry.isPending} className="btn-soft mt-3 disabled:opacity-50">
                  <RefreshCw className="mr-1 inline" size={13} /> Retry unrendered segments
                </button>
              }
            />
          )}

          {jobStatus === "idle" && total === 0 && (
            <Banner
              tone="info"
              icon={<AlertCircle size={16} />}
              title="No narration segments yet"
              body="Add chapter text in Write. Bookx splits it into render units sized for your voice model when you start a run."
            />
          )}

          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Segments" value={total ? `${completed} / ${total}` : "—"} />
            <Stat label="Audio rendered" value={formatDuration(data?.renderedDurationMs ?? 0)} />
            <Stat label="Reused" value={data?.skippedSegments ? String(data.skippedSegments) : "0"} />
            <Stat label="Unrendered" value={total ? String(Math.max(0, total - completed)) : "—"} />
          </div>

          <div className="rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5">
            <div className="mb-3 flex items-end justify-between">
              <div>
                <h3 className="font-bold">Progress</h3>
                <p className="mt-1 text-sm text-[#7b888a]">
                  Measured from stored audio, so this is how much of the book exists — not an estimate.
                </p>
              </div>
              <span className="text-sm font-bold text-[#2d7470]">{percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[#ebeeea]">
              <div
                className="h-full rounded-full bg-[#4e9287] transition-[width] duration-500 ease-out"
                style={{ width: `${percent}%` }}
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Narration progress"
              />
            </div>
            {data?.pinnedVoice && (
              <p className="mt-3 text-xs text-[#7b888a]">
                Pinned to <strong className="text-[#4a6360]">{data.pinnedVoice.provider}</strong> · {data.pinnedVoice.model}.
                A run never switches provider partway through, so the narrator stays the same voice from start to finish.
              </p>
            )}
          </div>

          <div className="rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="font-bold">Chapters</h3>
                <p className="mt-1 text-sm text-[#7b888a]">
                  {selectedChapters.size ? `${selectedChapters.size} selected for the next run.` : "Nothing selected renders the whole project."}
                </p>
              </div>
              {selectedChapters.size > 0 && (
                <button onClick={() => setSelectedChapters(new Set())} className="text-xs font-bold text-[#34736d]">Clear selection</button>
              )}
            </div>

            {chapters.length === 0 ? (
              <p className="border-t border-[#edf0eb] pt-4 text-sm text-[#7b888a]">No chapters yet.</p>
            ) : (
              chapters.map(chapter => {
                const chapterPercent = chapter.totalSegments
                  ? Math.round((chapter.renderedSegments / chapter.totalSegments) * 100)
                  : 0;
                const done = chapter.totalSegments > 0 && chapter.renderedSegments === chapter.totalSegments;
                return (
                  <label key={chapter.chapterId} className="flex cursor-pointer items-center gap-3 border-t border-[#edf0eb] py-3.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#3f827a]"
                      checked={selectedChapters.has(chapter.chapterId)}
                      onChange={() => toggleChapter(chapter.chapterId)}
                      disabled={active}
                    />
                    <div className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{chapter.title}</strong>
                      <span className="text-xs text-[#7e8b8d]">
                        {chapter.renderedSegments} / {chapter.totalSegments} segments
                        {chapter.durationMs > 0 && ` · ${formatDuration(chapter.durationMs)}`}
                        {chapter.failedSegments > 0 && ` · ${chapter.failedSegments} failed`}
                      </span>
                    </div>
                    <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-[#ebeeea] sm:block">
                      <div className="h-full rounded-full bg-[#7fb0a4]" style={{ width: `${chapterPercent}%` }} />
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] ${done ? "bg-[#e7f2ec] text-[#428174]" : chapter.failedSegments ? "bg-[#fbe9e4] text-[#a35a44]" : "bg-[#eef0ed] text-[#819091]"}`}>
                      {done ? "Ready" : chapter.failedSegments ? "Needs 1+" : `${chapterPercent}%`}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <IntegrityCard audit={audit.data} loading={audit.isLoading} />

          {(data?.failures.length ?? 0) > 0 && (
            <div className="rounded-[22px] border border-[#eddcd4] bg-[#fffaf7] p-5">
              <h3 className="flex items-center gap-2 font-bold text-[#8a4f3a]"><AlertCircle size={15} /> Unrendered segments</h3>
              <ul className="mt-3 space-y-2">
                {data!.failures.slice(-6).map(failure => (
                  <li key={`${failure.segmentId}-${failure.at}`} className="border-t border-[#f2e3dc] pt-2 text-[11px] leading-5 text-[#8a6b5f]">
                    {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5">
            <button
              onClick={() => setShowLog(value => !value)}
              aria-expanded={showLog}
              className="flex w-full items-center justify-between text-left"
            >
              <span className="flex items-center gap-2 font-bold"><Clock3 size={15} className="text-[#5b8b86]" /> Run log</span>
              <span className="text-xs font-bold text-[#34736d]">{showLog ? "Hide" : "Show"}</span>
            </button>
            {showLog && (
              (data?.events.length ?? 0) === 0
                ? <p className="mt-3 text-xs text-[#7e8a8c]">Nothing recorded yet.</p>
                : <ul className="mt-3 space-y-2">
                    {data!.events.slice(-14).reverse().map((event, index) => (
                      <li key={`${event.at}-${index}`} className="border-t border-[#edf0eb] pt-2">
                        <span className="mono block text-[9px] uppercase tracking-[.12em] text-[#9aa3a2]">{event.kind}</span>
                        <span className="block text-[11px] leading-5 text-[#5d6f71]">{event.message}</span>
                      </li>
                    ))}
                  </ul>
            )}
          </div>

          <div className="rounded-[22px] border border-[#cfe0db] bg-[#f5fbf8] p-5">
            <h3 className="font-bold text-[#3a5052]">How interruptions are handled</h3>
            <ul className="mt-3 space-y-2 text-[11px] leading-5 text-[#5f7b78]">
              <li><strong>One segment at a time.</strong> Audio is written per segment and verified before it is stored, so a dropped connection cannot leave a half-written file in the book.</li>
              <li><strong>Resume goes back a step.</strong> The segment that was in flight is re-rendered, along with the one before it, so the join is clean and nothing overlaps.</li>
              <li><strong>Stalls are detected, not waited out.</strong> If the provider stops sending audio it is retried with backoff rather than hanging until the request times out.</li>
              <li><strong>Edits invalidate only what changed.</strong> Each segment stores a hash of its text, so editing one paragraph re-renders that paragraph and nothing else.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Header({ status, actions }: { status: NarrationJobStatus | "idle"; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5 border-b border-[#e1e5de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9">
      <div>
        <p className="mono text-[10px] tracking-[.15em] text-[#5a918b]">03 · PRODUCE</p>
        <h2 className="serif mt-2 text-3xl tracking-[-.04em] text-[#25393c]">Generate narration.</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#738084]">
          Render a long book in resumable passes. Progress is checkpointed after every segment, so you can stop, close the tab, and continue later.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1.5 text-[10px] font-bold ${statusTone[status]}`}>{statusLabel[status].toUpperCase()}</span>
        {actions}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#e0e5de] bg-[#fffefa] p-4">
      <span className="mono text-[10px] text-[#819092]">{label.toUpperCase()}</span>
      <strong className="mt-3 block text-2xl tracking-[-.04em] text-[#304548]">{value}</strong>
    </div>
  );
}

function Banner({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: "info" | "warn" | "error";
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const styles = {
    info: "border-[#cfe0db] bg-[#f2f9f6] text-[#3d6b66]",
    warn: "border-[#ecd9b8] bg-[#fff8ea] text-[#8a6b35]",
    error: "border-[#eddcd4] bg-[#fffaf7] text-[#8a4f3a]",
  }[tone];

  return (
    <div className={`rounded-[20px] border p-4 ${styles}`}>
      <strong className="flex items-center gap-2 text-sm">{icon} {title}</strong>
      <p className="mt-2 text-xs leading-5">{body}</p>
      {action}
    </div>
  );
}

/**
 * The completeness report. This is the answer to "is anything missing or broken?",
 * and it is computed from the stored hashes rather than from run counters.
 */
function IntegrityCard({
  audit,
  loading,
}: {
  audit?: {
    totalSegments: number;
    renderedSegments: number;
    missingSegments: string[];
    staleSegments: string[];
    mismatchedVoiceSegments: string[];
    suspectSegments: string[];
    totalDurationMs: number;
    complete: boolean;
  };
  loading: boolean;
}) {
  if (loading) {
    return <div className="rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5"><div className="skeleton h-4 w-32" /><div className="skeleton mt-3 h-3 w-full" /></div>;
  }
  if (!audit) return null;

  const rows: Array<[string, number, string]> = [
    ["Never rendered", audit.missingSegments.length, "No audio exists for these yet."],
    ["Text changed since", audit.staleSegments.length, "The manuscript was edited after these were rendered."],
    ["Different voice", audit.mismatchedVoiceSegments.length, "Rendered before the project's voice changed."],
    ["Unverified audio", audit.suspectSegments.length, "Stored without a measurable duration."],
  ];
  const problems = rows.filter(([, count]) => count > 0);

  return (
    <div className={`rounded-[22px] border p-5 ${audit.complete ? "border-[#c9dfd5] bg-[#f4fbf7]" : "border-[#e0e5de] bg-[#fffefa]"}`}>
      <h3 className="flex items-center gap-2 font-bold text-[#34484a]">
        {audit.complete ? <ShieldCheck size={16} className="text-[#3d806f]" /> : <AlertCircle size={16} className="text-[#a87528]" />}
        Audio integrity
      </h3>

      {audit.complete ? (
        <p className="mt-2 text-xs leading-5 text-[#4a7168]">
          <CheckCircle2 className="mr-1 inline" size={13} />
          All {audit.totalSegments} segments are rendered from the current text with the current voice.
          {audit.totalDurationMs > 0 && ` ${formatDuration(audit.totalDurationMs)} of audio.`}
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs leading-5 text-[#748285]">
            {audit.renderedSegments} of {audit.totalSegments} segments are current.
          </p>
          <ul className="mt-3 space-y-2">
            {problems.map(([label, count, hint]) => (
              <li key={label} className="border-t border-[#edf0eb] pt-2">
                <span className="flex items-center justify-between text-xs font-semibold text-[#4e6063]">
                  {label}
                  <span className="rounded-full bg-[#f2f4f0] px-2 py-0.5 text-[10px] text-[#7b8584]">{count}</span>
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[#8a9492]">{hint}</span>
              </li>
            ))}
            {problems.length === 0 && (
              <li className="border-t border-[#edf0eb] pt-2 text-[11px] text-[#8a9492]">Nothing outstanding.</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
