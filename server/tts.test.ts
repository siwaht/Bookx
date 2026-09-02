import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ key: "qa/fallback.mp3", url: "https://example.test/fallback.mp3" }),
}));

vi.mock("./providerRouting", () => ({
  resolveProvider: (provider: string) => ({ provider, fallback: false }),
  configuredProviders: () => ["ElevenLabs", "Deepgram", "Cloudflare", "OpenAI"],
}));

import { synthesizeNarration, validateNarrationRequest } from "./tts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * Gives every provider a credential.
 *
 * Required because a provider with no key is now skipped outright rather than
 * called with an empty Authorization header — so mocking `configuredProviders`
 * alone no longer makes a route usable. Stubbing also isolates these tests from
 * whatever happens to be in the developer's `.env`.
 */
function stubAllProviderKeys() {
  vi.stubEnv("ELEVENLABS_API_KEY", "qa-elevenlabs");
  vi.stubEnv("DEEPGRAM_API_KEY", "qa-deepgram");
  vi.stubEnv("OPENAI_API_KEY", "qa-openai");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "qa-account");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "qa-token");
}

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
    stubAllProviderKeys();
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
    stubAllProviderKeys();
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await synthesizeNarration({ provider: "ElevenLabs", projectId: "qa-elevenlabs-fallback", text: "A direct provider fallback check." });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(String(mockedFetch.mock.calls[1]?.[0])).toContain("api.deepgram.com");
    expect(result).toMatchObject({ provider: "Deepgram", fallback: true, storageKey: "qa/fallback.mp3" });
  });

  it("terminates after a single pass when every configured provider fails", async () => {
    stubAllProviderKeys();
    const mockedFetch = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", mockedFetch);

    await expect(synthesizeNarration({ provider: "Cloudflare", projectId: "qa-exhaust", text: "Every route is down." }))
      .rejects.toThrow("no configured runtime fallback completed");

    // Cloudflare, ElevenLabs, Deepgram, OpenAI — each tried exactly once, no re-entry.
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });
});

describe("provider credentials gate narration routes", () => {
  it("skips a provider that has no key instead of calling it with an empty header", async () => {
    // Only ElevenLabs and OpenAI hold keys, so the Deepgram leg of the fallback
    // chain must be passed over rather than attempted with a blank credential.
    vi.stubEnv("ELEVENLABS_API_KEY", "qa-elevenlabs");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "qa-openai");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");

    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 9]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await synthesizeNarration({ provider: "ElevenLabs", projectId: "qa-no-key", text: "Skip the unconfigured route." });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(String(mockedFetch.mock.calls[1]?.[0])).toContain("api.openai.com");
    expect(result).toMatchObject({ provider: "OpenAI", fallback: true });
  });

  it("fails with a message naming the provider when nothing is configured", async () => {
    for (const name of ["ELEVENLABS_API_KEY", "DEEPGRAM_API_KEY", "OPENAI_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
      vi.stubEnv(name, "");
    }
    vi.stubGlobal("fetch", vi.fn());

    await expect(synthesizeNarration({ provider: "ElevenLabs", projectId: "qa-unconfigured", text: "Nothing is connected." }))
      .rejects.toThrow(/ElevenLabs is not connected/);
  });
});
