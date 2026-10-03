import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, AudioLines, Headphones, LoaderCircle, Music2, Play, RefreshCw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { AddCueForm, ChapterMusicSelect, CueExtras, MusicSettingsPanel, SoundLibraryPanel, SoundsSummary } from "./studio/SoundStudioExtras";
import { StepTiming } from "./studio/StepTiming";

/**
 * Audio studio: background sounds and music for an audiobook.
 *
 * Both are off until the creator turns them on. Turning one on plans the
 * book's scenes (if that has not happened yet) and prepares the sounds, so the
 * toggle is the whole workflow; the cue list is there to fine-tune.
 */

type SoundLevel = "ultra-subtle" | "extra-subtle" | "subtle";
type SoundSource = "auto" | "elevenlabs" | "builtin";
type JobStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";

const isRunning = (status?: JobStatus) => status === "queued" || status === "running";

const GAIN_STEPS = [-12, -6, -3, 0, 3, 6];

const LEVELS: Array<[SoundLevel, string, string]> = [
  ["subtle", "Subtle", "The most present of the three, still well under the voice (about 18 dB)."],
  ["extra-subtle", "Extra subtle", "You sense it more than you hear it. About 24 dB under the voice."],
  ["ultra-subtle", "Ultra subtle", "Barely there, a felt atmosphere. About 30 dB under the voice."],
];

const SOURCES: Array<[SoundSource, string, string]> = [
  ["auto", "Auto", "ElevenLabs when a key is connected, otherwise the built-in sounds."],
  ["elevenlabs", "ElevenLabs", "Generated sound effects. Each sound is made once and reused."],
  ["builtin", "Built-in", "Synthesised on this server. Free and simpler."],
];

const SOURCE_BADGE: Record<string, string> = { llm: "Scene analysis", keyword: "Keyword rules", manual: "Edited" };

