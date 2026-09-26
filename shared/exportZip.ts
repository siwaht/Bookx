import type { ExportDetail } from "../drizzle/schema";
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
  const entries = (detail.chapters ?? []).map((chapter, index, all) => ({
    name: chapter.fileName ?? chapterFileName(index + 1, all.length, chapter.title, container),
    storageKey: chapter.storageKey,
    bytes: chapter.bytes ?? null,
    lastModified,
  }));
  const zipName = `${bookFileName(input.projectTitle, "zip").replace(/ \(full book\)\.zip$/, "")} (${container.toUpperCase()} chapters).zip`;
  return { zipName, entries };
}
