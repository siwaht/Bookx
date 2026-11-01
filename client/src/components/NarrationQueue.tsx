import { ArrowRight, LoaderCircle, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

const statusLabel = { queued: "Queued", running: "Narrating", paused: "Paused" } as const;
const statusTone = {
  queued: "bg-sky-50 text-sky-600",
  running: "bg-brand-50 text-brand-600",
  paused: "bg-gold-100 text-gold-700",
} as const;

/**
 * Every book with a live narration run, on the dashboard. Books narrate
 * side by side, so the creator can start one, open another and start it too,
 * and watch or pause them all from here.
 */
export function NarrationQueue({ enabled, onOpen }: { enabled: boolean; onOpen: (projectId: string) => void }) {
  const utils = trpc.useUtils();
  const queue = trpc.bookx.narrationQueue.useQuery(undefined, {
    enabled,
    // Fast while something is rendering, slow otherwise, never while hidden.
    refetchInterval: query => (query.state.data?.some(run => run.status !== "paused") ? 5_000 : 30_000),
    refetchIntervalInBackground: false,
  });
  const refresh = () => void utils.bookx.narrationQueue.invalidate();
  const pause = trpc.bookx.pauseNarration.useMutation({
    onSuccess: refresh,
    onError: error => toast.error(error.message || "Prosecast could not pause that book."),
  });
  const resume = trpc.bookx.resumeNarration.useMutation({
    onSuccess: refresh,
    onError: error => toast.error(error.message || "Prosecast could not resume that book."),
  });

  const runs = queue.data ?? [];
  if (!enabled || !runs.length) return null;
  const busy = pause.isPending || resume.isPending;

  return (
    <section aria-labelledby="narration-queue-title" className="mb-14">
      <div className="mb-4 flex items-end justify-between gap-4 border-b border-stone-150 pb-4">
        <div>
          <p className="eyebrow text-ink-500">IN THE STUDIO</p>
          <h2 id="narration-queue-title" className="serif mt-1.5 text-[28px] leading-tight tracking-[-.02em] text-ink-950">Narrating now</h2>
        </div>
        <span className="text-xs text-ink-500">{runs.length} {runs.length === 1 ? "book" : "books"}</span>
      </div>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {runs.map(run => (
          <li key={run.jobId} className="rounded-card border border-stone-150 bg-paper p-4 shadow-hairline">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink-900">{run.title}</h3>
                {run.voice && <p className="mt-0.5 truncate text-2xs text-ink-500">{run.voice}</p>}
              </div>
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-semibold ${statusTone[run.status]}`}>
                {run.status === "running" && <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={10} />}
                {run.stopping ? "Stopping…" : statusLabel[run.status]}
              </span>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-label={`${run.title} narration progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.percent}>
              <div className="h-full rounded-full bg-brand-500 transition-[width] duration-700 ease-out" style={{ width: `${run.percent}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-xs">
              <span className="tabular-nums text-ink-600">
                {run.completedSegments} of {run.totalSegments || "…"} lines{run.failedSegments ? ` · ${run.failedSegments} failed` : ""}
              </span>
              <span className="flex items-center gap-1">
                {run.status === "paused" ? (
                  <button type="button" disabled={busy} onClick={() => resume.mutate({ projectId: run.projectId, jobId: run.jobId })} className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50" aria-label={`Resume ${run.title}`}>
                    <Play aria-hidden="true" size={12} /> Resume
                  </button>
                ) : (
                  <button type="button" disabled={busy || run.stopping} onClick={() => pause.mutate({ projectId: run.projectId, jobId: run.jobId })} className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold text-ink-600 transition hover:bg-stone-50 disabled:opacity-50" aria-label={`Pause ${run.title}`}>
                    <Pause aria-hidden="true" size={12} /> Pause
                  </button>
                )}
                <button type="button" onClick={() => onOpen(run.projectId)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold text-brand-700 transition hover:bg-brand-50" aria-label={`Open ${run.title}`}>
                  Open <ArrowRight aria-hidden="true" size={12} />
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
