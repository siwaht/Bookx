import { keyHint, openAiRoute, requireProviderApiKey } from "./providerCredentials";
import type { BuiltInProviderId } from "../shared/providers";
import { ttsTraits } from "../shared/direction";

/**
 * Live model catalogs.
 *
 * Each connected provider is asked for its current models, so a model launched
 * after this release (as Eleven v4 was) shows up without an update. Lists are
 * cached per user and key for half an hour, a refresh skips the cache, and the
 * curated list below is used whenever a provider cannot be asked.
 */

export type ModelCapability = "text-to-speech" | "speech-to-text" | "language-model";

export type CatalogModel = {
  id: string;
  label: string;
  capabilities: ModelCapability[];
  detail?: string;
  /** Listed by the provider just now, rather than from Prosecast's own list. */
  live?: boolean;
  /** Characters per request the provider documents. */
  maxChars?: number;
  languages?: number;
  /** Credits per character relative to the provider's base rate (ElevenLabs). */
  costMultiplier?: number;
  /** What the model takes besides text, for text-to-speech models. */
  direction?: "audio-tags" | "instructions" | null;
  recommended?: boolean;
  deprecated?: boolean;
};

const tts = (id: string, label: string, detail: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, label, capabilities: ["text-to-speech"], detail, ...extra });
const stt = (id: string, label: string, detail: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, label, capabilities: ["speech-to-text"], detail, ...extra });
const llm = (id: string, label: string, detail: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, label, capabilities: ["language-model"], detail, ...extra });

/** Curated lists, current as of October 2026. */
export const STATIC_MODELS: Partial<Record<BuiltInProviderId, CatalogModel[]>> = {
  ElevenLabs: [
    tts("eleven_v4", "Eleven v4", "Most expressive: audio tags for emotion and scene direction, 90+ languages", { maxChars: 10_000, direction: "audio-tags", recommended: true }),
    tts("eleven_v4_turbo", "Eleven v4 Turbo", "v4 expressiveness at low latency", { maxChars: 10_000, direction: "audio-tags" }),
    tts("eleven_v3", "Eleven v3", "Previous expressive model with audio tags", { maxChars: 5_000, direction: "audio-tags" }),
    tts("eleven_multilingual_v2", "Multilingual v2", "Stable long-form narration with style and speed controls", { maxChars: 10_000 }),
    tts("eleven_flash_v2_5", "Flash v2.5", "Fast, lower-cost draft narration", { maxChars: 40_000, costMultiplier: 0.5 }),
    tts("eleven_flash_v2", "Flash v2", "Fast English narration with phoneme tags", { maxChars: 30_000, costMultiplier: 0.5 }),
    stt("scribe_v2", "Scribe v2", "Timed transcription with speaker labels, 90+ languages", { recommended: true }),
  ],
  Deepgram: [
    tts("aura-2-thalia-en", "Aura-2 Thalia", "Natural English narration"),
    tts("aura-2-andromeda-en", "Aura-2 Andromeda", "Warm English narration"),
    tts("aura-2-orpheus-en", "Aura-2 Orpheus", "Measured English narration"),
    stt("nova-3", "Nova-3", "Pre-recorded transcription", { recommended: true }),
    stt("nova-2", "Nova-2", "Previous generation transcription"),
  ],
  OpenAI: [
    tts("gpt-4o-mini-tts", "GPT-4o mini TTS", "Takes delivery instructions (tone, emotion, setting)", { direction: "instructions", recommended: true, maxChars: 4_096 }),
    tts("tts-1-hd", "TTS-1 HD", "Higher-quality classic voices", { maxChars: 4_096 }),
    tts("tts-1", "TTS-1", "Fast classic voices", { maxChars: 4_096 }),
    stt("gpt-4o-transcribe", "GPT-4o Transcribe", "File transcription", { recommended: true }),
    stt("gpt-4o-mini-transcribe", "GPT-4o mini Transcribe", "Lower-cost file transcription"),
    stt("whisper-1", "Whisper", "Classic transcription"),
    llm("gpt-5", "GPT-5", "Project organisation and editorial planning", { recommended: true }),
    llm("gpt-5-mini", "GPT-5 mini", "Faster, lower-cost analysis"),
  ],
  OpenRouter: [
    llm("openai/gpt-4o-mini", "GPT-4o mini", "Fast, affordable editorial planning"),
    llm("openai/gpt-4o", "GPT-4o", "Balanced reasoning and analysis"),
    llm("anthropic/claude-3.5-sonnet", "Claude 3.5 Sonnet", "Thoughtful long-form analysis"),
    llm("google/gemini-2.0-flash-001", "Gemini 2.0 Flash", "Quick, capable reasoning"),
    llm("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B", "Open-weight reasoning"),
  ],
  "Fish Audio": [
    tts("s2.1-pro", "S2.1 Pro", "Expressive multilingual narration", { recommended: true }),
    tts("s2-pro", "S2 Pro", "Previous generation"),
    tts("s1", "S1", "Earlier model"),
    tts("s2.1-pro-free", "S2.1 Pro (free tier)", "Fish Audio's free developer tier"),
    stt("transcribe-1", "Transcribe 1", "File transcription"),
  ],
  Gradium: [
    tts("default", "Gradium TTS", "Natural narration in English, French, German, Spanish and Portuguese", { recommended: true }),
    tts("gradium-tts-beta", "Gradium TTS (beta)", "Newest model; may change"),
  ],
};

