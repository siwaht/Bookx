import { storageGetBuffer, storageGetSignedUrl } from "./storage";
import { transcribeAudio as transcribeWithManus } from "./_core/voiceTranscription";
import {
  availableProviders,
  buildCloudflareSttRequest,
  extractCloudflareTranscript,
  getCloudflareEndpoint,
  isWebsocketOnlyCloudflareModel,
  requireProviderApiKey,
} from "./providerCredentials";

import { isCustomProviderId, type BuiltInProviderId, type ProviderId } from "../shared/providers";
import { customProviderHeaders, requireCustomProvider } from "./customProviders";

export { BUILT_IN_PROVIDERS, isBuiltInProvider, isCustomProviderId, isProviderId } from "../shared/providers";
export type { BuiltInProviderId, CustomProviderId, ProviderId } from "../shared/providers";
export type RoutingCapability = "text-to-speech" | "speech-to-text" | "language-model";

export const providerCapabilities: Record<BuiltInProviderId, RoutingCapability[]> = {
  ElevenLabs: ["text-to-speech", "speech-to-text"],
  Deepgram: ["text-to-speech", "speech-to-text"],
  Cloudflare: ["text-to-speech", "speech-to-text", "language-model"],
  OpenAI: ["text-to-speech", "speech-to-text", "language-model"],
  OpenRouter: ["language-model"],
  "Fish Audio": ["text-to-speech", "speech-to-text"],
  Gradium: ["text-to-speech"],
};

export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  const providers: ProviderId[] = [];
  if (env.ELEVENLABS_API_KEY) providers.push("ElevenLabs");
  if (env.DEEPGRAM_API_KEY) providers.push("Deepgram");
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) providers.push("Cloudflare");
  if (env.OPENAI_API_KEY) providers.push("OpenAI");
  if (env.OPENROUTER_API_KEY) providers.push("OpenRouter");
  if (env.FISH_AUDIO_API_KEY) providers.push("Fish Audio");
  if (env.GRADIUM_API_KEY) providers.push("Gradium");
  return providers;
}

/**
 * Whether `provider` can serve `capability`. A custom provider's abilities
 * depend on the models the user gave it, so callers pass `available` already
 * narrowed to the custom providers that can do the task (see
 * `availableProviders(ownerId, capability)`); here being listed is enough.
 */
function supports(provider: ProviderId, capability: RoutingCapability): boolean {
  return isCustomProviderId(provider) || providerCapabilities[provider].includes(capability);
}

export function resolveProvider(requested: ProviderId, capability: RoutingCapability, available = configuredProviders()): { provider: ProviderId; fallback: boolean } {
  if (available.includes(requested) && supports(requested, capability)) return { provider: requested, fallback: false };
  // Fallbacks are built-in providers only: a custom service is used when chosen.
  const fallbackOrder: BuiltInProviderId[] = capability === "language-model"
    ? ["Cloudflare", "OpenAI", "OpenRouter"]
    : capability === "speech-to-text"
      ? ["Deepgram", "OpenAI", "Cloudflare", "ElevenLabs", "Fish Audio"]
      : ["ElevenLabs", "Deepgram", "Cloudflare", "OpenAI", "Fish Audio", "Gradium"];
  const provider = fallbackOrder.find((candidate) => available.includes(candidate) && providerCapabilities[candidate].includes(capability));
  if (!provider) throw new Error(`No configured provider supports ${capability}`);
  return { provider, fallback: true };
}