export function SoundDesign({ projectId, canEdit, disabledReason }: { projectId: string; canEdit: boolean; disabledReason: string }) {
  const utils = trpc.useUtils();
  const overview = trpc.bookx.soundDesign.useQuery({ projectId }, { enabled: canEdit });
  const planStatus = trpc.bookx.analysisStatus.useQuery(
    { projectId, kind: "scenes" },
    { enabled: canEdit, refetchInterval: query => (isRunning(query.state.data?.status) ? 1500 : false) },
  );
  const soundsStatus = trpc.bookx.analysisStatus.useQuery(
    { projectId, kind: "sounds" },
    { enabled: canEdit, refetchInterval: query => (isRunning(query.state.data?.status) ? 1500 : false) },
  );
  const planRunning = isRunning(planStatus.data?.status);
  const soundsRunning = isRunning(soundsStatus.data?.status);

  const refresh = () => {
    void utils.bookx.soundDesign.invalidate({ projectId });
    void utils.bookx.exportReadiness.invalidate({ projectId });
  };

  // Refresh the cue list and say so when a background run finishes.
  const lastStatus = useRef<Record<"scenes" | "sounds", JobStatus | undefined>>({ scenes: undefined, sounds: undefined });
  useEffect(() => {
    const runs = [["scenes", planStatus.data], ["sounds", soundsStatus.data]] as const;
    for (const [kind, run] of runs) {
      const previous = lastStatus.current[kind];
      lastStatus.current[kind] = run?.status;
      if (!run || !previous || !isRunning(previous) || isRunning(run.status)) continue;
      refresh();
      if (run.status === "completed") toast.success(kind === "scenes" ? "Sounds planned" : "Sounds ready", { description: run.message ?? undefined });
      else if (run.status === "failed") toast.error(run.message || "The sound run did not finish");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planStatus.data?.status, soundsStatus.data?.status]);

  const startPlan = trpc.bookx.startScenePlan.useMutation({
    onSuccess: () => void utils.bookx.analysisStatus.invalidate({ projectId, kind: "scenes" }),
    onError: error => toast.error(error.message || "Prosecast could not start planning."),
  });
  const prepare = trpc.bookx.prepareSounds.useMutation({
    onSuccess: () => void utils.bookx.analysisStatus.invalidate({ projectId, kind: "sounds" }),
    onError: error => toast.error(error.message || "Prosecast could not prepare the sounds."),
  });
  const cancel = trpc.bookx.cancelAnalysis.useMutation({
    onSuccess: () => {
      void utils.bookx.analysisStatus.invalidate({ projectId, kind: "scenes" });
      void utils.bookx.analysisStatus.invalidate({ projectId, kind: "sounds" });
    },
    onError: error => toast.error(error.message || "Prosecast could not stop that run."),
  });

  const updateSettings = trpc.bookx.updateSoundSettings.useMutation({
    onMutate: async next => {
      await utils.bookx.soundDesign.cancel({ projectId });
      const previous = utils.bookx.soundDesign.getData({ projectId });
      if (previous) {
        utils.bookx.soundDesign.setData({ projectId }, {
          ...previous,
          settings: {
            effects: next.effects ?? previous.settings.effects,
            music: next.music ?? previous.settings.music,
            level: next.level ?? previous.settings.level,
            source: next.source ?? previous.settings.source,
          },
        });
      }
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous) utils.bookx.soundDesign.setData({ projectId }, context.previous);
      toast.error(error.message || "Prosecast could not save the sound settings.");
    },
    // Turning a toggle on is the whole workflow: plan what is unplanned, or make
    // the sounds the newly enabled cues are missing. This lives here rather than
    // in a callback passed to mutate(), which React Query drops when another
    // settings change starts first, and it reads current data, not a snapshot.
    onSuccess: (_result, next) => {
      const kind = next.effects ? "sfx" : next.music ? "music" : null;
      if (!kind) return;
      const fresh = utils.bookx.soundDesign.getData({ projectId });
      const scenes = utils.bookx.analysisStatus.getData({ projectId, kind: "scenes" });
      const sounds = utils.bookx.analysisStatus.getData({ projectId, kind: "sounds" });
      if (!fresh || isRunning(scenes?.status) || isRunning(sounds?.status)) return;
      if (fresh.totals.unplannedChapters > 0) startPlan.mutate({ projectId });
      else if (fresh.chapters.some(chapter => chapter.cues.some(cue => cue.kind === kind && cue.enabled && !cue.sound))) prepare.mutate({ projectId });
    },
    onSettled: refresh,
  });

  const updateCue = trpc.bookx.updateSoundCue.useMutation({
    onMutate: async next => {
      await utils.bookx.soundDesign.cancel({ projectId });
      const previous = utils.bookx.soundDesign.getData({ projectId });
      if (previous) {
        utils.bookx.soundDesign.setData({ projectId }, {
          ...previous,
          chapters: previous.chapters.map(chapter => ({
            ...chapter,
            cues: chapter.cues.map(cue => cue.id !== next.cueId ? cue : {
              ...cue,
              enabled: next.enabled ?? cue.enabled,
              gainDb: next.gainDb ?? cue.gainDb,
              tag: next.tag ?? cue.tag,
              label: next.tag ? previous.tags.find(tag => tag.tag === next.tag)?.label ?? cue.label : cue.label,
              sound: next.tag && next.tag !== cue.tag ? null : cue.sound,
              source: "manual" as const,
            }),
          })),
        });
      }
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous) utils.bookx.soundDesign.setData({ projectId }, context.previous);
      toast.error(error.message || "Prosecast could not update that sound.");
    },
    onSettled: refresh,
  });

  // `nonce` remounts the player for every preview. The server reuses one storage
  // key per cue or chapter, so the URL alone never changes: a replay stayed
  // silent and a re-mix after a level change played the old audio.
  const [preview, setPreview] = useState<{ key: string; url: string; nonce: number } | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const previewCue = trpc.bookx.previewSoundCue.useMutation();
  const previewChapter = trpc.bookx.previewChapterSound.useMutation();

  const playCue = (cueId: string, inContext: boolean) => {
    const key = `${cueId}:${inContext ? "context" : "sound"}`;
    setPendingPreview(key);
    previewCue.mutate({ projectId, cueId, inContext }, {
      onSuccess: result => setPreview({ key, url: result.url, nonce: Date.now() }),
      onError: error => toast.error(error.message || "Prosecast could not play that sound."),
      onSettled: () => {
        setPendingPreview(null);
        refresh();
      },
    });
  };
  const playChapter = (chapterId: string) => {
    const key = `chapter:${chapterId}`;
    setPendingPreview(key);
    previewChapter.mutate({ projectId, chapterId }, {
      onSuccess: result => setPreview({ key, url: result.url, nonce: Date.now() }),
      onError: error => toast.error(error.message || "Prosecast could not mix that chapter."),
      onSettled: () => {
        setPendingPreview(null);
        refresh();
      },
    });
  };

  if (!canEdit) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center p-9">
          <div className="max-w-md rounded-card border border-dashed border-stone-300 bg-paper/70 p-8 text-center">
            <AudioLines aria-hidden="true" className="mx-auto mb-4 text-ink-400" size={26} />
            <h3 className="serif text-[22px] leading-tight text-ink-950">Sound design needs a saved project</h3>
            <p className="mt-2 text-sm leading-6 text-ink-500">{disabledReason}</p>
          </div>
        </div>
      </Shell>
    );
  }

  const data = overview.data;
  if (!data) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center p-9 text-sm text-ink-500">
          {overview.error ? overview.error.message : <><LoaderCircle aria-hidden="true" className="mr-2 animate-spin" size={16} /> Loading sound design…</>}
        </div>
      </Shell>
    );
  }

  const { settings, totals, availability } = data;
  const busy = planRunning || soundsRunning || startPlan.isPending || prepare.isPending;
  const anyOn = settings.effects || settings.music;

  const toggle = (which: "effects" | "music", value: boolean) => {
    updateSettings.mutate(which === "effects" ? { projectId, effects: value } : { projectId, music: value });
  };

  const chaptersWithCues = data.chapters.filter(chapter => chapter.cues.length);
  const plannedChapters = data.chapters.filter(chapter => chapter.planned).length;
  const bookChapters = data.chapters.filter(chapter => chapter.segments > 0).length;

  return (
    <Shell>
      <div className="grid flex-1 grid-cols-1 content-start gap-6 overflow-auto p-6 md:p-9 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            <ToggleCard
              icon={<AudioLines aria-hidden="true" size={18} />}
              title="Background sounds"
              detail="Rain, thunder, clashing swords, a knock at the door. Each plays for about a second, very softly, in the pause after the line that describes it."
              count={settings.effects ? `${totals.sfx} in the book` : null}
              checked={settings.effects}
              onChange={value => toggle("effects", value)}
            />
            <ToggleCard
              icon={<Music2 aria-hidden="true" size={18} />}
              title="Background music"
              detail="A few seconds of soft music as a scene opens, matched to its mood (romantic, tense, light), fading away under the first lines."
              count={settings.music ? `${totals.music} in the book` : null}
              checked={settings.music}
              onChange={value => toggle("music", value)}
            />
          </div>

          {!availability.ffmpeg && (
            <Notice tone="warning">ffmpeg is not available on this server, so sounds cannot be made or mixed. Install ffmpeg or set FFMPEG_PATH.</Notice>
          )}

          <RunBanner
            label={planRunning ? "Reading the scenes" : "Sound plan"}
            run={planStatus.data}
            onCancel={planStatus.data?.jobId && !cancel.isPending ? () => cancel.mutate({ projectId, jobId: planStatus.data!.jobId! }) : undefined}
          />
          {(soundsRunning || soundsStatus.data?.status === "failed") && (
            <RunBanner
              label={soundsRunning ? "Preparing the sounds" : "Sounds"}
              run={soundsStatus.data}
              onCancel={soundsStatus.data?.jobId && !cancel.isPending ? () => cancel.mutate({ projectId, jobId: soundsStatus.data!.jobId! }) : undefined}
            />
          )}

          <SoundsSummary chapters={data.chapters} effectsOn={settings.effects} musicOn={settings.music} />

          <div className="rounded-card border border-stone-150 bg-paper p-6 shadow-hairline">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-semibold text-ink-900">Sounds in the book</h3>
                <p className="mt-0.5 text-xs text-ink-500">
                  {plannedChapters
                    ? `${plannedChapters} of ${bookChapters} chapters planned${availability.languageModel ? ` with ${availability.languageModel}` : " with keyword rules"}. Mute or trim anything; your changes are kept when you re-plan.`
                    : "Prosecast reads each scene and suggests where a sound or a music swell belongs."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {totals.missingSounds > 0 && !busy && (
                  <button onClick={() => prepare.mutate({ projectId })} className="btn-soft">
                    <Sparkles aria-hidden="true" className="mr-1 inline" size={13} /> Prepare {totals.missingSounds} sound{totals.missingSounds === 1 ? "" : "s"}
                  </button>
                )}
                <button
                  onClick={() => startPlan.mutate({ projectId, replan: plannedChapters > 0 && totals.unplannedChapters === 0 && totals.staleChapters === 0 })}
                  disabled={busy}
                  className="btn-primary disabled:opacity-50"
                >
                  {planRunning || startPlan.isPending
                    ? <><LoaderCircle aria-hidden="true" className="mr-1 inline animate-spin" size={13} /> Planning…</>
                    : totals.unplannedChapters || totals.staleChapters
                      ? <><Sparkles aria-hidden="true" className="mr-1 inline" size={13} /> Plan sounds</>
                      : <><RefreshCw aria-hidden="true" className="mr-1 inline" size={13} /> Re-plan all</>}
                </button>
              </div>
            </div>
            {totals.staleChapters > 0 && !planRunning && (
              <Notice tone="info">{totals.staleChapters} chapter{totals.staleChapters === 1 ? " was" : "s were"} edited since planning. Their cues still follow the lines they were placed on; Plan sounds refreshes them.</Notice>
            )}

            {!chaptersWithCues.length ? (
              <div className="mt-5 rounded-2xl border border-dashed border-stone-300 bg-paper-50 p-8 text-center">
                <Headphones aria-hidden="true" className="mx-auto mb-3 text-ink-400" size={24} />
                <p className="mx-auto max-w-md text-sm leading-6 text-ink-500">
                  {plannedChapters
                    ? "No moments in the planned chapters called for a sound. That is often right for a quiet book."
                    : bookChapters
                      ? "Nothing planned yet. Turn on background sounds or music, or choose Plan sounds."
                      : "Add chapter text on the Manuscript tab first."}
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {chaptersWithCues.map((chapter, position) => {
                  const chapterKey = `chapter:${chapter.id}`;
                  const canPreviewChapter = anyOn && chapter.rendered === chapter.segments && chapter.cues.some(cue => cue.enabled && ((cue.kind === "sfx" && settings.effects) || (cue.kind === "music" && settings.music)));
                  return (
                    <details key={chapter.id} open={position < 3} className="group overflow-hidden rounded-2xl border border-stone-150 bg-paper-50 shadow-hairline">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-white">
                        <span className="min-w-0">
                          <strong className="block truncate text-sm font-semibold text-ink-900">{chapter.title}</strong>
                          <span className="text-2xs text-ink-500">
                            {chapter.cues.filter(cue => cue.kind === "sfx" && cue.enabled).length} sounds · {chapter.cues.filter(cue => cue.kind === "music" && cue.enabled).length} music
                            {chapter.rendered < chapter.segments ? ` · ${chapter.segments - chapter.rendered} lines not narrated yet` : ""}
                          </span>
                        </span>
                        <ChapterMusicSelect projectId={projectId} chapter={chapter} data={data} />
                        <button
                          onClick={event => { event.preventDefault(); playChapter(chapter.id); }}
                          disabled={!canPreviewChapter || pendingPreview !== null}
                          title={canPreviewChapter ? "Mix the whole chapter as the export will" : "Narrate every line and turn a toggle on to preview the chapter mix"}
                          className="btn-soft shrink-0 disabled:opacity-40"
                        >
                          {pendingPreview === chapterKey ? <LoaderCircle aria-hidden="true" className="mr-1 inline animate-spin" size={13} /> : <Headphones aria-hidden="true" className="mr-1 inline" size={13} />} Chapter mix
                        </button>
                      </summary>
                      {preview?.key === chapterKey && <audio key={preview.nonce} autoPlay controls src={preview.url} className="mx-4 mb-3 h-8 w-[calc(100%-2rem)]" aria-label={`${chapter.title} mixed with its sounds`} />}
                      <ul className="border-t border-stone-100">
                        {chapter.cues.map(cue => {
                          const kindOn = cue.kind === "sfx" ? settings.effects : settings.music;
                          const soundKey = `${cue.id}:sound`;
                          const contextKey = `${cue.id}:context`;
                          return (
                            <li key={cue.id} className={`border-b border-stone-100 px-4 py-3 last:border-0 ${cue.enabled && kindOn ? "" : "opacity-60"}`}>
                              <div className="flex flex-wrap items-start gap-3">
                                <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${cue.kind === "music" ? "bg-gold-100 text-gold-700" : "bg-sky-100 text-sky-600"}`}>
                                  {cue.kind === "music" ? <Music2 aria-hidden="true" size={14} /> : <AudioLines aria-hidden="true" size={14} />}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <select
                                      aria-label="Sound"
                                      value={cue.tag}
                                      onChange={event => updateCue.mutate({ projectId, cueId: cue.id, tag: event.target.value })}
                                      className="rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs font-semibold text-ink-800 outline-none transition focus:border-brand-500"
                                    >
                                      {data.tags.filter(tag => tag.kind === cue.kind).map(tag => <option key={tag.tag} value={tag.tag}>{cue.kind === "music" ? `${tag.label} music` : tag.label}</option>)}
                                    </select>
                                    <span className="rounded-full bg-stone-50 px-2 py-0.5 text-3xs font-semibold text-ink-600 ring-1 ring-stone-150">{SOURCE_BADGE[cue.source] ?? cue.source}</span>
                                    {!kindOn && <span className="text-3xs text-ink-500">{cue.kind === "music" ? "Music is off" : "Sounds are off"}</span>}
                                  </div>
                                  <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-ink-500">
                                    <span className="font-semibold text-ink-500">{cue.placement === "before" ? "Opens before " : "After "}</span>
                                    “{cue.anchorText}”
                                  </p>
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-2">
                                  <select
                                    aria-label="Level trim"
                                    value={cue.gainDb}
                                    onChange={event => updateCue.mutate({ projectId, cueId: cue.id, gainDb: Number(event.target.value) })}
                                    className="rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs tabular-nums text-ink-700 outline-none transition focus:border-brand-500"
                                  >
                                    {GAIN_STEPS.map(step => <option key={step} value={step}>{step > 0 ? `+${step}` : step} dB</option>)}
                                  </select>
                                  <button
                                    onClick={() => playCue(cue.id, false)}
                                    disabled={pendingPreview !== null}
                                    aria-label={`Play the ${cue.label} sound on its own`}
                                    className="grid h-8 w-8 place-items-center rounded-lg border border-brand-100 bg-brand-50 text-brand-700 transition hover:border-brand-200 hover:bg-brand-100 disabled:opacity-40"
                                  >
                                    {pendingPreview === soundKey ? <LoaderCircle aria-hidden="true" className="animate-spin" size={13} /> : <Play aria-hidden="true" size={13} />}
                                  </button>
                                  <button
                                    onClick={() => playCue(cue.id, true)}
                                    disabled={pendingPreview !== null || !cue.contextReady}
                                    title={cue.contextReady ? "Hear it mixed into the surrounding lines" : "Narrate the lines around it first"}
                                    className="btn-soft disabled:opacity-40"
                                  >
                                    {pendingPreview === contextKey ? <LoaderCircle aria-hidden="true" className="mr-1 inline animate-spin" size={13} /> : <Headphones aria-hidden="true" className="mr-1 inline" size={13} />} In context
                                  </button>
                                  <Switch
                                    checked={cue.enabled}
                                    label={`${cue.enabled ? "Mute" : "Unmute"} ${cue.label}`}
                                    onChange={value => updateCue.mutate({ projectId, cueId: cue.id, enabled: value })}
                                  />
                                </div>
                              </div>
                              <CueExtras projectId={projectId} cue={cue} data={data} />
                              {preview && (preview.key === soundKey || preview.key === contextKey) && (
                                <audio key={preview.nonce} autoPlay controls src={preview.url} className="mt-2 h-8 w-full" aria-label={`${cue.label} preview`} />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      <AddCueForm projectId={projectId} chapter={chapter} data={data} />
                    </details>
                  );
                })}
              </div>
            )}
            {data.chapters.some(chapter => !chapter.cues.length && chapter.lines.length > 0) && (
              <details className="mt-3 rounded-card border border-dashed border-stone-300 bg-paper-50">
                <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-brand-700">Add a sound to a chapter without any</summary>
                {data.chapters.filter(chapter => !chapter.cues.length && chapter.lines.length > 0).map(chapter => (
                  <div key={chapter.id} className="border-t border-stone-150 px-1 pt-2">
                    <span className="px-3 text-xs font-semibold text-ink-600">{chapter.title}</span>
                    <AddCueForm projectId={projectId} chapter={chapter} data={data} />
                  </div>
                ))}
              </details>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <MusicSettingsPanel projectId={projectId} data={data} />
          <SoundLibraryPanel projectId={projectId} data={data} />
          <div className="rounded-card border border-stone-150 bg-paper p-6 shadow-hairline">
            <span className="eyebrow text-brand-600">LEVEL</span>
            <div role="radiogroup" aria-label="Sound level" className="mt-3 space-y-2">
              {LEVELS.map(([value, label, detail]) => (
                <Choice key={value} checked={settings.level === value} label={label} detail={detail} onSelect={() => updateSettings.mutate({ projectId, level: value })} />
              ))}
            </div>
            <p className="mt-3 text-2xs leading-5 text-ink-500">Sounds and music dip further whenever someone is speaking, and come back up only in the pauses.</p>
          </div>

          <div className="rounded-card border border-stone-150 bg-paper p-6 shadow-hairline">
            <span className="eyebrow text-brand-600">SOUND SOURCE</span>
            <div role="radiogroup" aria-label="Sound source" className="mt-3 space-y-2">
              {SOURCES.map(([value, label, detail]) => (
                <Choice key={value} checked={settings.source === value} label={label} detail={detail} onSelect={() => updateSettings.mutate({ projectId, source: value })} />
              ))}
            </div>
            <p className="mt-3 text-2xs leading-5 text-ink-500">
              ElevenLabs key: <strong>{availability.elevenLabs ? "connected" : "not connected"}</strong>.
              {settings.source !== "builtin" && availability.elevenLabs ? " A key that is rejected falls back to the built-in sounds in Auto." : ""}
            </p>
            {totals.enabled > 0 && anyOn && (
              <button onClick={() => prepare.mutate({ projectId })} disabled={busy} className="btn-soft mt-3 w-full disabled:opacity-50">
                <RefreshCw aria-hidden="true" className="mr-1 inline" size={13} /> Apply source to all sounds
              </button>
            )}
          </div>

          <div className={`rounded-card border p-6 ${anyOn ? "border-brand-200 bg-brand-50" : "border-stone-150 bg-paper-50"}`}>
            <span className="eyebrow text-brand-600">IN THE EXPORT</span>
            <p className="mt-3 text-xs leading-5 text-ink-500">
              {anyOn
                ? "Each chapter is mixed with its sounds and encoded once, in the narration's own format, so chapter files still join cleanly into the full book."
                : "Both are off, so the export is narration only: joined frame by frame, with no re-encoding."}
            </p>
          </div>
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-5 border-b border-stone-150 bg-paper px-6 py-7 md:flex-row md:items-end md:justify-between md:px-9">
        <div className="min-w-0">
          <p className="eyebrow text-brand-600">04 · SOUND</p>
          <h2 className="serif mt-2 text-[34px] leading-[1.1] tracking-[-.02em] text-ink-950">Audio studio.</h2>
          <p className="mt-2.5 max-w-2xl text-sm leading-6 text-ink-500">
            Very soft scene sounds and short music swells under the narration. Both stay off until you turn them on, and neither ever competes with the voice.
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${checked ? "bg-brand-500" : "bg-stone-200"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function ToggleCard({ icon, title, detail, count, checked, onChange }: { icon: ReactNode; title: string; detail: string; count: string | null; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className={`rounded-card border p-6 transition ${checked ? "border-brand-300 bg-brand-50/70 shadow-soft" : "border-stone-150 bg-paper shadow-hairline"}`}>
      <div className="flex items-start justify-between gap-3">
        <span className={`grid h-10 w-10 place-items-center rounded-xl ring-1 transition ${checked ? "bg-brand-700 text-paper ring-brand-700" : "bg-stone-50 text-ink-500 ring-stone-150"}`}>{icon}</span>
        <Switch checked={checked} onChange={onChange} label={`${checked ? "Turn off" : "Turn on"} ${title.toLowerCase()}`} />
      </div>
      <strong className="serif mt-5 block text-[22px] leading-tight text-ink-950">{title}</strong>
      <p className="mt-1 text-xs leading-5 text-ink-500">{detail}</p>
      <span className="mt-3 block text-2xs font-semibold text-brand-600">{checked ? count ?? "On" : "Off"}</span>
    </div>
  );
}

function Choice({ checked, label, detail, onSelect }: { checked: boolean; label: string; detail: string; onSelect: () => void }) {
  return (
    <button
      role="radio"
      aria-checked={checked}
      onClick={() => !checked && onSelect()}
      className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition ${checked ? "border-brand-300 bg-brand-50/70 ring-1 ring-brand-200" : "border-stone-150 bg-white hover:border-stone-300"}`}
    >
      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${checked ? "border-brand-400" : "border-stone-300"}`}>
        {checked && <span className="h-2 w-2 rounded-full bg-brand-500" />}
      </span>
      <span>
        <strong className="block text-xs font-semibold text-ink-900">{label}</strong>
        <span className="block text-2xs leading-4 text-ink-500">{detail}</span>
      </span>
    </button>
  );
}

function Notice({ tone, children }: { tone: "warning" | "info"; children: ReactNode }) {
  return (
    <p role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-5 ${tone === "warning" ? "bg-gold-50 text-gold-700" : "bg-sky-50 text-sky-600"}`}>
      <AlertCircle aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

type RunState = { jobId: string | null; status: JobStatus; percent: number; message: string | null; errors: string[]; totalSteps?: number; completedSteps?: number; startedAt?: string | null };

function RunBanner({ label, run, onCancel }: { label: string; run?: RunState; onCancel?: () => void }) {
  if (!run || run.status === "idle") return null;
  const running = isRunning(run.status);
  const failed = run.status === "failed";
  return (
    <div role="status" className={`rounded-2xl border px-4 py-3 ${failed ? "border-clay-200 bg-clay-50" : "border-brand-100 bg-brand-50"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <strong className={`block text-sm ${failed ? "text-clay-700" : "text-brand-700"}`}>
            {running ? label : run.status === "completed" ? `${label}: done` : run.status === "cancelled" ? `${label}: stopped` : `${label}: did not finish`}
          </strong>
          <span className="block text-xs text-ink-500">{run.message}</span>
          {running && <StepTiming run={run} />}
        </div>
        {running && onCancel && (
          <button onClick={onCancel} aria-label={`Stop: ${label}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-500 hover:bg-brand-50"><X aria-hidden="true" size={14} /></button>
        )}
      </div>
      {running && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-brand-100">
          <div className="h-full rounded-full bg-brand-500 transition-[width] duration-500" style={{ width: `${Math.max(4, run.percent)}%` }} />
        </div>
      )}
      {run.errors.length > 0 && !running && (
        <details className="mt-2 text-2xs text-gold-700">
          <summary className="cursor-pointer font-semibold">{run.errors.length} note{run.errors.length === 1 ? "" : "s"}</summary>
          <ul className="mt-1 space-y-1">{run.errors.slice(-6).map((error, index) => <li key={index}>{error}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
