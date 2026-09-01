import { nanoid } from "nanoid";
import { storagePut } from "./storage";
import { resolveProvider, type ProviderId } from "./providerRouting";
import { AURA_2_SPEAKERS, DEFAULT_CLOUDFLARE_TTS_MODEL, availableProviders, buildCloudflareTtsBody, cloudflareHeaders, getCloudflareEndpoint } from "./providerCredentials";

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

const openAiVoiceForStarter: Record<string, string> = {
  "iris-narrative": "nova",
  "theo-dramatic": "onyx",
  "sage-conversational": "alloy",
  "noor-global": "shimmer",
  "rowan-deep": "echo",
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
  const request = validateNarrationRequest(input);
  if (!request.projectId) throw new Error("A project is required to store generated narration");
  const available = await availableProviders(request.ownerId);
  const resolved = resolveProvider(request.provider, "text-to-speech", available);
  const provider = resolved.provider;
  tried.add(provider);

  const response = provider === "ElevenLabs"
    ? await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${request.voiceId || "21m00Tcm4TlvDq8ikWAM"}`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY || "", "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: request.text, model_id: request.model || "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(120_000),
    })
    : provider === "Deepgram"
      ? await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(request.model || "aura-2-thalia-en")}`, {
        method: "POST",
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY || ""}`, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: request.text }),
        signal: AbortSignal.timeout(120_000),
      })
      : provider === "Cloudflare"
        ? await synthesizeWithCloudflare(request)
        : await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`, "content-type": "application/json" },
      body: JSON.stringify({ model: request.model || "gpt-4o-mini-tts", voice: request.voiceId || "alloy", input: request.text, response_format: "mp3" }),
      signal: AbortSignal.timeout(120_000),
    });

  if (!response.ok) {
    const candidates: TtsProvider[] = ["ElevenLabs", "Deepgram", "OpenAI", "Cloudflare"];
    for (const candidate of candidates) {
      if (tried.has(candidate) || !available.includes(candidate)) continue;
      tried.add(candidate);
      try {
        const fallbackResult = await synthesizeNarrationAttempt({ ...request, provider: candidate }, tried);
        return { ...fallbackResult, fallback: true };
      } catch {
        // Continue to the next configured route; the final error keeps the original provider context.
      }
    }
    throw new Error(`${provider} narration failed with HTTP ${response.status}; no configured runtime fallback completed`);
  }

  const contentType = response.headers.get("content-type") || "";
  const responseBody = contentType.includes("application/json") ? await response.json() as { result?: { audio?: string } | string } : null;
  const base64Audio = typeof responseBody?.result === "string" ? responseBody.result : responseBody?.result?.audio;
  const buffer = base64Audio ? Buffer.from(base64Audio, "base64") : Buffer.from(await response.arrayBuffer());
  const clipId = nanoid();
  const stored = await storagePut(`bookx/${request.projectId}/narration/${clipId}.mp3`, buffer, "audio/mpeg");
  return { clipId, storageKey: stored.key, audioUrl: stored.url, provider, fallback: resolved.fallback };
}

/**
 * Cloudflare TTS via the saved in-app endpoint (or environment credentials).
 * Native mode runs a Workers AI model directly (Aura-2 vs MeloTTS request
 * bodies); OpenAI-compatible mode (AI Gateway / self-hosted proxy) posts to
 * `{base}/audio/speech`.
 */
async function synthesizeWithCloudflare(request: NarrationRequest): Promise<Response> {
  const endpoint = await getCloudflareEndpoint(request.ownerId);
  if (!endpoint) throw new Error("Cloudflare text-to-speech is not configured");

  if (endpoint.mode === "openai-compatible") {
    const model = request.model || endpoint.ttsModel || "tts-1";
    const rawVoice = request.voiceId || "";
    const voice = openAiVoiceForStarter[rawVoice] || ((AURA_2_SPEAKERS as readonly string[]).includes(rawVoice.toLowerCase()) ? "alloy" : rawVoice || "alloy");
    return fetch(`${endpoint.apiBaseUrl}/audio/speech`, {
      method: "POST",
      headers: cloudflareHeaders(endpoint),
      body: JSON.stringify({ model, input: request.text, voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(120_000),
    });
  }

  const model = request.model || endpoint.ttsModel || DEFAULT_CLOUDFLARE_TTS_MODEL;
  return fetch(`${endpoint.apiBaseUrl}/run/${model}`, {
    method: "POST",
    headers: cloudflareHeaders(endpoint),
    body: JSON.stringify(buildCloudflareTtsBody(model, request.text, request.voiceId, request.language)),
    signal: AbortSignal.timeout(120_000),
  });
}
