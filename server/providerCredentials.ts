import { eq } from "drizzle-orm";
import { bookxProviderSettings } from "../drizzle/schema";
import { getDb } from "./db";
import { configuredProviders, type ProviderId } from "./providerRouting";

export type CloudflareEndpointMode = "native" | "openai-compatible";

/**
 * Default Workers AI narration model.
 *
 * Aura-2 answers in well under a second and returns a clean MP3 every time.
 * MeloTTS, the previous default, returns intermittent `AiError: Internal server
 * error` 500s for an identical request — survivable thanks to retries, but a poor
 * thing to point a multi-hour book at.
 */
export const DEFAULT_CLOUDFLARE_TTS_MODEL = "@cf/deepgram/aura-2-en";

export type CloudflareEndpoint = {
  /** Normalized base URL used for all requests (no trailing slash). */
  apiBaseUrl: string;
  mode: CloudflareEndpointMode;
  apiKey: string;
  ttsModel?: string;
  sttModel?: string;
  llmModel?: string;
};

/**
 * Speakers supported by `@cf/deepgram/aura-2-en` on Cloudflare Workers AI.
 * Used to map Bookx starter voices (and raw voice IDs) onto Aura-2 speakers.
 */
export const AURA_2_SPEAKERS = [
  "amalthea", "andromeda", "apollo", "arcas", "aries", "asteria", "athena", "atlas", "aurora", "callista",
  "cora", "cordelia", "delia", "draco", "electra", "harmonia", "helena", "hera", "hermes", "hyperion",
  "iris", "janus", "juno", "jupiter", "luna", "mars", "minerva", "neptune", "odysseus", "ophelia",
  "orion", "orpheus", "pandora", "phoebe", "pluto", "saturn", "thalia", "theia", "vesta", "zeus",
] as const;

const starterVoiceSpeakers: Record<string, string> = {
  "iris-narrative": "iris",
  "theo-dramatic": "orpheus",
  "sage-conversational": "helena",
  "noor-global": "luna",
  "rowan-deep": "atlas",
};

const melottsLanguages: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  chinese: "zh",
  japanese: "jp",
  korean: "kr",
};

export function resolveAura2Speaker(voiceId?: string | null): string | undefined {
  if (!voiceId) return undefined;
  const mapped = starterVoiceSpeakers[voiceId];
  if (mapped) return mapped;
  const lower = voiceId.toLowerCase();
  return (AURA_2_SPEAKERS as readonly string[]).includes(lower) ? lower : undefined;
}

export function resolveMelottsLanguage(language?: string | null): string {
  if (!language) return "en";
  const normalized = language.trim().toLowerCase();
  if (melottsLanguages[normalized]) return melottsLanguages[normalized]!;
  const code = normalized.slice(0, 2);
  return Object.values(melottsLanguages).includes(code) ? code : "en";
}

/**
 * Normalizes a user-supplied Cloudflare endpoint URL.
 *
 * Native mode (host `api.cloudflare.com`): any pasted form of the account AI
 * base — `.../ai`, `.../ai/v1`, `.../ai/run`, or a full run/chat URL — is
 * reduced to `https://api.cloudflare.com/client/v4/accounts/{account}/ai`.
 *
 * OpenAI-compatible mode (any other host, e.g. an AI Gateway `.../compat`
 * URL or a self-hosted proxy): trailing slashes and a pasted
 * `/chat/completions` suffix are stripped; the base is used as-is.
 */
export function normalizeCloudflareUrl(raw: string): { mode: CloudflareEndpointMode; apiBaseUrl: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  if (parsed.host === "api.cloudflare.com") {
    const match = parsed.pathname.match(/^(\/client\/v4\/accounts\/[^/]+\/ai)(\/|$)/);
    if (!match) return null;
    return { mode: "native", apiBaseUrl: `https://api.cloudflare.com${match[1]}` };
  }

  let base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  base = base.replace(/\/chat\/completions$/, "");
  if (!base) return null;
  return { mode: "openai-compatible", apiBaseUrl: base };
}

