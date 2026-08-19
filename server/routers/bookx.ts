import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  bookxChapters,
  bookxCharacters,
  bookxExports,
  bookxGenerationJobs,
  bookxPronunciations,
  bookxProjects,
  bookxProviderSettings,
  bookxSegments,
  bookxStudioAssets,
  bookxTimelineClips,
} from "../../drizzle/schema";
import { projectSetupSchema } from "../../shared/bookx";
import { getDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { synthesizeNarration } from "../tts";
import { storagePut } from "../storage";
import { transcribeAudioRoute } from "../providerRouting";

const projectId = z.object({ projectId: z.string().min(1).max(32) });
const chapterInput = z.object({ projectId: z.string().min(1), title: z.string().min(1).max(255), body: z.string().optional(), orderIndex: z.number().int().min(0).optional() });
const characterInput = z.object({ projectId: z.string().min(1), name: z.string().min(1).max(160), role: z.string().min(1).max(100), voiceId: z.string().max(160).optional(), voiceName: z.string().max(160).optional(), accent: z.string().max(160).optional(), voiceRationale: z.string().max(512).optional(), sampleLine: z.string().max(2000).optional(), previewStorageKey: z.string().max(512).optional(), assignmentConfidence: z.number().int().min(0).max(100).optional(), assignmentSource: z.enum(["manual", "llm"]).optional() });
const pronunciationInput = z.object({ projectId: z.string().min(1), word: z.string().min(1).max(255), alias: z.string().max(255).optional(), phoneme: z.string().max(255).optional() });
const podcastSourceInput = z.object({ projectId: z.string().min(1), filename: z.string().min(1).max(255), mimeType: z.string().min(1).max(120), base64: z.string().min(1).max(34_000_000) });

export const MAX_PODCAST_SOURCE_BYTES = 25 * 1024 * 1024;

export function validatePodcastSource(input: { filename: string; mimeType: string; base64: string }) {
  const acceptedMimeTypes = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/flac", "audio/aac"]);
  const source = Buffer.from(input.base64, "base64");
  if (!acceptedMimeTypes.has(input.mimeType)) throw new Error("Choose an MP3, WAV, M4A, FLAC, or AAC audio file");
  if (!source.length || source.byteLength > MAX_PODCAST_SOURCE_BYTES) throw new Error("Podcast source files must be between 1 byte and 25 MB");
  const safeFilename = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return { source, safeFilename };
}

export function resolveNarrationVoice(input: { explicitVoiceId?: string; characterVoiceId?: string | null }) {
  return input.explicitVoiceId || input.characterVoiceId || undefined;
}

export function resolveNarrationPlan(input: { provider: "ElevenLabs" | "OpenAI" | "Deepgram" | "Cloudflare"; explicitVoiceId?: string; characterVoiceId?: string | null; requestedModel?: string; projectModel: string }) {
  return {
    provider: input.provider,
    voiceId: resolveNarrationVoice({ explicitVoiceId: input.explicitVoiceId, characterVoiceId: input.characterVoiceId }),
    model: input.requestedModel || input.projectModel,
  };
}

async function requireProject(ownerId: number, projectIdValue: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [project] = await db.select().from(bookxProjects).where(and(eq(bookxProjects.id, projectIdValue), eq(bookxProjects.ownerId, ownerId))).limit(1);
  if (!project) throw new Error("Project not found");
  return { db, project };
}

export const bookxRouter = router({
  listProjects: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(bookxProjects).where(eq(bookxProjects.ownerId, ctx.user.id)).orderBy(desc(bookxProjects.updatedAt));
  }),

  createProject: protectedProcedure.input(projectSetupSchema).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const id = nanoid();
    await db.insert(bookxProjects).values({ ...input, id, ownerId: ctx.user.id, manuscriptName: input.manuscriptName || null });
    return { id };
  }),

  importPodcastSource: protectedProcedure.input(podcastSourceInput).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { source, safeFilename } = validatePodcastSource(input);
    const stored = await storagePut(`bookx/${input.projectId}/source/${nanoid()}-${safeFilename}`, source, input.mimeType);
    await db.update(bookxProjects).set({ manuscriptName: input.filename, manuscriptStorageKey: stored.key, updatedAt: new Date() }).where(eq(bookxProjects.id, input.projectId));
    return { storageKey: stored.key, url: stored.url, filename: input.filename };
  }),

  updateProject: protectedProcedure.input(projectId.merge(projectSetupSchema.partial())).mutation(async ({ ctx, input }) => {
    const { projectId: projectIdValue, ...updates } = input;
    const { db } = await requireProject(ctx.user.id, projectIdValue);
    await db.update(bookxProjects).set({ ...updates, manuscriptName: updates.manuscriptName === "" ? null : updates.manuscriptName, updatedAt: new Date() }).where(eq(bookxProjects.id, projectIdValue));
    return { success: true };
  }),

  deleteProject: protectedProcedure.input(projectId).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const chapters = await db.select({ id: bookxChapters.id }).from(bookxChapters).where(eq(bookxChapters.projectId, input.projectId));
    for (const chapter of chapters) await db.delete(bookxSegments).where(eq(bookxSegments.chapterId, chapter.id));
    await Promise.all([
      db.delete(bookxChapters).where(eq(bookxChapters.projectId, input.projectId)),
      db.delete(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId)),
      db.delete(bookxPronunciations).where(eq(bookxPronunciations.projectId, input.projectId)),
      db.delete(bookxGenerationJobs).where(eq(bookxGenerationJobs.projectId, input.projectId)),
      db.delete(bookxExports).where(eq(bookxExports.projectId, input.projectId)),
    ]);
    await db.delete(bookxProjects).where(eq(bookxProjects.id, input.projectId));
    return { success: true };
  }),

  getWorkspace: protectedProcedure.input(projectId).query(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const chapters = await db.select().from(bookxChapters).where(eq(bookxChapters.projectId, input.projectId)).orderBy(bookxChapters.orderIndex);
    const chapterIds = chapters.map((chapter) => chapter.id);
    const segments = chapterIds.length ? await db.select().from(bookxSegments).where(eq(bookxSegments.chapterId, chapterIds[0]!)).orderBy(bookxSegments.orderIndex) : [];
    const [characters, pronunciations, generationJobs, exports] = await Promise.all([
      db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId)),
      db.select().from(bookxPronunciations).where(eq(bookxPronunciations.projectId, input.projectId)),
      db.select().from(bookxGenerationJobs).where(eq(bookxGenerationJobs.projectId, input.projectId)).orderBy(desc(bookxGenerationJobs.createdAt)),
      db.select().from(bookxExports).where(eq(bookxExports.projectId, input.projectId)).orderBy(desc(bookxExports.createdAt)),
    ]);
    return {
      project,
      chapters,
      segments,
      characters: characters.map((character) => ({ ...character, previewUrl: character.previewStorageKey ? `/manus-storage/${character.previewStorageKey}` : null })),
      pronunciations,
      generationJobs,
      exports,
    };
  }),

  createChapter: protectedProcedure.input(chapterInput).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxChapters).values({ id, projectId: input.projectId, title: input.title, body: input.body || null, orderIndex: input.orderIndex ?? 0 });
    return { id };
  }),

  updateChapter: protectedProcedure.input(z.object({ projectId: z.string(), chapterId: z.string(), title: z.string().min(1).max(255).optional(), body: z.string().optional(), orderIndex: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, chapterId, ...updates } = input;
    await db.update(bookxChapters).set({ ...updates, updatedAt: new Date() }).where(and(eq(bookxChapters.id, chapterId), eq(bookxChapters.projectId, input.projectId)));
    return { success: true };
  }),

  deleteChapter: protectedProcedure.input(z.object({ projectId: z.string(), chapterId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.delete(bookxSegments).where(eq(bookxSegments.chapterId, input.chapterId));
    await db.delete(bookxChapters).where(and(eq(bookxChapters.id, input.chapterId), eq(bookxChapters.projectId, input.projectId)));
    return { success: true };
  }),

  createSegment: protectedProcedure.input(z.object({ projectId: z.string(), chapterId: z.string(), text: z.string().min(1), characterId: z.string().optional(), orderIndex: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxSegments).values({ id, chapterId: input.chapterId, text: input.text, characterId: input.characterId || null, orderIndex: input.orderIndex ?? 0 });
    return { id };
  }),

  updateSegment: protectedProcedure.input(z.object({ projectId: z.string(), segmentId: z.string(), text: z.string().min(1).optional(), characterId: z.string().nullable().optional(), orderIndex: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, segmentId, ...updates } = input;
    await db.update(bookxSegments).set({ ...updates, updatedAt: new Date() }).where(eq(bookxSegments.id, segmentId));
    return { success: true };
  }),

  deleteSegment: protectedProcedure.input(z.object({ projectId: z.string(), segmentId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.delete(bookxSegments).where(eq(bookxSegments.id, input.segmentId));
    return { success: true };
  }),

  createCharacter: protectedProcedure.input(characterInput).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxCharacters).values({ id, projectId: input.projectId, name: input.name, role: input.role, voiceId: input.voiceId || null, voiceName: input.voiceName || null, accent: input.accent || null, voiceRationale: input.voiceRationale || null, sampleLine: input.sampleLine || null, previewStorageKey: input.previewStorageKey || null, assignmentConfidence: input.assignmentConfidence ?? null, assignmentSource: input.assignmentSource || "manual" });
    return { id };
  }),

  updateCharacter: protectedProcedure.input(z.object({ projectId: z.string(), characterId: z.string(), name: z.string().min(1).max(160).optional(), role: z.string().min(1).max(100).optional(), voiceId: z.string().nullable().optional(), voiceName: z.string().nullable().optional(), accent: z.string().nullable().optional(), voiceRationale: z.string().max(512).nullable().optional(), sampleLine: z.string().max(2000).nullable().optional(), previewStorageKey: z.string().max(512).nullable().optional(), assignmentConfidence: z.number().int().min(0).max(100).nullable().optional(), assignmentSource: z.enum(["manual", "llm"]).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, characterId, ...updates } = input;
    await db.update(bookxCharacters).set({ ...updates, updatedAt: new Date() }).where(and(eq(bookxCharacters.id, characterId), eq(bookxCharacters.projectId, input.projectId)));
    return { success: true };
  }),

  updateCharacterByName: protectedProcedure.input(z.object({ projectId: z.string(), name: z.string().min(1).max(160), voiceId: z.string().nullable().optional(), voiceName: z.string().nullable().optional(), assignmentSource: z.enum(["manual", "llm"]).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, name, ...updates } = input;
    await db.update(bookxCharacters).set({ ...updates, updatedAt: new Date() }).where(and(eq(bookxCharacters.projectId, input.projectId), eq(bookxCharacters.name, name)));
    return { success: true };
  }),

  replaceCharacters: protectedProcedure.input(z.object({ projectId: z.string().min(1), characters: z.array(characterInput.omit({ projectId: true })).min(1).max(64) })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.delete(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId));
    await db.insert(bookxCharacters).values(input.characters.map((character) => ({ id: nanoid(), projectId: input.projectId, name: character.name, role: character.role, voiceId: character.voiceId || null, voiceName: character.voiceName || null, accent: character.accent || null, voiceRationale: character.voiceRationale || null, sampleLine: character.sampleLine || null, previewStorageKey: character.previewStorageKey || null, assignmentConfidence: character.assignmentConfidence ?? null, assignmentSource: character.assignmentSource || "llm" })));
    return { count: input.characters.length };
  }),

  deleteCharacter: protectedProcedure.input(z.object({ projectId: z.string(), characterId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.update(bookxSegments).set({ characterId: null, updatedAt: new Date() }).where(eq(bookxSegments.characterId, input.characterId));
    await db.delete(bookxCharacters).where(and(eq(bookxCharacters.id, input.characterId), eq(bookxCharacters.projectId, input.projectId)));
    return { success: true };
  }),

  createPronunciation: protectedProcedure.input(pronunciationInput).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxPronunciations).values({ id, projectId: input.projectId, word: input.word, alias: input.alias || null, phoneme: input.phoneme || null });
    return { id };
  }),

  updatePronunciation: protectedProcedure.input(z.object({ projectId: z.string(), ruleId: z.string(), word: z.string().min(1).max(255).optional(), alias: z.string().nullable().optional(), phoneme: z.string().nullable().optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, ruleId, ...updates } = input;
    await db.update(bookxPronunciations).set({ ...updates, updatedAt: new Date() }).where(and(eq(bookxPronunciations.id, ruleId), eq(bookxPronunciations.projectId, input.projectId)));
    return { success: true };
  }),

  deletePronunciation: protectedProcedure.input(z.object({ projectId: z.string(), ruleId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.delete(bookxPronunciations).where(and(eq(bookxPronunciations.id, input.ruleId), eq(bookxPronunciations.projectId, input.projectId)));
    return { success: true };
  }),

  startGeneration: protectedProcedure.input(z.object({ projectId: z.string(), scope: z.enum(["project", "chapter", "segment"]), totalSegments: z.number().int().min(0), detail: z.object({ chapterIds: z.array(z.string()).optional() }).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxGenerationJobs).values({ id, projectId: input.projectId, scope: input.scope, status: "queued", totalSegments: input.totalSegments, detail: input.detail || null });
    return { id, status: "queued" as const };
  }),

  updateGeneration: protectedProcedure.input(z.object({ projectId: z.string(), jobId: z.string(), status: z.enum(["queued", "running", "completed", "failed", "cancelled"]), completedSegments: z.number().int().min(0).optional(), failedSegments: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, jobId, ...updates } = input;
    await db.update(bookxGenerationJobs).set({ ...updates, updatedAt: new Date() }).where(and(eq(bookxGenerationJobs.id, jobId), eq(bookxGenerationJobs.projectId, input.projectId)));
    return { success: true };
  }),

  previewCharacterVoice: protectedProcedure.input(z.object({ projectId: z.string(), characterId: z.string(), provider: z.enum(["ElevenLabs", "OpenAI", "Deepgram", "Cloudflare"]), voiceId: z.string().min(1).max(160).optional(), model: z.string().max(160).optional() })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const [character] = await db.select().from(bookxCharacters).where(and(eq(bookxCharacters.id, input.characterId), eq(bookxCharacters.projectId, input.projectId))).limit(1);
    if (!character) throw new Error("Character not found");
    const plan = resolveNarrationPlan({ provider: input.provider, explicitVoiceId: input.voiceId, characterVoiceId: character.voiceId, requestedModel: input.model, projectModel: project.voiceModel });
    const voiceId = plan.voiceId;
    if (!voiceId) throw new Error("Assign a voice before generating a preview");
    const text = character.sampleLine?.trim();
    if (!text) throw new Error("Add a sample line before generating a preview");
    const generated = await synthesizeNarration({ projectId: input.projectId, provider: plan.provider, text, voiceId, model: plan.model });
    await db.update(bookxCharacters).set({ previewStorageKey: generated.storageKey, updatedAt: new Date() }).where(eq(bookxCharacters.id, character.id));
    return { ...generated, characterId: character.id, voiceId };
  }),

  previewVoice: protectedProcedure.input(z.object({ projectId: z.string(), provider: z.enum(["ElevenLabs", "OpenAI", "Deepgram", "Cloudflare"]), voiceId: z.string().min(1).max(160), model: z.string().max(160).optional(), text: z.string().trim().min(1).max(600) })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx.user.id, input.projectId);
    const generated = await synthesizeNarration({ projectId: input.projectId, provider: input.provider, text: input.text, voiceId: input.voiceId, model: input.model || project.voiceModel });
    return { ...generated, voiceId: input.voiceId };
  }),

  generateNarrationClip: protectedProcedure.input(z.object({ projectId: z.string(), segmentId: z.string().optional(), characterId: z.string().optional(), provider: z.enum(["ElevenLabs", "OpenAI", "Deepgram", "Cloudflare"]), text: z.string().min(1).max(4000), voiceId: z.string().max(160).optional(), model: z.string().max(160).optional() })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const [character] = input.characterId
      ? await db.select().from(bookxCharacters).where(and(eq(bookxCharacters.id, input.characterId), eq(bookxCharacters.projectId, input.projectId))).limit(1)
      : [];
    const plan = resolveNarrationPlan({ provider: input.provider, explicitVoiceId: input.voiceId, characterVoiceId: character?.voiceId, requestedModel: input.model, projectModel: project.voiceModel });
    const voiceId = plan.voiceId;
    const jobId = nanoid();
    await db.insert(bookxGenerationJobs).values({ id: jobId, projectId: input.projectId, scope: "segment", status: "running", totalSegments: 1, completedSegments: 0 });
    try {
      const generated = await synthesizeNarration({ projectId: input.projectId, provider: plan.provider, text: input.text, voiceId, model: plan.model });
      if (input.segmentId) await db.update(bookxSegments).set({ audioStorageKey: generated.storageKey, updatedAt: new Date() }).where(eq(bookxSegments.id, input.segmentId));
      await db.update(bookxGenerationJobs).set({ status: "completed", completedSegments: 1, updatedAt: new Date() }).where(eq(bookxGenerationJobs.id, jobId));
      return { jobId, characterId: input.characterId, voiceId, ...generated };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Narration failed";
      await db.update(bookxGenerationJobs).set({ status: "failed", failedSegments: 1, detail: { errors: [message] }, updatedAt: new Date() }).where(eq(bookxGenerationJobs.id, jobId));
      throw error;
    }
  }),

  transcribeAudioClip: protectedProcedure.input(z.object({ projectId: z.string(), provider: z.enum(["ElevenLabs", "OpenAI", "Deepgram", "Cloudflare", "Fish Audio"]), model: z.string().max(160).optional(), audioStorageKey: z.string().min(1).max(512), language: z.string().max(40).optional() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return transcribeAudioRoute(input);
  }),

  requestExport: protectedProcedure.input(z.object({ projectId: z.string(), format: z.enum(["ACX", "Podcast", "InAudio package"]) })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxExports).values({ id, projectId: input.projectId, format: input.format, status: "queued" });
    return { id, status: "queued" as const };
  }),

  updateExport: protectedProcedure.input(z.object({ projectId: z.string(), exportId: z.string(), status: z.enum(["queued", "ready", "failed"]), storageKey: z.string().nullable().optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, exportId, ...updates } = input;
    await db.update(bookxExports).set({ ...updates, updatedAt: new Date() }).where(and(eq(bookxExports.id, exportId), eq(bookxExports.projectId, input.projectId)));
    return { success: true };
  }),

  listStudio: protectedProcedure.input(projectId).query(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const [assets, clips] = await Promise.all([
      db.select().from(bookxStudioAssets).where(eq(bookxStudioAssets.projectId, input.projectId)),
      db.select().from(bookxTimelineClips).where(eq(bookxTimelineClips.projectId, input.projectId)).orderBy(bookxTimelineClips.startMs),
    ]);
    return { assets, clips };
  }),

  addStudioAsset: protectedProcedure.input(z.object({ projectId: z.string(), type: z.enum(["music", "sound-effect", "recording"]), title: z.string().min(1).max(255), storageKey: z.string().max(512).optional(), durationMs: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxStudioAssets).values({ id, projectId: input.projectId, type: input.type, title: input.title, storageKey: input.storageKey || null, durationMs: input.durationMs ?? 0 });
    return { id };
  }),

  updateStudioAsset: protectedProcedure.input(z.object({ projectId: z.string(), assetId: z.string(), title: z.string().min(1).max(255).optional(), durationMs: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, assetId, ...updates } = input;
    await db.update(bookxStudioAssets).set({ ...updates, updatedAt: new Date() }).where(and(eq(bookxStudioAssets.id, assetId), eq(bookxStudioAssets.projectId, input.projectId)));
    return { success: true };
  }),

  deleteStudioAsset: protectedProcedure.input(z.object({ projectId: z.string(), assetId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.delete(bookxTimelineClips).where(and(eq(bookxTimelineClips.assetId, input.assetId), eq(bookxTimelineClips.projectId, input.projectId)));
    await db.delete(bookxStudioAssets).where(and(eq(bookxStudioAssets.id, input.assetId), eq(bookxStudioAssets.projectId, input.projectId)));
    return { success: true };
  }),

  placeTimelineClip: protectedProcedure.input(z.object({ projectId: z.string(), assetId: z.string().optional(), segmentId: z.string().optional(), trackType: z.enum(["narration", "music", "sound-effect"]), startMs: z.number().int().min(0), durationMs: z.number().int().min(0), volume: z.number().int().min(0).max(100).optional(), fadeInMs: z.number().int().min(0).optional(), fadeOutMs: z.number().int().min(0).optional(), duckUnderNarration: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    await db.insert(bookxTimelineClips).values({ id, projectId: input.projectId, assetId: input.assetId || null, segmentId: input.segmentId || null, trackType: input.trackType, startMs: input.startMs, durationMs: input.durationMs, volume: input.volume ?? 80, fadeInMs: input.fadeInMs ?? 0, fadeOutMs: input.fadeOutMs ?? 0, duckUnderNarration: input.duckUnderNarration === false ? 0 : 1 });
    return { id };
  }),

  updateTimelineClip: protectedProcedure.input(z.object({ projectId: z.string(), clipId: z.string(), startMs: z.number().int().min(0).optional(), durationMs: z.number().int().min(0).optional(), volume: z.number().int().min(0).max(100).optional(), fadeInMs: z.number().int().min(0).optional(), fadeOutMs: z.number().int().min(0).optional(), duckUnderNarration: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, clipId, duckUnderNarration, ...updates } = input;
    await db.update(bookxTimelineClips).set({ ...updates, ...(duckUnderNarration === undefined ? {} : { duckUnderNarration: duckUnderNarration ? 1 : 0 }), updatedAt: new Date() }).where(and(eq(bookxTimelineClips.id, clipId), eq(bookxTimelineClips.projectId, input.projectId)));
    return { success: true };
  }),

  deleteTimelineClip: protectedProcedure.input(z.object({ projectId: z.string(), clipId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.delete(bookxTimelineClips).where(and(eq(bookxTimelineClips.id, input.clipId), eq(bookxTimelineClips.projectId, input.projectId)));
    return { success: true };
  }),

  listProviderSettings: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, ctx.user.id));
  }),

  saveProviderSettings: protectedProcedure.input(z.object({ provider: z.enum(["ElevenLabs", "OpenAI"]), secretConfigured: z.boolean(), defaultModel: z.string().max(100).optional(), defaultPace: z.string().max(80).optional(), chapterGapMs: z.number().int().min(0).max(60000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const existing = await db.select().from(bookxProviderSettings).where(and(eq(bookxProviderSettings.ownerId, ctx.user.id), eq(bookxProviderSettings.provider, input.provider))).limit(1);
    const values = { secretConfigured: input.secretConfigured ? 1 : 0, defaultModel: input.defaultModel || null, defaultPace: input.defaultPace || null, chapterGapMs: input.chapterGapMs ?? 2000, updatedAt: new Date() };
    if (existing[0]) {
      await db.update(bookxProviderSettings).set(values).where(eq(bookxProviderSettings.id, existing[0].id));
      return { id: existing[0].id };
    }
    const id = nanoid();
    await db.insert(bookxProviderSettings).values({ id, ownerId: ctx.user.id, provider: input.provider, ...values });
    return { id };
  }),
});
