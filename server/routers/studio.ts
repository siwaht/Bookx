import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createHash } from "node:crypto";
import { z } from "zod";
import { bookxChapters, bookxCharacters, bookxProjects, bookxPronunciations, bookxSegments, bookxSoundCues, bookxStudioAssets, type SegmentDelivery } from "../../drizzle/schema";
import { getDb, runBatched } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { assembleAudio } from "../audioAssembly";
import { chapterDirectionSpecs, directionFor, sceneCount } from "../direction";
import { extractJson, languageModelText, resolveLanguageModel } from "../languageModel";
import { checkReusable } from "../narrationPlan";
import { estimateNarration, includedChapters, loadPlannableSegments, regenerateChapters, retakeSegment } from "../narrationWorker";
import { pronunciationHash } from "../pronunciation";
import { storageGetBuffer, storageGetSignedUrl, storagePut } from "../storage";
import { PAUSE_PARAGRAPH_MS } from "../textSegmentation";
import { soundTag } from "../soundLibrary";
import { createSoundCue, deleteSoundCue, editSoundCue, generateCustomSound, soundAssets, uploadCustomSound } from "../soundDesign";
import { DIRECTION_LIMITS, VOICE_SETTING_RANGES, cleanTag, ttsTraits, type ChapterDirection, type SceneDirection, type VoiceSettings } from "../../shared/direction";
import { providerIdSchema } from "../../shared/providers";
import { SOUND_OPTION_LIMITS, resolveSoundOptions } from "../../shared/soundOptions";

/**
 * The listening and directing side of production: hearing a chapter while the
 * rest of the book renders, regenerating it, directing its performance, and
 * the finer sound-design controls.
 */

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function requireProject(ownerId: number, projectId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [project] = await db.select().from(bookxProjects).where(and(eq(bookxProjects.id, projectId), eq(bookxProjects.ownerId, ownerId))).limit(1);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  return { db, project };
}

async function requireChapter(db: Db, projectId: string, chapterId: string) {
  const [chapter] = await db.select().from(bookxChapters).where(and(eq(bookxChapters.id, chapterId), eq(bookxChapters.projectId, projectId))).limit(1);
  if (!chapter) throw new TRPCError({ code: "NOT_FOUND", message: "Chapter not found" });
  return chapter;
}

async function chapterSegments(db: Db, chapterId: string) {
  return db.select().from(bookxSegments).where(eq(bookxSegments.chapterId, chapterId)).orderBy(bookxSegments.orderIndex, bookxSegments.id);
}

const ids = z.string().min(1).max(32);
const sceneSchema = z.object({ setting: z.string().max(DIRECTION_LIMITS.setting).optional(), mood: z.string().max(DIRECTION_LIMITS.mood).optional() });

/** Joined narration previews, by a fingerprint of the audio they were made from. */
const joinedCache = new Map<string, { key: string; durationMs: number; lines: number }>();

const REASON_LABEL: Record<string, string> = {
  "missing-audio": "Not narrated yet",
  "text-changed": "Text changed since",
  "voice-changed": "Different voice or model",
  "pronunciation-changed": "Pronunciation rules changed",
  "direction-changed": "Direction changed",
};

const DIRECTOR_SYSTEM = [
  "You are the director of an audiobook recording. Read the chapter and give the narrator performance direction.",
  "Return ONLY one JSON object: {\"setting\":\"\",\"mood\":\"\",\"scenes\":[{\"index\":0,\"setting\":\"\",\"mood\":\"\"}],\"lines\":[{\"index\":0,\"tags\":[\"\"]}]}.",
  "setting: where and when the chapter takes place, in under 12 words (e.g. \"a rain-soaked cabin, late at night\").",
  "mood: the emotional tone of the narration in 1 to 3 words (e.g. \"tense, hushed\").",
  "scenes: only for scenes whose setting or mood differs from the chapter's; index is the scene number given in the text.",
  "lines: only the lines that clearly call for a specific delivery, at most one in four lines. Each tag is 1 to 3 lowercase words describing HOW the line is spoken",
  "(whispers, sarcastic, excited, worried, crying, laughs, sighs, shouting, softly, hesitant, angry, warm). Never describe sounds or music, never quote the text, at most 2 tags per line.",
].join(" ");

