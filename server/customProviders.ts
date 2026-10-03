import { and, eq, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { bookxProviderSettings } from "../drizzle/schema";
import { CUSTOM_PROVIDER_LIMITS, isCustomProviderId, type CustomProviderId } from "../shared/providers";
import { getDb } from "./db";
import { ProviderConfigurationError } from "./narrationRetry";
import type { RoutingCapability } from "./providerRouting";

/**
 * Providers the user adds themselves: any service with an OpenAI-compatible
 * speech API (`POST {base}/audio/speech`, and optionally
 * `POST {base}/audio/transcriptions`). Each is a `bookxProviderSettings` row
 * owned by one user, with the id `custom:<id>`.
 */

export type CustomProvider = {
  id: CustomProviderId;
  label: string;
  /** Base URL without a trailing slash, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  apiKey: string | null;
  ttsModel: string | null;
  sttModel: string | null;
  voices: string[];
};

/** Per-user ceiling, so a runaway client cannot fill the table. */
export const MAX_CUSTOM_PROVIDERS = 20;

export function customProviderCapabilities(provider: Pick<CustomProvider, "ttsModel" | "sttModel" | "voices">): RoutingCapability[] {
  const capabilities: RoutingCapability[] = [];
  if (provider.ttsModel && provider.voices.length) capabilities.push("text-to-speech");
  if (provider.sttModel) capabilities.push("speech-to-text");
  return capabilities;
}

// ---------------------------------------------------------------------------
// Which URLs a provider may use
// ---------------------------------------------------------------------------

/** The container reaches D1 and R2 through the Worker at `*.bookx`; never a provider. */
const INTERNAL_HOST = /(^|\.)bookx\.?$/i;

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "::1" || lower === "::" || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower) || lower.startsWith("::ffff:");
}

/** A machine-local or private-network address (literal IPs and localhost only). */
export function isLocalAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || isPrivateIpv4(host) || isPrivateIpv6(host);
}

/**
 * Why a provider URL is refused, or null when it is fine.
 *
 * The server calls these URLs itself, so they must not point at Bookx's own
 * storage and database hosts or, when hosted, at private addresses. Local
 * addresses are allowed in local development, where a speech server on this
 * machine is a normal setup.
 */
export function providerUrlProblem(raw: string, options: { allowLocal?: boolean } = {}): string | null {
  const allowLocal = options.allowLocal ?? process.env.BOOKX_CONTAINER !== "1";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Enter a full address, starting with https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an https:// address";
  if (url.username || url.password) return "Put the key in the API key field, not in the address";
  if (INTERNAL_HOST.test(url.hostname)) return "That address is reserved for Bookx itself";
  const local = isLocalAddress(url.hostname);
  if (local && !allowLocal) return "Prosecast is hosted, so it cannot reach local or private-network addresses";
  if (url.protocol === "http:" && !local) return "Use an https:// address";
  return null;
}

/**
 * Normalises a pasted base URL: no trailing slash, and no endpoint suffix, so
 * both `https://host/v1` and `https://host/v1/audio/speech/` work.
 */
export function normalizeCustomBaseUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  let base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  base = base.replace(/\/(audio\/speech|audio\/transcriptions|chat\/completions|models)$/i, "");
  return base || null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type SettingsRow = typeof bookxProviderSettings.$inferSelect;

function fromRow(row: SettingsRow): CustomProvider | null {
  if (!isCustomProviderId(row.provider) || !row.apiBaseUrl) return null;
  const voices = Array.isArray(row.options?.voices) ? row.options.voices.filter((voice): voice is string => typeof voice === "string" && Boolean(voice.trim())) : [];
  return {
    id: row.provider,
    label: row.label?.trim() || "Custom provider",
    baseUrl: row.apiBaseUrl,
    apiKey: row.apiKey?.trim() || null,
    ttsModel: row.defaultTtsModel?.trim() || null,
    sttModel: row.defaultSttModel?.trim() || null,
    voices,
  };
}

async function ownedRows(ownerId: number): Promise<SettingsRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(bookxProviderSettings)
    .where(and(eq(bookxProviderSettings.ownerId, ownerId), like(bookxProviderSettings.provider, "custom:%")));
}

