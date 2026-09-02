import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, LoaderCircle, Plus, Split, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

/**
 * The Write screen.
 *
 * Everything here is the project's real chapter text. The previous version
 * rendered a hardcoded four-chapter sample in a `readOnly` textarea, so edits were
 * impossible and the segment list was invented — which meant the narration run had
 * nothing real to render.
 */

const AUTOSAVE_DELAY_MS = 900;

export function ManuscriptEditor({
  projectId,
  canEdit,
  disabledReason,
  onNext,
}: {
  projectId: string;
  canEdit: boolean;
  disabledReason: string;
  onNext: () => void;
}) {
  const utils = trpc.useUtils();
  const workspace = trpc.bookx.getWorkspace.useQuery({ projectId }, { enabled: canEdit });
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);

  const chapters = useMemo(
    () => [...(workspace.data?.chapters ?? [])].sort((left, right) => left.orderIndex - right.orderIndex),
    [workspace.data?.chapters],
  );
  const activeChapter = chapters.find(chapter => chapter.id === selectedChapterId) ?? chapters[0] ?? null;
  const segments = (workspace.data?.segments ?? []).filter(segment => segment.chapterId === activeChapter?.id);

  // Load the selected chapter into the editor. Skipped while there are unsaved
  // keystrokes so a background refetch cannot overwrite what is being typed.
  useEffect(() => {
    if (!activeChapter || dirty) return;
    setSelectedChapterId(activeChapter.id);
    setDraftBody(activeChapter.body ?? "");
    setDraftTitle(activeChapter.title);
  }, [activeChapter?.id, activeChapter?.body, activeChapter?.title, dirty]);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const invalidate = () => {
    utils.bookx.getWorkspace.invalidate({ projectId });
    utils.bookx.narrationStatus.invalidate({ projectId });
    utils.bookx.auditNarration.invalidate({ projectId });
  };

  const updateChapter = trpc.bookx.updateChapter.useMutation({
    onSuccess: () => { setDirty(false); invalidate(); },
    onError: error => toast.error(error.message || "Bookx could not save the chapter."),
  });
  const createChapter = trpc.bookx.createChapter.useMutation({
    onSuccess: result => { setSelectedChapterId(result.id); setDirty(false); invalidate(); },
    onError: error => toast.error(error.message || "Bookx could not add the chapter."),
  });
  const deleteChapter = trpc.bookx.deleteChapter.useMutation({
    onSuccess: () => { setSelectedChapterId(null); setDirty(false); invalidate(); },
    onError: error => toast.error(error.message || "Bookx could not delete the chapter."),
  });
  const resegment = trpc.bookx.resegmentChapters.useMutation({
    onSuccess: result => {
      invalidate();
      toast.success(
        result.rebuiltChapters.length
          ? `Rebuilt segments for ${result.rebuiltChapters.length} chapter(s).`
          : "Segments already match the current text.",
      );
    },
    onError: error => toast.error(error.message || "Bookx could not split the manuscript."),
  });

  const queueSave = (title: string, body: string) => {
    if (!activeChapter) return;
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      updateChapter.mutate({ projectId, chapterId: activeChapter.id, title: title.trim() || "Untitled chapter", body });
    }, AUTOSAVE_DELAY_MS);
  };

  const saveNow = () => {
    if (!activeChapter || !dirty) return;
    window.clearTimeout(saveTimer.current);
    updateChapter.mutate({ projectId, chapterId: activeChapter.id, title: draftTitle.trim() || "Untitled chapter", body: draftBody });
  };

  if (!canEdit) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header actions={null} />
        <div className="flex flex-1 items-center justify-center p-9">
          <div className="max-w-md rounded-[22px] border border-dashed border-[#d4ded7] bg-[#fbfcf9] p-7 text-center">
            <Split aria-hidden="true" className="mx-auto mb-4 text-[#a3b3ac]" size={26} />
            <h3 className="font-bold text-[#35494b]">The manuscript lives on the server</h3>
            <p className="mt-2 text-sm leading-6 text-[#748285]">{disabledReason}</p>
          </div>
        </div>
      </div>
    );
  }

  const words = draftBody.trim() ? draftBody.trim().split(/\s+/).length : 0;
  const readMinutes = Math.max(1, Math.round(words / 155));
  const renderedSegments = segments.filter(segment => segment.audioStorageKey).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        actions={
          <>
            <span className="text-xs text-[#849092]" role="status">
              {updateChapter.isPending ? "Saving…" : dirty ? "Unsaved changes" : chapters.length ? "Saved" : ""}
            </span>
            <button
              onClick={() => resegment.mutate({ projectId })}
              disabled={resegment.isPending || !chapters.length}
              className="btn-soft disabled:opacity-50"
              title="Split every chapter into narration segments sized for your voice model"
            >
              {resegment.isPending ? <LoaderCircle className="mr-1 inline animate-spin" aria-hidden="true" size={14} /> : <Split className="mr-1 inline" aria-hidden="true" size={14} />}
              Split into segments
            </button>
            <button onClick={() => { saveNow(); onNext(); }} className="btn-primary">
              Continue to cast <ArrowRight className="ml-1 inline" aria-hidden="true" size={13} />
            </button>
          </>
        }
      />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
        <aside className="border-b border-[#e1e5de] bg-[#fafbf7] p-4 lg:border-b-0 lg:border-r lg:overflow-auto">
          <div className="mb-3 flex items-center justify-between">
            <span className="mono text-[10px] tracking-[.12em] text-[#899494]">CHAPTERS</span>
            <button
              onClick={() => createChapter.mutate({ projectId, title: `Chapter ${chapters.length + 1}`, body: "", orderIndex: chapters.length })}
              disabled={createChapter.isPending}
              aria-label="Add chapter"
              className="rounded-lg bg-[#e5f0ec] p-1.5 text-[#36746e] transition hover:bg-[#d9ebe4] disabled:opacity-50"
            >
              <Plus aria-hidden="true" size={14} />
            </button>
          </div>

          {workspace.isLoading ? (
            <div className="space-y-2">{[0, 1, 2].map(index => <div key={index} className="skeleton h-14 rounded-xl" />)}</div>
          ) : chapters.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#d8e1dc] p-4 text-xs leading-5 text-[#778689]">
              No chapters yet. Add one to start writing.
            </p>
          ) : (
            chapters.map((chapter, index) => {
              const own = (workspace.data?.segments ?? []).filter(segment => segment.chapterId === chapter.id);
              const ready = own.length > 0 && own.every(segment => segment.audioStorageKey);
              return (
                <button
                  key={chapter.id}
                  onClick={() => { saveNow(); setDirty(false); setSelectedChapterId(chapter.id); }}
                  aria-current={chapter.id === activeChapter?.id}
                  className={`mb-1 w-full rounded-xl p-3 text-left ${chapter.id === activeChapter?.id ? "bg-[#e5f0ed]" : "hover:bg-[#f0f2ee]"}`}
                >
                  <span className="line-clamp-2 text-xs font-semibold text-[#3c5052]">{index + 1}. {chapter.title}</span>
                  <span className="mt-2 flex items-center justify-between text-[10px] text-[#7f8a8c]">
                    <span>{own.length} segment{own.length === 1 ? "" : "s"}</span>
                    <span className={ready ? "text-[#4a8e7b]" : own.length ? "text-[#bd8432]" : "text-[#829092]"}>
                      {ready ? "Ready" : own.length ? `${own.filter(s => s.audioStorageKey).length}/${own.length}` : "Draft"}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </aside>

        <section className="flex min-w-0 flex-col border-b border-[#e1e5de] bg-[#fffefa] p-5 lg:border-b-0 lg:p-7">
          {!activeChapter ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[#849092]">Add a chapter to begin.</div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <label className="block">
                    <span className="mono text-[10px] tracking-[.12em] text-[#90a0a0]">CHAPTER TITLE</span>
                    <input
                      value={draftTitle}
                      onChange={event => { setDraftTitle(event.target.value); queueSave(event.target.value, draftBody); }}
                      onBlur={saveNow}
                      className="mt-1 w-full border-0 bg-transparent text-base font-bold text-[#304548] outline-none focus:underline"
                      aria-label="Chapter title"
                    />
                  </label>
                </div>
                <button
                  onClick={() => { if (window.confirm(`Delete "${activeChapter.title}" and its audio? This cannot be undone.`)) deleteChapter.mutate({ projectId, chapterId: activeChapter.id }); }}
                  disabled={deleteChapter.isPending}
                  className="shrink-0 rounded-lg p-2 text-[#9aa2a3] transition hover:bg-[#fbeeea] hover:text-[#af5d5d] disabled:opacity-50"
                  aria-label={`Delete ${activeChapter.title}`}
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </div>

              <textarea
                value={draftBody}
                onChange={event => { setDraftBody(event.target.value); queueSave(draftTitle, event.target.value); }}
                onBlur={saveNow}
                placeholder="Paste or write this chapter's text. Bookx splits it into narration segments sized for your voice model."
                className="min-h-[320px] flex-1 w-full resize-none border-0 bg-transparent text-[16px] leading-8 text-[#35474a] outline-none"
                aria-label={`${activeChapter.title} text`}
              />

              <div className="mt-3 flex flex-wrap justify-between gap-3 border-t border-[#edf0eb] pt-3 text-[11px] text-[#849092]">
                <span>{words.toLocaleString()} words · ~{readMinutes} min read</span>
                <span>{segments.length} segment{segments.length === 1 ? "" : "s"} · {renderedSegments} with audio</span>
              </div>
            </>
          )}
        </section>

        <aside className="bg-[#fafbf7] p-4 lg:overflow-auto">
          <div className="mb-4 flex items-center justify-between">
            <span className="mono text-[10px] tracking-[.12em] text-[#899494]">NARRATION SEGMENTS</span>
            <button
              onClick={() => activeChapter && resegment.mutate({ projectId, chapterIds: [activeChapter.id] })}
              disabled={!activeChapter || resegment.isPending || dirty}
              title={dirty ? "Save your edits first" : "Re-split this chapter"}
              aria-label="Re-split this chapter"
              className="rounded-lg bg-[#e5f0ec] p-1.5 text-[#36746e] disabled:opacity-40"
            >
              <Split aria-hidden="true" size={14} />
            </button>
          </div>

          {segments.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#d8e1dc] p-4 text-xs leading-5 text-[#778689]">
              No segments yet. Use <strong>Split into segments</strong> once this chapter has text — Bookx breaks it at paragraph and sentence boundaries so nothing is cut mid-phrase.
            </p>
          ) : (
            segments.map((segment, index) => (
              <div key={segment.id} className="mb-2 rounded-xl border border-[#e1e5de] bg-white p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="mono text-[10px] text-[#899494]">{String(index + 1).padStart(2, "0")}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[9px] ${segment.audioStorageKey ? "bg-[#e7f3ef] text-[#397b70]" : segment.lastError ? "bg-[#fbe9e4] text-[#a35a44]" : "bg-[#fbefd9] text-[#9e722c]"}`}>
                    {segment.audioStorageKey ? "Audio ready" : segment.lastError ? "Failed" : "Needs audio"}
                  </span>
                </div>
                <p className="line-clamp-4 text-xs leading-5 text-[#516064]">{segment.text}</p>
                <div className="mt-2 flex items-center justify-between text-[10px] text-[#8a9492]">
                  <span>{segment.text.length} chars</span>
                  {segment.audioDurationMs ? <span>{(segment.audioDurationMs / 1000).toFixed(1)}s</span> : null}
                </div>
                {segment.audioStorageKey && (
                  <audio
                    controls
                    preload="none"
                    src={`/manus-storage/${segment.audioStorageKey}`}
                    className="mt-2 h-8 w-full"
                    aria-label={`Segment ${index + 1} narration`}
                  />
                )}
                {segment.lastError && <p className="mt-2 text-[10px] leading-4 text-[#a35a44]">{segment.lastError}</p>}
              </div>
            ))
          )}
        </aside>
      </div>
    </div>
  );
}

function Header({ actions }: { actions: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5 border-b border-[#e1e5de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9">
      <div>
        <p className="mono text-[10px] tracking-[.15em] text-[#5a918b]">01 · WRITE</p>
        <h2 className="serif mt-2 text-3xl tracking-[-.04em] text-[#25393c]">The manuscript</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#738084]">
          Write or paste each chapter. Edits save as you type, and re-splitting keeps the audio for any paragraph you did not change.
        </p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
