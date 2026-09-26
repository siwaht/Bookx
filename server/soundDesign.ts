import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { bookxChapters, bookxProjects, bookxSegments, bookxSoundCues, bookxStudioAssets } from "../drizzle/schema";
import { AnalysisReporter, claimAnalysisJob, runWithConcurrency } from "./analysisJobs";
import { assembleAudio, type AssemblyPart } from "./audioAssembly";
import { forEachChunk, getDb, insertMany, projectChapterIds, selectInChunks } from "./db";
import { FfmpegUnavailableError, measureLoudness, resolveFfmpeg, runFfmpeg, withTempDir } from "./ffmpeg";
import { extractJson, languageModelText, resolveLanguageModel } from "./languageModel";
import { ensureChapterSegments, includedChapters } from "./narrationWorker";
import { getProviderApiKey } from "./providerCredentials";
import {
  SOUND_RECIPE_VERSION,
  SOUND_TAGS,
  builtinSoundArgs,
  soundTag,
  type SoundKind,
  type SoundLevel,
  type SoundSource,
  type SoundSourceSetting,
  type SoundTagDefinition,
} from "./soundLibrary";
import { mixTargetFor, mixUnderNarration, type MixTarget } from "./soundMixer";
import {
  cueStartMs,
  finalizeCuePlan,
  isSoundLevel,
  keywordProposals,
  layoutChapterCues,
  parseScenePlanReply,
  renderForScenePlanning,
  scenePlanSystemPrompt,
  scenePlanUserPrompt,
  type CueProposal,
  type PlanSegment,
  type PlannedCue,
} from "./soundPlan";
import { storageGetBuffer, storageGetSignedUrl, storagePut } from "./storage";
import { PAUSE_PARAGRAPH_MS, hashUnitTexts } from "./textSegmentation";

/**
 * Sound design: planning cues from the text, getting a sound for every cue,
 * and mixing them under the narration for previews and exports.
 *
 * Nothing here runs unless the creator turns background sounds or music on,
 * and every cue the creator touched (muted, trimmed, re-tagged) is marked
 * "manual" and survives re-planning.
 */

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ProjectRow = typeof bookxProjects.$inferSelect;
type SegmentRow = typeof bookxSegments.$inferSelect;
type CueRow = typeof bookxSoundCues.$inferSelect;
type AssetRow = typeof bookxStudioAssets.$inferSelect;
type Llm = NonNullable<Awaited<ReturnType<typeof resolveLanguageModel>>>;

const PLAN_CONCURRENCY = 3;

export const ELEVENLABS_SOUND_MODEL = "eleven_text_to_sound_v2";
const ELEVENLABS_PROMPT_INFLUENCE = 0.6;

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type SoundSettings = { effects: boolean; music: boolean; level: SoundLevel; source: SoundSourceSetting };

export function soundSettings(project: Pick<ProjectRow, "soundEffectsEnabled" | "backgroundMusicEnabled" | "soundLevel" | "soundSource">): SoundSettings {
  return {
    effects: Boolean(project.soundEffectsEnabled),
    music: Boolean(project.backgroundMusicEnabled),
    level: isSoundLevel(project.soundLevel) ? project.soundLevel : "very-subtle",
    source: project.soundSource === "elevenlabs" || project.soundSource === "builtin" ? project.soundSource : "auto",
  };
}

export const enabledKinds = (settings: SoundSettings): SoundKind[] => [
  ...(settings.effects ? (["sfx"] as const) : []),
  ...(settings.music ? (["music"] as const) : []),
];

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function toPlanSegments(segments: SegmentRow[]): PlanSegment[] {
  return segments.map(segment => ({
    id: segment.id,
    text: segment.text,
    kind: segment.delivery?.kind,
    paragraph: segment.delivery?.paragraph,
    sceneBreakBefore: segment.delivery?.sceneBreakBefore,
  }));
}

async function proposeWithModel(llm: Llm, input: { bookTitle: string; chapterTitle: string; segments: PlanSegment[]; ownerId: number }): Promise<CueProposal[]> {
  const system = scenePlanSystemPrompt();
  const proposals: CueProposal[] = [];
  for (const chunk of renderForScenePlanning(input.segments)) {
    const reply = await languageModelText({
      provider: llm.provider,
      model: llm.model,
      system,
      text: scenePlanUserPrompt({ bookTitle: input.bookTitle, chapterTitle: input.chapterTitle, chunk, total: input.segments.length }),
      ownerId: input.ownerId,
      reasoningEffort: "low",
    });
    proposals.push(...parseScenePlanReply(extractJson(reply, "sound plan"), chunk));
  }
  return proposals;
}

