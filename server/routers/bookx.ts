import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  bookxAnalysisJobs,
  bookxChapters,
  bookxCharacters,
  bookxExports,
  bookxGenerationJobs,
  bookxPronunciations,
  bookxProjects,
  bookxProviderSettings,
  bookxSegments,
  bookxSoundCues,
  bookxStudioAssets,
  bookxTimelineClips,
  type SegmentDelivery,
} from "../../drizzle/schema";
import { MAX_MANUSCRIPT_BYTES, ManuscriptImportError, parseManuscript } from "../manuscriptImport";
import { analysisProgress, requestAnalysisCancel } from "../analysisJobs";
import { assignProjectVoices, startCastAnalysis } from "../castAnalysis";
import { previewChapterSound, previewSoundCue, soundDesignOverview, soundSettings, startScenePlan, startSoundPreparation } from "../soundDesign";
import { isSoundTag } from "../soundLibrary";
import { projectSetupSchema } from "../../shared/bookx";
import { providerIdSchema, type ProviderId } from "../../shared/providers";
import { forEachChunk, getDb, insertMany, projectChapterIds, runBatched } from "../db";
import { chapterBodySchema, splitOversizedChapters } from "../chapterLimits";
import { protectedProcedure, router } from "../_core/trpc";
import { synthesizeNarration } from "../tts";
import { storageDeletePrefix, storagePut } from "../storage";
import { transcribeAudioRoute } from "../providerRouting";
import { redactProviderApiKey } from "../providerCredentials";
import {
  auditProjectAudio,
  ensureChapterSegments,
  includedChapters,
  requestCancel,
  requestPause,
  resumeNarrationRun,
  retryFailedSegments,
  startNarrationRun,
} from "../narrationWorker";
import { isTerminalJobStatus, type AudioAudit, type ChapterProgress, type NarrationProgress } from "../../shared/narration";
import { EXPORT_PRESET_IDS, exportOutputSchema } from "../../shared/exportOptions";
import {
  deleteProjectExport,
  exportOverview,
  getExportDownloadUrl,
  readinessFrom,
  requestProjectExport,
} from "../audioExport";

const projectId = z.object({ projectId: z.string().min(1).max(32) });
const chapterInput = z.object({ projectId: z.string().min(1), title: z.string().min(1).max(255), body: chapterBodySchema.optional(), orderIndex: z.number().int().min(0).optional() });
const characterInput = z.object({ projectId: z.string().min(1), name: z.string().min(1).max(160), role: z.string().min(1).max(100), voiceId: z.string().max(160).optional(), voiceName: z.string().max(160).optional(), accent: z.string().max(160).optional(), voiceRationale: z.string().max(512).optional(), sampleLine: z.string().max(2000).optional(), previewStorageKey: z.string().max(512).optional(), assignmentConfidence: z.number().int().min(0).max(100).optional(), assignmentSource: z.enum(["manual", "llm"]).optional() });
const pronunciationInput = z.object({ projectId: z.string().min(1), word: z.string().min(1).max(255), alias: z.string().max(255).optional(), phoneme: z.string().max(255).optional() });
const podcastSourceInput = z.object({ projectId: z.string().min(1), filename: z.string().min(1).max(255), mimeType: z.string().min(1).max(120), base64: z.string().min(1).max(34_000_000) });
const manuscriptInput = z.object({
  projectId: z.string().min(1),
  filename: z.string().min(1).max(255),
  // Base64 inflates by 4/3; allow the padding on top of the raw-byte ceiling.
  base64: z.string().min(1).max(Math.ceil(MAX_MANUSCRIPT_BYTES / 3) * 4 + 16),
  /** "replace" swaps the whole manuscript; "append" adds the chapters at the end. */
  mode: z.enum(["replace", "append"]).default("replace"),
});