/** The user's own providers, by name. Nobody else's are ever visible. */
export async function listCustomProviders(ownerId?: number): Promise<CustomProvider[]> {
  if (ownerId == null) return [];
  return (await ownedRows(ownerId))
    .map(fromRow)
    .filter((provider): provider is CustomProvider => Boolean(provider))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function getCustomProvider(id: string, ownerId?: number): Promise<CustomProvider | null> {
  if (!isCustomProviderId(id)) return null;
  return (await listCustomProviders(ownerId)).find(provider => provider.id === id) ?? null;
}

/** Same, but with an error that says what to fix. */
export async function requireCustomProvider(id: string, ownerId: number | undefined, capability?: RoutingCapability): Promise<CustomProvider> {
  const provider = await getCustomProvider(id, ownerId);
  if (!provider) throw new ProviderConfigurationError("This provider was removed. Choose another voice provider in the project's settings.");
  const problem = providerUrlProblem(provider.baseUrl);
  if (problem) throw new ProviderConfigurationError(`${provider.label}: ${problem}`);
  if (capability === "text-to-speech" && !customProviderCapabilities(provider).includes(capability)) {
    throw new ProviderConfigurationError(`${provider.label} needs a voice model and at least one voice. Add them in Settings.`);
  }
  if (capability === "speech-to-text" && !provider.sttModel) {
    throw new ProviderConfigurationError(`${provider.label} has no transcription model. Add one in Settings.`);
  }
  return provider;
}

export type CustomProviderInput = {
  /** Omitted when adding a provider; the id of an existing one when editing it. */
  id?: CustomProviderId;
  label: string;
  baseUrl: string;
  /** Omit to keep the saved key; an empty string removes it. */
  apiKey?: string;
  ttsModel?: string;
  sttModel?: string;
  voices: string[];
};

export async function saveCustomProvider(ownerId: number, input: CustomProviderInput): Promise<{ id: CustomProviderId }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const label = input.label.trim().slice(0, CUSTOM_PROVIDER_LIMITS.label);
  if (!label) throw new Error("Give the provider a name");
  const baseUrl = normalizeCustomBaseUrl(input.baseUrl);
  if (!baseUrl) throw new Error("Enter the provider's API address, starting with https://");
  const problem = providerUrlProblem(baseUrl);
  if (problem) throw new Error(problem);

  const ttsModel = input.ttsModel?.trim() || null;
  const sttModel = input.sttModel?.trim() || null;
  const voices = input.voices.map(voice => voice.trim()).filter(Boolean).slice(0, CUSTOM_PROVIDER_LIMITS.voices);
  if (!ttsModel && !sttModel) throw new Error("Add a voice model, a transcription model, or both");
  if (ttsModel && !voices.length) throw new Error("Add at least one voice name for the voice model");

  const rows = await ownedRows(ownerId);
  const existing = input.id ? rows.find(row => row.provider === input.id) : undefined;
  if (input.id && !existing) throw new Error("That provider no longer exists");
  if (!existing && rows.length >= MAX_CUSTOM_PROVIDERS) throw new Error(`You can add up to ${MAX_CUSTOM_PROVIDERS} providers`);

  const apiKey = input.apiKey === undefined ? existing?.apiKey ?? null : input.apiKey.trim() || null;
  const values = {
    label,
    apiBaseUrl: baseUrl,
    apiKey,
    defaultTtsModel: ttsModel,
    defaultModel: ttsModel,
    defaultSttModel: sttModel,
    options: { voices },
    secretConfigured: apiKey ? 1 : 0,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(bookxProviderSettings).set(values).where(eq(bookxProviderSettings.id, existing.id));
    return { id: existing.provider as CustomProviderId };
  }

  const id: CustomProviderId = `custom:${nanoid(12)}`;
  await db.insert(bookxProviderSettings).values({ id: nanoid(), ownerId, provider: id, chapterGapMs: 2000, fallbackEnabled: 0, ...values });
  return { id };
}

export async function deleteCustomProvider(ownerId: number, id: CustomProviderId): Promise<{ removed: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const row = (await ownedRows(ownerId)).find(candidate => candidate.provider === id);
  if (!row) return { removed: false };
  await db.delete(bookxProviderSettings).where(eq(bookxProviderSettings.id, row.id));
  return { removed: true };
}

/** Headers for a request to a custom provider; the key is optional for self-hosted servers. */
export function customProviderHeaders(provider: CustomProvider, json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["content-type"] = "application/json";
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}
