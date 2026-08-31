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

describe("Bookx segment ownership", () => {
  it("rejects cross-project segment updates and deletes even with a valid own project id", async () => {
    const owner = appRouter.createCaller(createAuthContext(990_001, "ownership-owner"));
    const intruder = appRouter.createCaller(createAuthContext(990_002, "ownership-intruder"));
    const stamp = Date.now();

    const owned = await owner.bookx.createProject({
      title: `Ownership QA owner ${stamp}`,
      author: "Bookx QA",
      kind: "audiobook",
      narrationStyle: "single",
      voiceProvider: "OpenAI",
      voiceModel: "gpt-4o-mini-tts",
      languageModelProvider: "Cloudflare",
      languageModel: "@cf/openai/gpt-oss-120b",
      language: "English",
    });
    const foreign = await intruder.bookx.createProject({
      title: `Ownership QA intruder ${stamp}`,
      author: "Bookx QA",
      kind: "audiobook",
      narrationStyle: "single",
      voiceProvider: "OpenAI",
      voiceModel: "gpt-4o-mini-tts",
      languageModelProvider: "Cloudflare",
      languageModel: "@cf/openai/gpt-oss-120b",
      language: "English",
    });

    try {
      const chapter = await owner.bookx.createChapter({ projectId: owned.id, title: "Chapter 01", body: "The house was still awake.", orderIndex: 0 });
      const segment = await owner.bookx.createSegment({ projectId: owned.id, chapterId: chapter.id, text: "The house was still awake.", orderIndex: 0 });

      // The intruder owns `foreign`, but the segment belongs to `owned`; both must fail.
      await expect(intruder.bookx.updateSegment({ projectId: foreign.id, segmentId: segment.id, text: "Tampered." })).rejects.toThrow("Segment not found");
      await expect(intruder.bookx.deleteSegment({ projectId: foreign.id, segmentId: segment.id })).rejects.toThrow("Segment not found");

      const workspace = await owner.bookx.getWorkspace({ projectId: owned.id });
      expect(workspace.segments[0]).toMatchObject({ text: "The house was still awake." });
    } finally {
      await owner.bookx.deleteProject({ projectId: owned.id });
      await intruder.bookx.deleteProject({ projectId: foreign.id });
    }
  }, 20_000);
});