const MANUSCRIPT_MIME: Record<string, string> = {
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  markdown: "text/markdown",
  text: "text/plain",
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Deletes chapters together with everything that hangs off them. */
async function removeChapters(db: Db, projectIdValue: string, chapterIds: string[]) {
  await forEachChunk(chapterIds, async part => {
    await db.delete(bookxSegments).where(inArray(bookxSegments.chapterId, part));
    await db.delete(bookxSoundCues).where(and(eq(bookxSoundCues.projectId, projectIdValue), inArray(bookxSoundCues.chapterId, part)));
    await db.delete(bookxChapters).where(and(eq(bookxChapters.projectId, projectIdValue), inArray(bookxChapters.id, part)));
  });
}



async function nextChapterIndex(db: Db, projectIdValue: string): Promise<number> {
  const [row] = await db.select({ value: max(bookxChapters.orderIndex) }).from(bookxChapters).where(eq(bookxChapters.projectId, projectIdValue));
  return row?.value == null ? 0 : Number(row.value) + 1;
}

/** Ownership check for a chapter id supplied by the client. */
async function requireChapter(db: Db, projectIdValue: string, chapterId: string) {
  const [chapter] = await db.select().from(bookxChapters)
    .where(and(eq(bookxChapters.id, chapterId), eq(bookxChapters.projectId, projectIdValue)))
    .limit(1);
  if (!chapter) throw new Error("Chapter not found");
  return chapter;
}

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

export function resolveNarrationPlan(input: { provider: ProviderId; explicitVoiceId?: string; characterVoiceId?: string | null; requestedModel?: string; projectModel: string }) {
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

/** Verifies a segment belongs to a chapter of the caller's project (ownership check). */
async function requireSegment(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, projectIdValue: string, segmentId: string) {
  const [row] = await db.select({ segment: bookxSegments }).from(bookxSegments)
    .innerJoin(bookxChapters, eq(bookxSegments.chapterId, bookxChapters.id))
    .where(and(eq(bookxSegments.id, segmentId), eq(bookxChapters.projectId, projectIdValue)))
    .limit(1);
  if (!row) throw new Error("Segment not found");
  return row.segment;
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
    await db.delete(bookxSegments).where(inArray(bookxSegments.chapterId, projectChapterIds(db, input.projectId)));
    await Promise.all([
      db.delete(bookxChapters).where(eq(bookxChapters.projectId, input.projectId)),
      db.delete(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId)),
      db.delete(bookxPronunciations).where(eq(bookxPronunciations.projectId, input.projectId)),
      db.delete(bookxGenerationJobs).where(eq(bookxGenerationJobs.projectId, input.projectId)),
      db.delete(bookxExports).where(eq(bookxExports.projectId, input.projectId)),
      db.delete(bookxSoundCues).where(eq(bookxSoundCues.projectId, input.projectId)),
      db.delete(bookxAnalysisJobs).where(eq(bookxAnalysisJobs.projectId, input.projectId)),
      db.delete(bookxTimelineClips).where(eq(bookxTimelineClips.projectId, input.projectId)),
      db.delete(bookxStudioAssets).where(eq(bookxStudioAssets.projectId, input.projectId)),
    ]);
    await db.delete(bookxProjects).where(eq(bookxProjects.id, input.projectId));
    // The book's audio, sounds and exports go too, so a deleted project stops
    // taking up storage. A failure here leaves orphaned files, not a broken app.
    await storageDeletePrefix(`bookx/${input.projectId}/`).catch(error => console.warn("[Storage] Could not remove project files:", error));
    return { success: true };
  }),

  getWorkspace: protectedProcedure.input(projectId).query(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const chapters = await db.select().from(bookxChapters).where(eq(bookxChapters.projectId, input.projectId)).orderBy(bookxChapters.orderIndex);
    const chapterIds = chapters.map((chapter) => chapter.id);
    // Every chapter's segments, not just the first one's. Returning only
    // `chapterIds[0]` meant the Write screen could never show segments for any
    // chapter but the opening one.
    const segments = chapterIds.length
      ? await db.select().from(bookxSegments).where(inArray(bookxSegments.chapterId, projectChapterIds(db, input.projectId))).orderBy(bookxSegments.orderIndex)
      : [];
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

  /**
   * Imports a whole manuscript (EPUB, DOCX, HTML, Markdown or text) as chapters.
   *
   * Front and back matter (cover, copyright, contents, about the author) are
   * imported but start excluded, so the creator can see them and opt back in.
   */
  importManuscript: protectedProcedure.input(manuscriptInput).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const data = Buffer.from(input.base64, "base64");

    let parsed: Awaited<ReturnType<typeof parseManuscript>>;
    try {
      parsed = await parseManuscript({ filename: input.filename, data });
    } catch (error) {
      if (error instanceof ManuscriptImportError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
      console.error("[Import] Manuscript parse failed:", error);
      throw new TRPCError({ code: "BAD_REQUEST", message: "Prosecast could not read that file. Try exporting it again as EPUB or DOCX." });
    }
    if (!parsed.chapters.length) throw new TRPCError({ code: "BAD_REQUEST", message: "No readable chapters were found in that file." });

    if (input.mode === "replace") {
      const existing = await db.select({ id: bookxChapters.id }).from(bookxChapters).where(eq(bookxChapters.projectId, input.projectId));
      await removeChapters(db, input.projectId, existing.map(chapter => chapter.id));
    }
    const startIndex = input.mode === "append" ? await nextChapterIndex(db, input.projectId) : 0;

    const chapters = splitOversizedChapters(parsed.chapters);
    const rows = chapters.map((chapter, index) => ({
      id: nanoid(),
      projectId: input.projectId,
      title: chapter.title.slice(0, 255),
      body: chapter.body,
      orderIndex: startIndex + index,
      included: chapter.included ? 1 : 0,
      kind: chapter.kind,
    }));
    // One row per statement keeps each insert well inside D1's 2 MB row and
    // 100 KB statement limits however long the chapters are.
    for (const row of rows) await db.insert(bookxChapters).values(row);

    const warnings = [...parsed.warnings];
    if (chapters.length > parsed.chapters.length) {
      warnings.push(`${chapters.length - parsed.chapters.length} very long chapter part(s) were split so each fits in the database. Check the chapter list and rename or merge them if you like.`);
    }
    let storageKey = project.manuscriptStorageKey;
    try {
      const safeFilename = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
      const stored = await storagePut(`bookx/${input.projectId}/source/${nanoid()}-${safeFilename}`, data, MANUSCRIPT_MIME[parsed.format] ?? "application/octet-stream");
      storageKey = stored.key;
    } catch (error) {
      console.warn("[Import] Could not keep a copy of the source file:", error);
      warnings.push("The chapters were imported, but a copy of the original file could not be stored.");
    }

    await db.update(bookxProjects).set({
      manuscriptName: input.filename.slice(0, 255),
      manuscriptStorageKey: storageKey,
      author: project.author || parsed.author?.slice(0, 120) || null,
      updatedAt: new Date(),
    }).where(eq(bookxProjects.id, input.projectId));

    const included = rows.filter(row => row.included).length;
    return {
      format: parsed.format,
      title: parsed.title ?? null,
      author: parsed.author ?? null,
      language: parsed.language ?? null,
      imported: rows.length,
      included,
      excluded: rows.length - included,
      words: parsed.chapters.reduce((total, chapter) => total + chapter.wordCount, 0),
      warnings,
    };
  }),

  createChapter: protectedProcedure.input(chapterInput).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const id = nanoid();
    const orderIndex = input.orderIndex ?? await nextChapterIndex(db, input.projectId);
    await db.insert(bookxChapters).values({ id, projectId: input.projectId, title: input.title, body: input.body || null, orderIndex });
    return { id };
  }),

  updateChapter: protectedProcedure.input(z.object({ projectId: z.string(), chapterId: z.string(), title: z.string().min(1).max(255).optional(), body: chapterBodySchema.optional(), orderIndex: z.number().int().min(0).optional(), included: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, chapterId, included, ...updates } = input;
    await db.update(bookxChapters).set({ ...updates, ...(included === undefined ? {} : { included: included ? 1 : 0 }), updatedAt: new Date() }).where(and(eq(bookxChapters.id, chapterId), eq(bookxChapters.projectId, input.projectId)));
    return { success: true };
  }),

  /** Includes or excludes many chapters at once ("select all", "select none"). */
  setChaptersIncluded: protectedProcedure.input(z.object({ projectId: z.string(), chapterIds: z.array(z.string()).min(1).max(2_000), included: z.boolean() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await forEachChunk(input.chapterIds, part => db.update(bookxChapters)
      .set({ included: input.included ? 1 : 0, updatedAt: new Date() })
      .where(and(eq(bookxChapters.projectId, input.projectId), inArray(bookxChapters.id, part))));
    return { success: true };
  }),

  /** Rewrites chapter order from the given id list; ids outside the project are ignored. */
  reorderChapters: protectedProcedure.input(z.object({ projectId: z.string(), chapterIds: z.array(z.string()).min(1).max(2_000) })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const owned = new Set((await db.select({ id: bookxChapters.id }).from(bookxChapters).where(eq(bookxChapters.projectId, input.projectId))).map(row => row.id));
    const ordered = input.chapterIds.filter(id => owned.has(id));
    await runBatched(db, ordered.map((id, index) =>
      db.update(bookxChapters).set({ orderIndex: index, updatedAt: new Date() }).where(and(eq(bookxChapters.id, id), eq(bookxChapters.projectId, input.projectId)))));
    return { success: true, count: ordered.length };
  }),

  deleteChapter: protectedProcedure.input(z.object({ projectId: z.string(), chapterId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    // Verify first: deleting segments by a bare chapter id let one user wipe
    // another project's narration by guessing an id.
    const chapter = await requireChapter(db, input.projectId, input.chapterId);
    await removeChapters(db, input.projectId, [chapter.id]);
    return { success: true };
  }),

  createSegment: protectedProcedure.input(z.object({ projectId: z.string(), chapterId: z.string(), text: z.string().min(1), characterId: z.string().optional(), orderIndex: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await requireChapter(db, input.projectId, input.chapterId);
    const id = nanoid();
    await db.insert(bookxSegments).values({ id, chapterId: input.chapterId, text: input.text, characterId: input.characterId || null, orderIndex: input.orderIndex ?? 0 });
    return { id };
  }),

  updateSegment: protectedProcedure.input(z.object({ projectId: z.string(), segmentId: z.string(), text: z.string().min(1).optional(), characterId: z.string().nullable().optional(), orderIndex: z.number().int().min(0).optional() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, segmentId, characterId, ...updates } = input;
    const segment = await requireSegment(db, input.projectId, segmentId);
    const speakerChange: { characterId?: string | null; delivery?: SegmentDelivery } = {};
    if (characterId !== undefined) {
      if (characterId) {
        // A segment may only be voiced by one of this project's characters.
        const [character] = await db.select({ id: bookxCharacters.id }).from(bookxCharacters)
          .where(and(eq(bookxCharacters.id, characterId), eq(bookxCharacters.projectId, input.projectId)))
          .limit(1);
        if (!character) throw new Error("Character not found");
      }
      // A creator's choice is final: later analysis never overwrites it.
      speakerChange.characterId = characterId;
      speakerChange.delivery = { ...(segment.delivery ?? {}), speakerSource: "manual" };
    }
    await db.update(bookxSegments).set({ ...updates, ...speakerChange, updatedAt: new Date() }).where(eq(bookxSegments.id, segmentId));
    return { success: true };
  }),

  deleteSegment: protectedProcedure.input(z.object({ projectId: z.string(), segmentId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await requireSegment(db, input.projectId, input.segmentId);
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
    await insertMany(db, bookxCharacters, input.characters.map((character) => ({ id: nanoid(), projectId: input.projectId, name: character.name, role: character.role, voiceId: character.voiceId || null, voiceName: character.voiceName || null, accent: character.accent || null, voiceRationale: character.voiceRationale || null, sampleLine: character.sampleLine || null, previewStorageKey: character.previewStorageKey || null, assignmentConfidence: character.assignmentConfidence ?? null, assignmentSource: character.assignmentSource || "llm" })));
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

  // ---- Narration runs ----------------------------------------------------
  // The worker owns a job's status; clients only express intent (start, pause,
  // resume, cancel) and read progress. There is deliberately no route that lets a
  // client write a job's status, because that could contradict a live run.

  /**
   * Splits chapter text into render units and starts (or resumes) the run.
   * Returns immediately: a book takes far longer than a request.
   */
  startNarration: protectedProcedure.input(z.object({
    projectId: z.string(),
    chapterIds: z.array(z.string()).max(500).optional(),
    force: z.boolean().optional(),
    rewindSegments: z.number().int().min(0).max(20).optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return startNarrationRun({
      projectId: input.projectId,
      ownerId: ctx.user.id,
      chapterIds: input.chapterIds,
      force: input.force,
      rewindSegments: input.rewindSegments,
    });
  }),

  /** Live progress for the newest run, computed from segments rather than a timer. */
  narrationStatus: protectedProcedure.input(projectId).query(async ({ ctx, input }): Promise<NarrationProgress> => {
    const { db } = await requireProject(ctx.user.id, input.projectId);

    // Only chapters that are part of the book count towards progress.
    const chapters = await includedChapters(db, input.projectId);
    const segments = chapters.length
      ? await db.select().from(bookxSegments).where(inArray(bookxSegments.chapterId, projectChapterIds(db, input.projectId, { includedOnly: true })))
      : [];

    const chapterProgress: ChapterProgress[] = chapters.map((chapter) => {
      const own = segments.filter((segment) => segment.chapterId === chapter.id);
      return {
        chapterId: chapter.id,
        title: chapter.title,
        orderIndex: chapter.orderIndex,
        totalSegments: own.length,
        renderedSegments: own.filter((segment) => segment.audioStorageKey).length,
        failedSegments: own.filter((segment) => !segment.audioStorageKey && segment.lastError).length,
        durationMs: own.reduce((total, segment) => total + (segment.audioDurationMs || 0), 0),
      };
    });

    const [job] = await db.select().from(bookxGenerationJobs)
      .where(eq(bookxGenerationJobs.projectId, input.projectId))
      .orderBy(desc(bookxGenerationJobs.createdAt))
      .limit(1);

    const renderedSegments = chapterProgress.reduce((total, chapter) => total + chapter.renderedSegments, 0);
    const totalSegments = job?.totalSegments || segments.length;
    const detail = (job?.detail || {}) as { failures?: NarrationProgress["failures"]; events?: NarrationProgress["events"]; pinnedVoice?: NarrationProgress["pinnedVoice"] };

    if (!job) {
      return {
        jobId: null, status: "idle", totalSegments, completedSegments: renderedSegments, failedSegments: 0,
        skippedSegments: 0, percent: totalSegments ? Math.round((renderedSegments / totalSegments) * 100) : 0,
        renderedDurationMs: chapterProgress.reduce((total, chapter) => total + chapter.durationMs, 0),
        renderedBytes: 0, cursorIndex: 0, cursorSegmentId: null, pinnedVoice: null, stopping: false,
        secondsSinceHeartbeat: null, startedAt: null, finishedAt: null, chapters: chapterProgress,
        failures: [], events: [], resumable: renderedSegments < totalSegments && totalSegments > 0,
      };
    }

    // Progress is reported from stored audio, not from the job's own counter, so a
    // lost or stale counter cannot overstate how much of the book actually exists.
    const completed = Math.max(job.completedSegments, renderedSegments);

    return {
      jobId: job.id,
      status: job.status,
      totalSegments,
      completedSegments: completed,
      failedSegments: job.failedSegments,
      skippedSegments: job.skippedSegments,
      percent: totalSegments ? Math.min(100, Math.round((completed / totalSegments) * 100)) : 0,
      renderedDurationMs: chapterProgress.reduce((total, chapter) => total + chapter.durationMs, 0),
      renderedBytes: Number(job.renderedBytes || 0),
      cursorIndex: job.cursorIndex,
      cursorSegmentId: job.cursorSegmentId,
      pinnedVoice: detail.pinnedVoice || (job.provider && job.model ? { provider: job.provider, model: job.model } : null),
      stopping: Boolean(job.pauseRequested || job.cancelRequested),
      secondsSinceHeartbeat: job.heartbeatAt ? Math.round((Date.now() - new Date(job.heartbeatAt).getTime()) / 1000) : null,
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      chapters: chapterProgress,
      failures: detail.failures || [],
      events: detail.events || [],
      resumable: !isTerminalJobStatus(job.status) || (job.status === "failed" && completed < totalSegments),
    };
  }),

  /** Stops at the next segment boundary; everything already rendered is kept. */
  pauseNarration: protectedProcedure.input(z.object({ projectId: z.string(), jobId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    await requestPause(input.jobId);
    return { success: true };
  }),

  resumeNarration: protectedProcedure.input(z.object({ projectId: z.string(), jobId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    await resumeNarrationRun({ jobId: input.jobId, ownerId: ctx.user.id });
    return { success: true };
  }),

  cancelNarration: protectedProcedure.input(z.object({ projectId: z.string(), jobId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    await requestCancel(input.jobId);
    return { success: true };
  }),

  /** Re-queues only the segments that never rendered, within the last run's chapters. */
  retryFailedNarration: protectedProcedure.input(projectId).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    // Keep the scope of the run being retried; retrying a two-chapter run used
    // to start a whole-book render.
    const [lastJob] = await db.select({ detail: bookxGenerationJobs.detail }).from(bookxGenerationJobs)
      .where(eq(bookxGenerationJobs.projectId, input.projectId))
      .orderBy(desc(bookxGenerationJobs.createdAt))
      .limit(1);
    const chapterIds = (lastJob?.detail as { chapterIds?: string[] } | null)?.chapterIds;
    const reset = await retryFailedSegments({ projectId: input.projectId, ownerId: ctx.user.id, chapterIds });
    const started = await startNarrationRun({ projectId: input.projectId, ownerId: ctx.user.id, chapterIds });
    return { ...started, reset };
  }),

  /**
   * "Is my book actually intact?" — derived from stored hashes and voices, so it
   * stays correct even if job records were lost.
   */
  auditNarration: protectedProcedure.input(projectId).query(async ({ ctx, input }): Promise<AudioAudit> => {
    await requireProject(ctx.user.id, input.projectId);
    return auditProjectAudio({ projectId: input.projectId, ownerId: ctx.user.id });
  }),

  // ---- Analysis runs (casting, scene cues, sound generation) ---------------

  /**
   * Reads the whole book to find the cast, attributes every line of dialogue and
   * assigns default voices. Runs in the background; poll `analysisStatus`.
   */
  startCastAnalysis: protectedProcedure.input(z.object({ projectId: z.string(), force: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return startCastAnalysis({ projectId: input.projectId, ownerId: ctx.user.id, force: input.force });
  }),

  analysisStatus: protectedProcedure.input(z.object({ projectId: z.string(), kind: z.enum(["cast", "scenes", "sounds"]) })).query(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return analysisProgress(input.projectId, input.kind);
  }),

  cancelAnalysis: protectedProcedure.input(z.object({ projectId: z.string(), jobId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    await requestAnalysisCancel(input.projectId, input.jobId);
    return { success: true };
  }),

  /** Re-picks default voices for every character the creator has not cast by hand. */
  assignDefaultVoices: protectedProcedure.input(projectId).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const [narrator] = await db.select({ id: bookxCharacters.id }).from(bookxCharacters)
      .where(and(eq(bookxCharacters.projectId, input.projectId), eq(bookxCharacters.isNarrator, 1)))
      .limit(1);
    // A project that has never been analysed still gets a narrator to cast.
    if (!narrator) {
      await db.insert(bookxCharacters).values({ id: nanoid(), projectId: input.projectId, name: "Narrator", role: "Narrator", isNarrator: 1, assignmentSource: "auto" });
    }
    return { assigned: await assignProjectVoices(db, input.projectId, ctx.user.id) };
  }),

  // ---- Sound design ---------------------------------------------------------

  /** Toggles, level, source, and every planned cue grouped by chapter. */
  soundDesign: protectedProcedure.input(projectId).query(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    return soundDesignOverview(db, project, ctx.user.id);
  }),

  updateSoundSettings: protectedProcedure.input(z.object({
    projectId: z.string(),
    effects: z.boolean().optional(),
    music: z.boolean().optional(),
    level: z.enum(["ultra-subtle", "extra-subtle", "subtle"]).optional(),
    source: z.enum(["auto", "elevenlabs", "builtin"]).optional(),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    await db.update(bookxProjects).set({
      ...(input.effects === undefined ? {} : { soundEffectsEnabled: input.effects ? 1 : 0 }),
      ...(input.music === undefined ? {} : { backgroundMusicEnabled: input.music ? 1 : 0 }),
      ...(input.level ? { soundLevel: input.level } : {}),
      ...(input.source ? { soundSource: input.source } : {}),
      updatedAt: new Date(),
    }).where(eq(bookxProjects.id, input.projectId));
    return { success: true };
  }),

  /**
   * Reads each chapter's scenes and places sound cues, then prepares the
   * sounds for whatever is switched on. Poll `analysisStatus("scenes")`.
   */
  startScenePlan: protectedProcedure.input(z.object({ projectId: z.string(), replan: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return startScenePlan({ projectId: input.projectId, ownerId: ctx.user.id, replan: input.replan });
  }),

  /** Generates or reuses a sound for every enabled cue. Poll `analysisStatus("sounds")`. */
  prepareSounds: protectedProcedure.input(projectId).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return startSoundPreparation({ projectId: input.projectId, ownerId: ctx.user.id });
  }),

  /** Mutes, trims or re-tags one cue. The cue becomes the creator's, so re-planning keeps it. */
  updateSoundCue: protectedProcedure.input(z.object({
    projectId: z.string(),
    cueId: z.string(),
    enabled: z.boolean().optional(),
    gainDb: z.number().int().min(-18).max(6).optional(),
    tag: z.string().max(64).optional(),
  })).mutation(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    const [cue] = await db.select().from(bookxSoundCues)
      .where(and(eq(bookxSoundCues.id, input.cueId), eq(bookxSoundCues.projectId, input.projectId)))
      .limit(1);
    if (!cue) throw new TRPCError({ code: "NOT_FOUND", message: "Sound cue not found" });
    if (input.tag !== undefined && !isSoundTag(input.tag, cue.kind)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That sound is not in the sound library" });
    }
    const retag = input.tag !== undefined && input.tag !== cue.tag;
    await db.update(bookxSoundCues).set({
      ...(input.enabled === undefined ? {} : { enabled: input.enabled ? 1 : 0 }),
      ...(input.gainDb === undefined ? {} : { gainDb: input.gainDb }),
      ...(retag ? { tag: input.tag, assetId: null } : {}),
      source: "manual",
      updatedAt: new Date(),
    }).where(eq(bookxSoundCues.id, cue.id));
    return { success: true };
  }),

  /** One cue on its own, or mixed into the lines around it exactly as the export mixes it. */
  previewSoundCue: protectedProcedure.input(z.object({ projectId: z.string(), cueId: z.string(), inContext: z.boolean() })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    return previewSoundCue(db, { project, ownerId: ctx.user.id, cueId: input.cueId, inContext: input.inContext });
  }),

  /** A whole chapter mixed with its enabled cues. */
  previewChapterSound: protectedProcedure.input(z.object({ projectId: z.string(), chapterId: z.string() })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    return previewChapterSound(db, { project, ownerId: ctx.user.id, chapterId: input.chapterId });
  }),

  /** Rebuilds render units from chapter text, carrying over unchanged audio. */
  resegmentChapters: protectedProcedure.input(z.object({ projectId: z.string(), chapterIds: z.array(z.string()).max(500).optional() })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx.user.id, input.projectId);
    return ensureChapterSegments({ projectId: input.projectId, chapterIds: input.chapterIds, model: project.voiceModel });
  }),

  previewCharacterVoice: protectedProcedure.input(z.object({ projectId: z.string(), characterId: z.string(), provider: providerIdSchema, voiceId: z.string().min(1).max(160).optional(), model: z.string().max(160).optional() })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const [character] = await db.select().from(bookxCharacters).where(and(eq(bookxCharacters.id, input.characterId), eq(bookxCharacters.projectId, input.projectId))).limit(1);
    if (!character) throw new Error("Character not found");
    const plan = resolveNarrationPlan({ provider: input.provider, explicitVoiceId: input.voiceId, characterVoiceId: character.voiceId, requestedModel: input.model, projectModel: project.voiceModel });
    const voiceId = plan.voiceId;
    if (!voiceId) throw new Error("Assign a voice before generating a preview");
    const text = character.sampleLine?.trim();
    if (!text) throw new Error("Add a sample line before generating a preview");
    const generated = await synthesizeNarration({ projectId: input.projectId, provider: plan.provider, text, voiceId, model: plan.model, ownerId: ctx.user.id });
    await db.update(bookxCharacters).set({ previewStorageKey: generated.storageKey, updatedAt: new Date() }).where(eq(bookxCharacters.id, character.id));
    return { ...generated, characterId: character.id, voiceId };
  }),

  previewVoice: protectedProcedure.input(z.object({ projectId: z.string(), provider: providerIdSchema, voiceId: z.string().min(1).max(160), model: z.string().max(160).optional(), text: z.string().trim().min(1).max(600) })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx.user.id, input.projectId);
    const generated = await synthesizeNarration({ projectId: input.projectId, provider: input.provider, text: input.text, voiceId: input.voiceId, model: input.model || project.voiceModel, ownerId: ctx.user.id });
    return { ...generated, voiceId: input.voiceId };
  }),

  generateNarrationClip: protectedProcedure.input(z.object({ projectId: z.string(), segmentId: z.string().optional(), characterId: z.string().optional(), provider: providerIdSchema, text: z.string().min(1).max(4000), voiceId: z.string().max(160).optional(), model: z.string().max(160).optional() })).mutation(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.projectId);
    const [character] = input.characterId
      ? await db.select().from(bookxCharacters).where(and(eq(bookxCharacters.id, input.characterId), eq(bookxCharacters.projectId, input.projectId))).limit(1)
      : [];
    const plan = resolveNarrationPlan({ provider: input.provider, explicitVoiceId: input.voiceId, characterVoiceId: character?.voiceId, requestedModel: input.model, projectModel: project.voiceModel });
    const voiceId = plan.voiceId;
    if (input.segmentId) await requireSegment(db, input.projectId, input.segmentId);
    const jobId = nanoid();
    await db.insert(bookxGenerationJobs).values({ id: jobId, projectId: input.projectId, scope: "segment", status: "running", totalSegments: 1, completedSegments: 0 });
    try {
      const generated = await synthesizeNarration({ projectId: input.projectId, provider: plan.provider, text: input.text, voiceId, model: plan.model, ownerId: ctx.user.id });
      if (input.segmentId) await db.update(bookxSegments).set({ audioStorageKey: generated.storageKey, updatedAt: new Date() }).where(eq(bookxSegments.id, input.segmentId));
      await db.update(bookxGenerationJobs).set({ status: "completed", completedSegments: 1, updatedAt: new Date() }).where(eq(bookxGenerationJobs.id, jobId));
      return { jobId, characterId: input.characterId, voiceId, ...generated };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Narration failed";
      await db.update(bookxGenerationJobs).set({ status: "failed", failedSegments: 1, detail: { errors: [message] }, updatedAt: new Date() }).where(eq(bookxGenerationJobs.id, jobId));
      throw error;
    }
  }),

  transcribeAudioClip: protectedProcedure.input(z.object({ projectId: z.string(), provider: providerIdSchema, model: z.string().max(160).optional(), audioStorageKey: z.string().min(1).max(512), language: z.string().max(40).optional() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    const { projectId: _projectId, ...route } = input;
    return transcribeAudioRoute({ ...route, ownerId: ctx.user.id });
  }),

  /**
   * Assembles the chosen chapters into one file each, plus an optional file
   * for the whole book, in the chosen format.
   *
   * Chapters that are not fully narrated are simply not offered; only an
   * export with nothing finished (or a selection that includes an unfinished
   * chapter) is refused, with a specific reason.
   */
  requestExport: protectedProcedure.input(z.object({
    projectId: z.string(),
    chapterIds: z.array(z.string().max(32)).max(2_000).optional(),
    preset: z.enum(EXPORT_PRESET_IDS).optional(),
    output: exportOutputSchema.optional(),
    /** Older clients sent a distribution format; every one of them maps to the Spotify & ACX preset. */
    format: z.enum(["ACX", "Podcast", "InAudio package"]).optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return requestProjectExport({ projectId: input.projectId, ownerId: ctx.user.id, chapterIds: input.chapterIds, preset: input.preset, output: input.output });
  }),

  /** Every chapter with whether (and why) it can be exported, plus the book totals. */
  exportReadiness: protectedProcedure.input(projectId).query(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    const overview = await exportOverview({ projectId: input.projectId, ownerId: ctx.user.id });
    const readiness = readinessFrom(overview);
    return {
      ...overview,
      ready: readiness.ready,
      reason: readiness.ready ? null : readiness.reason,
      warnings: readiness.ready ? readiness.warnings : [],
      segments: overview.totalSegments,
      durationMs: overview.exportableDurationMs,
    };
  }),

  /** A download URL for the whole-book file (default) or one chapter file of a finished export. */
  exportDownloadUrl: protectedProcedure.input(z.object({ projectId: z.string(), exportId: z.string(), file: z.string().max(64).optional() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    return getExportDownloadUrl({ projectId: input.projectId, ownerId: ctx.user.id, exportId: input.exportId, file: input.file });
  }),

  /** Deletes a finished package and its files. */
  deleteExport: protectedProcedure.input(z.object({ projectId: z.string(), exportId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx.user.id, input.projectId);
    await deleteProjectExport({ projectId: input.projectId, ownerId: ctx.user.id, exportId: input.exportId });
    return { success: true };
  }),

  listExports: protectedProcedure.input(projectId).query(async ({ ctx, input }) => {
    const { db } = await requireProject(ctx.user.id, input.projectId);
    return db.select().from(bookxExports).where(eq(bookxExports.projectId, input.projectId)).orderBy(desc(bookxExports.createdAt));
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
    // Cues that used this sound get a fresh one the next time sounds are prepared.
    await db.update(bookxSoundCues).set({ assetId: null, updatedAt: new Date() }).where(and(eq(bookxSoundCues.assetId, input.assetId), eq(bookxSoundCues.projectId, input.projectId)));
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
    const rows = await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, ctx.user.id));
    return rows.map(redactProviderApiKey);
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
