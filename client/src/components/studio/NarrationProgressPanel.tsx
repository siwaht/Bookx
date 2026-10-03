import { useMemo } from "react";
import { Clock3, Gauge, Hourglass, Mic2 } from "lucide-react";
import { formatClock, type NarrationProgress } from "@shared/narration";
import { Badge, count, ui } from "./studioUi";

/**
 * How far the run is and how long it has left, in plain numbers.
 *
 * The time left comes from the server, from how fast the last lines actually
 * rendered (pauses excluded), so it settles after a few lines and stays
 * honest when the provider slows down.
 */
export function NarrationProgressPanel({ data }: { data: NarrationProgress | undefined }) {
  const status = data?.status ?? "idle";
  const active = status === "running" || status === "queued";
  const percent = data?.percent ?? 0;
  const total = data?.totalSegments ?? 0;
  const completed = data?.completedSegments ?? 0;
  const timing = data?.timing;
  const runChapters = (data?.chapters ?? []).filter(chapter => chapter.inRun !== false);
  const chaptersDone = runChapters.filter(chapter => chapter.state === "done").length;

  const remaining = timing?.remainingMs ?? null;
  const finishesAt = active && remaining !== null ? new Date(Date.now() + remaining) : null;
  const timeLeft = active
    ? remaining !== null ? `About ${formatClock(remaining)}` : "Estimating…"
    : status === "paused" && remaining !== null ? `About ${formatClock(remaining)} when resumed` : "—";

  // Announced politely, and only when the chapter changes or another tenth is done.
  const announcement = useMemo(() => {
    if (!active) return status === "completed" ? "Narration complete." : "";
    const where = timing?.current ? `Narrating chapter ${timing.current.chapterNumber} of ${timing.current.chapterCount}.` : "";
    return `${where} ${Math.floor(percent / 10) * 10} percent done.`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, status, timing?.current?.chapterId, Math.floor(percent / 10)]);

  return (
    <div className={ui.card}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className={ui.heading}>Progress</h3>
          <p className={`mt-1 text-sm ${ui.muted} ${ui.numbers}`}>
            {total ? `${count(completed)} of ${count(total)} lines` : "No lines yet"}
            {runChapters.length > 0 && ` · ${chaptersDone} of ${runChapters.length} chapter${runChapters.length === 1 ? "" : "s"} done`}
            {data?.regenerating && " · regenerating"}
          </p>
        </div>
        <strong className={`text-3xl tracking-[-.04em] text-[#2d6f6a] ${ui.numbers}`}>{percent}%</strong>
      </div>

      <div className={`${ui.bar} mt-3`}>
        <div
          className={ui.barFill}
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${percent}% · ${completed} of ${total} lines`}
          aria-label="Narration progress"
        />
      </div>

      {timing?.current && active && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-[#3d5557]">
          <Badge tone="info"><Mic2 aria-hidden="true" size={10} /> Now narrating</Badge>
          <span className={ui.numbers}>
            Chapter {timing.current.chapterNumber} of {timing.current.chapterCount} · line {timing.current.segmentNumber} of {timing.current.segmentCount}
          </span>
          <span className={`truncate ${ui.muted}`}>— {timing.current.chapterTitle}</span>
        </p>
      )}

      <dl className="mt-4 grid gap-3 sm:grid-cols-4">
        <Fact icon={<Hourglass aria-hidden="true" size={13} />} label="Time left" value={timeLeft} detail={finishesAt ? `Done around ${finishesAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : undefined} />
        <Fact icon={<Clock3 aria-hidden="true" size={13} />} label="Rendering time" value={formatClock(timing?.activeElapsedMs ?? 0)} detail="Pauses not counted" />
        <Fact icon={<Mic2 aria-hidden="true" size={13} />} label="Audio made" value={formatClock(data?.renderedDurationMs ?? 0)} detail="Measured from the files" />
        <Fact
          icon={<Gauge aria-hidden="true" size={13} />}
          label="Pace"
          value={timing?.msPerCharacter ? `${Math.round(1000 / timing.msPerCharacter).toLocaleString()} chars/s` : "—"}
          detail={timing?.remainingCharacters ? `${count(timing.remainingCharacters)} characters to go` : undefined}
        />
      </dl>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}

function Fact({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-[#e8ece6] bg-[#fbfcf9] p-3">
      <dt className="mono flex items-center gap-1.5 text-[10px] tracking-[.1em] text-[#6c8486]">{icon} {label.toUpperCase()}</dt>
      <dd className={`mt-1.5 text-lg font-bold tracking-[-.02em] text-[#304548] ${ui.numbers}`}>{value}</dd>
      {detail && <dd className={`text-[10px] ${ui.faint}`}>{detail}</dd>}
    </div>
  );
}
