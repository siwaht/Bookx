import { z } from "zod";

/**
 * Provider identities, shared by the server and the web app.
 *
 * Built-in providers have their own API integrations. Anything else the user
 * adds in Settings is a custom provider: an OpenAI-compatible speech service,
 * stored per user under an id of the form `custom:<id>`.
 */

export const BUILT_IN_PROVIDERS = ["ElevenLabs", "Deepgram", "Cloudflare", "OpenAI", "OpenRouter", "Fish Audio", "Gradium"] as const;
export type BuiltInProviderId = (typeof BUILT_IN_PROVIDERS)[number];
export type CustomProviderId = `custom:${string}`;
export type ProviderId = BuiltInProviderId | CustomProviderId;

export const CUSTOM_PROVIDER_PATTERN = /^custom:[A-Za-z0-9_-]{1,40}$/;

export function isCustomProviderId(id: string): id is CustomProviderId {
  return CUSTOM_PROVIDER_PATTERN.test(id);
}

export function isBuiltInProvider(id: string): id is BuiltInProviderId {
  return (BUILT_IN_PROVIDERS as readonly string[]).includes(id);
}

export function isProviderId(id: string): id is ProviderId {
  return isBuiltInProvider(id) || isCustomProviderId(id);
}

export const builtInProviderSchema = z.enum(BUILT_IN_PROVIDERS);
export const customProviderIdSchema = z.custom<CustomProviderId>(value => typeof value === "string" && isCustomProviderId(value), {
  message: "Unknown provider",
});
export const providerIdSchema = z.union([builtInProviderSchema, customProviderIdSchema]);

/** Limits for a custom provider's settings, shared by the form and the server. */
export const CUSTOM_PROVIDER_LIMITS = {
  label: 60,
  url: 255,
  apiKey: 512,
  model: 160,
  voice: 80,
  voices: 64,
} as const;

/** Splits a comma- or newline-separated voice list into unique, trimmed names. */
export function parseVoiceList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]/)) {
    const voice = part.trim().slice(0, CUSTOM_PROVIDER_LIMITS.voice);
    if (voice) seen.add(voice);
  }
  return Array.from(seen).slice(0, CUSTOM_PROVIDER_LIMITS.voices);
}
