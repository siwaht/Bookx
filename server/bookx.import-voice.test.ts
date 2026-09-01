import { describe, expect, it, vi } from "vitest";

vi.mock("./tts", () => ({
  synthesizeNarration: vi.fn().mockResolvedValue({
    clipId: "library-preview-clip",
    storageKey: "bookx/qa/narration/library-preview.mp3",
    audioUrl: "https://example.test/library-preview.mp3",
    provider: "ElevenLabs",
    fallback: false,
  }),
}));

import { appRouter } from "./routers";
import { MAX_PODCAST_SOURCE_BYTES, validatePodcastSource } from "./routers/bookx";
import { rankVoiceMatches, type DiscoverableVoice } from "./routers/providers";
import { synthesizeNarration } from "./tts";
import type { TrpcContext } from "./_core/context";
import { needs, unconfigured } from "./testEnv";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "podcast-voice-qa",
    email: "qa@example.com",
    name: "Podcast Voice QA",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return { user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("Bookx podcast import and voice discovery", () => {
  it("accepts supported podcast audio and rejects unsupported or oversized uploads", () => {
    const accepted = validatePodcastSource({ filename: "episode one.mp3", mimeType: "audio/mpeg", base64: Buffer.from("audio").toString("base64") });
    expect(accepted.safeFilename).toBe("episode_one.mp3");
    expect(accepted.source.toString()).toBe("audio");
    expect(() => validatePodcastSource({ filename: "episode.txt", mimeType: "text/plain", base64: "dGV4dA==" })).toThrow("Choose an MP3");
    expect(MAX_PODCAST_SOURCE_BYTES).toBe(25 * 1024 * 1024);
  });

  it("ranks matching voice IDs and descriptive traits ahead of non-matches", () => {
    const voices: DiscoverableVoice[] = [
      { id: "iris-narrative", label: "Iris", description: "Warm calm narrative delivery", provider: "ElevenLabs" },
      { id: "theo-dramatic", label: "Theo", description: "British dramatic delivery", provider: "ElevenLabs" },
    ];
    expect(rankVoiceMatches(voices, "warm narrative")[0]?.id).toBe("iris-narrative");
    expect(rankVoiceMatches(voices, "theo-dramatic")[0]?.id).toBe("theo-dramatic");
  });

  it.skipIf(unconfigured("DATABASE_URL"))(`generates a library preview using an explicitly selected provider voice ID (${needs("DATABASE_URL")})`, async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const created = await caller.bookx.createProject({
      title: `Voice library QA ${Date.now()}`,
      author: "Bookx QA",
      kind: "podcast",
      narrationStyle: "cast",
      voiceProvider: "ElevenLabs",
      voiceModel: "eleven_multilingual_v2",
      languageModelProvider: "Cloudflare",
      languageModel: "@cf/openai/gpt-oss-120b",
      language: "English",
    });
    try {
      const preview = await caller.bookx.previewVoice({ projectId: created.id, provider: "ElevenLabs", voiceId: "iris-narrative", text: "A clear voice helps listeners follow every moment." });
      expect(preview).toMatchObject({ voiceId: "iris-narrative", storageKey: "bookx/qa/narration/library-preview.mp3" });
      expect(synthesizeNarration).toHaveBeenCalledWith(expect.objectContaining({ projectId: created.id, provider: "ElevenLabs", voiceId: "iris-narrative", model: "eleven_multilingual_v2" }));
    } finally {
      await caller.bookx.deleteProject({ projectId: created.id });
    }
  }, 20_000);
});
