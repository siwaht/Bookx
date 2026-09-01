import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { describe, expect, it } from "vitest";
import { needs, unconfigured } from "./testEnv";

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

describe.skipIf(unconfigured("DATABASE_URL"))(`Bookx character persistence (${needs("DATABASE_URL")})`, () => {
  it("persists model-ready character assignments on a saved project and removes the isolated test record", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const created = await caller.bookx.createProject({
      title: `Automated persistence QA ${Date.now()}`,
      author: "Bookx QA",
      kind: "audiobook",
      narrationStyle: "cast",
      voiceProvider: "OpenAI",
      voiceModel: "gpt-4o-mini-tts",
      languageModelProvider: "Cloudflare",
      languageModel: "@cf/openai/gpt-oss-120b",
      language: "English",
    });

    try {
      await caller.bookx.replaceCharacters({
        projectId: created.id,
        characters: [{
          name: "Narrator",
          role: "Narrator",
          voiceId: "Iris",
          voiceName: "Iris",
          accent: "Warm",
          voiceRationale: "Keeps the narrative intimate and distinct.",
          sampleLine: "The house was still awake when Mara returned.",
          previewStorageKey: "bookx/qa/narration/narrator-preview.mp3",
          assignmentConfidence: 92,
          assignmentSource: "llm",
        }],
      });

      const workspace = await caller.bookx.getWorkspace({ projectId: created.id });
      const [narrator] = workspace.characters;
      expect(narrator).toBeDefined();
      await caller.bookx.updateCharacterByName({
        projectId: created.id,
        name: narrator!.name,
        voiceId: "Noor",
        voiceName: "Noor",
        assignmentSource: "manual",
      });

      const updatedWorkspace = await caller.bookx.getWorkspace({ projectId: created.id });
      expect(workspace.characters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "Narrator",
          voiceId: "Iris",
          previewStorageKey: "bookx/qa/narration/narrator-preview.mp3",
          assignmentConfidence: 92,
          assignmentSource: "llm",
        }),
      ]));
      expect(updatedWorkspace.characters).toEqual(expect.arrayContaining([
        expect.objectContaining({ voiceId: "Noor", voiceName: "Noor", assignmentSource: "manual" }),
      ]));
    } finally {
      await caller.bookx.deleteProject({ projectId: created.id });
    }
  }, 20_000);
});