export async function transcribeAudioRoute(input: { provider: ProviderId; model?: string; audioStorageKey: string; language?: string; ownerId?: number }) {
  // Rejected before any storage or provider I/O: a realtime-only model can never
  // transcribe a stored file, so there is no point fetching the audio first.
  if (input.model && isWebsocketOnlyCloudflareModel(input.model)) {
    throw new Error(`${input.model} is a realtime model that only accepts WebSocket connections, so it cannot transcribe a stored file. Choose @cf/deepgram/nova-3 or @cf/openai/whisper instead.`);
  }

  const resolved = resolveProvider(input.provider, "speech-to-text", await availableProviders(input.ownerId, "speech-to-text"));
  const language = input.language && input.language !== "Auto-detect" ? input.language.slice(0, 2).toLowerCase() : undefined;
  // Read the bytes server-side rather than fetching a signed URL: in local
  // storage mode that URL is relative to the app and means nothing here.
  const readAudio = async () => new Uint8Array(await storageGetBuffer(input.audioStorageKey, { timeoutMs: 45_000 }));

  if (isCustomProviderId(resolved.provider)) {
    const custom = await requireCustomProvider(resolved.provider, input.ownerId, "speech-to-text");
    const body = new FormData();
    body.set("file", new Blob([await readAudio()], { type: "audio/mpeg" }), "recording.mp3");
    body.set("model", custom.sttModel!);
    if (language) body.set("language", language);
    const response = await fetch(`${custom.baseUrl}/audio/transcriptions`, { method: "POST", headers: customProviderHeaders(custom, false), body, signal: AbortSignal.timeout(120_000), redirect: "manual" });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${custom.label} transcription failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const payload = await response.json() as { text?: string };
    return { text: payload.text || "", provider: resolved.provider, fallback: resolved.fallback };
  }

  if (resolved.provider === "Fish Audio") {
    const body = new FormData();
    body.set("audio", new Blob([await readAudio()], { type: "audio/mpeg" }), "recording.mp3");
    if (language) body.set("language", language);
    body.set("ignore_timestamps", "true");
    const response = await fetch("https://api.fish.audio/v1/asr", {
      method: "POST",
      headers: { Authorization: `Bearer ${await requireProviderApiKey("Fish Audio", input.ownerId)}`, model: input.model || "transcribe-1" },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Fish Audio transcription failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const payload = await response.json() as { text?: string };
    return { text: payload.text || "", provider: resolved.provider, fallback: resolved.fallback };
  }

  if (resolved.provider === "Deepgram") {
    const response = await fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(input.model || "nova-3")}&smart_format=true`, {
      method: "POST",
      headers: { Authorization: `Token ${await requireProviderApiKey("Deepgram", input.ownerId)}`, "content-type": "audio/mpeg" },
      body: Buffer.from(await readAudio()) as unknown as BodyInit,
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Deepgram transcription failed with HTTP ${response.status}`);
    const payload = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
    return { text: payload.results?.channels?.[0]?.alternatives?.[0]?.transcript || "", provider: resolved.provider, fallback: resolved.fallback };
  }

  if (resolved.provider === "OpenAI") {
    const body = new FormData();
    body.set("file", new Blob([await readAudio()], { type: "audio/mpeg" }), "recording.mp3");
    body.set("model", input.model || "gpt-4o-transcribe");
    if (language) body.set("language", language);
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${await requireProviderApiKey("OpenAI", input.ownerId)}` }, body, signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`OpenAI transcription failed with HTTP ${response.status}`);
    const payload = await response.json() as { text?: string };
    return { text: payload.text || "", provider: resolved.provider, fallback: resolved.fallback };
  }

  if (resolved.provider === "Cloudflare") {
    const endpoint = await getCloudflareEndpoint(input.ownerId);
    if (!endpoint) throw new Error("Cloudflare speech-to-text is not configured");
    const bytes = await readAudio();

    if (endpoint.mode === "openai-compatible") {
      const body = new FormData();
      body.set("file", new Blob([bytes], { type: "audio/mpeg" }), "recording.mp3");
      body.set("model", input.model || endpoint.sttModel || "whisper-1");
      if (language) body.set("language", language);
      const response = await fetch(`${endpoint.apiBaseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
        body,
        signal: AbortSignal.timeout(45_000),
        redirect: "manual",
      });
      if (!response.ok) throw new Error(`Cloudflare transcription failed with HTTP ${response.status}`);
      const payload = await response.json() as { text?: string };
      return { text: payload.text || "", provider: resolved.provider, fallback: resolved.fallback };
    }

    const model = input.model || endpoint.sttModel || "@cf/openai/whisper";
    if (isWebsocketOnlyCloudflareModel(model)) {
      throw new Error(`${model} is a realtime model that only accepts WebSocket connections, so it cannot transcribe a stored file. Choose @cf/deepgram/nova-3 or @cf/openai/whisper instead.`);
    }

    // Whisper wants JSON with a byte array; Deepgram wants the raw audio as the
    // request body and rejects the JSON form outright.
    const { body, headers } = buildCloudflareSttRequest({
      model,
      audio: bytes,
      contentType: "audio/mpeg",
      language,
      apiKey: endpoint.apiKey,
    });
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID;
    if (gatewayId && endpoint.mode === "native") headers["cf-aig-gateway-id"] = gatewayId;

    const response = await fetch(`${endpoint.apiBaseUrl}/run/${model}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(120_000),
      redirect: "manual",
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Cloudflare transcription failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return { text: extractCloudflareTranscript(await response.json()), provider: resolved.provider, fallback: resolved.fallback };
  }

  // The managed transcriber fetches the audio itself, so it needs a real URL.
  const audioUrl = await storageGetSignedUrl(input.audioStorageKey);
  const result = await transcribeWithManus({ audioUrl, language, prompt: "Transcribe this Bookx audiobook or podcast clip with paragraph-ready punctuation." });
  if ("error" in result) throw new Error(result.error || "Managed transcription failed");
  return { text: result.text || "", provider: resolved.provider, fallback: true };
}
