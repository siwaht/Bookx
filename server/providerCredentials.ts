import { and, eq } from "drizzle-orm";
import { bookxProviderSettings } from "../drizzle/schema";
import { BUILT_IN_PROVIDERS, type BuiltInProviderId, type ProviderId } from "../shared/providers";
import { customProviderCapabilities, listCustomProviders, providerUrlProblem } from "./customProviders";
import { sanitizeCredential } from "../shared/credentials";
import { getDb } from "./db";
import { ProviderConfigurationError } from "./narrationRetry";
import { configuredProviders, type RoutingCapability } from "./providerRouting";

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

/** Workers AI base URL for an account. */
export function cloudflareAccountUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;
}

/** The account id in a native Workers AI URL, or null for any other endpoint. */
export function cloudflareAccountIdFromUrl(url?: string | null): string | null {
  if (!url) return null;
  const normalized = normalizeCloudflareUrl(url);
  if (normalized?.mode !== "native") return null;
  return normalized.apiBaseUrl.match(/\/accounts\/([^/]+)\/ai$/)?.[1] ?? null;
}

/**
 * The deployment's account from the environment. A token saved in the app
 * replaces the environment's token for that user, even without a saved account.
 */
function cloudflareEndpointFromEnv(tokenOverride?: string): CloudflareEndpoint | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = sanitizeCredential(tokenOverride) || sanitizeCredential(process.env.CLOUDFLARE_API_TOKEN);
  if (!accountId || !apiToken) return null;
  return { apiBaseUrl: cloudflareAccountUrl(accountId), mode: "native", apiKey: apiToken };
}

/**
 * Loads the stored Cloudflare endpoint configuration (URL + API key + saved
 * model names). A row without an API key still works when the environment
 * provides a token. Falls back to `null` when neither the app nor the
 * environment can supply a usable endpoint.
 */
export async function getCloudflareEndpoint(ownerId?: number): Promise<CloudflareEndpoint | null> {
  const db = await getDb();
  let savedToken: string | undefined;
  let models: Pick<CloudflareEndpoint, "ttsModel" | "sttModel" | "llmModel"> = {};
  // Only the caller's own row. Falling back to another user's row used their
  // token and endpoint for someone who had saved nothing.
  const row = db && ownerId != null ? await ownProviderRow(db, "Cloudflare", ownerId) : undefined;
  if (row) {
    // A pasted token can carry invisible characters (see shared/credentials):
    // one of them makes every Workers AI request fail before it is sent.
    savedToken = sanitizeCredential(row.apiKey);
    models = {
      ttsModel: row.defaultTtsModel || undefined,
      sttModel: row.defaultSttModel || undefined,
      llmModel: row.defaultLlmModel || undefined,
    };
    const normalized = row.apiBaseUrl && !providerUrlProblem(row.apiBaseUrl) ? normalizeCloudflareUrl(row.apiBaseUrl) : null;
    if (normalized) {
      // The deployment's token only ever goes to Cloudflare itself. Any other
      // address the user typed in has to come with the user's own token.
      if (!deploymentTokenMayReach(normalized.apiBaseUrl)) {
        return savedToken ? { apiBaseUrl: normalized.apiBaseUrl, mode: normalized.mode, apiKey: savedToken, ...models } : null;
      }
      const apiKey = savedToken || process.env.CLOUDFLARE_API_TOKEN?.trim();
      if (apiKey) return { apiBaseUrl: normalized.apiBaseUrl, mode: normalized.mode, apiKey, ...models };
    }
  }
  // Previously a token saved without an account URL was ignored here, so
  // replacing the Cloudflare key in Settings kept using the deployment's token.
  const fromEnv = cloudflareEndpointFromEnv(savedToken);
  return fromEnv ? { ...fromEnv, ...models } : null;
}

type ProviderSettingsRow = typeof bookxProviderSettings.$inferSelect;
type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The caller's own saved settings for a provider. Another user's are never used. */
async function ownProviderRow(db: Database, provider: string, ownerId: number): Promise<ProviderSettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(bookxProviderSettings)
    .where(and(eq(bookxProviderSettings.ownerId, ownerId), eq(bookxProviderSettings.provider, provider)))
    .limit(1);
  return row;
}

/**
 * Whether the deployment's own Cloudflare token may be sent to an address:
 * Cloudflare's API, or an AI Gateway on the deployment's own account. Any other
 * address a user saves has to come with that user's own token, or the
 * deployment's token would go wherever the user pointed it.
 */
function deploymentTokenMayReach(apiBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hostname === "api.cloudflare.com") return true;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return url.hostname === "gateway.ai.cloudflare.com" && Boolean(account) && url.pathname.split("/")[2] === account;
}

/** Whether a saved Cloudflare address only works with the user's own token. */
export function cloudflareUrlNeedsOwnToken(raw?: string | null): boolean {
  const normalized = raw ? normalizeCloudflareUrl(raw) : null;
  return Boolean(normalized && !deploymentTokenMayReach(normalized.apiBaseUrl));
}

export const OPENAI_API_BASE = "https://api.openai.com/v1";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/**
 * Loads the caller's custom base URL for the OpenAI route (the "Custom LLM
 * Route" preference). Returns a normalized base ending in `/v1` when possible,
 * or `null` to use the official OpenAI API. An address that fails the provider
 * URL checks (Bookx's own hosts, private networks when hosted) is ignored.
 */