/** Replaces a chapter's planned cues. Cues the creator touched are kept, and win over a new plan. */
async function writeChapterPlan(db: Db, input: { projectId: string; chapterId: string; segments: SegmentRow[]; planned: PlannedCue[]; source: "llm" | "keyword" }): Promise<number> {
  const existing = await db.select().from(bookxSoundCues).where(eq(bookxSoundCues.chapterId, input.chapterId));
  const kept = existing.filter(cue => cue.source === "manual");
  const replaced = existing.filter(cue => cue.source !== "manual").map(cue => cue.id);
  await forEachChunk(replaced, part => db.delete(bookxSoundCues).where(inArray(bookxSoundCues.id, part)));

  const taken = new Set(kept.map(cue => `${cue.segmentId}:${cue.kind}`));
  const rows = input.planned
    .filter(cue => !taken.has(`${input.segments[cue.index]!.id}:${cue.kind}`))
    .map(cue => ({
      id: nanoid(),
      projectId: input.projectId,
      chapterId: input.chapterId,
      segmentId: input.segments[cue.index]!.id,
      kind: cue.kind,
      tag: cue.tag,
      placement: cue.placement,
      source: input.source,
      enabled: 1,
      gainDb: 0,
    }));
  await insertMany(db, bookxSoundCues, rows);
  await db
    .update(bookxChapters)
    .set({ sceneHash: hashUnitTexts(input.segments.map(segment => segment.text)), updatedAt: new Date() })
    .where(eq(bookxChapters.id, input.chapterId));
  return rows.length;
}

async function loadChapterSegments(db: Db, chapterIds: string[]): Promise<Map<string, SegmentRow[]>> {
  const byChapter = new Map<string, SegmentRow[]>();
  if (!chapterIds.length) return byChapter;
  const rows = (await selectInChunks(chapterIds, part => db.select().from(bookxSegments).where(inArray(bookxSegments.chapterId, part))))
    .sort((left, right) => left.orderIndex - right.orderIndex);
  for (const row of rows) {
    const list = byChapter.get(row.chapterId) ?? [];
    list.push(row);
    byChapter.set(row.chapterId, list);
  }
  return byChapter;
}

async function runScenePlan(jobId: string, input: { projectId: string; ownerId: number; replan?: boolean }): Promise<void> {
  const db = await requireDb();
  const reporter = await AnalysisReporter.open(jobId);
  try {
    const [project] = await db.select().from(bookxProjects).where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId))).limit(1);
    if (!project) throw new Error("Project not found");

    await reporter.start(2, "Splitting chapters into lines");
    await ensureChapterSegments({ projectId: input.projectId, model: project.voiceModel });
    const chapters = await includedChapters(db, input.projectId);
    const byChapter = await loadChapterSegments(db, chapters.map(chapter => chapter.id));
    const withText = chapters.filter(chapter => byChapter.get(chapter.id)?.length);
    if (!withText.length) {
      await reporter.finish("failed", "No chapters are selected for the audiobook yet. Import or write the manuscript first.");
      return;
    }
    const toPlan = withText.filter(chapter => input.replan || chapter.sceneHash !== hashUnitTexts(byChapter.get(chapter.id)!.map(segment => segment.text)));
    const kinds = enabledKinds(soundSettings(project));
    await reporter.setTotal(toPlan.length + 1);

    const llm = toPlan.length ? await resolveLanguageModel({ ownerId: input.ownerId, provider: project.languageModelProvider, model: project.languageModel }) : null;
    if (toPlan.length && !llm) {
      await reporter.event("warning", "No language model is connected, so sounds were placed by keyword rules and each scene's mood was read from its wording.");
    }

    let completed = 0;
    let planned = 0;
    let modelChapters = 0;
    await runWithConcurrency(toPlan, llm ? PLAN_CONCURRENCY : 1, async chapter => {
      if (await reporter.cancelled()) return;
      const own = byChapter.get(chapter.id)!;
      const segments = toPlanSegments(own);
      let proposals: CueProposal[];
      let source: "llm" | "keyword" = "keyword";
      if (llm) {
        try {
          proposals = await proposeWithModel(llm, { bookTitle: project.title, chapterTitle: chapter.title, segments, ownerId: input.ownerId });
          source = "llm";
          modelChapters++;
        } catch (error) {
          proposals = keywordProposals(segments);
          await reporter.event("warning", `${chapter.title}: the model could not read the scenes (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}); used keyword rules.`);
        }
      } else {
        proposals = keywordProposals(segments);
      }
      planned += await writeChapterPlan(db, { projectId: input.projectId, chapterId: chapter.id, segments: own, planned: finalizeCuePlan(segments, proposals), source });
      completed++;
      await reporter.progress(completed, `Planned ${completed} of ${toPlan.length} chapter${toPlan.length === 1 ? "" : "s"} (${chapter.title})`);
    });
    reporter.setSummary({ chaptersPlanned: completed, cuesPlanned: planned, modelChapters });

    if (await reporter.cancelled()) {
      await reporter.finish("cancelled", `Stopped after ${completed} chapter(s). Planned chapters keep their cues.`);
      return;
    }

    let soundsLine = "Turn on background sounds or music to hear them.";
    if (kinds.length) {
      await reporter.progress(toPlan.length, "Preparing the sounds");
      // The plan is saved either way; a sound that cannot be made yet is
      // reported, not allowed to fail the planning run.
      try {
        const assets = await ensureCueAssets(db, { project, ownerId: input.ownerId, kinds, reporter });
        reporter.setSummary({ soundsGenerated: assets.generated, soundsReused: assets.reused, soundsFailed: assets.failed.length });
        for (const failure of assets.failed) await reporter.event("warning", failure);
        soundsLine = assets.failed.length
          ? `${assets.failed.length} sound(s) could not be prepared.`
          : "The sounds are ready.";
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        await reporter.event("warning", `Sounds could not be prepared: ${message}`);
        soundsLine = `Sounds could not be prepared: ${message}`;
      }
    }

    const cueCount = await countCues(db, input.projectId, chapters.map(chapter => chapter.id));
    await reporter.progress(toPlan.length + 1, "Done");
    await reporter.finish(
      "completed",
      toPlan.length
        ? `Planned ${completed} chapter${completed === 1 ? "" : "s"}: ${cueCount.sfx} sound effect${cueCount.sfx === 1 ? "" : "s"} and ${cueCount.music} music swell${cueCount.music === 1 ? "" : "s"}. ${soundsLine}`
        : `Every chapter was already planned. ${soundsLine}`,
    );
  } catch (error) {
    console.error("[Sound] Scene planning failed:", error);
    await reporter.finish("failed", error instanceof Error ? error.message : "Scene planning failed").catch(() => reporter.release());
  }
}