function cloudflareEndpointFromEnv(): CloudflareEndpoint | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return null;
  return { apiBaseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`, mode: "native", apiKey: apiToken };
}

/**
 * Loads the stored Cloudflare endpoint configuration (URL + API key + saved
 * model names). A row without an API key still works when the environment
 * provides a token. Falls back to `null` when neither the app nor the
 * environment can supply a usable endpoint.
 */
export async function getCloudflareEndpoint(ownerId?: number): Promise<CloudflareEndpoint | null> {
  const db = await getDb();
  if (db) {
    const rows = await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.provider, "Cloudflare"));
    const row = (ownerId != null ? rows.find((candidate) => candidate.ownerId === ownerId) : undefined) || rows[0];
    if (row?.apiBaseUrl) {
      const normalized = normalizeCloudflareUrl(row.apiBaseUrl);
      if (normalized) {
        const apiKey = row.apiKey || process.env.CLOUDFLARE_API_TOKEN;
        if (apiKey) {
          return {
            apiBaseUrl: normalized.apiBaseUrl,
            mode: normalized.mode,
            apiKey,
            ttsModel: row.defaultTtsModel || undefined,
            sttModel: row.defaultSttModel || undefined,
            llmModel: row.defaultLlmModel || undefined,
          };
        }
      }
    }
  }
  return cloudflareEndpointFromEnv();
}

/**
 * Loads the stored custom base URL for an OpenAI-compatible route (the
 * "Custom LLM Route" preference). Returns a normalized base ending in `/v1`
 * when possible, or `null` to use the official OpenAI API.
 */
export async function getOpenAiCompatibleBaseUrl(ownerId?: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.provider, "OpenAI"));
  const row = (ownerId != null ? rows.find((candidate) => candidate.ownerId === ownerId) : undefined) || rows[0];
  const raw = row?.apiBaseUrl?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    let base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
    if (!/\/v1$/.test(base)) base = `${base}/v1`;
    return base;
  } catch {
    return null;
  }
}

/** Headers shared by every Cloudflare request (native and compatible modes). */
export function cloudflareHeaders(endpoint: CloudflareEndpoint): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json" };
  const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID;
  if (gatewayId && endpoint.mode === "native") headers["cf-aig-gateway-id"] = gatewayId;
  return headers;
}

/**
 * Strips the write-only API key from a stored provider preference row,
 * reporting only whether a key exists. Used by every read path so the key
 * value never leaves the server.
 */
export function redactProviderApiKey<T extends { apiKey?: string | null }>(row: T) {
  const { apiKey, ...rest } = row;
  return { ...rest, apiKeyConfigured: Boolean(apiKey) };
}

/** Configured providers including in-app Cloudflare endpoint configuration. */
export async function availableProviders(ownerId?: number): Promise<ProviderId[]> {
  const available = new Set(configuredProviders());
  if (await getCloudflareEndpoint(ownerId)) available.add("Cloudflare");
  return Array.from(available);
}

/**
 * Builds the model-specific JSON body for a Cloudflare native TTS run:
 * Aura-2 models take `{ text, speaker, encoding }`, MeloTTS takes
 * `{ prompt, lang }`, and unknown models get the common `{ prompt, lang }`
 * shape as a best effort.
 */
export function buildCloudflareTtsBody(model: string, text: string, voiceId?: string | null, language?: string | null): Record<string, unknown> {
  if (/aura-2|aura-1/.test(model)) {
    const speaker = resolveAura2Speaker(voiceId);
    const body: Record<string, unknown> = { text, encoding: "mp3" };
    if (speaker && /aura-2/.test(model)) body.speaker = speaker;
    return body;
  }
  if (/melotts/.test(model)) {
    return { prompt: text, lang: resolveMelottsLanguage(language) };
  }
  return { prompt: text, lang: resolveMelottsLanguage(language) };
}

/**
 * Builds the model-specific JSON body for a Cloudflare native STT run.
 * Whisper models accept `{ audio: number[], task, language? }`.
 */
export function buildCloudflareSttBody(model: string, audio: Uint8Array, language?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { audio: Array.from(audio) };
  if (/whisper/.test(model)) {
    body.task = "transcribe";
    if (language) body.language = language;
  }
  return body;
}

/**
 * Workers AI models that are only reachable over a WebSocket, so an HTTP run can
 * never succeed. `@cf/deepgram/flux` answers an HTTP POST with
 * "only supports websocket connections", which is worth naming up front rather
 * than surfacing as an opaque 400 mid-run.
 */
export const CLOUDFLARE_WEBSOCKET_ONLY_MODELS = new Set(["@cf/deepgram/flux"]);

export const isWebsocketOnlyCloudflareModel = (model: string): boolean =>
  CLOUDFLARE_WEBSOCKET_ONLY_MODELS.has(model) || /\/flux$/.test(model);

/**
 * Request shape for a Cloudflare native speech-to-text run.
 *
 * The two model families disagree, and getting it wrong is a hard 400:
 *  - Whisper takes JSON with the audio as a byte array.
 *  - Deepgram (nova-*) rejects that and wants the audio as the raw request body
 *    with an audio content type.
 */
export function buildCloudflareSttRequest(input: {
  model: string;
  audio: Uint8Array;
  contentType: string;
  language?: string;
  apiKey: string;
}): { body: BodyInit; headers: Record<string, string> } {
  if (/deepgram|nova|aura/.test(input.model)) {
    return {
      body: Buffer.from(input.audio) as unknown as BodyInit,
      headers: { Authorization: `Bearer ${input.apiKey}`, "content-type": input.contentType || "audio/mpeg" },
    };
  }

  return {
    body: JSON.stringify(buildCloudflareSttBody(input.model, input.audio, input.language)),
    headers: { Authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
  };
}

/** Reads a transcript out of any of the shapes Workers AI STT models return. */
export function extractCloudflareTranscript(payload: unknown): string {
  const root = (payload as { result?: unknown })?.result ?? payload;
  if (typeof root === "string") return root;
  const asRecord = root as {
    text?: string;
    transcript?: string;
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  if (typeof asRecord?.text === "string") return asRecord.text;
  if (typeof asRecord?.transcript === "string") return asRecord.transcript;
  // Deepgram's nested shape.
  const nested = asRecord?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof nested === "string" ? nested : "";
}
