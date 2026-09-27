import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  bookxChapters,
  bookxCharacters,
  bookxExports,
  bookxProjects,
  bookxProviderSettings,
  bookxSegments,
  type ExportChapterFile,
  type ExportDetail,
} from "../drizzle/schema";
import {
  AUDIOBOOK_STANDARD,
  bookFileName,
  chapterFileName,
  describeOutput,
  isPassthrough,
  mimeTypeFor,
  presetById,
  type ExportOutput,
  type ExportPresetId,
} from "../shared/exportOptions";
import { getDb } from "./db";
import { assembleAudio, buildSilentMp3, scanMp3, scanWav, wavHeader } from "./audioAssembly";
import { bookMetadata, buildId3Tag, encodeChapter, joinBookFiles, measureBuffer, writeSilence } from "./exportEncoder";
import { measureNoiseFloor, resolveFfmpeg, withTempDir } from "./ffmpeg";
import {
  CLOSING_CREDITS_FILE_NAME,
  OPENING_CREDITS_FILE_NAME,
  RETAIL_SAMPLE_FILE_NAME,
  RETAIL_SAMPLE_MAX_MS,
  chapterHeaderText,
  closingCreditsText,
  openingCreditsText,
} from "../shared/audiobookExtras";
import { renderSegmentAudio } from "./ttsRender";
import { includedChapters, loadPlannableSegments } from "./narrationWorker";
import { chapterAudioStates, isExportableState, orderSegments, type ChapterAudioState, type ChapterAudioStatus, type PlannableSegment } from "./narrationPlan";
import { assembleAndMixChapter, enabledKinds, prepareExportSoundDesign, soundSettings, type ChapterPart, type ExportSoundDesign } from "./soundDesign";
import { describeTarget, pcmMixTarget, type MixTarget } from "./soundMixer";
import { storageDeletePrefix, storageDownloadUrl, storageGetBuffer, storagePut, storagePutFile } from "./storage";
import { exportZipPlan, type ZipEntry } from "../shared/exportZip";

/**
 * Turns rendered segments into deliverable files: one file per chapter, plus
 * an optional file for the whole book.
 *
 * An export covers the chapters that are done. A chapter still missing lines
 * is left out (and says why) rather than blocking the rest of the book, so a
 * creator can publish the chapters they rendered and skip the ones they chose
 * not to. Only an export with nothing finished at all is refused.
 */

/** Pause between paragraphs inside a chapter. */
const DEFAULT_SEGMENT_GAP_MS = 350;
/** Pause between chapters in the whole-book file, overridden by the saved provider preference. */
const DEFAULT_CHAPTER_GAP_MS = 2000;
/** Pause between a narrated chapter header and the chapter's first line. */
const HEADER_GAP_MS = 2500;
/** ACX's noise-floor ceiling, in dB RMS. */
const NOISE_FLOOR_MAX_DB = -60;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ProjectRow = typeof bookxProjects.$inferSelect;
type ChapterRow = typeof bookxChapters.$inferSelect;

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

async function requireOwnedProject(db: Db, projectId: string, ownerId: number): Promise<ProjectRow> {
  const [project] = await db
    .select()
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, projectId), eq(bookxProjects.ownerId, ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");
  return project;
}

