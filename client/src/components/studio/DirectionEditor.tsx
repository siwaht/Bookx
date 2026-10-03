import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Plus, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DIRECTION_LIMITS,
  SUGGESTED_LINE_TAGS,
  SUGGESTED_MOODS,
  cleanTag,
  composeDirection,
  sceneDirection,
  takesDirection,
  type ChapterDirection,
  type SceneDirection,
} from "@shared/direction";
import { ConfirmDialog } from "./ConfirmDialog";
import { Badge, Notice, ui } from "./studioUi";

/**
 * Directs a chapter's performance: a setting and a mood for the chapter and
 * each scene, and a delivery for any line ("whispers", "sarcastic"). Shows
 * exactly what the current model will receive, and can ask the project's
 * language model for a first pass to review.
 */
export function DirectionEditor({ projectId, chapterId, open, onOpenChange }: { projectId: string; chapterId: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  // No refetch on focus: a refetch reloads the form and would drop unsaved edits.
  const query = trpc.studio.chapterDirection.useQuery({ projectId, chapterId: chapterId ?? "" }, { enabled: open && Boolean(chapterId), refetchOnWindowFocus: false });
  const data = query.data;

  const [setting, setSetting] = useState("");
  const [mood, setMood] = useState("");
  const [scenes, setScenes] = useState<Record<string, SceneDirection>>({});
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTag, setDraftTag] = useState("");
  const [askAi, setAskAi] = useState(false);

  // Load the saved direction whenever the chapter (or its saved data) changes.
  useEffect(() => {
    if (!data) return;
    setSetting(data.direction.setting ?? "");
    setMood(data.direction.mood ?? "");
    setScenes(data.direction.scenes ?? {});
    setTags(Object.fromEntries(data.lines.map(line => [line.id, line.tags])));
    setEditing(null);
  }, [data]);

  const save = trpc.studio.saveChapterDirection.useMutation({
    onSuccess: result => {
      toast.success(result.lines ? `Direction saved. ${result.lines} line${result.lines === 1 ? "" : "s"} will be re-narrated on the next run.` : "Direction saved.");
      void utils.studio.chapterDirection.invalidate({ projectId, chapterId: chapterId ?? "" });
      void utils.studio.chapterPlayback.invalidate();
      void utils.bookx.auditNarration.invalidate({ projectId });
      void utils.bookx.narrationStatus.invalidate({ projectId });
    },
    onError: error => toast.error(error.message || "Prosecast could not save the direction."),
  });
  const suggest = trpc.studio.suggestDirection.useMutation({
    onSuccess: result => {
      if (result.setting) setSetting(result.setting);
      if (result.mood) setMood(result.mood);
      setScenes(current => ({ ...current, ...result.scenes }));
      setTags(current => ({ ...current, ...Object.fromEntries(result.lines.map(line => [line.segmentId, line.tags])) }));
      toast.success(`${result.model} suggested direction for ${result.lines.length} line${result.lines.length === 1 ? "" : "s"}. Review it, then save.`);
      setAskAi(false);
    },
    onError: error => {
      toast.error(error.message || "Prosecast could not get suggestions.");
      setAskAi(false);
    },
  });

  const direction: ChapterDirection = useMemo(() => ({ setting, mood, scenes }), [setting, mood, scenes]);
  const traits = data?.voice.traits;
  const directs = traits ? takesDirection(traits) : false;

  const changedLines = useMemo(() => (data?.lines ?? [])
    .filter(line => JSON.stringify(tags[line.id] ?? []) !== JSON.stringify(line.tags))
    .map(line => ({ segmentId: line.id, tags: tags[line.id] ?? [] })), [data?.lines, tags]);
  const dirty = Boolean(data) && (
    setting !== (data!.direction.setting ?? "") ||
    mood !== (data!.direction.mood ?? "") ||
    JSON.stringify(scenes) !== JSON.stringify(data!.direction.scenes ?? {}) ||
    changedLines.length > 0
  );

  const addTag = (lineId: string, raw: string) => {
    const tag = cleanTag(raw);
    if (!tag) return;
    setTags(current => {
      const existing = current[lineId] ?? [];
      if (existing.includes(tag) || existing.length >= DIRECTION_LIMITS.tagsPerLine) return current;
      return { ...current, [lineId]: [...existing, tag] };
    });
    setDraftTag("");
  };
  const removeTag = (lineId: string, tag: string) => setTags(current => ({ ...current, [lineId]: (current[lineId] ?? []).filter(value => value !== tag) }));
  const setScene = (index: number, patch: SceneDirection) => setScenes(current => ({ ...current, [String(index)]: { ...current[String(index)], ...patch } }));

  const sceneIndexes = Array.from({ length: data?.sceneCount ?? 1 }, (_, index) => index);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-hidden sm:max-w-3xl rounded-panel bg-paper p-0">
        <div className="flex max-h-[92vh] flex-col">
          <DialogHeader className="border-b border-stone-150 px-6 pb-4 pt-6">
            <DialogTitle className="serif text-2xl tracking-[-.03em] text-ink-900">Direct the performance</DialogTitle>
            <DialogDescription className="text-sm leading-6 text-ink-500">
              {data ? data.chapter.title : "Loading…"} · Give the chapter and its scenes a setting and a mood, and any line its own delivery.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 space-y-5 overflow-auto px-6 py-5">
            {!data ? (
              query.error ? <Notice tone="bad">{query.error.message}</Notice> : <div className="skeleton h-40 w-full" />
            ) : (
              <>
                {directs ? (
                  <Notice tone="good" title={`${traits!.label} takes direction`}>
                    {traits!.audioTags
                      ? "Each line is sent with audio tags such as [whispers]. Lines without their own tag carry the scene's mood; the setting is voiced at the start of each scene. Tags are billed as text."
                      : "Direction is sent as instructions alongside the text, so it is never read aloud and costs no extra characters."}
                  </Notice>
                ) : (
                  <Notice tone="warn" title={`${traits?.label ?? "This model"} ignores direction`}>
                    You can still write it, and it is kept. To hear it, switch the narration model to Eleven v4 (audio tags) or GPT-4o mini TTS (instructions) on the Generate tab.
                  </Notice>
                )}

                <section className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={ui.label}>Chapter setting</span>
                    <input className="input" value={setting} maxLength={DIRECTION_LIMITS.setting} onChange={event => setSetting(event.target.value)} placeholder="A rain-soaked cabin, late at night" />
                  </label>
                  <label className="block">
                    <span className={ui.label}>Chapter mood</span>
                    <input className="input" value={mood} maxLength={DIRECTION_LIMITS.mood} onChange={event => setMood(event.target.value)} placeholder="tense, hushed" list="prosecast-moods" />
                  </label>
                  <datalist id="prosecast-moods">{SUGGESTED_MOODS.map(value => <option key={value} value={value} />)}</datalist>
                  <div className="flex flex-wrap gap-1.5 sm:col-span-2" role="group" aria-label="Mood suggestions">
                    {SUGGESTED_MOODS.map(value => (
                      <button key={value} type="button" className={mood === value ? ui.chipOn : ui.chip} aria-pressed={mood === value} onClick={() => setMood(mood === value ? "" : value)}><span className={ui.chipText}>{value}</span></button>
                    ))}
                  </div>
                </section>

                {sceneIndexes.length > 1 && (
                  <section>
                    <h4 className={`${ui.heading} text-sm`}>Scenes</h4>
                    <p className={`mt-0.5 text-xs ${ui.muted}`}>Each scene break starts a new scene. Leave a field empty to use the chapter's.</p>
                    <div className="mt-3 space-y-2">
                      {sceneIndexes.map(index => {
                        const effective = sceneDirection(direction, index);
                        return (
                          <div key={index} className="grid items-center gap-2 rounded-xl border border-stone-150 bg-paper-50 p-3 sm:grid-cols-[90px_1fr_1fr]">
                            <span className="text-xs font-semibold text-ink-600">{index === 0 ? "Opening" : `Scene ${index + 1}`}</span>
                            <input className="input py-2 text-xs" aria-label={`Setting for scene ${index + 1}`} value={scenes[String(index)]?.setting ?? ""} maxLength={DIRECTION_LIMITS.setting} placeholder={effective.setting || "Setting"} onChange={event => setScene(index, { setting: event.target.value })} />
                            <input className="input py-2 text-xs" aria-label={`Mood for scene ${index + 1}`} value={scenes[String(index)]?.mood ?? ""} maxLength={DIRECTION_LIMITS.mood} placeholder={effective.mood || "Mood"} onChange={event => setScene(index, { mood: event.target.value })} />
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                <section>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className={`${ui.heading} text-sm`}>Lines</h4>
                      <p className={`mt-0.5 text-xs ${ui.muted}`}>Give a line its own delivery only where it matters. One emotion per line works best.</p>
                    </div>
                    <button type="button" className="btn-soft" onClick={() => setAskAi(true)} disabled={suggest.isPending}>
                      {suggest.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={13} /> : <Wand2 aria-hidden="true" size={13} />} Suggest with AI
                    </button>
                  </div>
                  <datalist id="prosecast-line-tags">{SUGGESTED_LINE_TAGS.map(value => <option key={value} value={value} />)}</datalist>
                  <ol className="mt-3 space-y-1.5">
                    {data.lines.map(line => {
                      const lineTags = tags[line.id] ?? [];
                      const spec = { lineTags, ...sceneDirection(direction, line.scene), sceneStart: line.sceneStart };
                      const sent = traits ? composeDirection(spec, traits, data.voice.instructions) : null;
                      const open = editing === line.id;
                      return (
                        <li key={line.id} className={`rounded-xl border px-3 py-2.5 ${open ? "border-brand-300 bg-brand-50/60" : "border-stone-150"}`}>
                          {line.sceneStart && line.index > 0 && <span className={`${ui.eyebrow} mb-1 block`}>Scene {line.scene + 1}</span>}
                          <div className="flex items-start gap-3">
                            <span className={`mono mt-0.5 text-3xs ${ui.faint} ${ui.numbers}`}>{String(line.index + 1).padStart(2, "0")}</span>
                            <div className="min-w-0 flex-1">
                              {line.speaker && <span className="text-3xs font-semibold text-ink-600">{line.speaker} · </span>}
                              <span className="text-[13px] leading-6 text-ink-700">{line.text}</span>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {lineTags.map(tag => (
                                  <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-brand-50 ring-1 ring-brand-100 px-2 py-0.5 text-2xs font-semibold text-brand-800">
                                    [{tag}]
                                    <button type="button" onClick={() => removeTag(line.id, tag)} aria-label={`Remove ${tag} from line ${line.index + 1}`} className="rounded-full hover:bg-brand-100"><X aria-hidden="true" size={10} /></button>
                                  </span>
                                ))}
                                <button type="button" className={ui.linkButton} onClick={() => { setEditing(open ? null : line.id); setDraftTag(""); }} aria-expanded={open}>
                                  <Plus aria-hidden="true" size={11} /><span className={ui.linkText}>{lineTags.length ? "Edit delivery" : "Add delivery"}</span>
                                </button>
                                {sent?.fingerprint && directs && <span className={`truncate text-3xs ${ui.faint}`}>Sends {sent.prefix ? sent.prefix.trim() : `instructions: “${sent.instructions}”`}</span>}
                              </div>
                              {open && (
                                <div className="mt-2 rounded-lg bg-white p-2.5">
                                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Delivery suggestions for line ${line.index + 1}`}>
                                    {SUGGESTED_LINE_TAGS.map(tag => (
                                      <button key={tag} type="button" className={lineTags.includes(tag) ? ui.chipOn : ui.chip} aria-pressed={lineTags.includes(tag)} onClick={() => (lineTags.includes(tag) ? removeTag(line.id, tag) : addTag(line.id, tag))}><span className={ui.chipText}>{tag}</span></button>
                                    ))}
                                  </div>
                                  <form className="mt-2 flex gap-2" onSubmit={event => { event.preventDefault(); addTag(line.id, draftTag); }}>
                                    <input className="input py-2 text-xs" list="prosecast-line-tags" value={draftTag} maxLength={DIRECTION_LIMITS.tag} onChange={event => setDraftTag(event.target.value)} placeholder="Or describe it: low, steady voice" aria-label={`Custom delivery for line ${line.index + 1}`} />
                                    <button type="submit" className="btn-soft shrink-0" disabled={!draftTag.trim()}>Add</button>
                                  </form>
                                </div>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-150 px-6 py-4">
            <span className={`text-xs ${ui.muted}`}>
              {dirty ? <Badge tone="warn">Unsaved changes</Badge> : "Saved direction applies to the next run, re-take or regeneration."}
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-soft" onClick={() => onOpenChange(false)}>Close</button>
              <button
                type="button"
                className="btn-primary"
                disabled={!dirty || save.isPending || !chapterId}
                onClick={() => chapterId && save.mutate({ projectId, chapterId, setting, mood, scenes, lines: changedLines })}
              >
                {save.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <Sparkles aria-hidden="true" size={14} />} Save direction
              </button>
            </div>
          </div>
        </div>

        <ConfirmDialog
          open={askAi}
          onOpenChange={setAskAi}
          title="Suggest direction with AI?"
          description="The project's language model reads this chapter and proposes a setting, a mood and deliveries for the lines that call for one. Nothing is saved until you review and save it."
          cost="Sends the chapter's text to the project's language model (one paid request)."
          confirmLabel="Suggest direction"
          pending={suggest.isPending}
          onConfirm={() => chapterId && suggest.mutate({ projectId, chapterId })}
        />
      </DialogContent>
    </Dialog>
  );
}
