import { nanoid } from "nanoid";
import { storagePut } from "./storage";
import { inspectAudio } from "./audioIntegrity";
import { ProviderConfigurationError } from "./narrationRetry";
import { resolveProvider, type ProviderId } from "./providerRouting";
import { DEFAULT_CLOUDFLARE_TTS_MODEL, availableProviders, buildCloudflareTtsBody, cloudflareHeaders, getCloudflareEndpoint, requireProviderApiKey } from "./providerCredentials";
import { FISH_AUDIO_DEFAULT_MODEL, GRADIUM_DEFAULT_MODEL, buildElevenLabsBody, buildProviderCall, decodeProviderAudio, openAiVoice, type ProviderCall } from "./ttsRender";
import { billedCharacters, recordUsage } from "./usage";

export type TtsProvider = ProviderId;

export type NarrationRequest = {
  provider: TtsProvider;
  projectId: string;
  text: string;
  voiceId?: string;
  model?: string;
  language?: string;
  /** Owner whose saved provider credentials should be used, if any. */
  ownerId?: number;
};

export function validateNarrationRequest(input: NarrationRequest) {
  const text = input.text.trim();
  if (!text) throw new Error("Narration text is required");
  if (text.length > 4_000) throw new Error("Narration requests are limited to 4,000 characters per clip");
  return { ...input, text, voiceId: input.voiceId?.trim() || undefined };
}

export async function synthesizeNarration(input: NarrationRequest): Promise<{ clipId: string; storageKey: string; audioUrl: string; provider: TtsProvider; fallback: boolean }> {
  return synthesizeNarrationAttempt(input, new Set());
}

/**
 * Single synthesis attempt. `tried` carries the providers already attempted
 * in this chain so a failing fallback can never re-enter a previous provider
 * and recurse forever.
 */
async function synthesizeNarrationAttempt(input: NarrationRequest, tried: Set<TtsProvider>): Promise<{ clipId: string; storageKey: string; audioUrl: string; provider: TtsProvider; fallback: boolean }> {
  const requested = validateNarrationRequest(input);
  if (!requested.projectId) throw new Error("A project is required to store generated narration");
  const available = await availableProviders(requested.ownerId, "text-to-speech");
  const resolved = resolveProvider(requested.provider, "text-to-speech", available);
  const provider = resolved.provider;
  tried.add(provider);
  // A model or voice id only means something to the provider it was chosen
  // for; another provider gets its own defaults instead of a request it rejects.
  const request = provider === requested.provider ? requested : { ...requested, model: undefined, voiceId: undefined };

  let shared: ProviderCall | null = null;
  let response: Response | null = null;
  let failure = "";
  try {
    // Fish Audio, Gradium and the user's own providers use the same request as
    // book narration, so a preview sounds exactly like the finished chapter.
    shared = provider === "ElevenLabs" || provider === "Deepgram" || provider === "Cloudflare" || provider === "OpenAI"
      ? null
      : await buildProviderCall({
        provider,
        model: request.model || (provider === "Fish Audio" ? FISH_AUDIO_DEFAULT_MODEL : provider === "Gradium" ? GRADIUM_DEFAULT_MODEL : ""),
        voiceId: request.voiceId,
        text: request.text,
        language: request.language,
        ownerId: request.ownerId,
      }, AbortSignal.timeout(120_000));
    response = await providerResponse(provider, request, shared);
    if (!response.ok) failure = `with HTTP ${response.status}`;
  } catch (error) {
    // A thrown error (no key, network, timeout) gets the same fallback as an HTTP one.
    failure = `(${error instanceof Error ? error.message : String(error)})`;
  }

  if (!response?.ok) {
    const candidates: TtsProvider[] = ["ElevenLabs", "Deepgram", "OpenAI", "Cloudflare", "Fish Audio", "Gradium"];
    for (const candidate of candidates) {
      if (tried.has(candidate) || !available.includes(candidate)) continue;
      tried.add(candidate);
      try {
        const fallbackResult = await synthesizeNarrationAttempt({ ...request, provider: candidate, model: undefined, voiceId: undefined }, tried);
        return { ...fallbackResult, fallback: true };
      } catch {
        // Continue to the next configured route; the final error keeps the original provider context.
      }
    }
    throw new Error(`${provider} narration failed ${failure}; no configured runtime fallback completed`);
  }

  const contentType = response.headers.get("content-type") || "";
  let buffer: Buffer;
  if (shared) {
    buffer = decodeProviderAudio(shared, Buffer.from(await response.arrayBuffer()), contentType);
  } else {
    const responseBody = contentType.includes("application/json") ? await response.json() as { result?: { audio?: string } | string } : null;
    const base64Audio = typeof responseBody?.result === "string" ? responseBody.result : responseBody?.result?.audio;
    buffer = base64Audio ? Buffer.from(base64Audio, "base64") : Buffer.from(await response.arrayBuffer());
  }
  // Stored under the container it really is, so a WAV preview is not labelled MP3.
  const isWav = inspectAudio(buffer).container === "wav";
  const clipId = nanoid();
  const stored = await storagePut(`bookx/${request.projectId}/narration/${clipId}.${isWav ? "wav" : "mp3"}`, buffer, isWav ? "audio/wav" : "audio/mpeg");
  void recordUsage({
    ownerId: request.ownerId,
    projectId: request.projectId,
    provider,
    capability: "tts",
    model: request.model || null,
    purpose: "preview",
    characters: request.text.length,
    providerCost: billedCharacters(response.headers),
  });
  return { clipId, storageKey: stored.key, audioUrl: stored.url, provider, fallback: resolved.fallback };
}