/** Fetches one stored audio object. */
async function fetchStoredAudio(storageKey: string, label: string): Promise<Buffer> {
  let buffer: Buffer;
  try {
    buffer = await storageGetBuffer(storageKey, { timeoutMs: 60_000 });
  } catch (error) {
    throw new Error(`${label}: stored audio could not be read (${error instanceof Error ? error.message : "unknown error"})`);
  }
  if (!buffer.length) throw new Error(`${label}: stored audio is empty`);
  return buffer;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// What can be exported
// ---------------------------------------------------------------------------

export type ExportChapterView = {
  chapterId: string;
  title: string;
  /** 1-based position among the book's chapters. */
  position: number;
  state: ChapterAudioState;
  exportable: boolean;
  /** Why the chapter is not ready, or what exporting it as-is means. */
  reason: string | null;
  totalSegments: number;
  segmentsWithAudio: number;
  durationMs: number;
  /** Whether sounds were planned for it; null when sound design is off. */
  soundPlanned: boolean | null;
};

export type ExportOverview = {
  chapters: ExportChapterView[];
  totalSegments: number;
  exportableChapters: number;
  readyChapters: number;
  exportableDurationMs: number;
  soundDesign: { effects: boolean; music: boolean; level: string };
  ffmpeg: boolean;
};

export function chapterReason(status: ChapterAudioStatus): string | null {
  switch (status.state) {
    case "ready":
      return null;
    case "empty":
      return "This chapter has no text to narrate.";
    case "unrendered":
      return "Not narrated yet.";
    case "partial":
      return `${status.segmentsWithAudio} of ${plural(status.totalSegments, "line")} narrated. Finish it on the Generate tab to include it.`;
    case "outdated": {
      const notes = [
        status.stale ? `${plural(status.stale, "line")} edited since narration` : null,
        status.mismatchedVoice ? `${plural(status.mismatchedVoice, "line")} in a different voice` : null,
        status.unverified ? `${plural(status.unverified, "line")} never verified` : null,
      ].filter(Boolean);
      return `Exports with the audio it has (${notes.join(", ")}). Re-render it to update.`;
    }
  }
}

/** Measured duration per segment; `null` means "has audio that was never measured". */
async function segmentDurations(db: Db, projectId: string): Promise<Map<string, number | null>> {
  const rows = await db
    .select({ id: bookxSegments.id, audioDurationMs: bookxSegments.audioDurationMs, audioStorageKey: bookxSegments.audioStorageKey })
    .from(bookxSegments)
    .innerJoin(bookxChapters, eq(bookxChapters.id, bookxSegments.chapterId))
    .where(and(eq(bookxChapters.projectId, projectId), eq(bookxChapters.included, 1)));
  return new Map(rows.map(row => [row.id, row.audioStorageKey ? row.audioDurationMs ?? null : 0]));
}

async function chapterStatuses(db: Db, project: ProjectRow): Promise<{ chapters: ChapterRow[]; statuses: Map<string, ChapterAudioStatus>; segments: PlannableSegment[] }> {
  const chapters = await includedChapters(db, project.id);
  const segments = chapters.length ? await loadPlannableSegments(project.id) : [];
  const statuses = chapterAudioStates(
    segments,
    { provider: project.voiceProvider, model: project.voiceModel },
    await segmentDurations(db, project.id),
    chapters.map(chapter => chapter.id),
  );
  return { chapters, statuses, segments };
}

/** Every chapter of the book with whether (and why) it can go into an export. */
export async function exportOverview(input: { projectId: string; ownerId: number }): Promise<ExportOverview> {
  const db = await requireDb();
  const project = await requireOwnedProject(db, input.projectId, input.ownerId);
  const { chapters, statuses } = await chapterStatuses(db, project);
  const settings = soundSettings(project);
  const soundOn = enabledKinds(settings).length > 0;

  const views = chapters.map((chapter, index): ExportChapterView => {
    const status = statuses.get(chapter.id)!;
    return {
      chapterId: chapter.id,
      title: chapter.title,
      position: index + 1,
      state: status.state,
      exportable: isExportableState(status.state),
      reason: chapterReason(status),
      totalSegments: status.totalSegments,
      segmentsWithAudio: status.segmentsWithAudio,
      durationMs: status.durationMs,
      soundPlanned: soundOn ? Boolean(chapter.sceneHash) : null,
    };
  });
  const exportable = views.filter(view => view.exportable);
  return {
    chapters: views,
    totalSegments: views.reduce((total, view) => total + view.totalSegments, 0),
    exportableChapters: exportable.length,
    readyChapters: views.filter(view => view.state === "ready").length,
    exportableDurationMs: exportable.reduce((total, view) => total + view.durationMs, 0),
    soundDesign: { effects: settings.effects, music: settings.music, level: settings.level },
    ffmpeg: Boolean(await resolveFfmpeg()),
  };
}

export type ExportReadiness =
  | { ready: true; chapterIds: string[]; warnings: string[] }
  | { ready: false; reason: string };

/**
 * Whether an export of `chapterIds` (default: every chapter that is fully
 * narrated) can go ahead, with a specific reason when it cannot.
 */
export async function checkExportReadiness(input: { projectId: string; ownerId: number; chapterIds?: string[]; output?: ExportOutput }): Promise<ExportReadiness> {
  return readinessFrom(await exportOverview(input), input);
}

/** Readiness from an overview already in hand. Pure, so it can be tested directly. */
export function readinessFrom(overview: ExportOverview, input: { chapterIds?: string[]; output?: ExportOutput } = {}): ExportReadiness {
  if (!overview.totalSegments) {
    return { ready: false, reason: "There is no narration to export yet. Add chapter text and render it first." };
  }
  const byId = new Map(overview.chapters.map(chapter => [chapter.chapterId, chapter]));
  let selected: ExportChapterView[];
  if (input.chapterIds?.length) {
    const wanted = new Set(input.chapterIds);
    selected = overview.chapters.filter(chapter => wanted.has(chapter.chapterId));
    const unknown = input.chapterIds.filter(id => !byId.has(id));
    if (unknown.length) return { ready: false, reason: `${plural(unknown.length, "chapter")} in the selection are not part of this book any more. Refresh and choose again.` };
    const blocked = selected.find(chapter => !chapter.exportable);
    if (blocked) return { ready: false, reason: `"${blocked.title}" cannot be exported yet: ${blocked.reason ?? "it has no audio"}` };
  } else {
    selected = overview.chapters.filter(chapter => chapter.exportable);
  }
  if (!selected.length) {
    return {
      ready: false,
      reason: "No chapter is fully narrated yet, so there is no narration to export. Render at least one chapter on the Generate tab; chapters you leave unrendered are simply left out.",
    };
  }
  if (input.output && !isPassthrough(input.output) && !overview.ffmpeg) {
    return { ready: false, reason: `Encoding to ${describeOutput(input.output)} needs ffmpeg on the server. Choose "Original" to export without re-encoding, or install ffmpeg (or set FFMPEG_PATH).` };
  }

  const warnings: string[] = [];
  const outdated = selected.filter(chapter => chapter.state === "outdated");
  if (outdated.length) warnings.push(`${plural(outdated.length, "chapter")} will use audio from before later edits or voice changes.`);
  const unplanned = selected.filter(chapter => chapter.soundPlanned === false);
  if (unplanned.length) warnings.push(`${plural(unplanned.length, "chapter")} have no sound plan yet and will export without background sounds or music.`);
  const long = selected.filter(chapter => chapter.durationMs > AUDIOBOOK_STANDARD.maxFileMinutes * 60_000);
  if (long.length) warnings.push(`${plural(long.length, "chapter")} run past ${AUDIOBOOK_STANDARD.maxFileMinutes} minutes, the per-file limit some distributors (ACX) set.`);
  return { ready: true, chapterIds: selected.map(chapter => chapter.chapterId), warnings };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

type ChapterAudio = { buffer: Buffer; container: "mp3" | "wav"; durationMs: number; mixedCues: number };

async function chapterParts(chapter: ChapterRow, segments: PlannableSegment[]): Promise<ChapterPart[]> {
  const parts: ChapterPart[] = [];
  for (const [index, segment] of segments.entries()) {
    // The readiness check guarantees audio; a missing file here would otherwise
    // be silently skipped and shorten the chapter.
    if (!segment.audioStorageKey) throw new Error(`${chapter.title}: line ${index + 1} has no audio`);
    parts.push({
      segmentId: segment.id,
      buffer: await fetchStoredAudio(segment.audioStorageKey, `${chapter.title} line ${index + 1}`),
      label: `${chapter.title} · ${index + 1}`,
      // Dialogue sits closer to its tag than paragraphs sit to each other, and a
      // scene break leaves a longer breath.
      gapAfterMs: segment.pauseMs ?? DEFAULT_SEGMENT_GAP_MS,
    });
  }
  return parts;
}

/**
 * One chapter's narration, joined and (when sound design applies) mixed.
 *
 * For a passthrough export every chapter goes through the same path so all of
 * them share one format; otherwise a mix is written as lossless PCM so the
 * delivery encode is the only lossy step.
 */
async function buildChapterAudio(input: {
  chapter: ChapterRow;
  segments: PlannableSegment[];
  design: ExportSoundDesign | null;
  passthrough: boolean;
  sharedTarget: { value?: MixTarget };
}): Promise<ChapterAudio> {
  const parts = await chapterParts(input.chapter, input.segments);
  const cues = input.design?.cuesByChapter.get(input.chapter.id) ?? [];
  if (input.design && (input.passthrough || cues.length)) {
    const mixed = await assembleAndMixChapter({
      parts,
      cues,
      level: input.design.settings.level,
      defaultGapMs: DEFAULT_SEGMENT_GAP_MS,
      target: input.passthrough ? input.sharedTarget.value : pcmMixTarget(parts[0]!.buffer),
    });
    if (input.passthrough) input.sharedTarget.value = mixed.target;
    return mixed;
  }
  const assembled = assembleAudio(parts, { gapMs: DEFAULT_SEGMENT_GAP_MS });
  return { buffer: assembled.buffer, container: assembled.container, durationMs: assembled.durationMs, mixedCues: 0 };
}

/** Silence in exactly the format of a passthrough chapter, for the whole-book file. */
function passthroughSilence(sample: Buffer, container: "mp3" | "wav", ms: number): Buffer {
  if (container === "mp3") return buildSilentMp3(scanMp3(sample).format, ms);
  const { format } = scanWav(sample);
  const bytes = Math.floor(((ms / 1000) * format.byteRate) / Math.max(1, format.blockAlign)) * Math.max(1, format.blockAlign);
  return Buffer.concat([wavHeader(format, bytes), Buffer.alloc(bytes, format.bitsPerSample === 8 ? 0x80 : 0)]);
}

// ---------------------------------------------------------------------------
// Narrated extras: credits, chapter headers, retail sample
// ---------------------------------------------------------------------------

/** The narrator's voice for the book's own announcements. A project that has
 * never run cast analysis has no narrator character, in which case the
 * credits use the project's own voice: the one every segment is rendered in. */
async function narratorVoiceId(db: Db, project: ProjectRow): Promise<string | null> {
  const [narrator] = await db
    .select({ voiceId: bookxCharacters.voiceId })
    .from(bookxCharacters)
    .where(and(eq(bookxCharacters.projectId, project.id), eq(bookxCharacters.isNarrator, 1)))
    .limit(1);
  return narrator?.voiceId ?? null;
}

/** The narrator's name as it should be spoken in the credits. */
async function narratorName(db: Db, projectId: string): Promise<string | null> {
  const [narrator] = await db
    .select({ name: bookxCharacters.name })
    .from(bookxCharacters)
    .where(and(eq(bookxCharacters.projectId, projectId), eq(bookxCharacters.isNarrator, 1)))
    .limit(1);
  // "Narrator" is a placeholder, not a name anyone wants spoken aloud.
  const name = narrator?.name?.trim();
  return name && !/^narrator$/i.test(name) ? name : null;
}

/** Renders one short announcement with the book's narrator voice. */
async function renderAnnouncement(input: {
  projectId: string;
  ownerId: number;
  provider: string;
  model: string;
  voiceId: string | null;
  text: string;
  label: string;
}): Promise<Buffer> {
  const result = await renderSegmentAudio({
    projectId: input.projectId,
    segmentId: `credits-${nanoid(8)}`,
    provider: input.provider as Parameters<typeof renderSegmentAudio>[0]["provider"],
    model: input.model,
    voiceId: input.voiceId,
    text: input.text,
    ownerId: input.ownerId,
    requestTimeoutMs: 120_000,
  });
  return fetchStoredAudio(result.storageKey, input.label);
}

/** Encodes an announcement into the delivery format, like a chapter. */
async function encodeAnnouncement(input: {
  audio: Buffer;
  durationMs: number;
  output: ExportOutput;
  tags: { title: string; album: string; artist?: string | null; track: number; totalTracks: number };
}): Promise<{ buffer: Buffer; durationMs: number; rmsDb: number | null; peakDb: number | null }> {
  if (isPassthrough(input.output)) {
    const levels = await measureBuffer(input.audio, input.audio.subarray(0, 4).toString("latin1") === "RIFF" ? "wav" : "mp3").catch(() => null);
    return { buffer: input.audio, durationMs: input.durationMs, rmsDb: levels?.rmsDb ?? null, peakDb: levels?.peakDb ?? null };
  }
  const encoded = await encodeChapter({ audio: input.audio, durationMs: input.durationMs, output: input.output, tags: input.tags });
  return { buffer: encoded.buffer, durationMs: encoded.durationMs, rmsDb: encoded.rmsDb, peakDb: encoded.peakDb };
}

/** Cuts the retail sample: the opening of the first chapter, capped at five minutes. */
async function buildRetailSample(input: {
  firstChapter: { buffer: Buffer; ext: "mp3" | "wav" | "flac"; durationMs: number } | null;
  output: ExportOutput;
}): Promise<{ buffer: Buffer; durationMs: number } | null> {
  if (!input.firstChapter || input.firstChapter.durationMs <= 0) return null;
  if (input.firstChapter.durationMs <= RETAIL_SAMPLE_MAX_MS) {
    // The chapter is already short enough to be the sample as it is.
    return { buffer: input.firstChapter.buffer, durationMs: input.firstChapter.durationMs };
  }
  return withTempDir(async dir => {
    const source = path.join(dir, `sample-source.${input.firstChapter!.ext}`);
    await writeFile(source, input.firstChapter!.buffer);
    const target = path.join(dir, `sample.${input.output.container}`);
    await runFfmpegCut(source, target, input.output);
    const buffer = await readFile(target);
    return { buffer, durationMs: RETAIL_SAMPLE_MAX_MS };
  });
}

/** ffmpeg arguments that trim a file to the sample length in its own format. */
async function runFfmpegCut(source: string, target: string, output: ExportOutput): Promise<void> {
  const { runFfmpeg } = await import("./ffmpeg");
  const seconds = (RETAIL_SAMPLE_MAX_MS / 1000).toFixed(3);
  const codec = output.container === "mp3"
    ? ["-c:a", "libmp3lame", "-b:a", `${output.mp3Bitrate === "original" ? 192 : output.mp3Bitrate}k`]
    : output.container === "wav"
      ? ["-c:a", output.bitDepth === 24 ? "pcm_s24le" : "pcm_s16le"]
      : ["-c:a", "flac"];
  await runFfmpeg(["-i", source, "-t", seconds, "-map", "0:a", "-map_metadata", "-1", ...codec, "-ar", String(output.sampleRate), "-ac", output.channels === "stereo" ? "2" : "1", "-f", output.container, target]);
}

async function updateProgress(db: Db, exportId: string, detail: ExportDetail) {
  await db.update(bookxExports).set({ detail, updatedAt: new Date() }).where(eq(bookxExports.id, exportId));
}

export type AssembleResult = {
  exportId: string;
  storageKey: string | null;
  durationMs: number;
  bytes: number;
  chapters: ExportChapterFile[];
};

/** Builds every file of an export. Runs in the background after `requestProjectExport`. */
export async function assembleProjectExport(input: {
  projectId: string;
  ownerId: number;
  exportId: string;
  chapterIds?: string[];
  output: ExportOutput;
  preset: ExportPresetId;
}): Promise<AssembleResult> {
  const db = await requireDb();
  const project = await requireOwnedProject(db, input.projectId, input.ownerId);

  const readiness = await checkExportReadiness({ projectId: input.projectId, ownerId: input.ownerId, chapterIds: input.chapterIds, output: input.output });
  if (!readiness.ready) throw new Error(readiness.reason);

  const [preference] = await db
    .select({ chapterGapMs: bookxProviderSettings.chapterGapMs })
    .from(bookxProviderSettings)
    .where(and(eq(bookxProviderSettings.ownerId, input.ownerId), eq(bookxProviderSettings.provider, project.voiceProvider)))
    .limit(1);
  const chapterGapMs = preference?.chapterGapMs ?? DEFAULT_CHAPTER_GAP_MS;

  const { chapters: allChapters, segments: allSegments } = await chapterStatuses(db, project);
  const selectedIds = new Set(readiness.chapterIds);
  const chapters = allChapters.filter(chapter => selectedIds.has(chapter.id));
  const positions = new Map(allChapters.map((chapter, index) => [chapter.id, index + 1]));
  const segments = orderSegments(allSegments);
  const passthrough = isPassthrough(input.output);
  const warnings = [...readiness.warnings];

  const detail: ExportDetail = {
    preset: input.preset,
    output: input.output,
    chapters: [],
    marks: [],
    segmentGapMs: DEFAULT_SEGMENT_GAP_MS,
    chapterGapMs,
    warnings,
    progress: { done: 0, total: chapters.length, stage: "Preparing" },
  };
  await db.update(bookxExports).set({ status: "assembling", detail, updatedAt: new Date() }).where(eq(bookxExports.id, input.exportId));

  // Sound design is best effort: a sound that cannot be prepared leaves that
  // chapter narration-only instead of failing the whole export.
  let design: ExportSoundDesign | null = null;
  try {
    design = await prepareExportSoundDesign(db, { project, ownerId: input.ownerId, chapterIds: chapters.map(chapter => chapter.id) });
  } catch (error) {
    warnings.push(`Background sounds were skipped: ${error instanceof Error ? error.message : "they could not be prepared"}`);
  }

  const ffmpegAvailable = Boolean(await resolveFfmpeg());
  let workDir: string | null = null;
  const bookFiles: string[] = [];
  const sharedTarget: { value?: MixTarget } = {};
  let container: "mp3" | "wav" | "flac" = input.output.container;
  let mixedCues = 0;
  let bytes = 0;

  // The narrator's voice and name, for the book's own announcements. Both are
  // best effort: a project with no narrator character simply skips the extras.
  const creditsVoice = input.output.credits || input.output.chapterHeaders ? await narratorVoiceId(db, project).catch(() => null) : null;
  const creditsName = input.output.credits ? await narratorName(db, project.id).catch(() => null) : null;
  const creditsInput = { title: project.title, author: project.author, narrator: creditsName };
  const openingText = input.output.credits ? openingCreditsText(creditsInput) : "";
  const closingText = input.output.credits ? closingCreditsText(creditsInput) : "";
  const canNarrateExtras = Boolean(openingText || closingText || input.output.chapterHeaders) && ffmpegAvailable;
  const extrasWarnings: string[] = [];

  let openingCreditsFile: { storageKey: string; fileName: string; bytes: number; durationMs: number } | null = null;
  let closingCreditsFile: { storageKey: string; fileName: string; bytes: number; durationMs: number } | null = null;
  if (canNarrateExtras && openingText) {
    try {
      detail.progress = { done: 0, total: chapters.length, stage: "Narrating the opening credits" };
      await updateProgress(db, input.exportId, detail);
      const audio = await renderAnnouncement({
        projectId: project.id, ownerId: input.ownerId, provider: project.voiceProvider, model: project.voiceModel,
        voiceId: creditsVoice, text: openingText, label: "opening credits",
      });
      const encoded = await encodeAnnouncement({ audio, durationMs: 0, output: input.output, tags: { title: OPENING_CREDITS_FILE_NAME, album: project.title, artist: project.author, track: 0, totalTracks: chapters.length } });
      const fileName = chapterFileName(0, chapters.length + 2, OPENING_CREDITS_FILE_NAME, container);
      const stored = await storagePut(`bookx/${project.id}/export/${input.exportId}/credits-opening.${container}`, encoded.buffer, mimeTypeFor(container));
      openingCreditsFile = { storageKey: stored.key, fileName, bytes: encoded.buffer.length, durationMs: encoded.durationMs };
      bytes += encoded.buffer.length;
    } catch (error) {
      extrasWarnings.push(`Opening credits were skipped: ${error instanceof Error ? error.message : "they could not be narrated"}`);
    }
  }
  if (canNarrateExtras && closingText) {
    try {
      detail.progress = { done: 0, total: chapters.length, stage: "Narrating the closing credits" };
      await updateProgress(db, input.exportId, detail);
      const audio = await renderAnnouncement({
        projectId: project.id, ownerId: input.ownerId, provider: project.voiceProvider, model: project.voiceModel,
        voiceId: creditsVoice, text: closingText, label: "closing credits",
      });
      const encoded = await encodeAnnouncement({ audio, durationMs: 0, output: input.output, tags: { title: CLOSING_CREDITS_FILE_NAME, album: project.title, artist: project.author, track: chapters.length + 1, totalTracks: chapters.length + 2 } });
      const fileName = chapterFileName(chapters.length + 1, chapters.length + 2, CLOSING_CREDITS_FILE_NAME, container);
      const stored = await storagePut(`bookx/${project.id}/export/${input.exportId}/credits-closing.${container}`, encoded.buffer, mimeTypeFor(container));
      closingCreditsFile = { storageKey: stored.key, fileName, bytes: encoded.buffer.length, durationMs: encoded.durationMs };
      bytes += encoded.buffer.length;
    } catch (error) {
      extrasWarnings.push(`Closing credits were skipped: ${error instanceof Error ? error.message : "they could not be narrated"}`);
    }
  }
  warnings.push(...extrasWarnings);

  try {
    if (input.output.fullBook) workDir = await mkdtemp(path.join(os.tmpdir(), "bookx-export-"));

    for (const [index, chapter] of chapters.entries()) {
      const position = positions.get(chapter.id) ?? index + 1;
      detail.progress = { done: index, total: chapters.length, stage: `Chapter ${index + 1} of ${chapters.length}: ${chapter.title}` };
      await updateProgress(db, input.exportId, detail);

      const own = segments.filter(segment => segment.chapterId === chapter.id);
      const audio = await buildChapterAudio({ chapter, segments: own, design, passthrough, sharedTarget });
      mixedCues += audio.mixedCues;

      // A narrated header opens the file, as ACX asks: the listener landing on
      // any file knows where they are. Best effort, like the credits.
      if (canNarrateExtras && input.output.chapterHeaders) {
        const headerText = chapterHeaderText(chapter.title);
        if (headerText) {
          try {
            const headerAudio = await renderAnnouncement({
              projectId: project.id, ownerId: input.ownerId, provider: project.voiceProvider, model: project.voiceModel,
              voiceId: creditsVoice, text: headerText, label: `${chapter.title} header`,
            });
            const header = assembleAudio(
              [{ buffer: headerAudio, label: `${chapter.title} header`, gapAfterMs: HEADER_GAP_MS }, { buffer: audio.buffer, label: chapter.title, gapAfterMs: 0 }],
              { gapMs: 0 },
            );
            audio.buffer = header.buffer;
            audio.durationMs = header.durationMs;
          } catch (error) {
            warnings.push(`"${chapter.title}" was exported without its narrated header: ${error instanceof Error ? error.message : "the header could not be narrated"}`);
          }
        }
      }

      const tags = { title: chapter.title, album: project.title, artist: project.author, track: index + 1, totalTracks: chapters.length };
      let file: { buffer: Buffer; ext: "mp3" | "wav" | "flac"; durationMs: number; rmsDb: number | null; peakDb: number | null };
      if (passthrough) {
        const buffer = audio.container === "mp3"
          ? Buffer.concat([buildId3Tag({ title: tags.title, album: tags.album, artist: tags.artist, track: `${tags.track}/${tags.totalTracks}` }), audio.buffer])
          : audio.buffer;
        const levels = ffmpegAvailable ? await measureBuffer(buffer, audio.container).catch(() => null) : null;
        file = { buffer, ext: audio.container, durationMs: audio.durationMs, rmsDb: levels?.rmsDb ?? null, peakDb: levels?.peakDb ?? null };
      } else {
        const encoded = await encodeChapter({ audio: audio.buffer, durationMs: audio.durationMs, output: input.output, tags });
        file = { buffer: encoded.buffer, ext: input.output.container, durationMs: encoded.durationMs || audio.durationMs, rmsDb: encoded.rmsDb, peakDb: encoded.peakDb };
      }
      container = file.ext;

      const fileName = chapterFileName(index + 1, chapters.length, chapter.title, file.ext);
      const stored = await storagePut(
        `bookx/${input.projectId}/export/${input.exportId}/${String(position).padStart(3, "0")}-${chapter.id}.${file.ext}`,
        file.buffer,
        mimeTypeFor(file.ext),
      );
      bytes += file.buffer.length;
      if (workDir) {
        const onDisk = path.join(workDir, `chapter-${String(index).padStart(4, "0")}.${file.ext}`);
        await writeFile(onDisk, file.buffer);
        bookFiles.push(onDisk);
      }
      await db
        .update(bookxChapters)
        .set({ audioStorageKey: stored.key, audioDurationMs: file.durationMs, updatedAt: new Date() })
        .where(eq(bookxChapters.id, chapter.id));

      detail.chapters!.push({
        chapterId: chapter.id,
        title: chapter.title,
        storageKey: stored.key,
        fileName,
        bytes: file.buffer.length,
        durationMs: file.durationMs,
        startMs: 0,
        rmsDb: file.rmsDb,
        peakDb: file.peakDb,
      });
    }

    // Chapter positions in the whole-book file. Levelled chapters already carry
    // room tone at both ends, so they need no extra gap.
    const gapMs = !passthrough && input.output.master ? 0 : chapterGapMs;
    let cursor = 0;
    detail.marks = detail.chapters!.map(file => {
      file.startMs = cursor;
      const mark = { label: file.title, startMs: cursor, durationMs: file.durationMs };
      cursor += file.durationMs + gapMs;
      return mark;
    });
    const totalMs = Math.max(0, cursor - gapMs);

    // The retail sample: the opening of the first chapter, capped at five
    // minutes, which is what Apple Books and Spotify play to a shopper.
    if (input.output.retailSample && detail.chapters!.length) {
      try {
        detail.progress = { done: chapters.length, total: chapters.length, stage: "Cutting the retail sample" };
        await updateProgress(db, input.exportId, detail);
        const first = detail.chapters![0]!;
        const firstBuffer = await fetchStoredAudio(first.storageKey, "retail sample source");
        const sample = await buildRetailSample({
          firstChapter: { buffer: firstBuffer, ext: container, durationMs: first.durationMs },
          output: input.output,
        });
        if (sample) {
          const fileName = chapterFileName(0, chapters.length + 2, RETAIL_SAMPLE_FILE_NAME, container);
          const stored = await storagePut(`bookx/${input.projectId}/export/${input.exportId}/sample.${container}`, sample.buffer, mimeTypeFor(container));
          detail.retailSample = { storageKey: stored.key, fileName, bytes: sample.buffer.length, durationMs: sample.durationMs };
          bytes += sample.buffer.length;
        }
      } catch (error) {
        warnings.push(`The retail sample was skipped: ${error instanceof Error ? error.message : "it could not be cut"}`);
      }
    }

    // Quality check: the noise floor of the delivered files, which ACX caps at
    // -60 dB RMS. Measured on a few chapters, not all of them, so a long book
    // does not spend minutes re-reading its own output.
    if (ffmpegAvailable && detail.chapters!.length) {
      try {
        const checkCount = Math.min(3, detail.chapters!.length);
        let worst: number | null = null;
        for (let check = 0; check < checkCount; check++) {
          const chapter = detail.chapters![Math.floor((check * detail.chapters!.length) / checkCount)]!;
          const buffer = await fetchStoredAudio(chapter.storageKey, `noise check on ${chapter.title}`);
          const floor = await withTempDir(async dir => {
            const file = path.join(dir, `check.${container}`);
            await writeFile(file, buffer);
            return measureNoiseFloor(file);
          });
          if (floor.floorDb !== null && (worst === null || floor.floorDb > worst)) worst = floor.floorDb;
        }
        detail.quality = { noiseFloorDb: worst, checkedFiles: checkCount };
        if (worst !== null && worst > NOISE_FLOOR_MAX_DB) {
          warnings.push(`The noise floor measures ${worst.toFixed(1)} dB, above the ${NOISE_FLOOR_MAX_DB} dB ceiling ACX sets. A different voice or a noise-reduction pass will fix it.`);
        }
      } catch {
        // A QC miss never blocks a finished package.
      }
    }

    let bookKey: string | null = null;
    if (workDir && bookFiles.length) {
      detail.progress = { done: chapters.length, total: chapters.length, stage: "Joining the whole book" };
      await updateProgress(db, input.exportId, detail);
      let gapFile: string | null = null;
      if (gapMs > 0) {
        if (passthrough) {
          // Built from the first chapter's own frames so the join stays frame-exact.
          gapFile = path.join(workDir, `gap.${container}`);
          await writeFile(gapFile, passthroughSilence(await readFile(bookFiles[0]!), container === "wav" ? "wav" : "mp3", gapMs));
        } else {
          gapFile = await writeSilence({ dir: workDir, output: input.output, ms: gapMs });
        }
      }
      const joined = await joinBookFiles({
        dir: workDir,
        files: bookFiles,
        container,
        gapFile,
        metadata: bookMetadata({
          title: project.title,
          artist: project.author,
          chapters: container === "mp3" ? detail.marks.map(mark => ({ title: mark.label, startMs: mark.startMs, endMs: mark.startMs + mark.durationMs })) : [],
        }),
      });
      const fileName = bookFileName(project.title, container);
      const stored = await storagePutFile(`bookx/${input.projectId}/export/${input.exportId}/book.${container}`, joined.filePath, mimeTypeFor(container));
      detail.fullBook = { storageKey: stored.key, fileName, bytes: stored.bytes, durationMs: joined.durationMs || totalMs };
      bookKey = stored.key;
    }

    detail.container = container;
    detail.credits = { opening: openingCreditsFile, closing: closingCreditsFile };
    if (design && mixedCues > 0) {
      detail.soundDesign = {
        effects: design.settings.effects,
        music: design.settings.music,
        level: design.settings.level,
        cues: mixedCues,
        encoding: passthrough && sharedTarget.value ? describeTarget(sharedTarget.value) : describeOutput(input.output),
      };
    }
    detail.progress = { done: chapters.length, total: chapters.length, stage: "Ready" };

    await db
      .update(bookxExports)
      .set({ status: "ready", storageKey: bookKey, durationMs: totalMs, bytes, error: null, detail, updatedAt: new Date() })
      .where(eq(bookxExports.id, input.exportId));

    return { exportId: input.exportId, storageKey: bookKey, durationMs: totalMs, bytes, chapters: detail.chapters! };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Exports currently being assembled in this process, so the host is not stopped mid-way. */
const assembling = new Set<string>();
export const exportsInProgress = () => assembling.size;

/**
 * Creates an export record and assembles it in the background.
 *
 * Readiness is checked first, so an export that cannot succeed fails at once
 * with a specific reason instead of sitting queued.
 */
export async function requestProjectExport(input: {
  projectId: string;
  ownerId: number;
  chapterIds?: string[];
  preset?: ExportPresetId;
  output?: ExportOutput;
}): Promise<{ id: string; status: "queued"; chapters: number }> {
  const db = await requireDb();
  const preset = input.preset ?? "spotify";
  const output = input.output ?? presetById(preset).output;

  const readiness = await checkExportReadiness({ projectId: input.projectId, ownerId: input.ownerId, chapterIds: input.chapterIds, output });
  if (!readiness.ready) throw new Error(readiness.reason);

  const id = nanoid();
  await db.insert(bookxExports).values({
    id,
    projectId: input.projectId,
    format: preset,
    status: "queued",
    detail: { preset, output, warnings: readiness.warnings, progress: { done: 0, total: readiness.chapterIds.length, stage: "Queued" } },
  });

  assembling.add(id);
  void assembleProjectExport({ projectId: input.projectId, ownerId: input.ownerId, exportId: id, chapterIds: readiness.chapterIds, output, preset })
    .catch(async error => {
      const message = error instanceof Error ? error.message : "Export failed";
      console.error("[Export] Assembly failed:", error);
      await db
        .update(bookxExports)
        .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
        .where(eq(bookxExports.id, id))
        .catch(() => {});
    })
    .finally(() => assembling.delete(id));

  return { id, status: "queued", chapters: readiness.chapterIds.length };
}

/** On boot: an export that was assembling when the process stopped cannot finish. */
export async function recoverInterruptedExports(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const stuck = await db.select({ id: bookxExports.id }).from(bookxExports).where(inArray(bookxExports.status, ["queued", "assembling"]));
  for (const row of stuck) {
    await db
      .update(bookxExports)
      .set({ status: "failed", error: "Interrupted by a restart. Create the package again.", updatedAt: new Date() })
      .where(eq(bookxExports.id, row.id));
  }
  return stuck.length;
}

async function requireExport(db: Db, input: { projectId: string; ownerId: number; exportId: string }) {
  await requireOwnedProject(db, input.projectId, input.ownerId);
  const [row] = await db
    .select()
    .from(bookxExports)
    .where(and(eq(bookxExports.id, input.exportId), eq(bookxExports.projectId, input.projectId)))
    .limit(1);
  if (!row) throw new Error("Export not found");
  return row;
}

/**
 * A download URL for one file of a finished export: the whole book (default),
 * or one chapter by id.
 */
export async function getExportDownloadUrl(input: { projectId: string; ownerId: number; exportId: string; file?: string }): Promise<{ url: string; fileName: string }> {
  const db = await requireDb();
  const row = await requireExport(db, input);
  if (row.status !== "ready") throw new Error("This export is not ready yet");
  const detail = row.detail ?? {};
  if (!input.file || input.file === "book") {
    const book = detail.fullBook ?? (row.storageKey ? { storageKey: row.storageKey, fileName: `audiobook.${detail.container ?? "mp3"}` } : null);
    if (!book) throw new Error("This package has no whole-book file. Download the chapters or the ZIP instead.");
    return { url: await storageDownloadUrl(book.storageKey, book.fileName), fileName: book.fileName };
  }
  const chapter = detail.chapters?.find(entry => entry.chapterId === input.file);
  if (chapter) {
    const fileName = chapter.fileName ?? `${chapter.title}.${detail.container ?? "mp3"}`;
    return { url: await storageDownloadUrl(chapter.storageKey, fileName), fileName };
  }
  // The credits and the retail sample are files of the package too.
  const extras: Array<{ key: string; file: { storageKey: string; fileName?: string } | null | undefined }> = [
    { key: "credits-opening", file: detail.credits?.opening },
    { key: "credits-closing", file: detail.credits?.closing },
    { key: "sample", file: detail.retailSample },
  ];
  const extra = extras.find(entry => entry.key === input.file && entry.file);
  if (extra?.file) {
    const fileName = extra.file.fileName ?? `${extra.key}.${detail.container ?? "mp3"}`;
    return { url: await storageDownloadUrl(extra.file.storageKey, fileName), fileName };
  }
  throw new Error("That file is not part of this package");
}

/** Deletes a package and its files. */
export async function deleteProjectExport(input: { projectId: string; ownerId: number; exportId: string }): Promise<void> {
  const db = await requireDb();
  const row = await requireExport(db, input);
  if (row.status === "queued" || row.status === "assembling") throw new Error("This package is still being assembled");
  await storageDeletePrefix(`bookx/${input.projectId}/export/${input.exportId}/`);
  await db.delete(bookxExports).where(eq(bookxExports.id, input.exportId));
}

export type { ZipEntry } from "../shared/exportZip";

/** The chapter files of a finished export, in order, for a ZIP download. */
export async function exportZipEntries(input: { projectId: string; ownerId: number; exportId: string }): Promise<{ zipName: string; entries: ZipEntry[] }> {
  const db = await requireDb();
  const project = await requireOwnedProject(db, input.projectId, input.ownerId);
  const row = await requireExport(db, input);
  if (row.status !== "ready") throw new Error("This export is not ready yet");
  return exportZipPlan({ projectTitle: project.title, detail: row.detail, updatedAt: row.updatedAt });
}
