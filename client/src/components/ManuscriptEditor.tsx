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
    onError: error => toast.error(error.message || "Prosecast could not save the chapter."),
  });
  const createChapter = trpc.bookx.createChapter.useMutation({
    onSuccess: result => { setSelectedChapterId(result.id); setDirty(false); invalidate(); },
    onError: error => toast.error(error.message || "Prosecast could not add the chapter."),
  });
  const deleteChapter = trpc.bookx.deleteChapter.useMutation({
    onSuccess: () => { setSelectedChapterId(null); setDirty(false); invalidate(); },
    onError: error => toast.error(error.message || "Prosecast could not delete the chapter."),
  });
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

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow choosing the same file again
    if (!file) return;
    setReadingFile(true);
    try {
      const upload = await readManuscriptFile(file);
      saveNow();
      if (chapters.length) setPendingImport(upload);
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
          <div className="max-w-md rounded-[22px] border border-dashed border-[#d4ded7] bg-[#fbfcf9] p-7 text-center">
            <Split aria-hidden="true" className="mx-auto mb-4 text-[#a3b3ac]" size={26} />
            <h3 className="font-bold text-[#35494b]">The manuscript lives on the server</h3>
            <p className="mt-2 text-sm leading-6 text-[#748285]">{disabledReason}</p>
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
            <span className="text-xs text-[#849092]" role="status">
              {updateChapter.isPending ? "Saving…" : dirty ? "Unsaved changes" : chapters.length ? "Saved" : ""}
            </span>
            <button onClick={() => fileInput.current?.click()} disabled={importing} className="btn-soft disabled:opacity-50">
              {importing ? <LoaderCircle className="mr-1 inline animate-spin" aria-hidden="true" size={14} /> : <FileUp className="mr-1 inline" aria-hidden="true" size={14} />}
              {importing ? "Importing…" : "Import manuscript"}
            </button>
            <button
              onClick={() => resegment.mutate({ projectId })}
              disabled={resegment.isPending || !includedChapters.length}
              className="btn-soft disabled:opacity-50"
              title="Split every included chapter into narration segments sized for your voice model"
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
        <div role="alertdialog" aria-labelledby="import-choice-title" className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eadfc7] bg-[#fff9ec] px-6 py-4 md:px-9">
          <div className="min-w-0">
            <strong id="import-choice-title" className="block text-sm text-[#5b4a2b]">Import “{pendingImport.name}”</strong>
            <span className="text-xs text-[#8a7446]">This project already has {chapters.length} chapter{chapters.length === 1 ? "" : "s"}. Replacing removes them and their narration.</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={importing} onClick={() => importManuscript.mutate({ projectId, filename: pendingImport.name, base64: pendingImport.base64, mode: "replace" })} className="btn-primary disabled:opacity-50">Replace chapters</button>
            <button disabled={importing} onClick={() => importManuscript.mutate({ projectId, filename: pendingImport.name, base64: pendingImport.base64, mode: "append" })} className="btn-soft disabled:opacity-50">Add at the end</button>
            <button disabled={importing} onClick={() => setPendingImport(null)} aria-label="Cancel import" className="grid h-9 w-9 place-items-center rounded-xl text-[#8a7446] hover:bg-[#f6ecd6]"><X aria-hidden="true" size={15} /></button>
          </div>
        </div>
      )}

      {!workspace.isLoading && chapters.length === 0 ? (
        <EmptyManuscript importing={importing} onImport={() => fileInput.current?.click()} onAdd={() => createChapter.mutate({ projectId, title: "Chapter 1", body: "" })} />
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[270px_minmax(0,1fr)_320px]">
          <aside className="border-b border-[#e1e5de] bg-[#fafbf7] p-4 lg:border-b-0 lg:border-r lg:overflow-auto">
            <div className="mb-2 flex items-center justify-between">
              <span className="mono text-[10px] tracking-[.12em] text-[#899494]">CHAPTERS</span>
              <button
                onClick={() => createChapter.mutate({ projectId, title: `Chapter ${chapters.length + 1}`, body: "" })}
                disabled={createChapter.isPending}
                aria-label="Add chapter"
                className="rounded-lg bg-[#e5f0ec] p-1.5 text-[#36746e] transition hover:bg-[#d9ebe4] disabled:opacity-50"
              >
                <Plus aria-hidden="true" size={14} />
              </button>
            </div>
            {chapters.length > 0 && (
              <div className="mb-3 rounded-xl bg-[#eef4f0] px-3 py-2 text-[11px] text-[#557570]">
                <span className="font-bold">{includedChapters.length} of {chapters.length}</span> in the audiobook · {formatWordCount(includedWords)}
                <div className="mt-1 flex gap-3">
                  <button disabled={setIncluded.isPending} onClick={() => setIncluded.mutate({ projectId, chapterIds: chapters.map(chapter => chapter.id), included: true })} className="font-bold text-[#34736d] hover:underline disabled:opacity-50">Select all</button>
                  <button disabled={setIncluded.isPending} onClick={() => setIncluded.mutate({ projectId, chapterIds: chapters.map(chapter => chapter.id), included: false })} className="font-bold text-[#34736d] hover:underline disabled:opacity-50">Select none</button>
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
                  <div key={chapter.id} className={`mb-1 flex items-start gap-2 rounded-xl p-2.5 ${active ? "bg-[#e5f0ed]" : "hover:bg-[#f0f2ee]"} ${included ? "" : "opacity-60"}`}>
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={event => toggleIncluded(chapter.id, event.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[#3f827a]"
                      aria-label={`Include ${chapter.title} in the audiobook`}
                    />
                    <button
                      onClick={() => { saveNow(); setDirty(false); setSelectedChapterId(chapter.id); }}
                      aria-current={active}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className={`line-clamp-2 text-xs font-semibold ${included ? "text-[#3c5052]" : "text-[#7c8a8b] line-through decoration-[#b9c3c1]"}`}>{index + 1}. {chapter.title}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#7f8a8c]">
                        {KIND_LABEL[chapter.kind] && <span className="rounded-full bg-[#f1ece0] px-1.5 py-0.5 text-[#8a7446]">{KIND_LABEL[chapter.kind]}</span>}
                        <span>{formatWordCount(chapterWords.get(chapter.id) ?? 0)}</span>
                        {included && (
                          <span className={ready ? "text-[#4a8e7b]" : own.length ? "text-[#bd8432]" : "text-[#829092]"}>
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

          <section className="flex min-w-0 flex-col border-b border-[#e1e5de] bg-[#fffefa] p-5 lg:border-b-0 lg:p-7">
            {!activeChapter ? (
              <div className="flex flex-1 items-center justify-center text-sm text-[#849092]">Choose a chapter to edit.</div>
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
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => moveChapter(-1)} disabled={activeIndex <= 0 || reorder.isPending} aria-label="Move chapter up" className="rounded-lg p-2 text-[#8a9899] transition hover:bg-[#eef3ef] hover:text-[#36746e] disabled:opacity-30"><ArrowUp aria-hidden="true" size={15} /></button>
                    <button onClick={() => moveChapter(1)} disabled={activeIndex < 0 || activeIndex >= chapters.length - 1 || reorder.isPending} aria-label="Move chapter down" className="rounded-lg p-2 text-[#8a9899] transition hover:bg-[#eef3ef] hover:text-[#36746e] disabled:opacity-30"><ArrowDown aria-hidden="true" size={15} /></button>
                    <button
                      onClick={() => { if (window.confirm(`Delete "${activeChapter.title}" and its audio? This cannot be undone.`)) deleteChapter.mutate({ projectId, chapterId: activeChapter.id }); }}
                      disabled={deleteChapter.isPending}
                      className="rounded-lg p-2 text-[#9aa2a3] transition hover:bg-[#fbeeea] hover:text-[#af5d5d] disabled:opacity-50"
                      aria-label={`Delete ${activeChapter.title}`}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                    </button>
                  </div>
                </div>

                {!activeChapter.included && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#eadfc7] bg-[#fff9ec] px-4 py-3 text-xs text-[#8a7446]">
                    <span>{KIND_LABEL[activeChapter.kind] ? `Detected as ${KIND_LABEL[activeChapter.kind]!.toLowerCase()}, so it` : "This chapter"} is left out of the audiobook. Its text is kept.</span>
                    <button onClick={() => toggleIncluded(activeChapter.id, true)} className="font-bold text-[#6b5520] hover:underline">Include it</button>
                  </div>
                )}

                <textarea
                  value={draftBody}
                  onChange={event => { setDraftBody(event.target.value); queueSave(draftTitle, event.target.value); }}
                  onBlur={saveNow}
                  placeholder="Paste or write this chapter's text. Leave a blank line between paragraphs; a line with * * * marks a scene break."
                  className="min-h-[320px] flex-1 w-full resize-none border-0 bg-transparent text-[16px] leading-8 text-[#35474a] outline-none"
                  aria-label={`${activeChapter.title} text`}
                />

                <div className="mt-3 flex flex-wrap justify-between gap-3 border-t border-[#edf0eb] pt-3 text-[11px] text-[#849092]">
                  <span>{words.toLocaleString()} words · ~{readMinutes} min listen</span>
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
                disabled={!activeChapter || !activeChapter.included || resegment.isPending || dirty}
                title={dirty ? "Save your edits first" : !activeChapter?.included ? "Include the chapter first" : "Re-split this chapter"}
                aria-label="Re-split this chapter"
                className="rounded-lg bg-[#e5f0ec] p-1.5 text-[#36746e] disabled:opacity-40"
              >
                <Split aria-hidden="true" size={14} />
              </button>
            </div>

            {segments.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[#d8e1dc] p-4 text-xs leading-5 text-[#778689]">
                No segments yet. Use <strong>Split into segments</strong>, or analyze the cast, once this chapter has text. Prosecast breaks it at paragraph and sentence boundaries{multiVoice ? " and separates dialogue so each character can speak their own lines" : ""}.
              </p>
            ) : (
              segments.map((segment, index) => {
                const dialogue = segment.delivery?.kind === "dialogue";
                const speaker = segment.characterId ? speakerName.get(segment.characterId) : undefined;
                return (
                  <div key={segment.id} className={`mb-2 rounded-xl border bg-white p-3 ${dialogue ? "border-[#d9e2ec]" : "border-[#e1e5de]"}`}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 mono text-[10px] text-[#899494]">
                        {String(index + 1).padStart(2, "0")}
                        {dialogue && <Quote aria-label="Dialogue" size={11} className="text-[#6f8fae]" />}
                        {segment.delivery?.sceneBreakBefore && <span className="rounded bg-[#f1ece0] px-1 text-[9px] text-[#8a7446]">SCENE</span>}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[9px] ${segment.audioStorageKey ? "bg-[#e7f3ef] text-[#397b70]" : segment.lastError ? "bg-[#fbe9e4] text-[#a35a44]" : "bg-[#fbefd9] text-[#9e722c]"}`}>
                        {segment.audioStorageKey ? "Audio ready" : segment.lastError ? "Failed" : "Needs audio"}
                      </span>
                    </div>
                    <p className="line-clamp-4 text-xs leading-5 text-[#516064]">{segment.text}</p>
                    {multiVoice && (
                      <label className="mt-2 flex items-center gap-2 text-[10px] font-semibold text-[#6d7f81]">
                        Voice
                        <select
                          value={segment.characterId ?? ""}
                          onChange={event => updateSegment.mutate({ projectId, segmentId: segment.id, characterId: event.target.value || null })}
                          disabled={updateSegment.isPending}
                          className="min-w-0 flex-1 rounded-lg border border-[#dfe6e0] bg-[#fbfcfa] px-2 py-1 text-[11px] text-[#3c5052] outline-none focus:border-[#7ba9a1]"
                          aria-label={`Speaker for segment ${index + 1}`}
                        >
                          <option value="">Narrator</option>
                          {speakers.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                          {segment.characterId && !speakers.some(character => character.id === segment.characterId) && <option value={segment.characterId}>{speaker ?? "Unknown speaker"}</option>}
                        </select>
                      </label>
                    )}
                    <div className="mt-2 flex items-center justify-between text-[10px] text-[#8a9492]">
                      <span>{segment.text.length} chars{dialogue && !segment.characterId ? " · speaker not identified yet" : ""}</span>
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
                );
              })
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function EmptyManuscript({ importing, onImport, onAdd }: { importing: boolean; onImport: () => void; onAdd: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-9">
      <div className="w-full max-w-xl rounded-[26px] border border-dashed border-[#9fbfb7] bg-[#f4f9f6] p-8 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#e2f0ea] text-[#3d7f75]"><BookOpen aria-hidden="true" size={24} /></span>
        <h3 className="serif mt-5 text-2xl tracking-[-.03em] text-[#25393c]">Bring in the whole book</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#6d7f82]">
          Import an EPUB, Word document, Markdown, HTML or text file. Bookx splits it into chapters and leaves the cover, copyright and contents pages out of the audiobook. You can edit, remove or re-include anything afterwards.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button onClick={onImport} disabled={importing} className="btn-primary btn-lg disabled:opacity-50">
            {importing ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <FileUp aria-hidden="true" size={16} />}
            {importing ? "Importing…" : "Import manuscript"}
          </button>
          <button onClick={onAdd} className="btn-soft btn-lg">Write a chapter instead</button>
        </div>
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
          Import the book or write it here. Tick the chapters that belong in the audiobook; edits save as you type, and re-splitting keeps the audio for anything you did not change.
        </p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