/** Sends the preview request to one provider. */
async function providerResponse(provider: TtsProvider, request: NarrationRequest, shared: ProviderCall | null): Promise<Response> {
  // Keys resolve app-saved-first, so a key entered on the Settings screen is used
  // in preference to a deployment-wide environment value.
  return shared
    ? await fetch(shared.url, { ...shared.init, redirect: "manual" })
    : provider === "ElevenLabs"
    ? await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${request.voiceId || "21m00Tcm4TlvDq8ikWAM"}`, {
      method: "POST",
      headers: { "xi-api-key": await requireProviderApiKey("ElevenLabs", request.ownerId), "content-type": "application/json", accept: "audio/mpeg" },
      // The render path's body, so a preview gets the settings the model accepts (v4: stability and similarity only).
      body: JSON.stringify(buildElevenLabsBody({ text: request.text, model: request.model || "eleven_multilingual_v2" })),
      signal: AbortSignal.timeout(120_000),
    })
    : provider === "Deepgram"
      ? await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(request.model || "aura-2-thalia-en")}`, {
        method: "POST",
        headers: { Authorization: `Token ${await requireProviderApiKey("Deepgram", request.ownerId)}`, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: request.text }),
        signal: AbortSignal.timeout(120_000),
      })
      : provider === "Cloudflare"
        ? await synthesizeWithCloudflare(request)
        : await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${await requireProviderApiKey("OpenAI", request.ownerId)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: request.model || "gpt-4o-mini-tts", voice: openAiVoice(request.voiceId, request.model || "gpt-4o-mini-tts"), input: request.text, response_format: "mp3" }),
      signal: AbortSignal.timeout(120_000),
    });
}

/**
 * Cloudflare TTS via the saved in-app endpoint (or environment credentials).
 * Native mode runs a Workers AI model directly (Aura-2 vs MeloTTS request
 * bodies); OpenAI-compatible mode (AI Gateway / self-hosted proxy) posts to
 * `{base}/audio/speech`.
 */
async function synthesizeWithCloudflare(request: NarrationRequest): Promise<Response> {
  const endpoint = await getCloudflareEndpoint(request.ownerId);
  if (!endpoint) throw new ProviderConfigurationError("Cloudflare text-to-speech is not configured");

  if (endpoint.mode === "openai-compatible") {
    const model = request.model || endpoint.ttsModel || "tts-1";
    // The same mapping a book render uses, so the preview is the voice the chapter gets.
    const voice = openAiVoice(request.voiceId, model);
    return fetch(`${endpoint.apiBaseUrl}/audio/speech`, {
      method: "POST",
      headers: cloudflareHeaders(endpoint),
      body: JSON.stringify({ model, input: request.text, voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(120_000),
      redirect: "manual",
    });
  }

  const model = request.model || endpoint.ttsModel || DEFAULT_CLOUDFLARE_TTS_MODEL;
  return fetch(`${endpoint.apiBaseUrl}/run/${model}`, {
    method: "POST",
    headers: cloudflareHeaders(endpoint),
    body: JSON.stringify(buildCloudflareTtsBody(model, request.text, request.voiceId, request.language)),
    signal: AbortSignal.timeout(120_000),
    redirect: "manual",
  });
}
