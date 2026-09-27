import type { ExportDetail } from "../drizzle/schema";
import { CLOSING_CREDITS_FILE_NAME, OPENING_CREDITS_FILE_NAME, RETAIL_SAMPLE_FILE_NAME } from "./audiobookExtras";
import { bookFileName, chapterFileName } from "./exportOptions";

/**
 * What goes into an export's ZIP download, worked out the same way by the app
 * server and by the Cloudflare Worker (which streams it straight from R2).
 */
export type ZipEntry = { name: string; storageKey: string; bytes: number | null; lastModified: Date };

export function exportZipPlan(input: { projectTitle: string; detail: ExportDetail | null; updatedAt: Date | number }): { zipName: string; entries: ZipEntry[] } {
  const detail = input.detail ?? {};
  const container = detail.container ?? "mp3";
  const lastModified = new Date(input.updatedAt);
  const chapters = detail.chapters ?? [];
  const entries: ZipEntry[] = chapters.map((chapter, index, all) => ({
    name: chapter.fileName ?? chapterFileName(index + 1, all.length, chapter.title, container),
    storageKey: chapter.storageKey,
    bytes: chapter.bytes ?? null,
    lastModified,
  }));
  // The credits and retail sample ride along in the ZIP, in book order.
  const opening = detail.credits?.opening;
  if (opening) entries.unshift({ name: opening.fileName ?? chapterFileName(0, chapters.length + 2, OPENING_CREDITS_FILE_NAME, container), storageKey: opening.storageKey, bytes: opening.bytes ?? null, lastModified });
  const closing = detail.credits?.closing;
  if (closing) entries.push({ name: closing.fileName ?? chapterFileName(chapters.length + 1, chapters.length + 2, CLOSING_CREDITS_FILE_NAME, container), storageKey: closing.storageKey, bytes: closing.bytes ?? null, lastModified });
  const sample = detail.retailSample;
  if (sample) entries.push({ name: sample.fileName ?? chapterFileName(0, chapters.length + 2, RETAIL_SAMPLE_FILE_NAME, container), storageKey: sample.storageKey, bytes: sample.bytes ?? null, lastModified });
  const zipName = `${bookFileName(input.projectTitle, "zip").replace(/ \(full book\)\.zip$/, "")} (${container.toUpperCase()} chapters).zip`;
  return { zipName, entries };
}
