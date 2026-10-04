import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, FileUp, LoaderCircle, Plus, Quote, Split, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { MANUSCRIPT_ACCEPT, formatWordCount, readManuscriptFile, type ManuscriptUpload } from "@/lib/files";

/**
 * The Write screen.
 *
 * Everything here is the project's real chapter text. A whole manuscript can be
 * imported (EPUB, DOCX, Markdown, HTML or plain text); every chapter can be
 * edited, deleted, reordered, or switched out of the audiobook without losing
 * its text. Segments show who speaks each line, and the speaker can be changed.
 */

const AUTOSAVE_DELAY_MS = 900;

const KIND_LABEL: Record<string, string> = { "front-matter": "Front matter", "back-matter": "Back matter" };

const wordsIn = (text: string | null | undefined) => (text?.trim() ? text.trim().split(/\s+/).length : 0);

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
  const [pendingImport, setPendingImport] = useState<ManuscriptUpload | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  // The edit waiting to be saved. A ref, so a save fired later (by the timer,
  // a blur, a chapter switch or unmount) always sends the latest keystrokes.
  const pending = useRef<{ projectId: string; chapterId: string; title: string; body: string } | null>(null);
  // The server's copy of the chapter in the editor, as last loaded or saved.
  // The draft is reloaded only when the server's copy differs from this, so
  // our own saves never bounce stale text back into the editor.
  const synced = useRef<{ chapterId: string; title: string; body: string } | null>(null);
  // The latest draft, for callbacks that run after the render that made them.
  const draftRef = useRef({ title: "", body: "" });
  draftRef.current = { title: draftTitle, body: draftBody };

  const chapters = useMemo(
    () => [...(workspace.data?.chapters ?? [])].sort((left, right) => left.orderIndex - right.orderIndex),
    [workspace.data?.chapters],
  );
  const chapterWords = useMemo(() => new Map(chapters.map(chapter => [chapter.id, wordsIn(chapter.body)])), [chapters]);
  const activeChapter = chapters.find(chapter => chapter.id === selectedChapterId) ?? chapters[0] ?? null;
  const segments = (workspace.data?.segments ?? []).filter(segment => segment.chapterId === activeChapter?.id);
  const includedChapters = chapters.filter(chapter => chapter.included);
  const narrationStyle = workspace.data?.project.narrationStyle ?? "single";
  const multiVoice = narrationStyle !== "single";
  const speakers = useMemo(
    () => (workspace.data?.characters ?? []).filter(character => !character.isNarrator).sort((left, right) => left.name.localeCompare(right.name)),
    [workspace.data?.characters],
  );
  const speakerName = useMemo(() => new Map((workspace.data?.characters ?? []).map(character => [character.id, character.name])), [workspace.data?.characters]);

  const invalidate = () => {
    utils.bookx.getWorkspace.invalidate({ projectId });
    utils.bookx.narrationStatus.invalidate({ projectId });
    utils.bookx.auditNarration.invalidate({ projectId });
  };

  const updateChapter = trpc.bookx.updateChapter.useMutation({
    onSuccess: (_result, saved) => {
      // Put the saved text in the cache straight away. Clearing "dirty" while
      // the cache still held the old text used to load that old text back into
      // the editor, so the next keystrokes were saved on top of it.
      if (synced.current?.chapterId === saved.chapterId) {
        synced.current = { chapterId: saved.chapterId, title: saved.title ?? synced.current.title, body: saved.body ?? synced.current.body };
      }
      utils.bookx.getWorkspace.setData({ projectId }, old => old && {
        ...old,
        chapters: old.chapters.map(chapter => chapter.id === saved.chapterId ? { ...chapter, title: saved.title ?? chapter.title, body: saved.body ?? chapter.body } : chapter),
      });
      // Saved only if nothing was typed since; newer keystrokes are still waiting.
      if (!pending.current) setDirty(false);
      invalidate();
    },
    onError: (error, failed) => {
      // Keep the edit queued, so the next blur or switch tries again.
      if (!pending.current && synced.current?.chapterId === failed.chapterId) {
        pending.current = { projectId: failed.projectId, chapterId: failed.chapterId, title: draftRef.current.title, body: draftRef.current.body };
      }
      toast.error(error.message || "Prosecast could not save the chapter.");
    },
  });
  const createChapter = trpc.bookx.createChapter.useMutation({
    onSuccess: async result => {
      // Selected once it is in the list: until then the editor fell back to
      // chapter 1 and stayed there.
      await utils.bookx.getWorkspace.invalidate({ projectId });
      setSelectedChapterId(result.id);
      invalidate();
    },
    onError: error => toast.error(error.message || "Prosecast could not add the chapter."),
  });
  const deleteChapter = trpc.bookx.deleteChapter.useMutation({
    onSuccess: () => {
      window.clearTimeout(saveTimer.current);
      pending.current = null;
      setSelectedChapterId(null);
      setDirty(false);
      invalidate();
    },
    onError: error => toast.error(error.message || "Prosecast could not delete the chapter."),
  });

  // Load the chapter into the editor when it changes, or when the server's copy
  // changed and nothing local is waiting to be saved.
  useEffect(() => {
    if (!activeChapter) return;
    const server = { chapterId: activeChapter.id, title: activeChapter.title, body: activeChapter.body ?? "" };
    const known = synced.current;
    if (known?.chapterId === server.chapterId) {
      if (dirty || updateChapter.isPending) return;
      if (known.title === server.title && known.body === server.body) return;
    }
    synced.current = server;
    setDraftTitle(server.title);
    setDraftBody(server.body);
    setDirty(false);
  }, [activeChapter?.id, activeChapter?.body, activeChapter?.title, dirty, updateChapter.isPending]);

  // Leaving the screen (or the page) within the autosave delay used to drop
  // the last edit. Flush it on unmount, and warn before the tab closes.
  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    const next = pending.current;
    pending.current = null;
    if (next) {
      void utils.client.bookx.updateChapter
        .mutate({ projectId: next.projectId, chapterId: next.chapterId, title: next.title.trim() || "Untitled chapter", body: next.body })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const setIncluded = trpc.bookx.setChaptersIncluded.useMutation({
    onSuccess: invalidate,
    onError: error => toast.error(error.message || "Prosecast could not update the chapter selection."),
  });
  const reorder = trpc.bookx.reorderChapters.useMutation({
    onSuccess: invalidate,
    onError: error => toast.error(error.message || "Prosecast could not move the chapter."),
  });
  const updateSegment = trpc.bookx.updateSegment.useMutation({
    onSuccess: invalidate,
    onError: error => toast.error(error.message || "Prosecast could not change the speaker."),
  });
  const importManuscript = trpc.bookx.importManuscript.useMutation({
    onSuccess: result => {
      setPendingImport(null);
      setSelectedChapterId(null);
      setDirty(false);
      // The imported text replaces whatever was loaded.
      synced.current = null;
      invalidate();
      utils.bookx.listProjects.invalidate();
      const leftOut = result.excluded ? ` ${result.excluded} front- or back-matter section${result.excluded === 1 ? " was" : "s were"} left out; you can switch them back on.` : "";
      toast.success(`Imported ${result.imported} section${result.imported === 1 ? "" : "s"} · ${result.included} in the audiobook.`, {
        description: `${formatWordCount(result.words)}.${leftOut}${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`,
      });
    },
    onError: error => toast.error(error.message || "Prosecast could not import that manuscript."),
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
    onError: error => toast.error(error.message || "Prosecast could not split the manuscript."),
  });

  /** Sends the waiting edit, if there is one. Safe to call twice (blur, then a click). */
  const saveNow = () => {
    window.clearTimeout(saveTimer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    // The title is trimmed for the server only; the input keeps what was typed,
    // so a pause after "The " no longer turns "The Storm" into "TheStorm".
    updateChapter.mutate({ projectId: next.projectId, chapterId: next.chapterId, title: next.title.trim() || "Untitled chapter", body: next.body });
  };

  const queueSave = (title: string, body: string) => {
    if (!activeChapter) return;
    pending.current = { projectId, chapterId: activeChapter.id, title, body };
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(saveNow, AUTOSAVE_DELAY_MS);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow choosing the same file again
    if (!file) return;
    setReadingFile(true);
    try {
      const upload = await readManuscriptFile(file);
      saveNow();
      // Replace without asking only when the chapter list has loaded and is
      // truly empty. While it was loading, or after it failed to load, it looked
      // empty, so an import silently replaced the whole book and its narration.
      if (!workspace.isSuccess || chapters.length) setPendingImport(upload);
      else importManuscript.mutate({ projectId, filename: upload.name, base64: upload.base64, mode: "replace" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Prosecast could not read that file.");
    } finally {
      setReadingFile(false);
    }
  };

  const moveChapter = (direction: -1 | 1) => {
    if (!activeChapter) return;
    const index = chapters.findIndex(chapter => chapter.id === activeChapter.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= chapters.length) return;
    const ids = chapters.map(chapter => chapter.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    saveNow();
    reorder.mutate({ projectId, chapterIds: ids });
  };

  const toggleIncluded = (chapterId: string, included: boolean) => setIncluded.mutate({ projectId, chapterIds: [chapterId], included });

  if (!canEdit) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header actions={null} />
        <div className="flex flex-1 items-center justify-center p-9">
          <div className="max-w-md rounded-card border border-dashed border-stone-300 bg-paper/70 p-8 text-center">
            <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-stone-50 text-ink-400 ring-1 ring-stone-150"><Split aria-hidden="true" size={22} /></span>
            <h3 className="serif text-[22px] leading-tight text-ink-950">The manuscript lives on the server</h3>
            <p className="mt-2 text-sm leading-6 text-ink-500">{disabledReason}</p>
          </div>
        </div>
      </div>
    );
  }

  const importing = importManuscript.isPending || readingFile;
  const words = wordsIn(draftBody);
  const readMinutes = Math.max(1, Math.round(words / 155));
  const renderedSegments = segments.filter(segment => segment.audioStorageKey).length;
  const activeIndex = activeChapter ? chapters.findIndex(chapter => chapter.id === activeChapter.id) : -1;
  const includedWords = includedChapters.reduce((total, chapter) => total + (chapterWords.get(chapter.id) ?? 0), 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input ref={fileInput} type="file" accept={MANUSCRIPT_ACCEPT} onChange={event => void chooseFile(event)} className="sr-only" aria-label="Choose a manuscript file to import" tabIndex={-1} />
      <Header
        actions={
          <>
            <span className="text-xs text-ink-500" role="status">
              {updateChapter.isPending ? "Saving…" : dirty ? "Unsaved changes" : chapters.length ? "Saved" : ""}
            </span>
            <button onClick={() => fileInput.current?.click()} disabled={importing || !workspace.isSuccess} className="btn-soft disabled:opacity-50">
              {importing ? <LoaderCircle className="mr-1 inline animate-spin" aria-hidden="true" size={14} /> : <FileUp className="mr-1 inline" aria-hidden="true" size={14} />}
              {importing ? "Importing…" : "Import manuscript"}
            </button>
            <button
              onClick={() => resegment.mutate({ projectId })}
              // Splits the saved text, so unsaved edits would be left out.
              disabled={resegment.isPending || !includedChapters.length || dirty || updateChapter.isPending}
              className="btn-soft disabled:opacity-50"
              title={dirty || updateChapter.isPending ? "Saving your edits first" : "Split every included chapter into narration segments sized for your voice model"}
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

      {pendingImport && (
        <div role="alertdialog" aria-labelledby="import-choice-title" className="flex flex-wrap items-center justify-between gap-3 border-b border-gold-100 bg-gold-50 px-6 py-4 md:px-9">
          <div className="min-w-0">
            <strong id="import-choice-title" className="block text-sm text-gold-800">Import “{pendingImport.name}”</strong>
            <span className="text-xs text-gold-700">
              {chapters.length
                ? `This project already has ${chapters.length} chapter${chapters.length === 1 ? "" : "s"}. Replacing removes them and their narration.`
                : "Replacing removes any chapters this project already has, and their narration."}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={importing} onClick={() => importManuscript.mutate({ projectId, filename: pendingImport.name, base64: pendingImport.base64, mode: "replace" })} className="btn-primary disabled:opacity-50">Replace chapters</button>
            <button disabled={importing} onClick={() => importManuscript.mutate({ projectId, filename: pendingImport.name, base64: pendingImport.base64, mode: "append" })} className="btn-soft disabled:opacity-50">Add at the end</button>
            <button disabled={importing} onClick={() => setPendingImport(null)} aria-label="Cancel import" className="grid h-9 w-9 place-items-center rounded-xl text-gold-700 hover:bg-gold-100"><X aria-hidden="true" size={15} /></button>
          </div>
        </div>
      )}

      {workspace.isError ? (
        <div className="flex flex-1 items-center justify-center p-9">
          <div role="alert" className="max-w-md rounded-card border border-clay-200 bg-clay-50 p-8 text-center">
            <h3 className="serif text-[22px] leading-tight text-clay-800">The manuscript did not load</h3>
            <p className="mt-2 text-sm leading-6 text-clay-700">{workspace.error.message || "Prosecast could not reach the server."}</p>
            <button onClick={() => void workspace.refetch()} disabled={workspace.isFetching} className="btn-soft mt-4 disabled:opacity-50">
              {workspace.isFetching ? "Trying again…" : "Try again"}
            </button>
          </div>
        </div>
      ) : workspace.isSuccess && chapters.length === 0 ? (
        <EmptyManuscript importing={importing} adding={createChapter.isPending} onImport={() => fileInput.current?.click()} onAdd={() => createChapter.mutate({ projectId, title: "Chapter 1", body: "" })} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[270px_minmax(0,1fr)_320px]">
          <aside className="border-b border-stone-150 bg-paper-50 p-4 lg:border-b-0 lg:border-r lg:overflow-auto">
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="eyebrow text-ink-500">CHAPTERS</span>
              <button
                onClick={() => { saveNow(); createChapter.mutate({ projectId, title: `Chapter ${chapters.length + 1}`, body: "" }); }}
                disabled={createChapter.isPending}
                aria-label="Add chapter"
                className="grid h-7 w-7 place-items-center rounded-lg bg-white text-brand-600 shadow-hairline ring-1 ring-stone-150 transition hover:text-brand-800 hover:ring-brand-200 disabled:opacity-50"
              >
                <Plus aria-hidden="true" size={14} />
              </button>
            </div>
            {chapters.length > 0 && (
              <div className="mb-3 rounded-xl border border-stone-150 bg-paper px-3 py-2.5 text-2xs text-ink-500">
                <span className="font-semibold tabular-nums text-ink-800">{includedChapters.length} of {chapters.length}</span> in the audiobook · {formatWordCount(includedWords)}
                <div className="mt-1.5 flex gap-3">
                  <button disabled={setIncluded.isPending} onClick={() => setIncluded.mutate({ projectId, chapterIds: chapters.map(chapter => chapter.id), included: true })} className="font-semibold text-brand-600 underline-offset-2 hover:underline disabled:opacity-50">Select all</button>
                  <button disabled={setIncluded.isPending} onClick={() => setIncluded.mutate({ projectId, chapterIds: chapters.map(chapter => chapter.id), included: false })} className="font-semibold text-brand-600 underline-offset-2 hover:underline disabled:opacity-50">Select none</button>
                </div>
              </div>
            )}

            {workspace.isLoading ? (
              <div className="space-y-2">{[0, 1, 2].map(index => <div key={index} className="skeleton h-14 rounded-xl" />)}</div>
            ) : (
              chapters.map((chapter, index) => {
                const own = (workspace.data?.segments ?? []).filter(segment => segment.chapterId === chapter.id);
                const ready = own.length > 0 && own.every(segment => segment.audioStorageKey);
                const active = chapter.id === activeChapter?.id;
                const included = Boolean(chapter.included);
                return (
                  <div key={chapter.id} className={`mb-1 flex items-start gap-2.5 rounded-xl p-2.5 transition ${active ? "bg-white shadow-soft ring-1 ring-stone-150" : "hover:bg-stone-50"} ${included ? "" : "opacity-60"}`}>
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={event => toggleIncluded(chapter.id, event.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                      aria-label={`Include ${chapter.title} in the audiobook`}
                    />
                    <button
                      onClick={() => { saveNow(); setSelectedChapterId(chapter.id); }}
                      aria-current={active}
                      className="min-w-0 flex-1 rounded text-left"
                    >
                      <span className={`line-clamp-2 text-[13px] leading-snug ${active ? "font-semibold" : "font-medium"} ${included ? (active ? "text-ink-950" : "text-ink-700") : "text-ink-500 line-through decoration-stone-300"}`}><span className="tabular-nums text-ink-500">{index + 1}.</span> {chapter.title}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-ink-500">
                        {KIND_LABEL[chapter.kind] && <span className="rounded-full bg-gold-50 px-1.5 py-0.5 text-gold-700 ring-1 ring-gold-100">{KIND_LABEL[chapter.kind]}</span>}
                        <span>{formatWordCount(chapterWords.get(chapter.id) ?? 0)}</span>
                        {included && (
                          <span className={ready ? "text-brand-600" : own.length ? "text-gold-700" : "text-ink-500"}>
                            {ready ? "Narrated" : own.length ? `${own.filter(segment => segment.audioStorageKey).length}/${own.length} segments` : "Not split yet"}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </aside>

          <section className="flex min-w-0 flex-col border-b border-stone-150 bg-paper px-5 py-6 lg:border-b-0 lg:px-10 lg:py-9">
            {!activeChapter ? (
              <div className="flex flex-1 items-center justify-center text-sm text-ink-500">Choose a chapter to edit.</div>
            ) : (
              <div className="mx-auto flex w-full max-w-[46rem] flex-1 flex-col">
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <label className="block">
                      <span className="eyebrow text-ink-500">CHAPTER TITLE</span>
                      <input
                        value={draftTitle}
                        onChange={event => { setDraftTitle(event.target.value); queueSave(event.target.value, draftBody); }}
                        onBlur={saveNow}
                        className="serif mt-1.5 w-full border-0 bg-transparent text-[30px] leading-tight tracking-[-.018em] text-ink-950 decoration-stone-300 underline-offset-8 outline-none focus:underline"
                        aria-label="Chapter title"
                      />
                    </label>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 rounded-xl border border-stone-150 bg-paper-50 p-0.5">
                    <button onClick={() => moveChapter(-1)} disabled={activeIndex <= 0 || reorder.isPending} aria-label="Move chapter up" className="rounded-lg p-2 text-ink-500 transition hover:bg-white hover:text-brand-700 disabled:opacity-30"><ArrowUp aria-hidden="true" size={15} /></button>
                    <button onClick={() => moveChapter(1)} disabled={activeIndex < 0 || activeIndex >= chapters.length - 1 || reorder.isPending} aria-label="Move chapter down" className="rounded-lg p-2 text-ink-500 transition hover:bg-white hover:text-brand-700 disabled:opacity-30"><ArrowDown aria-hidden="true" size={15} /></button>
                    <button
                      onClick={() => { if (window.confirm(`Delete "${activeChapter.title}" and its audio? This cannot be undone.`)) deleteChapter.mutate({ projectId, chapterId: activeChapter.id }); }}
                      disabled={deleteChapter.isPending}
                      className="rounded-lg p-2 text-ink-500 transition hover:bg-clay-50 hover:text-clay-600 disabled:opacity-50"
                      aria-label={`Delete ${activeChapter.title}`}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                    </button>
                  </div>
                </div>

                {!activeChapter.included && (
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gold-100 bg-gold-50 px-4 py-3 text-xs text-gold-700">
                    <span>{KIND_LABEL[activeChapter.kind] ? `Detected as ${KIND_LABEL[activeChapter.kind]!.toLowerCase()}, so it` : "This chapter"} is left out of the audiobook. Its text is kept.</span>
                    <button onClick={() => toggleIncluded(activeChapter.id, true)} className="font-semibold text-gold-800 underline-offset-2 hover:underline">Include it</button>
                  </div>
                )}

                <textarea
                  value={draftBody}
                  onChange={event => { setDraftBody(event.target.value); queueSave(draftTitle, event.target.value); }}
                  onBlur={saveNow}
                  placeholder="Paste or write this chapter's text. Leave a blank line between paragraphs; a line with * * * marks a scene break."
                  className="manuscript-page min-h-[320px] w-full flex-1 resize-none border-0 bg-transparent outline-none"
                  aria-label={`${activeChapter.title} text`}
                />

                <div className="mt-4 flex flex-wrap justify-between gap-3 border-t border-stone-100 pt-3 text-2xs tabular-nums text-ink-500">
                  <span>{words.toLocaleString()} words · ~{readMinutes} min listen</span>
                  <span>{segments.length} segment{segments.length === 1 ? "" : "s"} · {renderedSegments} with audio</span>
                </div>
              </div>
            )}
          </section>

          <aside className="bg-paper-50 p-4 lg:overflow-auto">
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="eyebrow text-ink-500">NARRATION SEGMENTS</span>
              <button
                onClick={() => activeChapter && resegment.mutate({ projectId, chapterIds: [activeChapter.id] })}
                disabled={!activeChapter || !activeChapter.included || resegment.isPending || dirty}
                title={dirty ? "Save your edits first" : !activeChapter?.included ? "Include the chapter first" : "Re-split this chapter"}
                aria-label="Re-split this chapter"
                className="grid h-7 w-7 place-items-center rounded-lg bg-white text-brand-600 shadow-hairline ring-1 ring-stone-150 transition hover:text-brand-800 hover:ring-brand-200 disabled:opacity-40"
              >
                <Split aria-hidden="true" size={14} />
              </button>
            </div>

            {segments.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-300 bg-paper/60 p-4 text-xs leading-5 text-ink-500">
                No segments yet. Use <strong className="font-semibold text-ink-700">Split into segments</strong>, or analyze the cast, once this chapter has text. Prosecast breaks it at paragraph and sentence boundaries{multiVoice ? " and separates dialogue so each character can speak their own lines" : ""}.
              </p>
            ) : (
              segments.map((segment, index) => {
                const dialogue = segment.delivery?.kind === "dialogue";
                const speaker = segment.characterId ? speakerName.get(segment.characterId) : undefined;
                return (
                  <div key={segment.id} className={`mb-2 rounded-xl border bg-white p-3 shadow-hairline ${dialogue ? "border-sky-200 border-l-2 border-l-sky-500" : "border-stone-150"}`}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="mono flex items-center gap-1.5 text-3xs text-ink-500">
                        {String(index + 1).padStart(2, "0")}
                        {dialogue && <Quote aria-label="Dialogue" size={11} className="text-sky-500" />}
                        {segment.delivery?.sceneBreakBefore && <span className="rounded bg-gold-50 px-1 text-3xs text-gold-700 ring-1 ring-gold-100">SCENE</span>}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-3xs font-medium ${segment.audioStorageKey ? "bg-brand-50 text-brand-700" : segment.lastError ? "bg-clay-50 text-clay-700" : "bg-gold-50 text-gold-700"}`}>
                        {segment.audioStorageKey ? "Audio ready" : segment.lastError ? "Failed" : "Needs audio"}
                      </span>
                    </div>
                    <p className="line-clamp-4 text-xs leading-5 text-ink-600">{segment.text}</p>
                    {multiVoice && (
                      <label className="mt-2 flex items-center gap-2 text-3xs font-semibold text-ink-500">
                        Voice
                        <select
                          value={segment.characterId ?? ""}
                          onChange={event => updateSegment.mutate({ projectId, segmentId: segment.id, characterId: event.target.value || null })}
                          disabled={updateSegment.isPending}
                          className="min-w-0 flex-1 rounded-lg border border-stone-150 bg-paper px-2 py-1 text-2xs text-ink-700 outline-none focus:border-brand-400"
                          aria-label={`Speaker for segment ${index + 1}`}
                        >
                          <option value="">Narrator</option>
                          {speakers.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                          {segment.characterId && !speakers.some(character => character.id === segment.characterId) && <option value={segment.characterId}>{speaker ?? "Unknown speaker"}</option>}
                        </select>
                      </label>
                    )}
                    <div className="mt-2 flex items-center justify-between text-3xs text-ink-500">
                      <span>{segment.text.length} chars{dialogue && !segment.characterId ? " · speaker not identified yet" : ""}</span>
                      {segment.audioDurationMs ? <span>{(segment.audioDurationMs / 1000).toFixed(1)}s</span> : null}
                    </div>
                    {segment.audioStorageKey && (
                      <audio
                        controls
                        preload="none"
                        src={storageUrl(segment.audioStorageKey)}
                        className="mt-2 h-8 w-full"
                        aria-label={`Segment ${index + 1} narration`}
                      />
                    )}
                    {segment.lastError && <p className="mt-2 text-3xs leading-4 text-clay-600">{segment.lastError}</p>}
                  </div>
                );
              })
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function EmptyManuscript({ importing, adding, onImport, onAdd }: { importing: boolean; adding: boolean; onImport: () => void; onAdd: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-9">
      <div className="w-full max-w-xl rounded-card border border-dashed border-stone-300 bg-paper p-10 text-center shadow-hairline">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-brand-100"><BookOpen aria-hidden="true" size={24} strokeWidth={1.75} /></span>
        <h3 className="serif mt-5 text-[28px] leading-tight tracking-[-.015em] text-ink-950">Bring in the whole book</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-500">
          Import an EPUB, Word document, Markdown, HTML or text file. Bookx splits it into chapters and leaves the cover, copyright and contents pages out of the audiobook. You can edit, remove or re-include anything afterwards.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button onClick={onImport} disabled={importing} className="btn-primary btn-lg disabled:opacity-50">
            {importing ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <FileUp aria-hidden="true" size={16} />}
            {importing ? "Importing…" : "Import manuscript"}
          </button>
          <button onClick={onAdd} disabled={adding || importing} className="btn-soft btn-lg disabled:opacity-50">Write a chapter instead</button>
        </div>
      </div>
    </div>
  );
}

function Header({ actions }: { actions: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5 border-b border-stone-150 bg-paper px-6 py-7 md:flex-row md:items-end md:justify-between md:px-9">
      <div className="min-w-0">
        <p className="eyebrow text-brand-600">01 · WRITE</p>
        <h2 className="serif mt-2 text-[34px] leading-[1.1] tracking-[-.02em] text-ink-950">The manuscript</h2>
        <p className="mt-2.5 max-w-2xl text-sm leading-6 text-ink-500">
          Import the book or write it here. Tick the chapters that belong in the audiobook; edits save as you type, and re-splitting keeps the audio for anything you did not change.
        </p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
import { storageUrl } from "@shared/storageKeys";