async function countCues(db: Db, projectId: string, chapterIds: string[]): Promise<{ sfx: number; music: number }> {
  if (!chapterIds.length) return { sfx: 0, music: 0 };
  const rows = await selectInChunks(chapterIds, part => db
    .select({ kind: bookxSoundCues.kind })
    .from(bookxSoundCues)
    .where(and(eq(bookxSoundCues.projectId, projectId), eq(bookxSoundCues.enabled, 1), inArray(bookxSoundCues.chapterId, part))));
  return { sfx: rows.filter(row => row.kind === "sfx").length, music: rows.filter(row => row.kind === "music").length };
}

/** Plans cues for every chapter that has none or has changed since. Poll `analysisStatus("scenes")`. */
export async function startScenePlan(input: { projectId: string; ownerId: number; replan?: boolean }): Promise<{ jobId: string; reused: boolean }> {
  const claimed = await claimAnalysisJob(input.projectId, "scenes", "Queued: reading the scenes");
  if (!claimed.reused) void runScenePlan(claimed.jobId, input).catch(error => console.error("[Sound] Scene planning crashed:", error));
  return claimed;
}

// ---------------------------------------------------------------------------
// Sounds for cues
// ---------------------------------------------------------------------------

/** Identity of a generated sound; the same identity is never paid for twice. */
export function soundPromptHash(source: SoundSource, definition: SoundTagDefinition): string {
  const recipe = source === "builtin"
    ? JSON.stringify(definition.synth)
    : `${definition.prompt}|${ELEVENLABS_SOUND_MODEL}|${ELEVENLABS_PROMPT_INFLUENCE}`;
  return createHash("sha256").update([source, definition.tag, recipe, definition.durationSeconds, SOUND_RECIPE_VERSION].join("|")).digest("hex");
}

class SoundGenerationError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
    this.name = "SoundGenerationError";
  }
}

async function generateWithElevenLabs(apiKey: string, definition: SoundTagDefinition): Promise<Buffer> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({
          text: definition.prompt,
          duration_seconds: Math.min(30, Math.max(0.5, definition.durationSeconds)),
          prompt_influence: ELEVENLABS_PROMPT_INFLUENCE,
          model_id: ELEVENLABS_SOUND_MODEL,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 1_000) throw new SoundGenerationError("ElevenLabs returned an empty sound", false);
        return buffer;
      }
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      // Bad key, no credits, no access: retrying cannot help, and neither can
      // asking again for the next tag.
      if ([400, 401, 402, 403].includes(response.status)) {
        throw new SoundGenerationError(`ElevenLabs refused the request (HTTP ${response.status}${detail ? `: ${detail}` : ""})`, true);
      }
      lastError = new SoundGenerationError(`ElevenLabs sound generation failed with HTTP ${response.status}`, false);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      if (error instanceof SoundGenerationError && (error.fatal || attempt === 3)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise(resolve => setTimeout(resolve, 1_500 * attempt));
  }
  throw lastError ?? new Error("ElevenLabs sound generation failed");
}

async function synthesizeBuiltin(definition: SoundTagDefinition): Promise<Buffer> {
  return withTempDir(async dir => {
    const output = path.join(dir, `${definition.tag}.mp3`);
    await runFfmpeg(builtinSoundArgs(definition, output), { timeoutMs: 60_000 });
    return readFile(output);
  });
}

async function storeAsset(db: Db, input: {
  projectId: string;
  definition: SoundTagDefinition;
  source: SoundSource;
  hash: string;
  buffer: Buffer;
  measured?: { meanDb: number; peakDb: number; durationMs: number };
}): Promise<AssetRow> {
  const measured = input.measured ?? await withTempDir(async dir => {
    const file = path.join(dir, "sound.mp3");
    await writeFile(file, input.buffer);
    return measureLoudness(file);
  });
  if (measured.durationMs < 200 || measured.meanDb <= -80) throw new Error(`${input.definition.label}: the generated sound is silent`);
  const stored = await storagePut(`bookx/${input.projectId}/sound/${input.definition.tag}-${input.hash.slice(0, 8)}.mp3`, input.buffer, "audio/mpeg");
  const row = {
    id: nanoid(),
    projectId: input.projectId,
    type: input.definition.kind === "music" ? ("music" as const) : ("sound-effect" as const),
    title: `${input.definition.label} (${input.source === "elevenlabs" ? "ElevenLabs" : "built-in"})`,
    storageKey: stored.key,
    durationMs: measured.durationMs,
    promptHash: input.hash,
    tag: input.definition.tag,
    source: input.source,
    meanVolumeDb: Math.round(measured.meanDb),
    peakVolumeDb: Math.round(measured.peakDb),
  };
  await db.insert(bookxStudioAssets).values(row);
  const [inserted] = await db.select().from(bookxStudioAssets).where(eq(bookxStudioAssets.id, row.id)).limit(1);
  return inserted!;
}

