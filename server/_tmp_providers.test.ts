// Temporary verification for provider key management and new providers; deleted after the run.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { upsertUser, getUserByOpenId } from "./db";
import { appRouter } from "./routers";
import { normalizeCustomBaseUrl, providerUrlProblem } from "./customProviders";
import { availableProviders, getCloudflareEndpoint } from "./providerCredentials";
import { transcribeAudioRoute } from "./providerRouting";
import { buildFishAudioBody, buildGradiumBody, gradiumErrorStatus, pcm16MonoToWav, renderSegmentAudio } from "./ttsRender";
import { synthesizeNarration } from "./tts";
import { voiceCatalogFor } from "./voiceCatalog";
import { verifyAudioPayload } from "./audioIntegrity";
import { storagePut } from "./storage";
import { isCustomProviderId, parseVoiceList } from "../shared/providers";

let ownerId = 0;
function caller() {
  const user: NonNullable<TrpcContext["user"]> = {
    id: ownerId, openId: "tmp-providers", email: "tmp@example.com", name: "tmp", loginMethod: "manus", role: "user",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] });
}

/** A plausible CBR MP3: MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono frames. */
function fakeMp3(frames = 12): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0xc4;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

beforeAll(async () => {
  await upsertUser({ openId: "tmp-providers", name: "tmp", email: "tmp@example.com", loginMethod: "manus", lastSignedIn: new Date() });
  ownerId = (await getUserByOpenId("tmp-providers"))!.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("shared helpers", () => {
  it("recognises custom ids and parses voice lists", () => {
    expect(isCustomProviderId("custom:abc_DEF-123")).toBe(true);
    expect(isCustomProviderId("custom:")).toBe(false);
    expect(isCustomProviderId("custom:a/b")).toBe(false);
    expect(parseVoiceList(" alloy, nova\nonyx,, alloy ")).toEqual(["alloy", "nova", "onyx"]);
  });
});

describe("provider URL policy", () => {
  it("refuses Bookx's own hosts, credentials in URLs and plain http", () => {
    expect(providerUrlProblem("http://d1.bookx/query")).toMatch(/reserved/);
    expect(providerUrlProblem("https://r2.bookx")).toMatch(/reserved/);
    expect(providerUrlProblem("https://user:pass@api.example.com/v1")).toMatch(/API key field/);
    expect(providerUrlProblem("http://api.example.com/v1")).toMatch(/https/);
    expect(providerUrlProblem("ftp://api.example.com")).toMatch(/https/);
    expect(providerUrlProblem("not a url")).toMatch(/full address/);
    expect(providerUrlProblem("https://api.example.com/v1")).toBeNull();
  });
  it("allows local addresses only outside the hosted container", () => {
    expect(providerUrlProblem("http://localhost:8880/v1", { allowLocal: true })).toBeNull();
    expect(providerUrlProblem("http://127.0.0.1:8880/v1", { allowLocal: false })).toMatch(/cannot reach/);
    expect(providerUrlProblem("https://10.1.2.3/v1", { allowLocal: false })).toMatch(/cannot reach/);
    expect(providerUrlProblem("https://169.254.169.254/latest", { allowLocal: false })).toMatch(/cannot reach/);
    expect(providerUrlProblem("https://[::1]/v1", { allowLocal: false })).toMatch(/cannot reach/);
    expect(providerUrlProblem("http://192.168.1.10/v1", { allowLocal: true })).toBeNull();
  });
  it("strips endpoint suffixes from a pasted base URL", () => {
    expect(normalizeCustomBaseUrl("https://api.example.com/v1/audio/speech/")).toBe("https://api.example.com/v1");
    expect(normalizeCustomBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeCustomBaseUrl("https://api.example.com/openai/v1/models")).toBe("https://api.example.com/openai/v1");
  });
});

describe("Gradium", () => {
  it("asks for PCM and wraps it as a valid WAV", () => {
    expect(buildGradiumBody("Hi", "default", "iris-narrative")).toEqual({ text: "Hi", voice_id: "YTpq7expH9539ERJ", output_format: "pcm_44100", only_audio: true });
    expect(buildGradiumBody("Hi", "gradium-tts-beta", "POBHtemksfWQbng0")).toMatchObject({ voice_id: "POBHtemksfWQbng0", model_name: "gradium-tts-beta" });
    const wav = pcm16MonoToWav(Buffer.alloc(88_201));
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    const verdict = verifyAudioPayload(wav, { text: "A sentence of about sixty characters for the length check." });
    expect(verdict.ok).toBe(true);
    expect(verdict.inspection.durationMs).toBe(1000);
    expect(gradiumErrorStatus(500, "error from server 401: invalid key")).toBe(401);
    expect(gradiumErrorStatus(500, "boom")).toBe(500);
  });

  it("renders a segment to a stored WAV", async () => {
    vi.stubEnv("GRADIUM_API_KEY", "gradium-test-key-0000");
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(88_200), { status: 200, headers: { "content-type": "audio/pcm" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await renderSegmentAudio({ projectId: "tmp-gradium", segmentId: "s1", provider: "Gradium", model: "default", voiceId: "POBHtemksfWQbng0", text: "A sentence of about sixty characters for the length check.", ownerId });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.gradium.ai/api/post/speech/tts");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "gradium-test-key-0000" });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ voice_id: "POBHtemksfWQbng0", output_format: "pcm_44100", only_audio: true });
    expect(result.storageKey).toMatch(/\.wav$/);
    expect(result.inspection).toMatchObject({ container: "wav", durationMs: 1000 });
  });

  it("treats an embedded 401 as an auth failure, not a retryable 500", async () => {
    vi.stubEnv("GRADIUM_API_KEY", "gradium-test-key-0000");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error from server 401: invalid api key", { status: 500 })));
    const failure = await renderSegmentAudio({ projectId: "tmp-gradium", segmentId: "s2", provider: "Gradium", model: "default", text: "Hello there, this is a short line.", ownerId }).catch(error => error as Error & { classification?: { kind: string; retryable: boolean } });
    expect(failure.classification).toMatchObject({ kind: "auth", retryable: false });
  });

  it("lists voices from the API with tags", async () => {
    vi.stubEnv("GRADIUM_API_KEY", "gradium-test-key-1111");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([
      { uid: "POBHtemksfWQbng0", name: "Garrett", description: "Smooth", is_catalog: true, language: "en", tags: [{ category: "gender", value: "Masculine" }] },
      { uid: "myCloneVoice0001", name: "My clone", is_catalog: false, tags: [] },
    ])));
    const voices = await voiceCatalogFor("Gradium", ownerId);
    expect(voices[0]).toMatchObject({ id: "myCloneVoice0001", provider: "Gradium" });
    expect(voices.find(voice => voice.id === "POBHtemksfWQbng0")).toMatchObject({ label: "Garrett", gender: "male" });
  });
});

describe("Fish Audio", () => {
  it("builds a pinned-voice MP3 request", () => {
    expect(buildFishAudioBody("Hi", "iris-narrative")).toMatchObject({ reference_id: "9a9cf47702da476aa4629e2506d4a857", format: "mp3", mp3_bitrate: 128, sample_rate: 44100 });
    expect(buildFishAudioBody("Hi", "933563129E564B19A115BEDD57B7406A")).toMatchObject({ reference_id: "933563129e564b19a115bedd57b7406a" });
  });

  it("previews through the shared request, with the model header", async () => {
    vi.stubEnv("FISH_AUDIO_API_KEY", "fish-test-key-00000000");
    const fetchMock = vi.fn().mockResolvedValue(new Response(fakeMp3(), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesizeNarration({ provider: "Fish Audio", projectId: "tmp-fish", text: "Hello from Fish Audio.", voiceId: "933563129e564b19a115bedd57b7406a", ownerId });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer fish-test-key-00000000", model: "s2.1-pro" });
    expect(result).toMatchObject({ provider: "Fish Audio", fallback: false });
    expect(result.storageKey).toMatch(/\.mp3$/);
  });

  it("transcribes with the ASR endpoint", async () => {
    vi.stubEnv("FISH_AUDIO_API_KEY", "fish-test-key-00000000");
    const stored = await storagePut("bookx/tmp-fish/source/clip.mp3", fakeMp3(), "audio/mpeg");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "hello world", duration: 1, segments: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await transcribeAudioRoute({ provider: "Fish Audio", audioStorageKey: stored.key, ownerId });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.fish.audio/v1/asr");
    expect(((fetchMock.mock.calls[0]![1] as RequestInit).body as FormData).get("audio")).toBeTruthy();
    expect(result).toMatchObject({ text: "hello world", provider: "Fish Audio" });
  });

  it("lists the account's own voices first", async () => {
    vi.stubEnv("FISH_AUDIO_API_KEY", "fish-test-key-22222222");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("self=true")) return Response.json({ total: 1, items: [{ _id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "My voice", type: "tts", state: "trained", tags: ["female"], languages: ["en"] }] });
      return Response.json({ total: 1, items: [{ _id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", title: "Public", type: "tts", state: "trained", tags: ["male", "young"] }] });
    }));
    const voices = await voiceCatalogFor("Fish Audio", ownerId);
    expect(voices.map(voice => voice.id)).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
    expect(voices[1]).toMatchObject({ gender: "male", age: "young" });
  });
});

describe("custom providers", () => {
  it("validates, saves, lists, narrates, edits and removes one", async () => {
    const api = caller();
    await expect(api.providers.saveCustomProvider({ label: "Kokoro", baseUrl: "https://tts.example.com/v1", ttsModel: "kokoro", voices: [] })).rejects.toThrow(/at least one voice/);
    await expect(api.providers.saveCustomProvider({ label: "Evil", baseUrl: "http://d1.bookx", ttsModel: "x", voices: ["a"] })).rejects.toThrow(/reserved/);
    await expect(api.providers.saveCustomProvider({ label: "None", baseUrl: "https://tts.example.com/v1", voices: ["a"] })).rejects.toThrow(/voice model, a transcription model/);

    const { id } = await api.providers.saveCustomProvider({ label: "Kokoro", baseUrl: "https://tts.example.com/v1/audio/speech", apiKey: "kokoro-secret-key-123456", ttsModel: "kokoro", sttModel: "whisper-1", voices: ["af_heart", "am_adam"] });
    expect(isCustomProviderId(id)).toBe(true);

    const catalog = await api.providers.catalog();
    const entry = catalog.find(item => item.id === id)!;
    expect(entry).toMatchObject({ label: "Kokoro", configured: true, keySource: "app", keyHint: "…3456", capabilities: ["text-to-speech", "speech-to-text"] });
    expect(entry.custom).toEqual({ baseUrl: "https://tts.example.com/v1", ttsModel: "kokoro", sttModel: "whisper-1", voices: ["af_heart", "am_adam"] });
    expect(JSON.stringify(catalog)).not.toContain("kokoro-secret-key-123456");
    expect(catalog.map(item => item.id)).toEqual(expect.arrayContaining(["Fish Audio", "Gradium"]));

    expect(await availableProviders(ownerId, "text-to-speech")).toContain(id);
    expect(await availableProviders(ownerId, "language-model")).not.toContain(id);
    expect((await api.providers.voiceCatalog({ provider: id })).map(voice => voice.id)).toEqual(["af_heart", "am_adam"]);

    const fetchMock = vi.fn(async () => new Response(fakeMp3(), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const preview = await synthesizeNarration({ provider: id, projectId: "tmp-custom", text: "Hello from my own provider.", voiceId: "21m00Tcm4TlvDq8ikWAM", ownerId });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://tts.example.com/v1/audio/speech");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer kokoro-secret-key-123456" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ model: "kokoro", input: "Hello from my own provider.", voice: "af_heart", response_format: "mp3" });
    expect(preview.provider).toBe(id);

    const rendered = await renderSegmentAudio({ projectId: "tmp-custom", segmentId: "c1", provider: id, model: "kokoro", voiceId: "am_adam", text: "Hello from my own provider.", ownerId });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)).voice).toBe("am_adam");
    expect(rendered.storageKey).toMatch(/\.mp3$/);

    fetchMock.mockResolvedValueOnce(Response.json({ data: [] }));
    expect(await api.providers.validate({ provider: id })).toMatchObject({ status: "connected" });
    fetchMock.mockResolvedValueOnce(new Response("bad key", { status: 401 }));
    expect(await api.providers.validate({ provider: id })).toMatchObject({ status: "degraded" });

    // Edit: keep the key when none is sent, then remove it.
    await api.providers.saveCustomProvider({ id, label: "Kokoro 2", baseUrl: "https://tts.example.com/v1", ttsModel: "kokoro", voices: ["af_heart"] });
    let edited = (await api.providers.catalog()).find(item => item.id === id)!;
    expect(edited).toMatchObject({ label: "Kokoro 2", keyHint: "…3456", capabilities: ["text-to-speech"] });
    await api.providers.saveCustomProvider({ id, label: "Kokoro 2", baseUrl: "https://tts.example.com/v1", apiKey: "", ttsModel: "kokoro", voices: ["af_heart"] });
    edited = (await api.providers.catalog()).find(item => item.id === id)!;
    expect(edited.keySource).toBeUndefined();

    expect(await api.providers.removeCustomProvider({ id })).toEqual({ removed: true });
    expect((await api.providers.catalog()).some(item => item.id === id)).toBe(false);
    // A book run is pinned to its provider, so it stops with a clear message...
    await expect(renderSegmentAudio({ projectId: "tmp-custom", segmentId: "c2", provider: id, model: "kokoro", text: "Gone now, so this cannot render.", ownerId })).rejects.toThrow(/removed/);
    // ...while a one-off preview may fall back to a connected provider, as before.
    const fallback = await synthesizeNarration({ provider: id, projectId: "tmp-custom", text: "Gone.", ownerId }).catch(error => error as Error);
    if (!(fallback instanceof Error)) expect(fallback).toMatchObject({ fallback: true });
  });

  it("refuses private addresses when hosted", async () => {
    vi.stubEnv("BOOKX_CONTAINER", "1");
    await expect(caller().providers.saveCustomProvider({ label: "Local", baseUrl: "http://localhost:8880/v1", ttsModel: "x", voices: ["a"] })).rejects.toThrow(/cannot reach/);
    await expect(caller().providers.savePreference({ provider: "OpenAI", apiBaseUrl: "https://10.0.0.5/v1" })).rejects.toThrow(/cannot reach/);
  });
});

describe("changing and removing built-in keys", () => {
  it("replaces and removes an ElevenLabs key, falling back to the deployment's", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "env-elevenlabs-key-AAAA");
    const api = caller();
    let entry = (await api.providers.catalog()).find(item => item.id === "ElevenLabs")!;
    expect(entry).toMatchObject({ keySource: "environment", keyHint: "…AAAA", environmentKey: true });

    await api.providers.savePreference({ provider: "ElevenLabs", apiKey: "sk_saved_elevenlabs_BBBB" });
    entry = (await api.providers.catalog()).find(item => item.id === "ElevenLabs")!;
    expect(entry).toMatchObject({ keySource: "app", keyHint: "…BBBB" });

    expect(await api.providers.removeKey({ provider: "ElevenLabs" })).toEqual({ removed: true });
    entry = (await api.providers.catalog()).find(item => item.id === "ElevenLabs")!;
    expect(entry).toMatchObject({ keySource: "environment", keyHint: "…AAAA" });
  });

  it("uses a saved Cloudflare token even without a saved account, and removes account and token together", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-cloudflare-token-CCCC");
    const api = caller();
    await api.providers.savePreference({ provider: "Cloudflare", apiKey: "saved-cloudflare-token-DDDD" });
    expect(await getCloudflareEndpoint(ownerId)).toMatchObject({ apiKey: "saved-cloudflare-token-DDDD", apiBaseUrl: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai" });

    await api.providers.savePreference({ provider: "Cloudflare", apiBaseUrl: "https://api.cloudflare.com/client/v4/accounts/fedcba9876543210fedcba9876543210/ai" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ result: [] })));
    const entry = (await api.providers.catalog()).find(item => item.id === "Cloudflare")!;
    expect(entry).toMatchObject({ accountId: "fedcba9876543210fedcba9876543210", accountSource: "app", keyHint: "…DDDD", environmentKey: true });

    await api.providers.removeKey({ provider: "Cloudflare" });
    expect(await getCloudflareEndpoint(ownerId)).toMatchObject({ apiKey: "env-cloudflare-token-CCCC", apiBaseUrl: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai" });
    const after = (await api.providers.catalog()).find(item => item.id === "Cloudflare")!;
    expect(after).toMatchObject({ accountSource: "environment", keySource: "environment" });
  });

  it("refuses a Cloudflare endpoint on Bookx's own hosts", async () => {
    await expect(caller().providers.savePreference({ provider: "Cloudflare", apiBaseUrl: "http://r2.bookx/object" })).rejects.toThrow(/reserved/);
  });
});
