import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bookxChapters, bookxSegments, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { MAX_CHAPTER_BODY_BYTES, splitOversizedChapters } from "./chapterLimits";
import { chunk, getDb, getUserByOpenId, idChunks, insertMany, projectChapterIds, selectInChunks, upsertUser } from "./db";
import { appRouter } from "./routers";
import { D1_LIMITS, D1LimitError, checkD1Limits, toSqlValue } from "./sqlTransport";

function caller(id: number, openId: string) {
  const user: NonNullable<TrpcContext["user"]> = {
    id, openId, email: `${openId}@example.com`, name: openId, loginMethod: "manus", role: "user",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] });
}

describe("D1 limits", () => {
  it("are enforced locally, so code that would fail on D1 fails in tests too", () => {
    expect(() => checkD1Limits({ sql: "select 1", params: Array(100).fill(1) })).not.toThrow();
    expect(() => checkD1Limits({ sql: "select 1", params: Array(101).fill(1) })).toThrow(D1LimitError);
    expect(() => checkD1Limits({ sql: `select '${"x".repeat(D1_LIMITS.maxSqlBytes)}'`, params: [] })).toThrow(/100000 bytes/);
    expect(() => checkD1Limits({ sql: "insert", params: ["é".repeat(1_100_000)] })).toThrow(/2 MB/);
  });

  it("reject an oversized IN list at the driver", async () => {
    const db = await getDb();
    const ids = Array.from({ length: 150 }, (_, index) => `missing-${index}`);
    const failure = await db.select().from(bookxSegments).where(inArray(bookxSegments.id, ids)).then(() => null, (error: Error & { cause?: unknown }) => error);
    // drizzle wraps driver errors in a "Failed query" error; the D1 check is its cause.
    expect(failure?.cause).toBeInstanceOf(D1LimitError);
    expect(String((failure?.cause as Error).message)).toMatch(/at most 100 bound parameters/);
    expect(await selectInChunks(ids, part => db.select().from(bookxSegments).where(inArray(bookxSegments.id, part)))).toEqual([]);
  });

  it("chunk id lists with room for the statement's other parameters", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    const parts = idChunks(Array.from({ length: 250 }, (_, index) => index), 10);
    expect(parts.map(part => part.length)).toEqual([90, 90, 70]);
    expect(idChunks(["a", "a", "b"])).toEqual([["a", "b"]]);
  });

  it("serialise parameters the way SQLite and D1 expect", () => {
    expect(toSqlValue(undefined)).toBeNull();
    expect(toSqlValue(true)).toBe(1);
    expect(toSqlValue(new Date(1_700_000_000_123))).toBe(1_700_000_000_123);
    expect(toSqlValue({ a: 1 })).toBe('{"a":1}');
    expect(toSqlValue(10n)).toBe(10);
  });
});

