import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));

import {
  AURA_2_SPEAKERS,
  availableProviders,
  buildCloudflareSttBody,
  buildCloudflareTtsBody,
  getCloudflareEndpoint,
  normalizeCloudflareUrl,
  redactProviderApiKey,
  resolveAura2Speaker,
  resolveMelottsLanguage,
} from "./providerCredentials";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeCloudflareUrl", () => {
  const nativeBase = "https://api.cloudflare.com/client/v4/accounts/abc123/ai";

  it.each([
    "https://api.cloudflare.com/client/v4/accounts/abc123/ai",
    "https://api.cloudflare.com/client/v4/accounts/abc123/ai/",
    "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
    "https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/myshell-ai/melotts",
    "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions",
  ])("normalizes the pasted native URL %s to the /ai base", (raw) => {
    expect(normalizeCloudflareUrl(raw)).toEqual({ mode: "native", apiBaseUrl: nativeBase });
  });

  it("treats any other host as an OpenAI-compatible endpoint and strips pasted suffixes", () => {
    expect(normalizeCloudflareUrl("https://gateway.ai.cloudflare.com/v1/acc/gw/compat/")).toEqual({ mode: "openai-compatible", apiBaseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat" });
    expect(normalizeCloudflareUrl("https://llm.example.com/v1/chat/completions")).toEqual({ mode: "openai-compatible", apiBaseUrl: "https://llm.example.com/v1" });
  });

  it("rejects empty, malformed, non-http, and non-AI Cloudflare URLs", () => {
    expect(normalizeCloudflareUrl("")).toBeNull();
    expect(normalizeCloudflareUrl("not a url")).toBeNull();
    expect(normalizeCloudflareUrl("ftp://example.com/v1")).toBeNull();
    expect(normalizeCloudflareUrl("https://api.cloudflare.com/client/v4/accounts/abc123/")).toBeNull();
  });
});

describe("Aura-2 speaker resolution", () => {
  it("maps starter voice ids and passes raw speaker names through", () => {
    expect(resolveAura2Speaker("iris-narrative")).toBe("iris");
    expect(resolveAura2Speaker("theo-dramatic")).toBe("orpheus");
    expect(resolveAura2Speaker("ZeuS")).toBe("zeus");
    expect(AURA_2_SPEAKERS).toContain("helena");
  });

  it("returns undefined for unmappable voices", () => {
    expect(resolveAura2Speaker("not-a-speaker")).toBeUndefined();
    expect(resolveAura2Speaker(undefined)).toBeUndefined();
  });
});

describe("resolveMelottsLanguage", () => {
  it("maps full language names and ISO-ish codes onto MeloTTS codes", () => {
    expect(resolveMelottsLanguage("French")).toBe("fr");
    expect(resolveMelottsLanguage("es")).toBe("es");
    expect(resolveMelottsLanguage(undefined)).toBe("en");
  });

  it("falls back to English for unsupported languages", () => {
    expect(resolveMelottsLanguage("German")).toBe("en");
  });
});

describe("buildCloudflareTtsBody", () => {
  it("builds the Aura-2 request with the mapped starter voice speaker", () => {
    expect(buildCloudflareTtsBody("@cf/deepgram/aura-2-en", "Hello there.", "iris-narrative")).toEqual({ text: "Hello there.", encoding: "mp3", speaker: "iris" });
  });

  it("passes a raw Aura-2 speaker name straight through", () => {
    expect(buildCloudflareTtsBody("@cf/deepgram/aura-2-en", "Hello.", "Orpheus")).toEqual({ text: "Hello.", encoding: "mp3", speaker: "orpheus" });
  });

  it("omits the speaker when the voice cannot be mapped to Aura-2", () => {
    expect(buildCloudflareTtsBody("@cf/deepgram/aura-2-en", "Hello.", "some-unknown-voice")).toEqual({ text: "Hello.", encoding: "mp3" });
  });

  it("builds the MeloTTS prompt body with a mapped language", () => {
    expect(buildCloudflareTtsBody("@cf/myshell-ai/melotts", "Bonjour.", undefined, "French")).toEqual({ prompt: "Bonjour.", lang: "fr" });
  });

  it("defaults unknown models to the common prompt shape", () => {
    expect(buildCloudflareTtsBody("@cf/vendor/custom-tts", "Hello.")).toEqual({ prompt: "Hello.", lang: "en" });
  });
});

describe("buildCloudflareSttBody", () => {
  it("adds the transcribe task and language for whisper models", () => {
    expect(buildCloudflareSttBody("@cf/openai/whisper", new Uint8Array([1, 2, 3]), "English")).toEqual({ audio: [1, 2, 3], task: "transcribe", language: "English" });
  });

  it("sends only the audio payload for non-whisper models", () => {
    expect(buildCloudflareSttBody("@cf/deepgram/nova-3", new Uint8Array([4, 5]))).toEqual({ audio: [4, 5] });
  });
});

describe("getCloudflareEndpoint", () => {
  it("falls back to environment credentials in native mode", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "env-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    expect(await getCloudflareEndpoint()).toMatchObject({ mode: "native", apiBaseUrl: "https://api.cloudflare.com/client/v4/accounts/env-account/ai", apiKey: "env-token" });
  });

  it("returns null when nothing is configured", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    expect(await getCloudflareEndpoint()).toBeNull();
  });
});

describe("availableProviders", () => {
  it("adds Cloudflare when the environment configures it", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "env-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    expect(await availableProviders()).toContain("Cloudflare");
  });
});

describe("redactProviderApiKey", () => {
  it("never returns the stored key value", () => {
    const redacted = redactProviderApiKey({ id: "row-1", provider: "Cloudflare", apiKey: "super-secret", defaultTtsModel: null });
    expect(redacted).toEqual({ id: "row-1", provider: "Cloudflare", defaultTtsModel: null, apiKeyConfigured: true });
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
  });

  it("reports false when no key is stored", () => {
    expect(redactProviderApiKey({ provider: "OpenAI", apiKey: null })).toEqual({ provider: "OpenAI", apiKeyConfigured: false });
  });
});