/** This project's copy of a sound: reused, copied from another of the owner's books, or made. */
async function obtainAsset(db: Db, input: { projectId: string; ownerId: number; definition: SoundTagDefinition; source: SoundSource; apiKey: string | null }): Promise<{ asset: AssetRow; fresh: boolean }> {
  const hash = soundPromptHash(input.source, input.definition);
  const [own] = await db.select().from(bookxStudioAssets)
    .where(and(eq(bookxStudioAssets.projectId, input.projectId), eq(bookxStudioAssets.promptHash, hash)))
    .limit(1);
  if (own?.storageKey) return { asset: own, fresh: false };

  // Copied rather than shared, so deleting the other book never breaks this one.
  const [shared] = await db.select({ asset: bookxStudioAssets }).from(bookxStudioAssets)
    .innerJoin(bookxProjects, eq(bookxProjects.id, bookxStudioAssets.projectId))
    .where(and(eq(bookxStudioAssets.promptHash, hash), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (shared?.asset.storageKey) {
    try {
      const buffer = await storageGetBuffer(shared.asset.storageKey, { timeoutMs: 30_000 });
      const asset = await storeAsset(db, {
        projectId: input.projectId, definition: input.definition, source: input.source, hash, buffer,
        measured: shared.asset.meanVolumeDb === null || shared.asset.peakVolumeDb === null
          ? undefined
          : { meanDb: shared.asset.meanVolumeDb, peakDb: shared.asset.peakVolumeDb, durationMs: shared.asset.durationMs },
      });
      return { asset, fresh: false };
    } catch {
      // The other copy is unreadable; make a new one.
    }
  }

  if (input.source === "elevenlabs" && !input.apiKey) throw new SoundGenerationError("No ElevenLabs API key is connected", true);
  const buffer = input.source === "elevenlabs" ? await generateWithElevenLabs(input.apiKey!, input.definition) : await synthesizeBuiltin(input.definition);
  return { asset: await storeAsset(db, { projectId: input.projectId, definition: input.definition, source: input.source, hash, buffer }), fresh: true };
}

export type AssetReport = { generated: number; reused: number; failed: string[]; fellBack: boolean };

/**
 * Makes sure every cue in scope has a sound, generating each distinct tag once.
 *
 * In "auto" mode ElevenLabs is used when a key is connected; if it refuses
 * (bad key, no credits) the run switches to the built-in sounds instead of
 * failing, and an existing ElevenLabs sound is never downgraded.
 */
export async function ensureCueAssets(db: Db, input: {
  project: ProjectRow;
  ownerId: number;
  kinds: SoundKind[];
  chapterIds?: string[];
  cueIds?: string[];
  reporter?: AnalysisReporter;
}): Promise<AssetReport> {
  const report: AssetReport = { generated: 0, reused: 0, failed: [], fellBack: false };
  if (!input.kinds.length) return report;
  if (!(await resolveFfmpeg())) throw new FfmpegUnavailableError();

  const settings = soundSettings(input.project);
  const chapterIds = input.chapterIds ?? (await includedChapters(db, input.project.id)).map(chapter => chapter.id);
  if (!chapterIds.length) return report;

  const cueIds = input.cueIds ? new Set(input.cueIds) : null;
  const cues = (await selectInChunks(chapterIds, part => db.select().from(bookxSoundCues).where(and(
    eq(bookxSoundCues.projectId, input.project.id),
    inArray(bookxSoundCues.kind, input.kinds),
    inArray(bookxSoundCues.chapterId, part),
    // Muted cues get a sound once they are unmuted, not before.
    ...(cueIds ? [] : [eq(bookxSoundCues.enabled, 1)]),
  ))))
    .filter(cue => !cueIds || cueIds.has(cue.id));
  if (!cues.length) return report;

  const assetIds = [...new Set(cues.map(cue => cue.assetId).filter((id): id is string => Boolean(id)))];
  const assets = await projectAssets(db, input.project.id, assetIds);
  const assetById = new Map(assets.map(asset => [asset.id, asset]));

  const apiKey = settings.source === "builtin" ? null : await getProviderApiKey("ElevenLabs", input.ownerId);
  if (settings.source === "elevenlabs" && !apiKey) {
    throw new Error("The sound source is ElevenLabs, but no ElevenLabs API key is connected. Add one in Settings or switch the source to Auto or Built-in.");
  }
  let elevenLabsUsable = Boolean(apiKey);

  const byTag = new Map<string, CueRow[]>();
  for (const cue of cues) byTag.set(cue.tag, [...(byTag.get(cue.tag) ?? []), cue]);

  for (const [tag, tagCues] of byTag) {
    const definition = soundTag(tag);
    if (!definition) {
      report.failed.push(`"${tag}" is not a known sound`);
      continue;
    }
    const wanted: SoundSource = elevenLabsUsable ? "elevenlabs" : "builtin";
    const linked = new Set(tagCues.map(cue => cue.assetId));
    const current = tagCues[0]!.assetId ? assetById.get(tagCues[0]!.assetId) : undefined;
    const satisfies = (asset: AssetRow | undefined) =>
      Boolean(asset?.storageKey) &&
      (asset!.promptHash === soundPromptHash(wanted, definition) || (settings.source === "auto" && asset!.source === "elevenlabs"));
    if (linked.size === 1 && satisfies(current)) continue;

    let obtained: { asset: AssetRow; fresh: boolean } | null = null;
    try {
      obtained = await obtainAsset(db, { projectId: input.project.id, ownerId: input.ownerId, definition, source: wanted, apiKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (wanted === "elevenlabs" && settings.source === "auto") {
        if (!(error instanceof SoundGenerationError) || error.fatal) elevenLabsUsable = false;
        report.fellBack = true;
        await input.reporter?.event("warning", `${definition.label}: ElevenLabs could not make it (${message.slice(0, 140)}); used the built-in sound.`);
        try {
          obtained = await obtainAsset(db, { projectId: input.project.id, ownerId: input.ownerId, definition, source: "builtin", apiKey: null });
        } catch (inner) {
          report.failed.push(`${definition.label}: ${inner instanceof Error ? inner.message : "could not be made"}`);
        }
      } else {
        report.failed.push(`${definition.label}: ${message}`);
      }
    }
    if (!obtained) continue;
    await db.update(bookxSoundCues).set({ assetId: obtained.asset.id, updatedAt: new Date() })
      .where(and(eq(bookxSoundCues.projectId, input.project.id), eq(bookxSoundCues.tag, tag)));
    assetById.set(obtained.asset.id, obtained.asset);
    if (obtained.fresh) report.generated++;
    else report.reused++;
  }
  return report;
}

async function runSoundPreparation(jobId: string, input: { projectId: string; ownerId: number }): Promise<void> {
  const db = await requireDb();
  const reporter = await AnalysisReporter.open(jobId);
  try {
    const [project] = await db.select().from(bookxProjects).where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId))).limit(1);
    if (!project) throw new Error("Project not found");
    const kinds = enabledKinds(soundSettings(project));
    await reporter.start(1, "Preparing the sounds");
    if (!kinds.length) {
      await reporter.finish("completed", "Background sounds and music are both off, so there is nothing to prepare.");
      return;
    }
    const assets = await ensureCueAssets(db, { project, ownerId: input.ownerId, kinds, reporter });
    for (const failure of assets.failed) await reporter.event("warning", failure);
    reporter.setSummary({ soundsGenerated: assets.generated, soundsReused: assets.reused, soundsFailed: assets.failed.length });
    await reporter.progress(1, "Done");
    await reporter.finish(
      assets.failed.length && !assets.generated && !assets.reused ? "failed" : "completed",
      assets.failed.length
        ? `${assets.failed.length} sound(s) could not be prepared: ${assets.failed[0]}`
        : `${assets.generated} new sound${assets.generated === 1 ? "" : "s"} made, ${assets.reused} reused.`,
    );
  } catch (error) {
    console.error("[Sound] Preparation failed:", error);
    await reporter.finish("failed", error instanceof Error ? error.message : "Sound preparation failed").catch(() => reporter.release());
  }
}

/** Generates (or reuses) a sound for every enabled cue. Poll `analysisStatus("sounds")`. */
export async function startSoundPreparation(input: { projectId: string; ownerId: number }): Promise<{ jobId: string; reused: boolean }> {
  const claimed = await claimAnalysisJob(input.projectId, "sounds", "Queued: preparing the sounds");
  if (!claimed.reused) void runSoundPreparation(claimed.jobId, input).catch(error => console.error("[Sound] Preparation crashed:", error));
  return claimed;
}

// ---------------------------------------------------------------------------
// Mixing
// ---------------------------------------------------------------------------

export type CueWithSound = { cue: CueRow; asset: AssetRow; audio: Buffer };

export type ChapterPart = AssemblyPart & { segmentId: string };

/**
 * Assembles a chapter with room around its cues, then mixes the cues under it.
 * Cues whose anchor line is not in `parts` are ignored.
 */
export async function assembleAndMixChapter(input: {
  parts: ChapterPart[];
  cues: CueWithSound[];
  level: SoundLevel;
  defaultGapMs: number;
  target?: MixTarget;
}): Promise<{ buffer: Buffer; container: "mp3" | "wav"; mimeType: string; durationMs: number; mixedCues: number; target: MixTarget }> {
  const indexOf = new Map(input.parts.map((part, index) => [part.segmentId, index]));
  const placed = input.cues
    .map(entry => ({ entry, index: indexOf.get(entry.cue.segmentId) }))
    .filter((item): item is { entry: CueWithSound; index: number } => item.index !== undefined);
  const layout = layoutChapterCues(
    input.parts.map(part => part.gapAfterMs),
    placed.map(item => ({ index: item.index, kind: item.entry.cue.kind, placement: item.entry.cue.placement })),
    input.defaultGapMs,
  );
  const assembled = assembleAudio(
    input.parts.map((part, index) => ({ buffer: part.buffer, label: part.label, gapAfterMs: layout.gaps[index] })),
    { gapMs: input.defaultGapMs, leadInMs: layout.leadInMs },
  );
  const target = input.target ?? mixTargetFor(assembled.buffer);
  const mixed = await mixUnderNarration({
    voice: assembled.buffer,
    voiceDurationMs: assembled.durationMs,
    level: input.level,
    target,
    tailMs: layout.tailMs,
    cues: placed.map(({ entry, index }) => ({
      audio: entry.audio,
      startMs: cueStartMs(assembled.marks[index]!, entry.cue),
      kind: entry.cue.kind,
      tag: entry.cue.tag,
      assetDurationMs: entry.asset.durationMs,
      assetMeanDb: entry.asset.meanVolumeDb,
      assetPeakDb: entry.asset.peakVolumeDb,
      trimDb: entry.cue.gainDb,
    })),
  });
  return { buffer: mixed.buffer, container: mixed.container, mimeType: mixed.mimeType, durationMs: mixed.durationMs, mixedCues: placed.length, target };
}

/** The project's copies of these sounds. */
async function projectAssets(db: Db, projectId: string, assetIds: string[]): Promise<AssetRow[]> {
  return selectInChunks(assetIds, part => db.select().from(bookxStudioAssets).where(and(eq(bookxStudioAssets.projectId, projectId), inArray(bookxStudioAssets.id, part))));
}

async function loadCueSounds(db: Db, projectId: string, cues: CueRow[]): Promise<CueWithSound[]> {
  const assetIds = [...new Set(cues.map(cue => cue.assetId).filter((id): id is string => Boolean(id)))];
  const assets = await projectAssets(db, projectId, assetIds);
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const audio = new Map<string, Buffer>();
  for (const asset of assets) {
    if (asset.storageKey) audio.set(asset.id, await storageGetBuffer(asset.storageKey, { timeoutMs: 60_000 }));
  }
  const missing = cues.filter(cue => !cue.assetId || !audio.has(cue.assetId));
  if (missing.length) {
    const labels = [...new Set(missing.map(cue => soundTag(cue.tag)?.label ?? cue.tag))].slice(0, 4).join(", ");
    throw new Error(`${missing.length} sound cue(s) have no sound yet (${labels}). Prepare the sounds in Audio studio, or turn sound design off to export narration only.`);
  }
  return cues.map(cue => ({ cue, asset: assetById.get(cue.assetId!)!, audio: audio.get(cue.assetId!)! }));
}

export type ExportSoundDesign = {
  settings: SoundSettings;
  cuesByChapter: Map<string, CueWithSound[]>;
  cueCount: number;
};

/**
 * Everything an export needs to mix, or null when sound design is off (or on
 * but nothing is planned to play), in which case the export stays lossless.
 */
export async function prepareExportSoundDesign(db: Db, input: { project: ProjectRow; ownerId: number; chapterIds: string[] }): Promise<ExportSoundDesign | null> {
  const settings = soundSettings(input.project);
  const kinds = enabledKinds(settings);
  if (!kinds.length || !input.chapterIds.length) return null;
  const load = () => selectInChunks(input.chapterIds, part => db.select().from(bookxSoundCues).where(and(
    eq(bookxSoundCues.projectId, input.project.id),
    eq(bookxSoundCues.enabled, 1),
    inArray(bookxSoundCues.kind, kinds),
    inArray(bookxSoundCues.chapterId, part),
  )));
  if (!(await load()).length) return null;

  const report = await ensureCueAssets(db, { project: input.project, ownerId: input.ownerId, kinds, chapterIds: input.chapterIds });
  if (report.failed.length) {
    throw new Error(`Sound design: ${report.failed.slice(0, 3).join("; ")}. Switch the sound source, or turn sound design off to export narration only.`);
  }
  const withSounds = await loadCueSounds(db, input.project.id, await load());
  const cuesByChapter = new Map<string, CueWithSound[]>();
  for (const entry of withSounds) cuesByChapter.set(entry.cue.chapterId, [...(cuesByChapter.get(entry.cue.chapterId) ?? []), entry]);
  return { settings, cuesByChapter, cueCount: withSounds.length };
}

/** Whether an export with the current sound settings can succeed, and why not. */
export async function soundDesignReadiness(db: Db, project: ProjectRow, ownerId: number): Promise<{ ready: true } | { ready: false; reason: string }> {
  const settings = soundSettings(project);
  if (!enabledKinds(settings).length) return { ready: true };
  if (!(await resolveFfmpeg())) {
    return { ready: false, reason: "Background sounds and music need ffmpeg on the server to mix. Install it (or set FFMPEG_PATH), or turn sound design off to export narration only." };
  }
  if (settings.source === "elevenlabs" && !(await getProviderApiKey("ElevenLabs", ownerId))) {
    return { ready: false, reason: "The sound source is ElevenLabs, but no ElevenLabs key is connected. Add one in Settings, or switch the sound source to Auto." };
  }
  const unplanned = (await includedChapters(db, project.id)).filter(chapter => chapter.totalSegments > 0 && !chapter.sceneHash);
  if (unplanned.length) {
    return {
      ready: false,
      reason: `Sound design is on, but ${unplanned.length} chapter${unplanned.length === 1 ? " has" : "s have"} no sound plan yet. Open Audio studio and choose Plan sounds, or turn background sounds and music off.`,
    };
  }
  return { ready: true };
}

// ---------------------------------------------------------------------------
// Studio screen
// ---------------------------------------------------------------------------

export async function soundDesignOverview(db: Db, project: ProjectRow, ownerId: number) {
  const settings = soundSettings(project);
  const chapters = await includedChapters(db, project.id);
  const byChapter = await loadChapterSegments(db, chapters.map(chapter => chapter.id));
  const cues = chapters.length
    ? await db.select().from(bookxSoundCues).where(and(eq(bookxSoundCues.projectId, project.id), inArray(bookxSoundCues.chapterId, projectChapterIds(db, project.id, { includedOnly: true }))))
    : [];
  const assetIds = [...new Set(cues.map(cue => cue.assetId).filter((id): id is string => Boolean(id)))];
  const assets = await projectAssets(db, project.id, assetIds);
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const [ffmpeg, elevenLabsKey, llm] = await Promise.all([
    resolveFfmpeg(),
    getProviderApiKey("ElevenLabs", ownerId),
    resolveLanguageModel({ ownerId, provider: project.languageModelProvider, model: project.languageModel }).catch(() => null),
  ]);

  const chapterViews = chapters.map(chapter => {
    const segments = byChapter.get(chapter.id) ?? [];
    const position = new Map(segments.map((segment, index) => [segment.id, index]));
    const hash = segments.length ? hashUnitTexts(segments.map(segment => segment.text)) : null;
    const own = cues
      .filter(cue => cue.chapterId === chapter.id && position.has(cue.segmentId))
      .sort((left, right) => position.get(left.segmentId)! - position.get(right.segmentId)! || (left.kind === "music" ? -1 : 1));
    return {
      id: chapter.id,
      title: chapter.title,
      segments: segments.length,
      rendered: segments.filter(segment => segment.audioStorageKey).length,
      planned: Boolean(chapter.sceneHash),
      stale: Boolean(chapter.sceneHash && hash && chapter.sceneHash !== hash),
      cues: own.map(cue => {
        const index = position.get(cue.segmentId)!;
        const asset = cue.assetId ? assetById.get(cue.assetId) : undefined;
        // Same window as `previewSoundCue`: the line before, the anchor, the line after.
        const neighbours = [index - 1, index, index + 1];
        return {
          id: cue.id,
          kind: cue.kind,
          tag: cue.tag,
          label: soundTag(cue.tag)?.label ?? cue.tag,
          placement: cue.placement,
          source: cue.source,
          enabled: Boolean(cue.enabled),
          gainDb: cue.gainDb,
          segmentIndex: index,
          anchorText: segments[index]!.text.replace(/\s+/g, " ").slice(0, 220),
          // A preview in context needs the lines around the cue rendered.
          contextReady: neighbours.filter(value => value >= 0 && value < segments.length).every(value => Boolean(segments[value]!.audioStorageKey)),
          sound: asset?.storageKey ? { source: asset.source ?? "builtin", durationMs: asset.durationMs } : null,
        };
      }),
    };
  });

  const all = chapterViews.flatMap(chapter => chapter.cues);
  const kinds = enabledKinds(settings);
  return {
    settings,
    availability: { ffmpeg: Boolean(ffmpeg), elevenLabs: Boolean(elevenLabsKey), languageModel: llm ? `${llm.model}` : null },
    chapters: chapterViews,
    tags: SOUND_TAGS.map(definition => ({ tag: definition.tag, kind: definition.kind, label: definition.label })),
    totals: {
      cues: all.length,
      enabled: all.filter(cue => cue.enabled).length,
      sfx: all.filter(cue => cue.kind === "sfx" && cue.enabled).length,
      music: all.filter(cue => cue.kind === "music" && cue.enabled).length,
      unplannedChapters: chapterViews.filter(chapter => chapter.segments > 0 && !chapter.planned).length,
      staleChapters: chapterViews.filter(chapter => chapter.stale).length,
      missingSounds: all.filter(cue => cue.enabled && kinds.includes(cue.kind) && !cue.sound).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/**
 * Mixed previews by a hash of everything that shapes them, so pressing Listen
 * again reuses the stored mix instead of storing another copy. Every stored
 * object gets a unique key, which is also why a changed mix never plays stale.
 */
const previewCache = new Map<string, { key: string; durationMs: number; cues: number }>();
const PREVIEW_CACHE_LIMIT = 200;

function previewHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function rememberPreview(hash: string, value: { key: string; durationMs: number; cues: number }) {
  previewCache.delete(hash);
  previewCache.set(hash, value);
  if (previewCache.size > PREVIEW_CACHE_LIMIT) previewCache.delete(previewCache.keys().next().value!);
}

const segmentFingerprint = (segments: SegmentRow[]) => segments.map(segment => [segment.id, segment.audioStorageKey, segment.delivery?.pauseMs ?? null]);
const cueFingerprint = (entry: CueWithSound) => [entry.cue.id, entry.cue.segmentId, entry.cue.tag, entry.cue.placement, entry.cue.gainDb, entry.asset.id];

async function requireCue(db: Db, projectId: string, cueId: string): Promise<CueRow> {
  const [cue] = await db.select().from(bookxSoundCues).where(and(eq(bookxSoundCues.id, cueId), eq(bookxSoundCues.projectId, projectId))).limit(1);
  if (!cue) throw new Error("Sound cue not found");
  return cue;
}

async function chapterParts(segments: SegmentRow[], title: string): Promise<ChapterPart[]> {
  const parts: ChapterPart[] = [];
  for (const [index, segment] of segments.entries()) {
    if (!segment.audioStorageKey) throw new Error(`${title}: line ${index + 1} has no narration yet. Render it on the Generate tab first.`);
    parts.push({
      segmentId: segment.id,
      buffer: await storageGetBuffer(segment.audioStorageKey, { timeoutMs: 60_000 }),
      label: `${title} · ${index + 1}`,
      gapAfterMs: segment.delivery?.pauseMs ?? PAUSE_PARAGRAPH_MS,
    });
  }
  return parts;
}

/**
 * Plays one cue: on its own, or mixed into the lines around it exactly as the
 * export would mix it.
 */
export async function previewSoundCue(db: Db, input: { project: ProjectRow; ownerId: number; cueId: string; inContext: boolean }): Promise<{ url: string; durationMs: number; inContext: boolean }> {
  let cue = await requireCue(db, input.project.id, input.cueId);
  const report = await ensureCueAssets(db, { project: input.project, ownerId: input.ownerId, kinds: [cue.kind], chapterIds: [cue.chapterId], cueIds: [cue.id] });
  if (report.failed.length) throw new Error(report.failed[0]!);
  cue = await requireCue(db, input.project.id, input.cueId);
  const [withSound] = await loadCueSounds(db, input.project.id, [cue]);

  if (!input.inContext) return { url: await storageGetSignedUrl(withSound!.asset.storageKey!), durationMs: withSound!.asset.durationMs, inContext: false };

  const [chapter] = await db.select().from(bookxChapters).where(eq(bookxChapters.id, cue.chapterId)).limit(1);
  const segments = (await loadChapterSegments(db, [cue.chapterId])).get(cue.chapterId) ?? [];
  const index = segments.findIndex(segment => segment.id === cue.segmentId);
  if (!chapter || index < 0) throw new Error("This cue's line is no longer in the chapter");
  const window = segments.slice(Math.max(0, index - 1), Math.min(segments.length, index + 2));
  if (window.some(segment => !segment.audioStorageKey)) {
    throw new Error("Render the narration around this line first (Generate tab). You can still play the sound on its own.");
  }
  const level = soundSettings(input.project).level;
  const hash = previewHash(["cue", level, cueFingerprint(withSound!), segmentFingerprint(window)]);
  const cached = previewCache.get(hash);
  if (cached) return { url: await storageGetSignedUrl(cached.key), durationMs: cached.durationMs, inContext: true };

  const mixed = await assembleAndMixChapter({
    parts: await chapterParts(window, chapter.title),
    cues: [withSound!],
    level,
    defaultGapMs: PAUSE_PARAGRAPH_MS,
  });
  const stored = await storagePut(`bookx/${input.project.id}/preview/cue-${cue.id}.${mixed.container}`, mixed.buffer, mixed.mimeType);
  rememberPreview(hash, { key: stored.key, durationMs: mixed.durationMs, cues: 1 });
  return { url: await storageGetSignedUrl(stored.key), durationMs: mixed.durationMs, inContext: true };
}

/** The whole chapter mixed with its enabled cues, as the export would produce it. */
export async function previewChapterSound(db: Db, input: { project: ProjectRow; ownerId: number; chapterId: string }): Promise<{ url: string; durationMs: number; cues: number }> {
  const settings = soundSettings(input.project);
  const kinds = enabledKinds(settings);
  if (!kinds.length) throw new Error("Turn on background sounds or background music to hear the chapter mix.");
  const [chapter] = await db.select().from(bookxChapters).where(and(eq(bookxChapters.id, input.chapterId), eq(bookxChapters.projectId, input.project.id))).limit(1);
  if (!chapter) throw new Error("Chapter not found");
  const segments = (await loadChapterSegments(db, [chapter.id])).get(chapter.id) ?? [];
  if (!segments.length) throw new Error("This chapter has no lines yet");

  const report = await ensureCueAssets(db, { project: input.project, ownerId: input.ownerId, kinds, chapterIds: [chapter.id] });
  if (report.failed.length) throw new Error(report.failed[0]!);
  const cues = await db.select().from(bookxSoundCues).where(and(
    eq(bookxSoundCues.chapterId, chapter.id),
    eq(bookxSoundCues.projectId, input.project.id),
    eq(bookxSoundCues.enabled, 1),
    inArray(bookxSoundCues.kind, kinds),
  ));
  const withSounds = await loadCueSounds(db, input.project.id, cues);
  const hash = previewHash(["chapter", chapter.id, settings.level, withSounds.map(cueFingerprint).sort(), segmentFingerprint(segments)]);
  const cached = previewCache.get(hash);
  if (cached) return { url: await storageGetSignedUrl(cached.key), durationMs: cached.durationMs, cues: cached.cues };

  const mixed = await assembleAndMixChapter({
    parts: await chapterParts(segments, chapter.title),
    cues: withSounds,
    level: settings.level,
    defaultGapMs: PAUSE_PARAGRAPH_MS,
  });
  const stored = await storagePut(`bookx/${input.project.id}/preview/chapter-${chapter.id}.${mixed.container}`, mixed.buffer, mixed.mimeType);
  rememberPreview(hash, { key: stored.key, durationMs: mixed.durationMs, cues: mixed.mixedCues });
  return { url: await storageGetSignedUrl(stored.key), durationMs: mixed.durationMs, cues: mixed.mixedCues };
}
