import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { ChevronLeft, ChevronRight, Download, Headphones, LoaderCircle, Music2, Pause, Play, RotateCcw, SkipBack, SkipForward, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "../../../../server/routers";
import { ConfirmDialog } from "./ConfirmDialog";
import { Badge, playerClock, ui, type Tone } from "./studioUi";

type Playback = inferRouterOutputs<AppRouter>["studio"]["chapterPlayback"];
type Line = Playback["lines"][number];

/** Rough speaking pace, for lines whose audio length was never measured. */
const MS_PER_CHARACTER = 65;
const lineLength = (line: Line) => line.durationMs ?? Math.max(800, line.text.length * MS_PER_CHARACTER);

const STATUS: Record<Line["status"], { label: string; tone: Tone }> = {
  current: { label: "Ready", tone: "good" },
  outdated: { label: "Outdated", tone: "warn" },
  missing: { label: "Not narrated yet", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
};

/**
 * Plays a chapter line by line from the stored segment audio, with the same
 * pauses an export puts between lines. It needs nothing to be assembled, so a
 * chapter can be heard the moment its lines exist, while the run carries on
 * with later chapters, and it keeps going as new lines arrive.
 */
export function ChapterPlayer({
  projectId,
  chapterId,
  live,
  onNavigate,
  onClose,
}: {
  projectId: string;
  chapterId: string;
  /** The chapter is still being narrated, so new lines may appear. */
  live: boolean;
  onNavigate: (chapterId: string) => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const playback = trpc.studio.chapterPlayback.useQuery({ projectId, chapterId }, { refetchInterval: live ? 4000 : false });
  const join = trpc.studio.joinChapter.useMutation();
  const retake = trpc.studio.retakeLine.useMutation({
    onSuccess: () => {
      toast.success("Line re-taken.");
      void utils.studio.chapterPlayback.invalidate({ projectId, chapterId });
      void utils.bookx.narrationStatus.invalidate({ projectId });
      void utils.bookx.auditNarration.invalidate({ projectId });
    },
    onError: error => toast.error(error.message || "Prosecast could not re-take that line."),
  });

  const audio = useRef<HTMLAudioElement | null>(null);
  const gapTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState(0);
  const [retakeLine, setRetakeLine] = useState<Line | null>(null);

  const data = playback.data;
  const lines = useMemo(() => data?.lines ?? [], [data?.lines]);

  // Where every line starts on the chapter's timeline (lines without audio are skipped).
  const timeline = useMemo(() => {
    let at = 0;
    return lines.map(line => {
      const start = at;
      if (line.audioUrl) at += lineLength(line) + line.gapAfterMs;
      return { start, length: line.audioUrl ? lineLength(line) : 0 };
    });
  }, [lines]);
  const totalMs = lines.reduce((total, line) => total + (line.audioUrl ? lineLength(line) + line.gapAfterMs : 0), 0);
  const current = lines[index];
  const elapsedMs = (timeline[index]?.start ?? 0) + position;

  const clearGap = () => {
    window.clearTimeout(gapTimer.current);
    gapTimer.current = undefined;
  };

  // Reset when another chapter is opened.
  useEffect(() => {
    clearGap();
    setIndex(0);
    setPosition(0);
    setPlaying(false);
    setWaiting(false);
  }, [chapterId]);

  useEffect(() => () => {
    clearGap();
    audio.current?.pause();
  }, []);

  /** The next line with audio at or after `from`, or -1. */
  const nextPlayable = useCallback((from: number) => {
    for (let candidate = from; candidate < lines.length; candidate++) if (lines[candidate]!.audioUrl) return candidate;
    return -1;
  }, [lines]);

  const startLine = useCallback((target: number, offsetMs = 0) => {
    const element = audio.current;
    const line = lines[target];
    clearGap();
    if (!element || !line?.audioUrl) return;
    setIndex(target);
    setWaiting(false);
    if (!element.src.endsWith(line.audioUrl)) element.src = line.audioUrl;
    element.currentTime = offsetMs / 1000;
    void element.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }, [lines]);

  const advance = useCallback(() => {
    const line = lines[index];
    const next = nextPlayable(index + 1);
    if (next >= 0 && (next === index + 1 || !live)) {
      gapTimer.current = window.setTimeout(() => startLine(next), line?.gapAfterMs ?? 0);
      return;
    }
    // The next line is not narrated yet: wait for it if the run is still going.
    if (live && index + 1 < lines.length) {
      setWaiting(true);
      setPlaying(false);
      setIndex(index + 1);
      setPosition(0);
      return;
    }
    setPlaying(false);
    setPosition(0);
  }, [index, lines, live, nextPlayable, startLine]);

  // A line that was being waited for has arrived.
  useEffect(() => {
    if (waiting && lines[index]?.audioUrl) startLine(index);
  }, [waiting, lines, index, startLine]);

  // Keep the current line in view.
  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-line="${index}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (playing) {
      element.pause();
      clearGap();
      setPlaying(false);
      return;
    }
    const target = current?.audioUrl ? index : nextPlayable(index);
    if (target < 0) {
      const first = nextPlayable(0);
      if (first >= 0) startLine(first);
      return;
    }
    if (target === index && element.src && !element.ended && element.currentTime > 0) {
      void element.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      startLine(target, target === index ? position : 0);
    }
  };

  const step = (direction: -1 | 1) => {
    let target = index + direction;
    while (target >= 0 && target < lines.length && !lines[target]!.audioUrl) target += direction;
    if (target < 0 || target >= lines.length) return;
    if (playing) startLine(target);
    else {
      setIndex(target);
      setPosition(0);
    }
  };

  const seek = (ms: number) => {
    let target = lines.findIndex((line, candidate) => line.audioUrl && ms < timeline[candidate]!.start + timeline[candidate]!.length + line.gapAfterMs);
    if (target < 0) target = Math.max(0, nextPlayable(0));
    const offset = Math.max(0, Math.min(ms - timeline[target]!.start, timeline[target]!.length - 50));
    if (playing) startLine(target, offset);
    else {
      setIndex(target);
      setPosition(offset);
      const element = audio.current;
      if (element && lines[target]?.audioUrl) {
        if (!element.src.endsWith(lines[target]!.audioUrl!)) element.src = lines[target]!.audioUrl!;
        element.currentTime = offset / 1000;
      }
    }
  };

  const download = () => join.mutate({ projectId, chapterId }, {
    onSuccess: result => {
      const link = document.createElement("a");
      link.href = result.url;
      link.download = `${data?.chapter.title || "chapter"}.mp3`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (result.partial) toast(`Joined the first ${result.lines} of ${result.totalLines} lines; the rest are not narrated yet.`);
    },
    onError: error => toast.error(error.message || "Prosecast could not join the chapter."),
  });

  const cueAfter = useMemo(() => {
    const map = new Map<string, Playback["cues"]>();
    for (const cue of data?.cues ?? []) map.set(cue.segmentId, [...(map.get(cue.segmentId) ?? []), cue]);
    return map;
  }, [data?.cues]);

  if (playback.isLoading) {
    return <div className={ui.card}><div className="skeleton h-5 w-48" /><div className="skeleton mt-4 h-10 w-full" /></div>;
  }
  if (!data) {
    return <div className={ui.card}><p className={`text-sm ${ui.muted}`}>{playback.error?.message ?? "This chapter could not be loaded."}</p></div>;
  }

  const { totals } = data;
  const partial = totals.withAudio < totals.lines;
  const nothing = totals.withAudio === 0;

  return (
    <section className={ui.cardRaised} aria-label={`Player for ${data.chapter.title}`}>
      <audio
        ref={audio}
        preload="auto"
        onTimeUpdate={event => setPosition(event.currentTarget.currentTime * 1000)}
        onEnded={advance}
        // The end of a line also fires "pause"; only a real pause stops the chapter.
        onPause={event => { if (!event.currentTarget.ended && !gapTimer.current) setPlaying(false); }}
        onError={() => {
          setPlaying(false);
          toast.error("That line's audio could not be played. Try again, or re-take the line.");
        }}
        className="hidden"
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={ui.eyebrow}>Chapter {data.chapter.number} of {data.chapter.chapterCount}</span>
          <h3 className="serif mt-1 truncate text-xl tracking-[-.02em] text-ink-900">{data.chapter.title}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs">
            {nothing ? <Badge>Nothing narrated yet</Badge> : partial ? <Badge tone="info">Partial · {totals.withAudio} of {totals.lines} lines</Badge> : <Badge tone="good">All {totals.lines} lines narrated</Badge>}
            {totals.outdated > 0 && <Badge tone="warn">{totals.outdated} outdated</Badge>}
            {live && <Badge tone="info"><LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={10} /> Still rendering</Badge>}
            {totals.models.length > 0 && <span className={ui.faint}>Voiced with {totals.models.join(", ")}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={download} disabled={nothing || join.isPending} className="btn-soft" title="Join the narrated lines into one file">
            {join.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <Download aria-hidden="true" size={14} />} Download
          </button>
          <button type="button" onClick={onClose} className={ui.iconButton} aria-label="Close the player"><X aria-hidden="true" size={15} /></button>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-stone-150 bg-paper-50 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => data.previous && onNavigate(data.previous.id)} disabled={!data.previous} className={ui.iconButton} aria-label={data.previous ? `Previous chapter: ${data.previous.title}` : "No previous chapter"}>
            <ChevronLeft aria-hidden="true" size={16} />
          </button>
          <button type="button" onClick={() => step(-1)} disabled={nothing} className={ui.iconButton} aria-label="Previous line"><SkipBack aria-hidden="true" size={15} /></button>
          <button
            type="button"
            onClick={toggle}
            disabled={nothing}
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-700 text-paper transition hover:bg-brand-800 disabled:opacity-40"
            aria-label={playing ? "Pause" : waiting ? "Waiting for the next line" : "Play"}
          >
            {waiting ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={18} /> : playing ? <Pause aria-hidden="true" size={18} /> : <Play aria-hidden="true" className="ml-0.5" size={18} />}
          </button>
          <button type="button" onClick={() => step(1)} disabled={nothing} className={ui.iconButton} aria-label="Next line"><SkipForward aria-hidden="true" size={15} /></button>
          <button type="button" onClick={() => data.next && onNavigate(data.next.id)} disabled={!data.next} className={ui.iconButton} aria-label={data.next ? `Next chapter: ${data.next.title}` : "No next chapter"}>
            <ChevronRight aria-hidden="true" size={16} />
          </button>
          <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.round(totalMs))}
              step={250}
              value={Math.min(Math.round(elapsedMs), Math.max(1, Math.round(totalMs)))}
              onChange={event => seek(Number(event.target.value))}
              disabled={nothing}
              aria-label="Position in the chapter"
              aria-valuetext={`${playerClock(elapsedMs)} of ${playerClock(totalMs)}`}
              className="h-6 w-full cursor-pointer accent-brand-600 disabled:cursor-not-allowed"
            />
            <div className={`flex justify-between text-2xs font-semibold text-ink-500 ${ui.numbers}`}>
              <span>{playerClock(elapsedMs)}</span>
              <span>{partial ? `${playerClock(totalMs)} so far` : playerClock(totalMs)}</span>
            </div>
          </div>
        </div>
        <p className={`mt-2 text-xs ${ui.muted}`} aria-live="polite">
          {nothing
            ? live ? "Lines will appear here as soon as they are narrated." : "Render this chapter on the Generate tab to hear it."
            : waiting
              ? `Waiting for line ${index + 1} to be narrated…`
              : current ? `Line ${index + 1} of ${lines.length}${current.speaker ? ` · ${current.speaker}` : ""}` : ""}
        </p>
      </div>

      <ol ref={listRef} className="mt-4 max-h-[420px] space-y-1 overflow-auto pr-1" aria-label="Lines in this chapter">
        {lines.map(line => {
          const active = line.index === index;
          const status = STATUS[line.status];
          const cues = cueAfter.get(line.id) ?? [];
          return (
            <li key={line.id} data-line={line.index} className={`rounded-xl border px-3 py-2.5 ${active ? "border-brand-300 bg-brand-50" : "border-transparent hover:bg-stone-50"}`}>
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => startLine(line.index)}
                  disabled={!line.audioUrl}
                  className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-stone-200 bg-white text-brand-700 disabled:opacity-30"
                  aria-label={line.audioUrl ? `Play from line ${line.index + 1}` : `Line ${line.index + 1} has no audio yet`}
                >
                  {active && playing ? <Headphones aria-hidden="true" size={12} /> : <Play aria-hidden="true" size={11} />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-3xs">
                    <span className={`mono ${ui.faint} ${ui.numbers}`}>{String(line.index + 1).padStart(2, "0")}</span>
                    {line.speaker && <span className="font-semibold text-ink-600">{line.speaker}</span>}
                    {line.status !== "current" && <Badge tone={status.tone}>{status.label}</Badge>}
                    {line.tags.map(tag => <span key={tag} className="rounded-full bg-brand-50 ring-1 ring-brand-100 px-2 py-0.5 font-semibold text-brand-800">[{tag}]</span>)}
                    {cues.map((cue, position) => (
                      <span key={`${cue.label}-${position}`} className="inline-flex items-center gap-1 rounded-full bg-gold-100 px-2 py-0.5 font-semibold text-gold-700">
                        <Music2 aria-hidden="true" size={9} /> {cue.label} {cue.placement === "before" ? "before" : "after"}
                      </span>
                    ))}
                  </div>
                  <p className={`mt-1 text-[13px] leading-6 ${active ? "text-ink-900" : "text-ink-600"}`}>{line.text}</p>
                  {line.reason && line.status !== "current" && line.status !== "missing" && <p className={`mt-0.5 text-2xs ${ui.faint}`}>{line.reason}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => setRetakeLine(line)}
                  disabled={retake.isPending}
                  className={`mt-0.5 shrink-0 ${ui.linkButton}`}
                  aria-label={line.audioUrl ? `Re-take line ${line.index + 1}` : `Narrate line ${line.index + 1} now`}
                >
                  <RotateCcw aria-hidden="true" size={11} /><span className={ui.linkText}>{line.audioUrl ? "Re-take" : "Narrate"}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <ConfirmDialog
        open={Boolean(retakeLine)}
        onOpenChange={open => { if (!open) setRetakeLine(null); }}
        title={`${retakeLine?.audioUrl ? "Re-take" : "Narrate"} line ${(retakeLine?.index ?? 0) + 1}?`}
        description="The line is voiced again with its character's voice, its direction and the project's model. The new take replaces the old one."
        cost={retakeLine ? <>Sends about <strong>{retakeLine.text.length.toLocaleString()}</strong> characters to {data.voice.provider} ({data.voice.label}). This is a paid request.</> : null}
        confirmLabel={retakeLine?.audioUrl ? "Re-take line" : "Narrate line"}
        pending={retake.isPending}
        onConfirm={() => {
          if (!retakeLine) return;
          retake.mutate({ projectId, segmentId: retakeLine.id }, { onSettled: () => setRetakeLine(null) });
        }}
      />
    </section>
  );
}
