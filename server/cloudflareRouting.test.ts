import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOUDFLARE_TTS_MODEL,
  buildCloudflareSttBody,
  buildCloudflareSttRequest,
  buildCloudflareTtsBody,
  extractCloudflareTranscript,
  isWebsocketOnlyCloudflareModel,
  normalizeCloudflareUrl,
  resolveAura2Speaker,
} from "./providerCredentials";

/**
 * Behaviour pinned from live probes against Workers AI account
 * 2c5abfb2…/ai. Each expectation below corresponds to an observed response, so a
 * regression here means the app would break against the real endpoint.
 */

describe("normalizeCloudflareUrl", () => {
  // The account URL is commonly pasted with the OpenAI-compatible `/v1` suffix.
  // Both forms must reduce to the same native base, because the LLM path appends
  // `/v1/chat/completions` and the TTS path appends `/run/<model>`.
  it("reduces every pasted form of an account URL to the native base", () => {
    const base = "https://api.cloudflare.com/client/v4/accounts/abc123/ai";
    for (const input of [base, `${base}/`, `${base}/v1`, `${base}/run`, `${base}/v1/chat/completions`]) {
      expect(normalizeCloudflareUrl(input)).toEqual({ mode: "native", apiBaseUrl: base });
    }
  });

  it("treats any other host as OpenAI-compatible", () => {
    expect(normalizeCloudflareUrl("https://gateway.ai.cloudflare.com/v1/acct/gw/compat")).toEqual({
      mode: "openai-compatible",
      apiBaseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
    });
  });

  it("strips a pasted chat-completions suffix from a compatible endpoint", () => {
    expect(normalizeCloudflareUrl("https://proxy.example.com/v1/chat/completions")?.apiBaseUrl)
      .toBe("https://proxy.example.com/v1");
  });

  it("rejects nonsense", () => {
    expect(normalizeCloudflareUrl("")).toBeNull();
    expect(normalizeCloudflareUrl("not a url")).toBeNull();
    expect(normalizeCloudflareUrl("ftp://api.cloudflare.com/client/v4/accounts/a/ai")).toBeNull();
    // Right host, but not an account AI path.
    expect(normalizeCloudflareUrl("https://api.cloudflare.com/client/v4/zones")).toBeNull();
  });
});

describe("isWebsocketOnlyCloudflareModel", () => {
  // Observed: an HTTP POST to @cf/deepgram/flux returns
  // "AiError: @cf/deepgram/flux only supports websocket connections".
  it("flags flux, which cannot serve an HTTP run at all", () => {
    expect(isWebsocketOnlyCloudflareModel("@cf/deepgram/flux")).toBe(true);
  });

  it("does not flag the models that do work over HTTP", () => {
    for (const model of ["@cf/deepgram/nova-3", "@cf/openai/whisper", "@cf/deepgram/aura-2-en"]) {
      expect(isWebsocketOnlyCloudflareModel(model)).toBe(false);
    }
  });
});

describe("buildCloudflareSttRequest", () => {
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22]);

  // Observed: Deepgram rejects the JSON byte-array form with
  // "required properties at '/audio' are 'body,contentType'", but accepts the
  // audio as the raw request body.
  it("sends raw bytes for Deepgram models", () => {
    const request = buildCloudflareSttRequest({ model: "@cf/deepgram/nova-3", audio, contentType: "audio/mpeg", apiKey: "k" });
    expect(Buffer.isBuffer(request.body)).toBe(true);
    expect(Buffer.from(request.body as Buffer).equals(Buffer.from(audio))).toBe(true);
    expect(request.headers["content-type"]).toBe("audio/mpeg");
    expect(request.headers.Authorization).toBe("Bearer k");
  });

  it("falls back to audio/mpeg when the stored content type is unknown", () => {
    const request = buildCloudflareSttRequest({ model: "@cf/deepgram/nova-3", audio, contentType: "", apiKey: "k" });
    expect(request.headers["content-type"]).toBe("audio/mpeg");
  });

  // Observed: Whisper accepts the JSON byte-array form.
  it("sends JSON with a byte array for Whisper", () => {
    const request = buildCloudflareSttRequest({ model: "@cf/openai/whisper", audio, contentType: "audio/mpeg", language: "en", apiKey: "k" });
    expect(request.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(request.body as string);
    expect(parsed.audio).toEqual([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22]);
    expect(parsed).toMatchObject({ task: "transcribe", language: "en" });
  });

  it("omits language when none is given", () => {
    const request = buildCloudflareSttRequest({ model: "@cf/openai/whisper", audio, contentType: "audio/mpeg", apiKey: "k" });
    expect(JSON.parse(request.body as string).language).toBeUndefined();
  });
});

