import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  bookxChapters,
  bookxExports,
  bookxProjects,
  bookxProviderSettings,
  bookxSegments,
  type ExportDetail,
} from "../drizzle/schema";
import { getDb } from "./db";
import { assembleAudio, type AssemblyPart } from "./audioAssembly";
import { auditProjectAudio, loadPlannableSegments } from "./narrationWorker";
import { orderSegments } from "./narrationPlan";
import { storageGetSignedUrl, storagePut } from "./storage";

/**
 * Turns rendered segments into deliverable files.
 *
 * The guard at the top is the important part: an export is refused outright when the
 * audit says anything is missing, stale, or voiced differently. A partial export is
 * the exact failure the whole pipeline exists to prevent — a book that plays with a
 * silent gap or a paragraph in the wrong voice, discovered only by a listener.
 */

/** Pause between paragraphs inside a chapter. */
const DEFAULT_SEGMENT_GAP_MS = 350;
/** Pause between chapters, overridden by the saved provider preference. */
const DEFAULT_CHAPTER_GAP_MS = 2000;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

/** Fetches one stored audio object. */
async function fetchStoredAudio(storageKey: string, label: string): Promise<Buffer> {
  const url = await storageGetSignedUrl(storageKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`${label}: stored audio could not be read (HTTP ${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error(`${label}: stored audio is empty`);
  return buffer;
}

export type ExportFormat = "ACX" | "Podcast" | "InAudio package";

export type AssembleResult = {
  exportId: string;
  storageKey: string;
  durationMs: number;
  bytes: number;
  chapters: NonNullable<ExportDetail["chapters"]>;
};

/**
 * Refuses to proceed unless every segment is current.
 *
 * Returns the reason so the caller can surface something specific rather than a
 * generic failure.
 */
export async function checkExportReadiness(input: { projectId: string; ownerId: number }): Promise<{ ready: true } | { ready: false; reason: string }> {
  const audit = await auditProjectAudio(input);

  if (audit.totalSegments === 0) {
    return { ready: false, reason: "There is no narration to export yet. Add chapter text and render it first." };
  }
  if (audit.missingSegments.length) {
    return { ready: false, reason: `${audit.missingSegments.length} segment(s) have no audio. Finish the narration run before exporting.` };
  }
  if (audit.staleSegments.length) {
    return { ready: false, reason: `${audit.staleSegments.length} segment(s) were edited after they were rendered. Re-render them so the audio matches the manuscript.` };
  }
  if (audit.mismatchedVoiceSegments.length) {
    return { ready: false, reason: `${audit.mismatchedVoiceSegments.length} segment(s) were rendered with a different voice. Re-render them so the whole book matches.` };
  }
  if (audit.suspectSegments.length) {
    return { ready: false, reason: `${audit.suspectSegments.length} segment(s) have audio that was never verified. Re-render them before exporting.` };
  }
  return { ready: true };
}

/**
 * Assembles a project into per-chapter files plus one combined file.
 *
 * Joining happens at the frame level, so nothing is re-encoded and the audio is
 * bit-identical to what the provider returned. Chapter marks are recorded against
 * the combined file so a player can navigate it.
 */
export async function assembleProjectExport(input: {
  projectId: string;
  ownerId: number;
  format: ExportFormat;
  exportId: string;
}): Promise<AssembleResult> {
  const db = await requireDb();

  const [project] = await db
    .select()
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const readiness = await checkExportReadiness({ projectId: input.projectId, ownerId: input.ownerId });
  if (!readiness.ready) throw new Error(readiness.reason);

  const [preference] = await db
    .select({ chapterGapMs: bookxProviderSettings.chapterGapMs })
    .from(bookxProviderSettings)
    .where(and(eq(bookxProviderSettings.ownerId, input.ownerId), eq(bookxProviderSettings.provider, project.voiceProvider)))
    .limit(1);
  const chapterGapMs = preference?.chapterGapMs ?? DEFAULT_CHAPTER_GAP_MS;

  const chapters = await db
    .select()
    .from(bookxChapters)
    .where(eq(bookxChapters.projectId, input.projectId))
    .orderBy(bookxChapters.orderIndex);
  if (!chapters.length) throw new Error("This project has no chapters to export");

  const segments = orderSegments(await loadPlannableSegments(input.projectId));

  await db
    .update(bookxExports)
    .set({ status: "assembling", updatedAt: new Date() })
    .where(eq(bookxExports.id, input.exportId));

  // ---- Per chapter ------------------------------------------------------
  const chapterFiles: NonNullable<ExportDetail["chapters"]> = [];
  const chapterParts: AssemblyPart[] = [];
  let container: "mp3" | "wav" = "mp3";

  for (const chapter of chapters) {
    const own = segments.filter(segment => segment.chapterId === chapter.id);
    if (!own.length) continue;

    const parts: AssemblyPart[] = [];
    for (const [index, segment] of own.entries()) {
      if (!segment.audioStorageKey) {
        // Should be unreachable after the readiness check, but a missing file here
        // would otherwise be silently skipped and shorten the book.
        throw new Error(`${chapter.title}: segment ${index + 1} has no audio`);
      }
      parts.push({
        buffer: await fetchStoredAudio(segment.audioStorageKey, `${chapter.title} segment ${index + 1}`),
        label: `${chapter.title} · ${index + 1}`,
      });
    }

    const assembled = assembleAudio(parts, { gapMs: DEFAULT_SEGMENT_GAP_MS });
    container = assembled.container;

    const stored = await storagePut(
      `bookx/${input.projectId}/export/${input.exportId}/${chapter.orderIndex + 1}-${chapter.id}.${assembled.container}`,
      assembled.buffer,
      assembled.mimeType,
    );

    await db
      .update(bookxChapters)
      .set({ audioStorageKey: stored.key, audioDurationMs: assembled.durationMs, updatedAt: new Date() })
      .where(eq(bookxChapters.id, chapter.id));

    chapterFiles.push({
      chapterId: chapter.id,
      title: chapter.title,
      storageKey: stored.key,
      durationMs: assembled.durationMs,
      startMs: 0, // filled in once the combined file is laid out
    });
    chapterParts.push({ buffer: assembled.buffer, label: chapter.title });
  }

  if (!chapterParts.length) throw new Error("No chapter contained any rendered audio");

  // ---- Combined file ----------------------------------------------------
  const combined = assembleAudio(chapterParts, { gapMs: chapterGapMs });
  combined.marks.forEach((mark, index) => {
    const file = chapterFiles[index];
    if (file) file.startMs = mark.startMs;
  });

  const safeTitle = project.title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "bookx-export";
  const stored = await storagePut(
    `bookx/${input.projectId}/export/${input.exportId}/${safeTitle}.${combined.container}`,
    combined.buffer,
    combined.mimeType,
  );

  const detail: ExportDetail = {
    chapters: chapterFiles,
    marks: combined.marks,
    container: combined.container,
    segmentGapMs: DEFAULT_SEGMENT_GAP_MS,
    chapterGapMs,
  };

  await db
    .update(bookxExports)
    .set({
      status: "ready",
      storageKey: stored.key,
      durationMs: combined.durationMs,
      bytes: combined.buffer.length,
      error: null,
      detail,
      updatedAt: new Date(),
    })
    .where(eq(bookxExports.id, input.exportId));

  return {
    exportId: input.exportId,
    storageKey: stored.key,
    durationMs: combined.durationMs,
    bytes: combined.buffer.length,
    chapters: chapterFiles,
  };
}

/**
 * Creates an export record and assembles it in the background.
 *
 * Readiness is checked before the record is created, so an export that cannot
 * succeed fails immediately with a specific reason instead of sitting queued.
 */
export async function requestProjectExport(input: {
  projectId: string;
  ownerId: number;
  format: ExportFormat;
}): Promise<{ id: string; status: "queued" }> {
  const db = await requireDb();

  const readiness = await checkExportReadiness({ projectId: input.projectId, ownerId: input.ownerId });
  if (!readiness.ready) throw new Error(readiness.reason);

  const id = nanoid();
  await db.insert(bookxExports).values({ id, projectId: input.projectId, format: input.format, status: "queued" });

  void assembleProjectExport({ ...input, exportId: id }).catch(async error => {
    const message = error instanceof Error ? error.message : "Export failed";
    console.error("[Export] Assembly failed:", error);
    await db
      .update(bookxExports)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(bookxExports.id, id))
      .catch(() => {});
  });

  return { id, status: "queued" };
}

/** Signed download URL for a finished export. */
export async function getExportDownloadUrl(input: { projectId: string; ownerId: number; exportId: string }): Promise<string> {
  const db = await requireDb();

  const [project] = await db
    .select({ id: bookxProjects.id })
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const [row] = await db
    .select()
    .from(bookxExports)
    .where(and(eq(bookxExports.id, input.exportId), eq(bookxExports.projectId, input.projectId)))
    .limit(1);
  if (!row) throw new Error("Export not found");
  if (row.status !== "ready" || !row.storageKey) throw new Error("This export is not ready yet");

  return storageGetSignedUrl(row.storageKey);
}

/**
 * Total rendered audio for a project, read from stored segment durations.
 * Used by the Export screen before any assembly has happened.
 */
export async function projectAudioSummary(input: { projectId: string; ownerId: number }) {
  const db = await requireDb();

  const [project] = await db
    .select({ id: bookxProjects.id })
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const chapters = await db
    .select({ id: bookxChapters.id })
    .from(bookxChapters)
    .where(eq(bookxChapters.projectId, input.projectId));
  if (!chapters.length) return { durationMs: 0, bytes: 0, segments: 0 };

  const rows = await db
    .select({ audioDurationMs: bookxSegments.audioDurationMs, audioBytes: bookxSegments.audioBytes })
    .from(bookxSegments)
    .where(inArray(bookxSegments.chapterId, chapters.map(chapter => chapter.id)));

  return {
    durationMs: rows.reduce((total, row) => total + (row.audioDurationMs || 0), 0),
    bytes: rows.reduce((total, row) => total + (row.audioBytes || 0), 0),
    segments: rows.length,
  };
}
