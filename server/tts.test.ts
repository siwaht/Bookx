import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ key: "qa/fallback.mp3", url: "https://example.test/fallback.mp3" }),
}));

vi.mock("./providerRouting", () => ({
  resolveProvider: (provider: string) => ({ provider, fallback: false }),
}));

import { synthesizeNarration, validateNarrationRequest } from "./tts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bookx narration request validation", () => {
  it("normalizes an eligible narration request", () => {
    expect(validateNarrationRequest({ provider: "OpenAI", text: "  The tide was turning.  ", voiceId: "alloy" })).toEqual({
      provider: "OpenAI",
      text: "The tide was turning.",
      voiceId: "alloy",
    });
  });

  it("rejects empty and oversized narration text", () => {
    expect(() => validateNarrationRequest({ provider: "ElevenLabs", text: "   " })).toThrow("Narration text is required");
    expect(() => validateNarrationRequest({ provider: "ElevenLabs", text: "a".repeat(4_001) })).toThrow("4,000");
  });

  it("skips failed Cloudflare and ElevenLabs narration responses for the next configured route", async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await synthesizeNarration({ provider: "Cloudflare", projectId: "qa-fallback", text: "A short fallback check." });

    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ provider: "Deepgram", fallback: true, storageKey: "qa/fallback.mp3" });
  });

  it("falls through from ElevenLabs directly to Deepgram when ElevenLabs fails", async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await synthesizeNarration({ provider: "ElevenLabs", projectId: "qa-elevenlabs-fallback", text: "A direct provider fallback check." });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(String(mockedFetch.mock.calls[1]?.[0])).toContain("api.deepgram.com");
    expect(result).toMatchObject({ provider: "Deepgram", fallback: true, storageKey: "qa/fallback.mp3" });
  });
});