const LIVE_TTL_MS = 30 * 60_000;
const LIVE_TIMEOUT_MS = 8_000;
const liveCache = new Map<string, { at: number; models: CatalogModel[] }>();

/** The provider's own words for a failure, without the JSON wrapped around them. */
function errorWords(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown; message?: unknown; err_msg?: unknown } | null;
    const nested = (value: unknown) => (value && typeof value === "object" ? (value as { message?: unknown }).message : value);
    const found = [nested(parsed?.detail), nested(parsed?.error), parsed?.err_msg, parsed?.message].find(value => typeof value === "string" && value.trim());
    if (typeof found === "string") return found.trim();
  } catch {
    // Not JSON; the text itself is the message.
  }
  return body.replace(/\s+/g, " ").trim();
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS), redirect: "manual" });
  if (!response.ok) {
    const detail = errorWords(await response.text().catch(() => ""));
    throw new Error(`Model list returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  return response.json();
}

const directionOf = (provider: string, id: string): CatalogModel["direction"] => {
  const traits = ttsTraits(provider, id);
  return traits.audioTags ? "audio-tags" : traits.instructions ? "instructions" : null;
};

async function elevenLabsModels(ownerId?: number): Promise<CatalogModel[]> {
  const key = await requireProviderApiKey("ElevenLabs", ownerId);
  const payload = await getJson("https://api.elevenlabs.io/v1/models", { "xi-api-key": key }) as Array<{
    model_id?: string; name?: string; description?: string; can_do_text_to_speech?: boolean; languages?: unknown[];
    maximum_text_length_per_request?: number; max_characters_request_subscribed_user?: number;
    model_rates?: { character_cost_multiplier?: number }; token_cost_factor?: number; requires_alpha_access?: boolean;
  }>;
  const curated = new Map((STATIC_MODELS.ElevenLabs ?? []).map(model => [model.id, model]));
  return (Array.isArray(payload) ? payload : [])
    .filter(model => model.model_id && model.can_do_text_to_speech && !/_sts_|ttv/.test(model.model_id))
    .map(model => {
      const id = model.model_id!;
      const known = curated.get(id);
      return tts(id, model.name || known?.label || id, known?.detail || (model.description ?? "").slice(0, 140), {
        live: true,
        maxChars: model.maximum_text_length_per_request || model.max_characters_request_subscribed_user || known?.maxChars,
        languages: Array.isArray(model.languages) ? model.languages.length : undefined,
        costMultiplier: model.model_rates?.character_cost_multiplier ?? model.token_cost_factor ?? known?.costMultiplier,
        direction: directionOf("ElevenLabs", id),
        recommended: known?.recommended,
        deprecated: /turbo_v2/.test(id),
      });
    });
}

async function deepgramModels(ownerId?: number): Promise<CatalogModel[]> {
  const key = await requireProviderApiKey("Deepgram", ownerId);
  const payload = await getJson("https://api.deepgram.com/v1/models", { Authorization: `Token ${key}` }) as {
    stt?: Array<{ canonical_name?: string; name?: string; batch?: boolean; languages?: unknown[] }>;
    tts?: Array<{ canonical_name?: string; name?: string; languages?: unknown[]; metadata?: { accent?: string; tags?: string[] } }>;
  };
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const voice of payload.tts ?? []) {
    const id = voice.canonical_name;
    if (!id || seen.has(id) || !/^aura/.test(id)) continue;
    seen.add(id);
    const detail = [voice.metadata?.accent, ...(voice.metadata?.tags ?? []).slice(0, 2)].filter(Boolean).join(" · ");
    models.push(tts(id, `${/^aura-2/.test(id) ? "Aura-2" : "Aura"} ${voice.name ?? id}`, detail || "Deepgram voice", { live: true }));
  }
  for (const model of payload.stt ?? []) {
    const id = model.canonical_name;
    // Streaming-only models cannot transcribe a stored file.
    if (!id || seen.has(id) || model.batch === false) continue;
    seen.add(id);
    models.push(stt(id, model.name ? `${model.name}` : id, "Pre-recorded transcription", { live: true, languages: model.languages?.length, recommended: id === "nova-3" }));
  }
  return models.sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)));
}

const OPENAI_SKIP = /(embedding|moderation|dall-e|image|realtime|search|davinci|babbage|computer-use|-audio-|audio-preview|instruct)/;

async function openAiModels(ownerId?: number): Promise<CatalogModel[]> {
  const route = await openAiRoute(ownerId);
  const payload = await getJson(`${route.baseUrl}/models`, { Authorization: `Bearer ${route.apiKey}` }) as { data?: Array<{ id?: string; created?: number }> };
  const curated = new Map((STATIC_MODELS.OpenAI ?? []).map(model => [model.id, model]));
  return (payload.data ?? [])
    .filter(entry => entry.id && !OPENAI_SKIP.test(entry.id))
    .sort((left, right) => (right.created ?? 0) - (left.created ?? 0))
    .flatMap(entry => {
      const id = entry.id!;
      const known = curated.get(id);
      if (/tts/.test(id)) return [tts(id, known?.label ?? id, known?.detail ?? "Text to speech", { live: true, direction: directionOf("OpenAI", id), recommended: known?.recommended })];
      if (/(transcribe|whisper)/.test(id)) return [stt(id, known?.label ?? id, known?.detail ?? "Transcription", { live: true, recommended: known?.recommended })];
      if (/^(gpt-|o\d|chatgpt-)/.test(id)) return [llm(id, known?.label ?? id, known?.detail ?? "Language model", { live: true, recommended: known?.recommended })];
      return [];
    })
    .slice(0, 80);
}

async function openRouterModels(ownerId?: number): Promise<CatalogModel[]> {
  const key = await requireProviderApiKey("OpenRouter", ownerId);
  const payload = await getJson("https://openrouter.ai/api/v1/models", { Authorization: `Bearer ${key}` }) as {
    data?: Array<{ id?: string; name?: string; created?: number; context_length?: number; pricing?: { prompt?: string; completion?: string }; architecture?: { output_modalities?: string[] } }>;
  };
  return (payload.data ?? [])
    .filter(model => model.id && (!model.architecture?.output_modalities || model.architecture.output_modalities.includes("text")))
    .sort((left, right) => (right.created ?? 0) - (left.created ?? 0))
    .slice(0, 400)
    .map(model => {
      const perMillion = Number.parseFloat(model.pricing?.prompt ?? "") * 1_000_000;
      const price = Number.isFinite(perMillion) ? (perMillion === 0 ? "free" : `$${perMillion < 1 ? perMillion.toFixed(2) : perMillion.toFixed(perMillion < 10 ? 1 : 0)}/M input`) : null;
      const context = model.context_length ? `${Math.round(model.context_length / 1000)}k context` : null;
      return llm(model.id!, model.name || model.id!, [context, price].filter(Boolean).join(" · ") || "Language model", { live: true });
    });
}

const LIVE: Partial<Record<BuiltInProviderId, (ownerId?: number) => Promise<CatalogModel[]>>> = {
  ElevenLabs: elevenLabsModels,
  Deepgram: deepgramModels,
  OpenAI: openAiModels,
  OpenRouter: openRouterModels,
};

export const hasLiveCatalog = (provider: string): boolean => provider in LIVE;

/**
 * A provider's models: the live list merged with the curated one (curated
 * entries the provider did not list, such as ElevenLabs' transcription models,
 * are kept), or the curated list alone when asking failed.
 */
export async function providerModels(input: {
  provider: BuiltInProviderId;
  ownerId?: number;
  apiKey: string | null;
  refresh?: boolean;
}): Promise<{ models: CatalogModel[]; live: boolean; error?: string; fetchedAt?: string }> {
  const curated = STATIC_MODELS[input.provider] ?? [];
  const fetchLive = LIVE[input.provider];
  if (!fetchLive || !input.apiKey) return { models: curated, live: false };

  const cacheKey = `${input.ownerId ?? "env"}:${input.provider}:${keyHint(input.apiKey) ?? ""}`;
  const cached = liveCache.get(cacheKey);
  if (cached && !input.refresh && Date.now() - cached.at < LIVE_TTL_MS) {
    return { models: mergeModels(cached.models, curated), live: true, fetchedAt: new Date(cached.at).toISOString() };
  }
  try {
    const models = await fetchLive(input.ownerId);
    liveCache.set(cacheKey, { at: Date.now(), models });
    if (liveCache.size > 300) liveCache.delete(liveCache.keys().next().value!);
    return { models: mergeModels(models, curated), live: true, fetchedAt: new Date().toISOString() };
  } catch (error) {
    // A previous good list beats the short curated one.
    if (cached) return { models: mergeModels(cached.models, curated), live: true, fetchedAt: new Date(cached.at).toISOString(), error: error instanceof Error ? error.message : "Model discovery failed" };
    return { models: curated, live: false, error: error instanceof Error ? error.message : "Model discovery failed" };
  }
}

function mergeModels(live: CatalogModel[], curated: CatalogModel[]): CatalogModel[] {
  const ids = new Set(live.map(model => model.id));
  // Curated entries for a capability the live list covers are dropped when the
  // provider no longer lists them (a retired model); others are kept.
  const liveCapabilities = new Set(live.flatMap(model => model.capabilities));
  const kept = curated.filter(model => !ids.has(model.id) && !model.capabilities.every(capability => liveCapabilities.has(capability)));
  const ordered = [...live, ...kept];
  return ordered.sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)));
}

/** Forgets cached lists for a user, so the next catalog read asks the providers again. */
export function forgetModelCatalog(ownerId: number, provider?: string) {
  for (const key of [...liveCache.keys()]) {
    const [owner, name] = key.split(":");
    if (owner === String(ownerId) && (!provider || name === provider)) liveCache.delete(key);
  }
}
