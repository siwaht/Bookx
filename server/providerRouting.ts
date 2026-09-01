import { storageGetSignedUrl } from "./storage";
import { transcribeAudio as transcribeWithManus } from "./_core/voiceTranscription";
import {
  availableProviders,
  buildCloudflareSttRequest,
  extractCloudflareTranscript,
  getCloudflareEndpoint,
  isWebsocketOnlyCloudflareModel,
} from "./providerCredentials";

export type ProviderId = "ElevenLabs" | "Deepgram" | "Cloudflare" | "OpenAI" | "Fish Audio";
export type RoutingCapability = "text-to-speech" | "speech-to-text" | "language-model";

export const providerCapabilities: Record<ProviderId, RoutingCapability[]> = {
  ElevenLabs: ["text-to-speech", "speech-to-text"],
  Deepgram: ["text-to-speech", "speech-to-text"],
  Cloudflare: ["text-to-speech", "speech-to-text", "language-model"],
  OpenAI: ["text-to-speech", "speech-to-text", "language-model"],
  "Fish Audio": ["text-to-speech", "speech-to-text"],
};

export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  const providers: ProviderId[] = [];
  if (env.ELEVENLABS_API_KEY) providers.push("ElevenLabs");
  if (env.DEEPGRAM_API_KEY) providers.push("Deepgram");
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) providers.push("Cloudflare");
  if (env.OPENAI_API_KEY) providers.push("OpenAI");
  if (env.FISH_AUDIO_API_KEY) providers.push("Fish Audio");
  return providers;
}

export function resolveProvider(requested: ProviderId, capability: RoutingCapability, available = configuredProviders()): { provider: ProviderId; fallback: boolean } {
  if (available.includes(requested) && providerCapabilities[requested].includes(capability)) return { provider: requested, fallback: false };
  const fallbackOrder: ProviderId[] = capability === "language-model" ? ["Cloudflare", "OpenAI"] : capability === "speech-to-text" ? ["Deepgram", "OpenAI", "Cloudflare", "ElevenLabs"] : ["ElevenLabs", "Deepgram", "Cloudflare", "OpenAI"];
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

  const resolved = resolveProvider(input.provider, "speech-to-text", await availableProviders(input.ownerId));
  const audioUrl = await storageGetSignedUrl(input.audioStorageKey);
  const language = input.language && input.language !== "Auto-detect" ? input.language.slice(0, 2).toLowerCase() : undefined;

  if (resolved.provider === "Deepgram") {
    const response = await fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(input.model || "nova-3")}&smart_format=true`, {
      method: "POST",
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY || ""}`, "content-type": "application/json" },
      body: JSON.stringify({ url: audioUrl }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Deepgram transcription failed with HTTP ${response.status}`);
    const payload = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
    return { text: payload.results?.channels?.[0]?.alternatives?.[0]?.transcript || "", provider: resolved.provider, fallback: resolved.fallback };
  }

  if (resolved.provider === "OpenAI") {
    const audio = await fetch(audioUrl, { signal: AbortSignal.timeout(45_000) });
    if (!audio.ok) throw new Error("Stored audio could not be read for transcription");
    const body = new FormData();
    body.set("file", new Blob([await audio.arrayBuffer()], { type: audio.headers.get("content-type") || "audio/mpeg" }), "recording.mp3");
    body.set("model", input.model || "gpt-4o-transcribe");
    if (language) body.set("language", language);
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}` }, body, signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`OpenAI transcription failed with HTTP ${response.status}`);
    const payload = await response.json() as { text?: string };
    return { text: payload.text || "", provider: resolved.provider, fallback: resolved.fallback };
  }

  if (resolved.provider === "Cloudflare") {
    const endpoint = await getCloudflareEndpoint(input.ownerId);
    if (!endpoint) throw new Error("Cloudflare speech-to-text is not configured");
    const audio = await fetch(audioUrl, { signal: AbortSignal.timeout(45_000) });
    if (!audio.ok) throw new Error("Stored audio could not be read for transcription");
    const bytes = new Uint8Array(await audio.arrayBuffer());

    if (endpoint.mode === "openai-compatible") {
      const body = new FormData();
      body.set("file", new Blob([bytes], { type: audio.headers.get("content-type") || "audio/mpeg" }), "recording.mp3");
      body.set("model", input.model || endpoint.sttModel || "whisper-1");
      if (language) body.set("language", language);
      const response = await fetch(`${endpoint.apiBaseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
        body,
        signal: AbortSignal.timeout(45_000),
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
      contentType: audio.headers.get("content-type") || "audio/mpeg",
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
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Cloudflare transcription failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return { text: extractCloudflareTranscript(await response.json()), provider: resolved.provider, fallback: resolved.fallback };
  }

  const result = await transcribeWithManus({ audioUrl, language, prompt: "Transcribe this Bookx audiobook or podcast clip with paragraph-ready punctuation." });
  if ("error" in result) throw new Error(result.error || "Managed transcription failed");
  return { text: result.text || "", provider: resolved.provider, fallback: true };
}