describe("extractCloudflareTranscript", () => {
  // Observed: Whisper returns { result: { text } }.
  it("reads the Whisper shape", () => {
    expect(extractCloudflareTranscript({ result: { text: "the house was still awake" } })).toBe("the house was still awake");
  });

  // Observed: Deepgram returns { result: { results: { channels: [ { alternatives: [ { transcript } ] } ] } } }.
  it("reads the Deepgram nested shape", () => {
    const payload = { result: { results: { channels: [{ alternatives: [{ transcript: "nova three check" }] }] } } };
    expect(extractCloudflareTranscript(payload)).toBe("nova three check");
  });

  it("reads a bare string result", () => {
    expect(extractCloudflareTranscript({ result: "plain text" })).toBe("plain text");
  });

  it("returns empty for an unrecognised shape rather than throwing", () => {
    expect(extractCloudflareTranscript({ result: {} })).toBe("");
    expect(extractCloudflareTranscript(null)).toBe("");
    expect(extractCloudflareTranscript({ result: { results: { channels: [] } } })).toBe("");
  });
});

describe("buildCloudflareTtsBody", () => {
  // Observed: aura-2-en requires `speaker` to be one of its enum values and
  // returns HTTP 400 listing the enum for anything else, but succeeds with no
  // `speaker` key at all.
  it("maps a starter voice onto a real Aura-2 speaker", () => {
    expect(buildCloudflareTtsBody("@cf/deepgram/aura-2-en", "hello", "iris-narrative")).toEqual({
      text: "hello",
      encoding: "mp3",
      speaker: "iris",
    });
  });

  it("omits speaker entirely for an unknown voice id, rather than sending an invalid one", () => {
    const body = buildCloudflareTtsBody("@cf/deepgram/aura-2-en", "hello", "some-elevenlabs-uuid");
    expect(body).toEqual({ text: "hello", encoding: "mp3" });
    expect("speaker" in body).toBe(false);
  });

  it("accepts a raw Aura-2 speaker name directly", () => {
    expect(buildCloudflareTtsBody("@cf/deepgram/aura-2-en", "hello", "thalia")).toMatchObject({ speaker: "thalia" });
  });

  // Observed: melotts rejects { text } with "required properties at '/' are 'prompt'".
  it("uses prompt/lang for MeloTTS", () => {
    expect(buildCloudflareTtsBody("@cf/myshell-ai/melotts", "hello", "iris-narrative", "Spanish")).toEqual({
      prompt: "hello",
      lang: "es",
    });
  });

  it("falls back to English for an unrecognised language", () => {
    expect(buildCloudflareTtsBody("@cf/myshell-ai/melotts", "hello", null, "Klingon")).toEqual({ prompt: "hello", lang: "en" });
  });
});

describe("resolveAura2Speaker", () => {
  it("maps every starter voice to a speaker Aura-2 accepts", () => {
    // Enum observed in the HTTP 400 response from aura-2-en.
    const accepted = new Set(["iris", "orpheus", "helena", "luna", "atlas"]);
    for (const id of ["iris-narrative", "theo-dramatic", "sage-conversational", "noor-global", "rowan-deep"]) {
      const speaker = resolveAura2Speaker(id);
      expect(speaker, `${id} should map to a real speaker`).toBeDefined();
      expect(accepted.has(speaker!), `${id} -> ${speaker}`).toBe(true);
    }
  });

  it("returns undefined for anything it cannot vouch for", () => {
    expect(resolveAura2Speaker("21m00Tcm4TlvDq8ikWAM")).toBeUndefined();
    expect(resolveAura2Speaker(null)).toBeUndefined();
  });
});

describe("DEFAULT_CLOUDFLARE_TTS_MODEL", () => {
  // MeloTTS returned intermittent 500s for an identical request during probing,
  // so it must not be the default a multi-hour book points at.
  it("is Aura-2 rather than MeloTTS", () => {
    expect(DEFAULT_CLOUDFLARE_TTS_MODEL).toBe("@cf/deepgram/aura-2-en");
  });
});

describe("buildCloudflareSttBody", () => {
  it("still supports the legacy Whisper-only helper", () => {
    const body = buildCloudflareSttBody("@cf/openai/whisper", new Uint8Array([1, 2]), "en");
    expect(body).toEqual({ audio: [1, 2], task: "transcribe", language: "en" });
  });
});