describe("database helpers", () => {
  it("insert hundreds of rows within the parameter limit and read them back intact", async () => {
    const db = await getDb();
    const chapterId = `bulk-${Date.now()}`;
    const rows = Array.from({ length: 333 }, (_, index) => ({
      id: `${chapterId}-${index}`, chapterId, text: `Line ${index} “quoted”`, orderIndex: index,
      delivery: { kind: "dialogue" as const, paragraph: index, pauseMs: 150 },
    }));
    await insertMany(db, bookxSegments, rows);
    const stored = await db.select().from(bookxSegments).where(eq(bookxSegments.chapterId, chapterId)).orderBy(bookxSegments.orderIndex);
    expect(stored).toHaveLength(333);
    expect(stored[200]).toMatchObject({ text: "Line 200 “quoted”", delivery: { kind: "dialogue", paragraph: 200, pauseMs: 150 }, renderAttempts: 0 });
    expect(stored[0]!.createdAt).toBeInstanceOf(Date);
    await db.delete(bookxSegments).where(eq(bookxSegments.chapterId, chapterId));
  });

  it("keeps millisecond timestamps, so the newest row really sorts first", async () => {
    const db = await getDb();
    const projectId = `ts-${Date.now()}`;
    await db.insert(bookxChapters).values({ id: `${projectId}-a`, projectId, title: "A" });
    await db.insert(bookxChapters).values({ id: `${projectId}-b`, projectId, title: "B" });
    const rows = await db.select().from(bookxChapters).where(eq(bookxChapters.projectId, projectId));
    expect(new Set(rows.map(row => row.createdAt.getTime())).size).toBe(2);
    expect(rows.every(row => row.createdAt.getTime() % 1000 !== 0 || row.createdAt.getTime() > 0)).toBe(true);
    const ids = await db.select().from(bookxChapters).where(inArray(bookxChapters.id, projectChapterIds(db, projectId)));
    expect(ids).toHaveLength(2);
    await db.delete(bookxChapters).where(eq(bookxChapters.projectId, projectId));
  });

  it("upserts users on their open id", async () => {
    const openId = `user-${Date.now()}`;
    await upsertUser({ openId, name: "First", email: "a@example.com", loginMethod: "cloudflare-access" });
    await upsertUser({ openId, name: "Second" });
    const user = await getUserByOpenId(openId);
    expect(user).toMatchObject({ openId, name: "Second", email: "a@example.com", role: "user" });
    const db = await getDb();
    await db.delete(users).where(eq(users.openId, openId));
  });

  it("splits a chapter too big for one D1 row at paragraph breaks", () => {
    const paragraph = "word ".repeat(40_000).trim(); // ~200 KB
    const body = Array.from({ length: 20 }, () => paragraph).join("\n\n"); // ~4 MB
    const parts = splitOversizedChapters([{ title: "Everything", body, kind: "chapter" }]);
    expect(parts.length).toBe(3);
    expect(parts.map(part => part.title)).toEqual(["Everything", "Everything (part 2)", "Everything (part 3)"]);
    expect(parts.every(part => Buffer.byteLength(part.body) <= MAX_CHAPTER_BODY_BYTES && part.kind === "chapter")).toBe(true);
    expect(parts.map(part => part.body).join("\n\n")).toBe(body);
    const giant = "x".repeat(MAX_CHAPTER_BODY_BYTES * 2 + 10);
    const cut = splitOversizedChapters([{ title: "One line", body: giant }]);
    expect(cut.map(part => part.body.length)).toEqual([MAX_CHAPTER_BODY_BYTES, MAX_CHAPTER_BODY_BYTES, 10]);
  });
});

describe("a book with more chapters than D1 allows parameters", () => {
  it("imports, lists, selects, segments, audits and deletes 150 chapters", async () => {
    const owner = caller(990_301, "long-book-owner");
    const { id: projectId } = await owner.bookx.createProject({
      title: "Long book", author: "Bookx QA", kind: "audiobook", narrationStyle: "narrator-cast",
      voiceProvider: "Cloudflare", voiceModel: "@cf/deepgram/aura-2-en", languageModelProvider: "Cloudflare", languageModel: "@cf/openai/gpt-oss-120b", language: "English",
    });
    try {
      const text = Array.from({ length: 150 }, (_, index) => `Chapter ${index + 1}\n\nThe road went on, and on, for the ${index + 1}th time. “Keep going,” said Mira.`).join("\n\n");
      const imported = await owner.bookx.importManuscript({ projectId, filename: "long.txt", base64: Buffer.from(text).toString("base64"), mode: "replace" });
      expect(imported.imported).toBe(150);

      const workspace = await owner.bookx.getWorkspace({ projectId });
      expect(workspace.chapters).toHaveLength(150);
      const ids = workspace.chapters.map(chapter => chapter.id);
      await owner.bookx.setChaptersIncluded({ projectId, chapterIds: ids, included: false });
      await owner.bookx.setChaptersIncluded({ projectId, chapterIds: ids, included: true });
      await owner.bookx.reorderChapters({ projectId, chapterIds: [...ids].reverse() });

      const segmented = await owner.bookx.resegmentChapters({ projectId });
      expect(segmented.created).toBeGreaterThanOrEqual(300);
      const status = await owner.bookx.narrationStatus({ projectId });
      expect(status.chapters).toHaveLength(150);
      expect(status.chapters[0]!.title).toBe("Chapter 150");
      const audit = await owner.bookx.auditNarration({ projectId });
      expect(audit.missingSegments.length).toBe(segmented.created);
      const readiness = await owner.bookx.exportReadiness({ projectId });
      expect(readiness.chapters).toHaveLength(150);
      expect(readiness.ready).toBe(false);

      // Replacing the manuscript removes all 150 chapters and their lines.
      await owner.bookx.importManuscript({ projectId, filename: "short.txt", base64: Buffer.from("Chapter 1\n\nOnly this.").toString("base64"), mode: "replace" });
      expect((await owner.bookx.getWorkspace({ projectId })).chapters).toHaveLength(1);
      const db = await getDb();
      expect(await selectInChunks(ids, part => db.select({ id: bookxSegments.id }).from(bookxSegments).where(inArray(bookxSegments.chapterId, part)))).toEqual([]);
    } finally {
      await owner.bookx.deleteProject({ projectId });
    }
  }, 60_000);
});
