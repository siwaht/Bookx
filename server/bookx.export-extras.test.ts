import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { resolveFfmpeg, runFfmpeg, withTempDir } from "./ffmpeg";
import { appRouter } from "./routers";

/**
 * The full export package: credits, chapter headers, the retail sample and the
 * noise-floor check, assembled end to end against a real database. TTS is
 * mocked with a real (silent-ish) MP3 so the pipeline runs without spending
 * provider credits; ffmpeg still does the real encoding and joining.
 */

vi.mock("./ttsRender", async importOriginal => {
  const original = await importOriginal<typeof import("./ttsRender")>();
  return {
    ...original,
    renderSegmentAudio: async (request: { projectId: string; segmentId: string }) => {
      // A short, quiet tone: real audio, really stored, so assembly and
      // encoding are honest without spending provider credits.
      const { runFfmpeg, withTempDir } = await import("./ffmpeg");
      const { storagePut } = await import("./storage");
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const buffer = await withTempDir(async dir => {
        const file = path.join(dir, "clip.mp3");
        await runFfmpeg([
          "-f", "lavfi", "-i", "aevalsrc=exprs='0.3*(0.5+0.5*sin(2*PI*3*t))*sin(2*PI*180*t)':s=44100:d=1.2",
          "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", file,
        ]);
        return readFile(file);
      });
      const stored = await storagePut(`bookx/${request.projectId}/narration/${request.segmentId}.mp3`, buffer, "audio/mpeg");
      return { storageKey: stored.key, audioUrl: stored.url, inspection: { container: "mp3" as const, mimeType: "audio/mpeg", bytes: buffer.length, durationMs: 1200 } };
    },
  };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function caller(id: number, openId: string) {
  const user: AuthenticatedUser = {
    id, openId, email: `${openId}@example.com`, name: openId, loginMethod: "manus", role: "user",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] });
}

const MANUSCRIPT = [
  "Chapter 1",
  "",
  "The road went on between the hedges, and the morning was quiet.",
  "",
  "Anna walked until the light changed.",
].join("\n");

const setup = {
  author: "Bookx QA",
  kind: "audiobook" as const,
  narrationStyle: "single" as const,
  voiceProvider: "Cloudflare",
  voiceModel: "@cf/deepgram/aura-2-en",
  languageModelProvider: "Cloudflare",
  languageModel: "@cf/openai/gpt-oss-120b",
  language: "English",
};

const hasFfmpeg = Boolean(await resolveFfmpeg());

describe.skipIf(!hasFfmpeg)("Bookx export package extras", () => {
  it("narrates credits and headers, cuts a sample, and checks the noise floor", async () => {
    const owner = caller(990_201, "export-extras-owner");
    const stamp = Date.now();
    const { id: projectId } = await owner.bookx.createProject({ ...setup, title: `Export QA ${stamp}` });

    try {
      await owner.bookx.importManuscript({ projectId, filename: "road.txt", base64: Buffer.from(MANUSCRIPT).toString("base64"), mode: "replace" });
      await owner.bookx.resegmentChapters({ projectId });

      // Give every segment audio, as a finished render would.
      const db = (await (await import("./db")).getDb())!;
      const { bookxSegments, bookxChapters } = await import("../drizzle/schema");
      const { eq: eqOp, inArray } = await import("drizzle-orm");
      const chapters = await db.select({ id: bookxChapters.id }).from(bookxChapters).where(eqOp(bookxChapters.projectId, projectId));
      const chapterIds = chapters.map(chapter => chapter.id);
      const segments = await db.select().from(bookxSegments).where(inArray(bookxSegments.chapterId, chapterIds));
      expect(segments.length).toBeGreaterThan(0);
      for (const segment of segments) {
        await db.update(bookxSegments).set({
          audioStorageKey: `bookx/${projectId}/narration/qa-${segment.id}.mp3`,
          textHash: "qa",
          voiceProvider: "Cloudflare",
          voiceModel: "@cf/deepgram/aura-2-en",
          audioMimeType: "audio/mpeg",
          audioBytes: 1000,
          audioDurationMs: 1200,
          renderedAt: new Date(),
          updatedAt: new Date(),
        }).where(eqOp(bookxSegments.id, segment.id));
      }

      // The stored audio must exist for the export to read it. `storagePut`
      // appends a hash suffix, so the returned key is what the row must hold.
      const { storagePut } = await import("./storage");
      const clip = await withTempDir(async dir => {
        const file = `${dir}/clip.mp3`;
        await runFfmpeg([
          "-f", "lavfi", "-i", "aevalsrc=exprs='0.3*(0.5+0.5*sin(2*PI*3*t))*sin(2*PI*180*t)':s=44100:d=1.2",
          "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", file,
        ]);
        const { readFile } = await import("node:fs/promises");
        return readFile(file);
      });
      for (const segment of segments) {
        const stored = await storagePut(`bookx/${projectId}/narration/qa-${segment.id}.mp3`, clip, "audio/mpeg");
        await db.update(bookxSegments).set({ audioStorageKey: stored.key }).where(eqOp(bookxSegments.id, segment.id));
      }

      const readiness = await owner.bookx.exportReadiness({ projectId });
      expect(readiness.exportableChapters).toBe(1);

      const requested = await owner.bookx.requestExport({ projectId, preset: "spotify" });
      expect(requested.status).toBe("queued");

      // The export runs in the background; wait for it.
      for (let attempt = 0; attempt < 120; attempt++) {
        const exports = await owner.bookx.listExports({ projectId });
        const row = exports.find(entry => entry.id === requested.id);
        if (row && row.status === "ready") break;
        if (row && row.status === "failed") throw new Error(`Export failed: ${row.error}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      const exports = await owner.bookx.listExports({ projectId });
      const row = exports.find(entry => entry.id === requested.id)!;
      expect(row.status).toBe("ready");

      // The package carries the extras.
      const detail = (row as unknown as { detail: { credits?: unknown; retailSample?: unknown; quality?: { noiseFloorDb?: number | null } } }).detail;
      expect(detail.credits).toBeTruthy();
      expect(detail.retailSample).toBeTruthy();
      expect(detail.quality?.noiseFloorDb).not.toBeNull();

      // Every file downloads.
      const opening = await owner.bookx.exportDownloadUrl({ projectId, exportId: requested.id, file: "credits-opening" });
      expect(opening.url).toBeTruthy();
      const sample = await owner.bookx.exportDownloadUrl({ projectId, exportId: requested.id, file: "sample" });
      expect(sample.url).toBeTruthy();
    } finally {
      await owner.bookx.deleteProject({ projectId });
    }
  }, 180_000);
});
