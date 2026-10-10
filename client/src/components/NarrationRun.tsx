import { useEffect, useMemo, useRef, useState } from "react";
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
import { isTerminalJobStatus, type ChapterProgress, type NarrationJobStatus } from "@shared/narration";
import { failureSummary } from "@shared/narration";
import { ttsTraits } from "@shared/direction";
import { ChapterPlayer } from "./studio/ChapterPlayer";
import { DirectionEditor } from "./studio/DirectionEditor";
import { NarrationChapterList } from "./studio/NarrationChapterList";
import { NarrationProgressPanel } from "./studio/NarrationProgressPanel";
import { NarrationVoicePanel } from "./studio/NarrationVoicePanel";
import { RegenerateDialog } from "./studio/RegenerateDialog";

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
  idle: "bg-stone-50 text-ink-500",
  queued: "bg-sky-50 text-sky-600",
  running: "bg-brand-50 text-brand-600",
  paused: "bg-gold-100 text-gold-700",
  completed: "bg-brand-50 text-brand-600",
  failed: "bg-clay-100 text-clay-600",
  cancelled: "bg-stone-50 text-ink-500",
};

/**
 * A recast is worth saying out loud: a voice on screen that the creator did not
 * choose should never appear without a reason.
 */
function recastNote(recast: Array<{ name: string; to: string }> | undefined): string {
  if (!recast?.length) return "";
  return ` Recast for this provider: ${recast.map(change => `${change.name} → ${change.to}`).join(", ")}.`;
}

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
  const [playerChapter, setPlayerChapter] = useState<string | null>(null);
  const [directChapter, setDirectChapter] = useState<string | null>(null);
  const [regenChapter, setRegenChapter] = useState<ChapterProgress | null>(null);
  const workspace = trpc.bookx.getWorkspace.useQuery({ projectId }, { enabled: canRender });
  const project = workspace.data?.project;

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
      toast.success(`${result.resumed ? "Picking up where the last run stopped." : "Narration started."}${recastNote(result.recast)}`);
    },
    onError: onError("Prosecast could not start narration."),
  });
  const pause = trpc.bookx.pauseNarration.useMutation({
    onSuccess: () => { invalidate(); toast("Pausing after the current segment. Everything rendered is kept."); },
    onError: onError("Prosecast could not pause the run."),
  });
  const resume = trpc.bookx.resumeNarration.useMutation({
    onSuccess: () => { invalidate(); toast.success("Resuming just before where it stopped."); },
    onError: onError("Prosecast could not resume the run."),
  });
  const cancel = trpc.bookx.cancelNarration.useMutation({
    onSuccess: () => { invalidate(); toast("Run cancelled. Rendered audio is kept."); },
    onError: onError("Prosecast could not cancel the run."),
  });
  const retry = trpc.bookx.retryFailedNarration.useMutation({
    onSuccess: result => { invalidate(); toast.success(`Retrying ${result.reset} unrendered segment(s).${recastNote(result.recast)}`); },
    onError: onError("Prosecast could not retry the unrendered segments."),
  });

  const data = status.data;
  const jobStatus = data?.status ?? "idle";
  const active = ACTIVE_STATUSES.includes(jobStatus);
  const busy = start.isPending || resume.isPending || retry.isPending;

  const stalled = useMemo(
    () => jobStatus === "running" && (data?.secondsSinceHeartbeat ?? 0) > STALL_WARNING_SECONDS,
    [jobStatus, data?.secondsSinceHeartbeat],
  );

  // Only the run status polls, so when a run stopped the integrity card, the
  // Write screen's segment badges and export readiness still showed the numbers
  // from before it. Refresh them once, as the run ends or pauses.
  const previousStatus = useRef(jobStatus);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = jobStatus;
    if (ACTIVE_STATUSES.includes(was) && !ACTIVE_STATUSES.includes(jobStatus)) {
      void utils.bookx.auditNarration.invalidate({ projectId });
      void utils.bookx.getWorkspace.invalidate({ projectId });
      void utils.bookx.exportReadiness.invalidate({ projectId });
    }
  }, [jobStatus, projectId, utils]);

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
          <div className="max-w-md rounded-card border border-dashed border-stone-300 bg-paper/70 p-8 text-center">
            <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-stone-50 text-ink-400 ring-1 ring-stone-150"><Sparkles size={22} /></span>
            <h3 className="serif text-[22px] leading-tight text-ink-950">Narration runs on saved projects</h3>
            <p className="mt-2 text-sm leading-6 text-ink-500">{disabledReason}</p>
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
            {project && (
              <span className="rounded-full bg-stone-50 px-3 py-1.5 text-3xs font-semibold text-ink-600 ring-1 ring-stone-150" title={`${project.voiceProvider} · ${project.voiceModel}`}>
                {project.voiceProvider} · {ttsTraits(project.voiceProvider, project.voiceModel).label}
              </span>
            )}
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

      <div className="grid flex-1 grid-cols-1 content-start gap-6 overflow-auto p-6 lg:grid-cols-[minmax(0,1fr)_340px] md:p-9">
        <section className="min-w-0 space-y-5">
          {stalled && (
            <Banner
              tone="warn"
              icon={<TriangleAlert size={16} />}
              title="The provider has gone quiet"
              body={`No progress for ${data?.secondsSinceHeartbeat}s. Prosecast is still retrying the current segment with backoff. You can pause and resume later — it will restart just before this point, so nothing overlaps or goes missing.`}
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
              body={`${failureSummary(data?.failures ?? [], workspace.data?.segments ?? [], workspace.data?.characters ?? [])} Everything else is intact. Retrying re-renders only the missing segments.`}
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
              body="Add chapter text in Write. Prosecast splits it into render units sized for your voice model when you start a run."
            />
          )}

          {playerChapter && (
            <ChapterPlayer
              projectId={projectId}
              chapterId={playerChapter}
              live={active && ["rendering", "queued"].includes(chapters.find(chapter => chapter.chapterId === playerChapter)?.state ?? "")}
              onNavigate={setPlayerChapter}
              onClose={() => setPlayerChapter(null)}
            />
          )}

          <NarrationProgressPanel data={data} />
          {data?.pinnedVoice && (
            <p className="-mt-2 px-1 text-xs text-ink-500">
              This run is pinned to <strong className="font-semibold text-ink-800">{data.pinnedVoice.provider}</strong> · {data.pinnedVoice.model}, so the narrator stays the same voice from start to finish.
              {data.skippedSegments > 0 && ` ${data.skippedSegments} line${data.skippedSegments === 1 ? " was" : "s were"} reused from earlier runs.`}
            </p>
          )}

          <NarrationChapterList
            chapters={chapters}
            selected={selectedChapters}
            onToggle={toggleChapter}
            onClearSelection={() => setSelectedChapters(new Set())}
            locked={active}
            playingChapterId={playerChapter}
            onListen={setPlayerChapter}
            onDirect={setDirectChapter}
            onRegenerate={setRegenChapter}
          />
        </section>

        <aside className="space-y-4">
          <NarrationVoicePanel projectId={projectId} disabled={active} />
          <IntegrityCard audit={audit.data} loading={audit.isLoading} />

          {(data?.failures.length ?? 0) > 0 && (
            <div className="rounded-card border border-clay-200 bg-clay-50 p-6">
              <h3 className="flex items-center gap-2 text-[15px] font-semibold text-clay-700"><AlertCircle size={15} /> Unrendered segments</h3>
              <ul className="mt-3 space-y-2">
                {data!.failures.slice(-6).map(failure => (
                  <li key={`${failure.segmentId}-${failure.at}`} className="border-t border-clay-100 pt-2 text-2xs leading-5 text-clay-700">
                    {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-card border border-stone-150 bg-paper p-6 shadow-hairline">
            <button
              onClick={() => setShowLog(value => !value)}
              aria-expanded={showLog}
              className="flex w-full items-center justify-between text-left"
            >
              <span className="flex items-center gap-2 text-[15px] font-semibold text-ink-900"><Clock3 size={15} className="text-brand-500" /> Run log</span>
              <span className="text-xs font-semibold text-brand-600">{showLog ? "Hide" : "Show"}</span>
            </button>
            {showLog && (
              (data?.events.length ?? 0) === 0
                ? <p className="mt-3 text-xs text-ink-500">Nothing recorded yet.</p>
                : <ul className="mt-3 space-y-2">
                    {data!.events.slice(-14).reverse().map((event, index) => (
                      <li key={`${event.at}-${index}`} className="border-t border-stone-100 pt-2">
                        <span className="eyebrow block text-3xs text-ink-500">{event.kind}</span>
                        <span className="block text-2xs leading-5 text-ink-600">{event.message}</span>
                      </li>
                    ))}
                  </ul>
            )}
          </div>

          <div className="rounded-card border border-brand-100 bg-brand-50/60 p-6">
            <h3 className="serif text-[22px] leading-tight text-ink-950">How interruptions are handled</h3>
            <ul className="mt-4 space-y-3 text-2xs leading-5 text-ink-600 [&_strong]:font-semibold [&_strong]:text-ink-900">
              <li><strong>One segment at a time.</strong> Audio is written per segment and verified before it is stored, so a dropped connection cannot leave a half-written file in the book.</li>
              <li><strong>Resume goes back a step.</strong> The segment that was in flight is re-rendered, along with the one before it, so the join is clean and nothing overlaps.</li>
              <li><strong>Stalls are detected, not waited out.</strong> If the provider stops sending audio it is retried with backoff rather than hanging until the request times out.</li>
              <li><strong>Edits invalidate only what changed.</strong> Each segment stores a hash of its text, so editing one paragraph re-renders that paragraph and nothing else.</li>
            </ul>
          </div>
        </aside>
      </div>

      <DirectionEditor projectId={projectId} chapterId={directChapter} open={Boolean(directChapter)} onOpenChange={open => { if (!open) setDirectChapter(null); }} />
      <RegenerateDialog
        projectId={projectId}
        chapter={regenChapter ? { id: regenChapter.chapterId, title: regenChapter.title } : null}
        open={Boolean(regenChapter)}
        onOpenChange={open => { if (!open) setRegenChapter(null); }}
        activeJobId={jobStatus === "running" || jobStatus === "queued" ? data?.jobId ?? null : null}
      />
    </div>
  );
}

function Header({ status, actions }: { status: NarrationJobStatus | "idle"; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5 border-b border-stone-150 bg-paper px-6 py-7 md:flex-row md:items-end md:justify-between md:px-9">
      <div className="min-w-0">
        <p className="eyebrow text-brand-600">03 · PRODUCE</p>
        <h2 className="serif mt-2 text-[34px] leading-[1.1] tracking-[-.02em] text-ink-950">Generate narration.</h2>
        <p className="mt-2.5 max-w-2xl text-sm leading-6 text-ink-500">
          Render a long book in resumable passes. Progress is checkpointed after every segment, so you can stop, close the tab, and continue later.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-3xs font-semibold tracking-[.12em] ${statusTone[status]}`}><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />{statusLabel[status].toUpperCase()}</span>
        {actions}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-150 bg-paper p-4 shadow-hairline">
      <span className="eyebrow text-3xs text-ink-500">{label.toUpperCase()}</span>
      <strong className="mt-3 block text-[26px] font-semibold leading-none tracking-[-.02em] tabular-nums text-ink-900">{value}</strong>
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
    info: "border-brand-100 bg-brand-50 text-brand-700",
    warn: "border-gold-200 bg-gold-50 text-gold-700",
    error: "border-clay-200 bg-clay-50 text-clay-700",
  }[tone];

  return (
    <div className={`rounded-card border p-5 ${styles}`}>
      <strong className="flex items-center gap-2 text-sm font-semibold">{icon} {title}</strong>
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
    return <div className="rounded-card border border-stone-150 bg-paper p-6"><div className="skeleton h-4 w-32" /><div className="skeleton mt-3 h-3 w-full" /></div>;
  }
  if (!audit) return null;

  const rows: Array<[string, number, string]> = [
    ["Never rendered", audit.missingSegments.length, "No audio exists for these yet."],
    ["Text or direction changed", audit.staleSegments.length, "The text, pronunciation or direction changed after these were rendered."],
    ["Different voice", audit.mismatchedVoiceSegments.length, "Rendered before the project's voice changed."],
    ["Unverified audio", audit.suspectSegments.length, "Stored without a measurable duration."],
  ];
  const problems = rows.filter(([, count]) => count > 0);

  return (
    <div className={`rounded-card border p-6 ${audit.complete ? "border-brand-200 bg-brand-50" : "border-stone-150 bg-paper shadow-hairline"}`}>
      <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink-900">
        {audit.complete ? <ShieldCheck size={16} className="text-brand-500" /> : <AlertCircle size={16} className="text-gold-600" />}
        Audio integrity
      </h3>

      {audit.complete ? (
        <p className="mt-2 text-xs leading-5 text-brand-600">
          <CheckCircle2 className="mr-1 inline" size={13} />
          All {audit.totalSegments} segments are rendered from the current text with the current voice.
          {audit.totalDurationMs > 0 && ` ${formatDuration(audit.totalDurationMs)} of audio.`}
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs leading-5 text-ink-500">
            {audit.renderedSegments} of {audit.totalSegments} segments are current.
          </p>
          <ul className="mt-3 space-y-2">
            {problems.map(([label, count, hint]) => (
              <li key={label} className="border-t border-stone-100 pt-2">
                <span className="flex items-center justify-between text-xs font-semibold text-ink-600">
                  {label}
                  <span className="rounded-full bg-stone-50 px-2 py-0.5 text-3xs font-semibold tabular-nums text-ink-600 ring-1 ring-stone-150">{count}</span>
                </span>
                <span className="mt-0.5 block text-2xs leading-4 text-ink-500">{hint}</span>
              </li>
            ))}
            {problems.length === 0 && (
              <li className="border-t border-stone-100 pt-2 text-2xs text-ink-500">Nothing outstanding.</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