export const studioRouter = router({
  // ---- Listening --------------------------------------------------------------

  /**
   * Every line of a chapter with its audio, in order, for playback while the
   * rest of the book is still rendering. Lines without audio are included so
   * the player can say what is missing.
   */
  chapterPlayback: protectedProcedure.input(z.object({ projectId: ids, chapterId: ids })).query(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const chapter = await requireChapter(db, input.projectId, input.chapterId);
    const [segments, characters, rules, plannable, chapters, cues] = await Promise.all([
      chapterSegments(db, chapter.id),
      db.select({ id: bookxCharacters.id, name: bookxCharacters.name, isNarrator: bookxCharacters.isNarrator }).from(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId)),
      db.select().from(bookxPronunciations).where(eq(bookxPronunciations.projectId, input.projectId)),
      loadPlannableSegments(input.projectId, [chapter.id]),
      includedChapters(db, input.projectId),
      db.select().from(bookxSoundCues).where(and(eq(bookxSoundCues.chapterId, chapter.id), eq(bookxSoundCues.projectId, input.projectId))),
    ]);
    const names = new Map(characters.map(character => [character.id, character.name]));
    const narrator = characters.find(character => character.isNarrator)?.name ?? "Narrator";
    const byId = new Map(plannable.map(segment => [segment.id, segment]));
    const pronHash = pronunciationHash(rules.map(rule => ({ word: rule.word, alias: rule.alias, phoneme: rule.phoneme })));
    const pinned = { provider: project.voiceProvider, model: project.voiceModel };
    const specs = chapterDirectionSpecs(chapter.direction, segments);
    let scene = 0;

    const lines = segments.map((segment, index) => {
      if (index > 0 && segment.delivery?.sceneBreakBefore) scene++;
      const planned = byId.get(segment.id);
      const check = planned ? checkReusable(planned, pinned, pronHash, { voiceInstructions: project.voiceSettings?.instructions }) : null;
      const status = !segment.audioStorageKey
        ? segment.lastError ? "failed" as const : "missing" as const
        : check?.reusable ? "current" as const : "outdated" as const;
      return {
        id: segment.id,
        index,
        scene,
        text: segment.text,
        speaker: segment.delivery?.kind === "dialogue" && segment.characterId ? names.get(segment.characterId) ?? null : narrator,
        kind: segment.delivery?.kind ?? "narration",
        audioUrl: segment.audioStorageKey ? `/manus-storage/${segment.audioStorageKey}` : null,
        durationMs: segment.audioDurationMs,
        gapAfterMs: Math.max(0, segment.delivery?.pauseMs ?? PAUSE_PARAGRAPH_MS),
        status,
        reason: check && !check.reusable ? REASON_LABEL[check.reason] ?? check.reason : segment.lastError && !segment.audioStorageKey ? segment.lastError.slice(0, 160) : null,
        renderedWith: segment.voiceProvider && segment.voiceModel ? `${segment.voiceProvider} · ${segment.voiceModel}` : null,
        renderedAt: segment.renderedAt ? new Date(segment.renderedAt).toISOString() : null,
        tags: segment.delivery?.tags ?? [],
        sent: segment.audioStorageKey ? null : directionFor(specs[index], project.voiceProvider, project.voiceModel, project.voiceSettings?.instructions).prefix.trim() || null,
      };
    });

    const position = chapters.findIndex(candidate => candidate.id === chapter.id);
    const withAudio = lines.filter(line => line.audioUrl);
    // The playable stretch is the opening run of lines that have audio.
    const firstGap = lines.findIndex(line => !line.audioUrl);
    const playable = firstGap < 0 ? lines : lines.slice(0, firstGap);
    return {
      chapter: { id: chapter.id, title: chapter.title, number: position + 1, included: Boolean(chapter.included), chapterCount: chapters.length },
      previous: position > 0 ? { id: chapters[position - 1]!.id, title: chapters[position - 1]!.title } : null,
      next: position >= 0 && position < chapters.length - 1 ? { id: chapters[position + 1]!.id, title: chapters[position + 1]!.title } : null,
      voice: { provider: project.voiceProvider, model: project.voiceModel, label: ttsTraits(project.voiceProvider, project.voiceModel).label },
      lines,
      totals: {
        lines: lines.length,
        withAudio: withAudio.length,
        current: lines.filter(line => line.status === "current").length,
        outdated: lines.filter(line => line.status === "outdated").length,
        durationMs: withAudio.reduce((total, line) => total + (line.durationMs ?? 0), 0),
        playableLines: playable.length,
        models: [...new Set(lines.map(line => line.renderedWith).filter((value): value is string => Boolean(value)))],
      },
      cues: cues.filter(cue => cue.enabled).map(cue => ({
        segmentId: cue.segmentId,
        kind: cue.kind,
        label: soundTag(cue.tag)?.label ?? (cue.tag === "custom" ? "Custom sound" : cue.tag),
        placement: cue.placement,
      })),
    };
  }),

  /**
   * The chapter's narration joined into one file, as far as it is rendered,
   * for downloading or playing in one go. No provider is called: the stored
   * lines are only joined.
   */
  joinChapter: protectedProcedure.input(z.object({ projectId: ids, chapterId: ids })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const chapter = await requireChapter(db, input.projectId, input.chapterId);
    const segments = await chapterSegments(db, chapter.id);
    const firstGap = segments.findIndex(segment => !segment.audioStorageKey);
    const ready = firstGap < 0 ? segments : segments.slice(0, firstGap);
    if (!ready.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing in this chapter is narrated yet." });
    const fingerprint = createHash("sha256").update(JSON.stringify(ready.map(segment => [segment.audioStorageKey, segment.delivery?.pauseMs ?? null]))).digest("hex");
    const cached = joinedCache.get(fingerprint);
    if (cached) return { url: await storageGetSignedUrl(cached.key), durationMs: cached.durationMs, lines: cached.lines, partial: ready.length < segments.length, totalLines: segments.length };

    const parts = [];
    for (const [index, segment] of ready.entries()) {
      parts.push({ buffer: await storageGetBuffer(segment.audioStorageKey!, { timeoutMs: 60_000 }), label: `${chapter.title} · ${index + 1}`, gapAfterMs: segment.delivery?.pauseMs ?? PAUSE_PARAGRAPH_MS });
    }
    const joined = assembleAudio(parts, { gapMs: PAUSE_PARAGRAPH_MS });
    const stored = await storagePut(`bookx/${input.projectId}/preview/narration-${chapter.id}-${fingerprint.slice(0, 10)}.${joined.container}`, joined.buffer, joined.mimeType);
    joinedCache.set(fingerprint, { key: stored.key, durationMs: joined.durationMs, lines: ready.length });
    if (joinedCache.size > 200) joinedCache.delete(joinedCache.keys().next().value!);
    return { url: await storageGetSignedUrl(stored.key), durationMs: joined.durationMs, lines: ready.length, partial: ready.length < segments.length, totalLines: segments.length };
  }),

  // ---- Regenerating ---------------------------------------------------------

  /** Lines and characters a run or a regeneration would send, for the confirmation. */
  estimate: protectedProcedure.input(z.object({ projectId: ids, chapterIds: z.array(ids).max(500).optional(), regenerate: z.boolean().optional() })).query(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return estimateNarration({ projectId: input.projectId, ownerId: ctx.user.id, chapterIds: input.chapterIds, regenerate: input.regenerate });
  }),

  /** Re-renders whole chapters even where their audio is current. Paid: the client confirms first. */
  regenerateChapters: protectedProcedure.input(z.object({ projectId: ids, chapterIds: z.array(ids).min(1).max(500) })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return regenerateChapters({ projectId: input.projectId, ownerId: ctx.user.id, chapterIds: input.chapterIds });
  }),

  /** Re-voices one line with its own voice and direction. Paid: one line. */
  retakeLine: protectedProcedure.input(z.object({ projectId: ids, segmentId: ids })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    const result = await retakeSegment({ projectId: input.projectId, ownerId: ctx.user.id, segmentId: input.segmentId });
    return { durationMs: result.durationMs, audioUrl: `/manus-storage/${result.storageKey}` };
  }),

  // ---- Model and voice settings ---------------------------------------------

  /** The narration model for the next runs. Audio already made keeps its model until regenerated. */
  setNarrationModel: protectedProcedure.input(z.object({ projectId: ids, provider: providerIdSchema, model: z.string().trim().min(1).max(160) })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.update(bookxProjects).set({ voiceProvider: input.provider, voiceModel: input.model, updatedAt: new Date() }).where(eq(bookxProjects.id, input.projectId));
    return { provider: input.provider, model: input.model, traits: ttsTraits(input.provider, input.model) };
  }),

  /** Stability, similarity and the like; anything the model does not take is kept but not sent. */
  setVoiceSettings: protectedProcedure.input(z.object({
    projectId: ids,
    settings: z.object({
      stability: z.number().min(VOICE_SETTING_RANGES.stability.min).max(VOICE_SETTING_RANGES.stability.max).optional(),
      similarity: z.number().min(VOICE_SETTING_RANGES.similarity.min).max(VOICE_SETTING_RANGES.similarity.max).optional(),
      style: z.number().min(VOICE_SETTING_RANGES.style.min).max(VOICE_SETTING_RANGES.style.max).optional(),
      speed: z.number().min(VOICE_SETTING_RANGES.speed.min).max(VOICE_SETTING_RANGES.speed.max).optional(),
      speakerBoost: z.boolean().optional(),
      instructions: z.string().max(DIRECTION_LIMITS.instructions).optional(),
    }).nullable(),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const settings: VoiceSettings | null = input.settings
      ? Object.fromEntries(Object.entries(input.settings).filter(([, value]) => value !== undefined && value !== "")) as VoiceSettings
      : null;
    await db.update(bookxProjects).set({ voiceSettings: settings && Object.keys(settings).length ? settings : null, updatedAt: new Date() }).where(eq(bookxProjects.id, input.projectId));
    return { success: true };
  }),

  // ---- Direction ------------------------------------------------------------

  /** A chapter's scenes and lines with their direction, and what the current model does with it. */
  chapterDirection: protectedProcedure.input(z.object({ projectId: ids, chapterId: ids })).query(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const chapter = await requireChapter(db, input.projectId, input.chapterId);
    const segments = await chapterSegments(db, chapter.id);
    const characters = await db.select({ id: bookxCharacters.id, name: bookxCharacters.name }).from(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId));
    const names = new Map(characters.map(character => [character.id, character.name]));
    const specs = chapterDirectionSpecs(chapter.direction, segments);
    let scene = 0;
    return {
      chapter: { id: chapter.id, title: chapter.title },
      direction: (chapter.direction ?? {}) as ChapterDirection,
      sceneCount: sceneCount(segments),
      voice: { provider: project.voiceProvider, model: project.voiceModel, traits: ttsTraits(project.voiceProvider, project.voiceModel), instructions: project.voiceSettings?.instructions ?? "" },
      lines: segments.map((segment, index) => {
        if (index > 0 && segment.delivery?.sceneBreakBefore) scene++;
        const composed = directionFor(specs[index], project.voiceProvider, project.voiceModel, project.voiceSettings?.instructions);
        return {
          id: segment.id,
          index,
          scene,
          sceneStart: index === 0 || Boolean(segment.delivery?.sceneBreakBefore),
          text: segment.text.length > 400 ? `${segment.text.slice(0, 400)}…` : segment.text,
          speaker: segment.delivery?.kind === "dialogue" && segment.characterId ? names.get(segment.characterId) ?? null : null,
          tags: segment.delivery?.tags ?? [],
          // Exactly what the model receives besides the words.
          sends: composed.prefix.trim() || null,
          instructions: composed.instructions || null,
        };
      }),
    };
  }),

  /**
   * Saves the chapter's setting and mood, per-scene overrides and per-line
   * tags. Lines whose direction changed become outdated, nothing else.
   */
  saveChapterDirection: protectedProcedure.input(z.object({
    projectId: ids,
    chapterId: ids,
    setting: z.string().max(DIRECTION_LIMITS.setting).optional(),
    mood: z.string().max(DIRECTION_LIMITS.mood).optional(),
    scenes: z.record(z.string().regex(/^\d{1,4}$/), sceneSchema).optional(),
    lines: z.array(z.object({ segmentId: ids, tags: z.array(z.string().max(DIRECTION_LIMITS.tag)).max(DIRECTION_LIMITS.tagsPerLine) })).max(2_000).optional(),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const chapter = await requireChapter(db, input.projectId, input.chapterId);
    const trim = (value?: string) => value?.trim() || undefined;
    const scenes: Record<string, SceneDirection> = {};
    for (const [index, value] of Object.entries(input.scenes ?? {})) {
      const scene = { setting: trim(value.setting), mood: trim(value.mood) };
      if (scene.setting || scene.mood) scenes[index] = scene;
    }
    const direction: ChapterDirection = { setting: trim(input.setting), mood: trim(input.mood), ...(Object.keys(scenes).length ? { scenes } : {}) };
    const empty = !direction.setting && !direction.mood && !direction.scenes;
    const statements: BatchItem<"sqlite">[] = [db.update(bookxChapters).set({ direction: empty ? null : direction, updatedAt: new Date() }).where(eq(bookxChapters.id, chapter.id))];

    if (input.lines?.length) {
      const segments = await chapterSegments(db, chapter.id);
      const byId = new Map(segments.map(segment => [segment.id, segment]));
      for (const line of input.lines) {
        const segment = byId.get(line.segmentId);
        if (!segment) continue; // Not this chapter's line.
        const tags = [...new Set(line.tags.map(cleanTag).filter(Boolean))];
        const current = segment.delivery?.tags ?? [];
        if (tags.length === current.length && tags.every((tag, index) => tag === current[index])) continue;
        const { tags: _old, ...rest } = segment.delivery ?? {};
        const delivery: SegmentDelivery = tags.length ? { ...rest, tags } : rest;
        statements.push(db.update(bookxSegments).set({ delivery, updatedAt: new Date() }).where(eq(bookxSegments.id, segment.id)));
      }
    }
    await runBatched(db, statements);
    return { success: true, lines: statements.length - 1 };
  }),

  /**
   * Asks the project's language model to direct the chapter. Paid (one LLM
   * call) and only on request; nothing is saved until the creator saves it.
   */
  suggestDirection: protectedProcedure.input(z.object({ projectId: ids, chapterId: ids })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const chapter = await requireChapter(db, input.projectId, input.chapterId);
    const segments = await chapterSegments(db, chapter.id);
    if (!segments.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Split the chapter into lines first (Generate does this when a run starts)." });
    const llm = await resolveLanguageModel({ ownerId: ctx.user.id, provider: project.languageModelProvider, model: project.languageModel });
    if (!llm) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a language model (Cloudflare, OpenAI or OpenRouter) in Settings to get direction suggestions." });

    let scene = 0;
    let budget = 24_000;
    const numbered: string[] = [];
    for (const [index, segment] of segments.entries()) {
      if (index > 0 && segment.delivery?.sceneBreakBefore) {
        scene++;
        numbered.push(`--- scene ${scene} ---`);
      }
      const line = `[${index}] ${segment.text.replace(/\s+/g, " ").slice(0, 600)}`;
      budget -= line.length;
      if (budget < 0) break;
      numbered.push(line);
    }
    const reply = await languageModelText({
      provider: llm.provider,
      model: llm.model,
      system: DIRECTOR_SYSTEM,
      text: `Book: ${project.title}\nChapter: ${chapter.title}\nScene 0 is the chapter opening.\n\n${numbered.join("\n")}`,
      ownerId: ctx.user.id,
      projectId: input.projectId,
      purpose: "direction",
      reasoningEffort: "low",
    });
    const parsed = z.object({
      setting: z.string().optional().catch(undefined),
      mood: z.string().optional().catch(undefined),
      scenes: z.array(z.object({ index: z.number().int().min(0), setting: z.string().optional().catch(undefined), mood: z.string().optional().catch(undefined) })).optional().catch([]),
      lines: z.array(z.object({ index: z.number().int().min(0), tags: z.array(z.string()).catch([]) })).optional().catch([]),
    }).parse(extractJson(reply, "direction"));
    const clip = (value: string | undefined, limit: number) => value?.replace(/[[\]]/g, "").trim().slice(0, limit) || undefined;
    return {
      model: `${llm.provider} · ${llm.model}`,
      setting: clip(parsed.setting, DIRECTION_LIMITS.setting),
      mood: clip(parsed.mood, DIRECTION_LIMITS.mood),
      scenes: Object.fromEntries((parsed.scenes ?? []).filter(item => item.index > 0 && item.index <= scene).map(item => [String(item.index), { setting: clip(item.setting, DIRECTION_LIMITS.setting), mood: clip(item.mood, DIRECTION_LIMITS.mood) }])),
      lines: (parsed.lines ?? [])
        .filter(item => item.index >= 0 && item.index < segments.length)
        .map(item => ({ segmentId: segments[item.index]!.id, tags: item.tags.map(cleanTag).filter(Boolean).slice(0, 2) }))
        .filter(item => item.tags.length),
    };
  }),

  // ---- Sound design: options, cues and custom sounds ----------------------------

  /** Music bed, intro and outro, volumes, fades, ducking and effect length for the whole book. */
  updateSoundOptions: protectedProcedure.input(z.object({
    projectId: ids,
    options: z.object({
      musicMode: z.enum(["swells", "bed"]).optional(),
      bedTag: z.string().max(64).optional(),
      bedAssetId: ids.nullable().optional(),
      musicGainDb: z.number().int().min(SOUND_OPTION_LIMITS.gainDb.min).max(SOUND_OPTION_LIMITS.gainDb.max).optional(),
      sfxGainDb: z.number().int().min(SOUND_OPTION_LIMITS.gainDb.min).max(SOUND_OPTION_LIMITS.gainDb.max).optional(),
      musicFadeInMs: z.number().int().min(SOUND_OPTION_LIMITS.fadeInMs.min).max(SOUND_OPTION_LIMITS.fadeInMs.max).optional(),
      musicFadeOutMs: z.number().int().min(SOUND_OPTION_LIMITS.fadeOutMs.min).max(SOUND_OPTION_LIMITS.fadeOutMs.max).optional(),
      duck: z.enum(["light", "medium", "strong"]).optional(),
      intro: z.object({ enabled: z.boolean(), seconds: z.number().int().min(SOUND_OPTION_LIMITS.introSeconds.min).max(SOUND_OPTION_LIMITS.introSeconds.max) }).optional(),
      outro: z.object({ enabled: z.boolean(), seconds: z.number().int().min(SOUND_OPTION_LIMITS.outroSeconds.min).max(SOUND_OPTION_LIMITS.outroSeconds.max) }).optional(),
      effectLength: z.enum(["short", "medium", "long"]).optional(),
    }),
  })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    if (input.options.bedTag !== undefined && !soundTag(input.options.bedTag)?.tag.startsWith("music-")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a music track from the library" });
    }
    if (input.options.bedAssetId) await requireAsset(db, input.projectId, input.options.bedAssetId, "music");
    const merged = { ...(project.soundOptions ?? {}), ...input.options };
    await db.update(bookxProjects).set({ soundOptions: merged, updatedAt: new Date() }).where(eq(bookxProjects.id, input.projectId));
    return { options: resolveSoundOptions(merged) };
  }),

  /** One chapter without music, or with a different track. */
  updateChapterSoundOptions: protectedProcedure.input(z.object({
    projectId: ids,
    chapterId: ids,
    music: z.enum(["inherit", "off"]).optional(),
    bedTag: z.string().max(64).nullable().optional(),
    bedAssetId: ids.nullable().optional(),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const chapter = await requireChapter(db, input.projectId, input.chapterId);
    if (input.bedTag && !soundTag(input.bedTag)?.tag.startsWith("music-")) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a music track from the library" });
    if (input.bedAssetId) await requireAsset(db, input.projectId, input.bedAssetId, "music");
    const next = { ...(chapter.soundOptions ?? {}) };
    if (input.music !== undefined) next.music = input.music;
    if (input.bedTag !== undefined) next.bedTag = input.bedTag ?? undefined;
    if (input.bedAssetId !== undefined) next.bedAssetId = input.bedAssetId;
    const empty = (next.music ?? "inherit") === "inherit" && !next.bedTag && !next.bedAssetId;
    await db.update(bookxChapters).set({ soundOptions: empty ? null : next, updatedAt: new Date() }).where(eq(bookxChapters.id, chapter.id));
    return { success: true };
  }),

  /** The book's own sounds and tracks: uploads and generated ones. */
  soundAssets: protectedProcedure.input(z.object({ projectId: ids })).query(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    return soundAssets(db, input.projectId);
  }),

  /** Adds a sound at a chosen line. The cue is the creator's, so re-planning keeps it. */
  addSoundCue: protectedProcedure.input(z.object({
    projectId: ids,
    segmentId: ids,
    kind: z.enum(["sfx", "music"]),
    tag: z.string().max(64).optional(),
    assetId: ids.optional(),
    placement: z.enum(["before", "after"]).default("after"),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    return createSoundCue(db, input);
  }),

  /** Placement, timing, length or a custom sound for one cue. */
  editSoundCue: protectedProcedure.input(z.object({
    projectId: ids,
    cueId: ids,
    placement: z.enum(["before", "after"]).optional(),
    offsetMs: z.number().int().min(SOUND_OPTION_LIMITS.cueOffsetMs.min).max(SOUND_OPTION_LIMITS.cueOffsetMs.max).optional(),
    lengthMs: z.number().int().min(SOUND_OPTION_LIMITS.cueLengthMs.min).max(SOUND_OPTION_LIMITS.cueLengthMs.max).nullable().optional(),
    assetId: ids.nullable().optional(),
    gainDb: z.number().int().min(-24).max(12).optional(),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    return editSoundCue(db, input);
  }),

  removeSoundCue: protectedProcedure.input(z.object({ projectId: ids, cueId: ids })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    return deleteSoundCue(db, input);
  }),

  /** Uploads a sound effect or a music track (MP3 or WAV, up to 15 MB). */
  uploadSound: protectedProcedure.input(z.object({
    projectId: ids,
    kind: z.enum(["sfx", "music"]),
    title: z.string().trim().min(1).max(120),
    filename: z.string().min(1).max(255),
    base64: z.string().min(1).max(Math.ceil((15 * 1024 * 1024) / 3) * 4 + 16),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    return uploadCustomSound(db, input);
  }),

  /** Generates a custom sound or music track with ElevenLabs from a description. Paid, and only on request. */
  generateSound: protectedProcedure.input(z.object({
    projectId: ids,
    kind: z.enum(["sfx", "music"]),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(3).max(450),
    seconds: z.number().min(1).max(30),
    loop: z.boolean().optional(),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    return generateCustomSound(db, { ...input, ownerId: ctx.user.id });
  }),
});

async function requireAsset(db: Db, projectId: string, assetId: string, kind: "sfx" | "music") {
  const [asset] = await db.select().from(bookxStudioAssets).where(and(eq(bookxStudioAssets.id, assetId), eq(bookxStudioAssets.projectId, projectId))).limit(1);
  if (!asset?.storageKey) throw new TRPCError({ code: "NOT_FOUND", message: "Sound not found" });
  if ((kind === "music") !== (asset.type === "music")) throw new TRPCError({ code: "BAD_REQUEST", message: kind === "music" ? "Choose a music track" : "Choose a sound effect" });
  return asset;
}
