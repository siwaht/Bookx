import { Headphones, RotateCcw, Wand2 } from "lucide-react";
import { formatClock, type ChapterProgress } from "@shared/narration";
import { Badge, ui, type Tone } from "./studioUi";

const STATE: Record<NonNullable<ChapterProgress["state"]>, { label: string; tone: Tone }> = {
  done: { label: "Ready to listen", tone: "good" },
  rendering: { label: "Rendering now", tone: "info" },
  queued: { label: "Queued", tone: "neutral" },
  partial: { label: "Partly narrated", tone: "warn" },
  failed: { label: "Needs a retry", tone: "bad" },
  idle: { label: "Not narrated", tone: "neutral" },
  empty: { label: "No text", tone: "neutral" },
};

/**
 * The chapters of the book with where each one stands, and the three things
 * a creator does with one: listen (as soon as any of it exists), direct it,
 * and regenerate it.
 */
export function NarrationChapterList({
  chapters,
  selected,
  onToggle,
  onClearSelection,
  locked,
  playingChapterId,
  onListen,
  onDirect,
  onRegenerate,
}: {
  chapters: ChapterProgress[];
  selected: Set<string>;
  onToggle: (chapterId: string) => void;
  onClearSelection: () => void;
  /** A run is active: the selection for the next run is frozen. */
  locked: boolean;
  playingChapterId: string | null;
  onListen: (chapterId: string) => void;
  onDirect: (chapterId: string) => void;
  onRegenerate: (chapter: ChapterProgress) => void;
}) {
  return (
    <div className={ui.card}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className={ui.title}>Chapters</h3>
          <p className={`mt-1 text-sm ${ui.muted}`}>
            {selected.size ? `${selected.size} selected for the next run.` : "Select chapters to narrate only those; none selected renders the whole book."}
          </p>
        </div>
        {selected.size > 0 && <button type="button" onClick={onClearSelection} className={ui.linkButton}><span className={ui.linkText}>Clear selection</span></button>}
      </div>

      {chapters.length === 0 ? (
        <p className={`${ui.divider} pt-4 text-sm ${ui.muted}`}>No chapters yet.</p>
      ) : (
        <ul>
          {chapters.map((chapter, position) => {
            const percent = chapter.totalSegments ? Math.round((chapter.renderedSegments / chapter.totalSegments) * 100) : 0;
            const state = STATE[chapter.state ?? (chapter.renderedSegments === chapter.totalSegments && chapter.totalSegments ? "done" : chapter.renderedSegments ? "partial" : "idle")];
            const listenable = chapter.renderedSegments > 0 || (chapter.durationMs ?? 0) > 0;
            const checkboxId = `chapter-select-${chapter.chapterId}`;
            return (
              <li key={chapter.chapterId} className={`flex flex-wrap items-center gap-3 py-3.5 ${ui.divider} ${playingChapterId === chapter.chapterId ? "bg-brand-50/60" : ""}`}>
                <input
                  id={checkboxId}
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-brand-600"
                  checked={selected.has(chapter.chapterId)}
                  onChange={() => onToggle(chapter.chapterId)}
                  disabled={locked}
                />
                <div className="min-w-0 flex-1">
                  <label htmlFor={checkboxId} className="block cursor-pointer truncate text-sm font-semibold text-ink-800">
                    <span className={`mono mr-2 text-3xs ${ui.faint}`}>{String(position + 1).padStart(2, "0")}</span>{chapter.title}
                  </label>
                  <span className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${ui.muted} ${ui.numbers}`}>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    {chapter.renderedSegments} / {chapter.totalSegments} lines
                    {chapter.durationMs > 0 && <span>· {formatClock(chapter.durationMs)}</span>}
                    {chapter.failedSegments > 0 && <span>· {chapter.failedSegments} failed</span>}
                  </span>
                  <div className={`${ui.bar} mt-2 h-1.5 max-w-xs`} aria-hidden="true">
                    <div className={ui.barFill} style={{ width: `${percent}%` }} />
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button type="button" className="btn-soft px-3 py-2" onClick={() => onListen(chapter.chapterId)} disabled={!listenable} aria-label={`Listen to ${chapter.title}`} title={listenable ? "Listen to what is narrated so far" : "Nothing narrated yet"}>
                    <Headphones aria-hidden="true" size={13} /> Listen
                  </button>
                  <button type="button" className="btn-soft px-3 py-2" onClick={() => onDirect(chapter.chapterId)} disabled={!chapter.totalSegments} aria-label={`Direct ${chapter.title}`} title="Setting, mood and line deliveries">
                    <Wand2 aria-hidden="true" size={13} /> Direct
                  </button>
                  <button type="button" className="btn-soft px-3 py-2" onClick={() => onRegenerate(chapter)} disabled={!chapter.totalSegments} aria-label={`Regenerate ${chapter.title}`} title="Narrate the whole chapter again">
                    <RotateCcw aria-hidden="true" size={13} /> Regenerate
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
