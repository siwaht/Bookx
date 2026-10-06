// Reproduction test for the "old projects cannot be deleted" report.
// A project with rows in every related table must delete cleanly, and a
// project that is already gone from the database must not wedge the shelf.
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { describe, expect, it } from "vitest";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(id: number, openId: string): TrpcContext {
  const user: AuthenticatedUser = {
    id,
    openId,
    email: `${openId}@example.com`,
    name: openId,
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return { user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

const setup = {
  title: "Delete QA", author: "Bookx QA", kind: "audiobook" as const, narrationStyle: "narrator-cast" as const,
  voiceProvider: "Cloudflare", voiceModel: "@cf/deepgram/aura-2-en", languageModelProvider: "Cloudflare",
  languageModel: "@cf/openai/gpt-oss-120b", language: "English",
};

describe("deleting a project", () => {
  it("removes a project that has rows in every related table", async () => {
    const owner = appRouter.createCaller(createAuthContext(990_501, "delete-owner"));
    const { id } = await owner.bookx.createProject(setup);
    await owner.bookx.createChapter({ projectId: id, title: "Chapter 01", body: "The house was still awake.", orderIndex: 0 });
    await owner.bookx.createSegment({ projectId: id, chapterId: (await owner.bookx.getWorkspace({ projectId: id })).chapters[0]!.id, text: "The house was still awake.", orderIndex: 0 });
    await owner.bookx.createCharacter({ projectId: id, name: "Narrator", role: "Narrator" });
    await owner.bookx.createPronunciation({ projectId: id, word: "Mara", alias: "MAH-rah" });

    await owner.bookx.deleteProject({ projectId: id });

    const remaining = await owner.bookx.listProjects();
    expect(remaining.some((project) => project.id === id)).toBe(false);
    const workspace = await owner.bookx.getWorkspace({ projectId: id }).catch(() => null);
    expect(workspace).toBeNull();
  }, 30_000);

  it("succeeds when the project is already gone, so a stale shelf entry can be cleared", async () => {
    const owner = appRouter.createCaller(createAuthContext(990_502, "delete-owner-stale"));
    // A shelf entry can outlive its database row (a redeploy wiped the
    // database, or the row was removed by another session). The delete must
    // resolve — not throw "Project not found" — or the entry is wedged on the
    // shelf forever.
    await expect(owner.bookx.deleteProject({ projectId: "missing-project-id" })).resolves.toMatchObject({ success: true });
  }, 30_000);

  it("still refuses to let one account see or take another account's project", async () => {
    const owner = appRouter.createCaller(createAuthContext(990_503, "delete-owner-a"));
    const other = appRouter.createCaller(createAuthContext(990_504, "delete-owner-b"));
    const { id } = await owner.bookx.createProject(setup);
    try {
      // The intruder's delete reports the same "already gone" success without
      // touching the row, and the owner still sees their project.
      await expect(other.bookx.deleteProject({ projectId: id })).resolves.toMatchObject({ success: true });
      const remaining = await owner.bookx.listProjects();
      expect(remaining.some((project) => project.id === id)).toBe(true);
    } finally {
      await owner.bookx.deleteProject({ projectId: id });
    }
  }, 30_000);
});
