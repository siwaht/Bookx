import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { projectReadiness } from "../shared/bookx";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return { user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("Bookx isolated multi-cast podcast workflow", () => {
  it("creates, casts, mixes, reviews, and prepares a Podcast package without retaining QA data", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const created = await caller.bookx.createProject({
      title: `Automated podcast workflow QA ${Date.now()}`,
      author: "Bookx QA",
      kind: "podcast",
      narrationStyle: "cast",
      voiceProvider: "Deepgram",
      voiceModel: "aura-2-thalia-en",
      languageModelProvider: "Cloudflare",
      languageModel: "@cf/openai/gpt-oss-120b",
      language: "English",
    });
    try {
      await caller.bookx.replaceCharacters({ projectId: created.id, characters: [
        { name: "Host", role: "Host", voiceId: "Iris", voiceName: "Iris", sampleLine: "Welcome to the show.", assignmentConfidence: 93, assignmentSource: "llm" },
        { name: "Guest", role: "Guest", voiceId: "Theo", voiceName: "Theo", sampleLine: "Thank you for having me.", assignmentConfidence: 89, assignmentSource: "llm" },
      ] });
      const music = await caller.bookx.addStudioAsset({ projectId: created.id, type: "music", title: "Opening Bed", durationMs: 12_000 });
      const effect = await caller.bookx.addStudioAsset({ projectId: created.id, type: "sound-effect", title: "Page Turn", durationMs: 800 });
      await caller.bookx.placeTimelineClip({ projectId: created.id, assetId: music.id, trackType: "music", startMs: 0, durationMs: 12_000, volume: 35, duckUnderNarration: true });
      await caller.bookx.placeTimelineClip({ projectId: created.id, assetId: effect.id, trackType: "sound-effect", startMs: 4_000, durationMs: 800, volume: 70, duckUnderNarration: false });
      const exportRequest = await caller.bookx.requestExport({ projectId: created.id, format: "Podcast" });
      const workspace = await caller.bookx.getWorkspace({ projectId: created.id });
      const studio = await caller.bookx.listStudio({ projectId: created.id });

      expect(workspace.characters).toHaveLength(2);
      expect(workspace.exports).toEqual(expect.arrayContaining([expect.objectContaining({ id: exportRequest.id, format: "Podcast", status: "queued" })]));
      expect(studio.assets).toHaveLength(2);
      expect(studio.clips).toHaveLength(2);
      expect(projectReadiness({ chapterCount: 1, generatedChapters: 1, hasCast: true, hasTimeline: studio.clips.length > 0 }).readyToExport).toBe(true);
    } finally {
      await caller.bookx.deleteProject({ projectId: created.id });
    }
  }, 20_000);
});