export async function getOpenAiCompatibleBaseUrl(ownerId?: number): Promise<string | null> {
  const db = await getDb();
  if (!db || ownerId == null) return null;
  const raw = (await ownProviderRow(db, "OpenAI", ownerId))?.apiBaseUrl?.trim();
  if (!raw || providerUrlProblem(raw)) return null;
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

// ---------------------------------------------------------------------------
// Provider API keys
// ---------------------------------------------------------------------------

/**
 * Environment variable that supplies each provider's key when one has not been
 * saved in the app.
 */
export const PROVIDER_ENV_KEYS: Record<BuiltInProviderId, string> = {
  ElevenLabs: "ELEVENLABS_API_KEY",
  Deepgram: "DEEPGRAM_API_KEY",
  OpenAI: "OPENAI_API_KEY",
  OpenRouter: "OPENROUTER_API_KEY",
  Cloudflare: "CLOUDFLARE_API_TOKEN",
  "Fish Audio": "FISH_AUDIO_API_KEY",
  Gradium: "GRADIUM_API_KEY",
};

const ALL_PROVIDERS: readonly BuiltInProviderId[] = BUILT_IN_PROVIDERS;

export type ProviderKeySource = "app" | "environment";

export type ProviderKeyState = {
  apiKey: string | null;
  source: ProviderKeySource | null;
};

/**
 * The last four characters of a key, so the user can tell which key is in use
 * without the key ever reaching the browser. Short keys get no hint at all.
 */
export function keyHint(key?: string | null): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  return trimmed.length >= 16 ? `…${trimmed.slice(-4)}` : "…";
}

/**
 * Resolves every provider's key in one query.
 *
 * A key saved in the app wins over the environment, so a user can override a
 * deployment-wide key with their own. Previously only Cloudflare consulted the
 * stored column, which meant a key entered for ElevenLabs, Deepgram, OpenAI or
 * Fish Audio was written to the database and then silently ignored everywhere —
 * the provider still reported itself unconfigured and every request used the
 * (missing) environment value.
 */
export async function providerKeyStates(ownerId?: number): Promise<Record<BuiltInProviderId, ProviderKeyState>> {
  const states = Object.fromEntries(
    ALL_PROVIDERS.map(provider => {
      const fromEnv = sanitizeCredential(process.env[PROVIDER_ENV_KEYS[provider]]);
      return [provider, fromEnv ? { apiKey: fromEnv, source: "environment" as const } : { apiKey: null, source: null }];
    }),
  ) as Record<BuiltInProviderId, ProviderKeyState>;

  // Without an owner there is nobody's saved key to use: the environment only.
  const db = await getDb();
  if (!db || ownerId == null) return states;

  const rows = await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, ownerId));
  for (const provider of ALL_PROVIDERS) {
    // Read through the cleaner so a key saved before this check existed still
    // works without the user having to paste it again.
    const stored = sanitizeCredential(rows.find(row => row.provider === provider)?.apiKey);
    if (stored) states[provider] = { apiKey: stored, source: "app" };
  }

  return states;
}

/**
 * Where OpenAI requests go, and with which key. A custom address only ever
 * gets the key the user saved: the deployment's OPENAI_API_KEY is for
 * api.openai.com alone.
 */
export async function openAiRoute(ownerId?: number): Promise<{ baseUrl: string; apiKey: string }> {
  const custom = await getOpenAiCompatibleBaseUrl(ownerId);
  if (!custom) return { baseUrl: OPENAI_API_BASE, apiKey: await requireProviderApiKey("OpenAI", ownerId) };
  const own = (await providerKeyStates(ownerId)).OpenAI;
  if (own.source !== "app" || !own.apiKey) {
    throw new ProviderConfigurationError("A custom OpenAI address needs its own API key. Save the key for that address in Settings, or clear the address to use api.openai.com.");
  }
  return { baseUrl: custom, apiKey: own.apiKey };
}

export async function getProviderApiKey(provider: BuiltInProviderId, ownerId?: number): Promise<string | null> {
  return (await providerKeyStates(ownerId))[provider].apiKey;
}

/** Same, but with an error that tells the user where to put the key. */
export async function requireProviderApiKey(provider: BuiltInProviderId, ownerId?: number): Promise<string> {
  const key = await getProviderApiKey(provider, ownerId);
  if (!key) {
    throw new ProviderConfigurationError(
      `${provider} is not connected. Add its API key on the Settings screen, or set ${PROVIDER_ENV_KEYS[provider]} in the environment.`,
    );
  }
  return key;
}

/**
 * Providers usable right now, from either an app-saved key or the environment.
 * Cloudflare additionally counts when an endpoint URL is configured.
 *
 * The user's own (custom) providers are included when they can do
 * `capability`, or all of them when no capability is given.
 */
export async function availableProviders(ownerId?: number, capability?: RoutingCapability): Promise<ProviderId[]> {
  const states = await providerKeyStates(ownerId);
  const available = new Set<ProviderId>(configuredProviders());
  for (const provider of ALL_PROVIDERS) {
    if (states[provider].apiKey) available.add(provider);
  }
  if (await getCloudflareEndpoint(ownerId)) available.add("Cloudflare");
  else available.delete("Cloudflare"); // a bare token is not enough without an account URL
  for (const custom of await listCustomProviders(ownerId)) {
    if (!capability || customProviderCapabilities(custom).includes(capability)) available.add(custom.id);
  }
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
