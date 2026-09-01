import { describe, expect, it, vi } from "vitest";

vi.mock("./tts", () => ({
  synthesizeNarration: vi.fn().mockResolvedValue({
    clipId: "preview-clip",
    storageKey: "bookx/qa/narration/narrator-preview.mp3",
    audioUrl: "https://example.test/narrator-preview.mp3",
    provider: "Deepgram",
    fallback: false,
  }),
}));

import { appRouter } from "./routers";
import { synthesizeNarration } from "./tts";
import type { TrpcContext } from "./_core/context";
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

describe.skipIf(unconfigured("DATABASE_URL"))(`Bookx character preview (${needs("DATABASE_URL")})`, () => {
  it("uses the persisted character voice and saves the generated preview key", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const created = await caller.bookx.createProject({
      title: `Automated preview QA ${Date.now()}`,
      author: "Bookx QA",
      kind: "audiobook",
      narrationStyle: "cast",
      voiceProvider: "Deepgram",
      voiceModel: "aura-2-thalia-en",
      languageModelProvider: "Cloudflare",
      languageModel: "@cf/openai/gpt-oss-120b",
      language: "English",
    });
    try {
      const character = await caller.bookx.createCharacter({
        projectId: created.id,
        name: "Narrator",
        role: "Narrator",
        voiceId: "Iris",
        voiceName: "Iris",
        sampleLine: "The house was still awake when Mara returned.",
        assignmentSource: "llm",
      });

      const preview = await caller.bookx.previewCharacterVoice({ projectId: created.id, characterId: character.id, provider: "Deepgram" });
      expect(preview).toMatchObject({ characterId: character.id, voiceId: "Iris", storageKey: "bookx/qa/narration/narrator-preview.mp3" });
      expect(synthesizeNarration).toHaveBeenCalledWith(expect.objectContaining({ provider: "Deepgram", voiceId: "Iris", model: "aura-2-thalia-en" }));

      const workspace = await caller.bookx.getWorkspace({ projectId: created.id });
      expect(workspace.characters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: character.id,
          previewStorageKey: "bookx/qa/narration/narrator-preview.mp3",
          previewUrl: "/manus-storage/bookx/qa/narration/narrator-preview.mp3",
        }),
      ]));
    } finally {
      await caller.bookx.deleteProject({ projectId: created.id });
    }
  }, 20_000);
});
