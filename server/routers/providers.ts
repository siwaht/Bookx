import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { protectedProcedure, router } from "../_core/trpc";
import { bookxProviderSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { providerCapabilities, resolveProvider, type ProviderId, type RoutingCapability } from "../providerRouting";
import { PROVIDER_ENV_KEYS, availableProviders, cloudflareAccountIdFromUrl, cloudflareHeaders, cloudflareUrlNeedsOwnToken, getCloudflareEndpoint, isWebsocketOnlyCloudflareModel, keyHint, openAiRoute, providerKeyStates, redactProviderApiKey, requireProviderApiKey, type CloudflareEndpoint } from "../providerCredentials";
import { customProviderCapabilities, customProviderHeaders, deleteCustomProvider, listCustomProviders, providerUrlProblem, requireCustomProvider, saveCustomProvider } from "../customProviders";
import { extractJson, languageModelText } from "../languageModel";
import { rankCatalogVoices, voiceCatalogFor } from "../voiceCatalog";
import { CUSTOM_PROVIDER_LIMITS, builtInProviderSchema, customProviderIdSchema, isCustomProviderId, providerIdSchema } from "../../shared/providers";

export type ProviderCapability = "text-to-speech" | "speech-to-text" | "language-model";

type ProviderModel = {
  id: string;
  label: string;
  capabilities: ProviderCapability[];
  detail?: string;
};

type ProviderCatalogItem = {
  id: string;
  label: string;
  configured: boolean;
  status: "connected" | "available" | "optional";
  /** Whether the key came from the Settings screen or the environment. */
  keySource?: "app" | "environment";
  /** The last characters of the key in use, so the user can tell keys apart. */
  keyHint?: string;
  /** Whether the deployment also supplies a key, which applies if the saved one is removed. */
  environmentKey?: boolean;
  /** Set when live model discovery failed, so the UI can explain the short list. */
  discoveryError?: string;
  capabilities: ProviderCapability[];
  models: ProviderModel[];
  /** Cloudflare: the account in use, and whether it was saved in the app. */
  accountId?: string;
  accountSource?: "app" | "environment";
  /** A provider the user added: its settings, for the edit form (never its key). */
  custom?: { baseUrl: string; ttsModel: string; sttModel: string; voices: string[] };
};

const providerId = providerIdSchema;
const capability = z.enum(["text-to-speech", "speech-to-text", "language-model"]);

const capabilities = (taskName: string): ProviderCapability[] => {
  const task = taskName.toLowerCase();
  const result: ProviderCapability[] = [];
  if (/(text generation|language model|chat|summarization)/.test(task)) result.push("language-model");
  if (/(text[\s-]+to[\s-]+speech|speech synthesis|audio generation)/.test(task)) result.push("text-to-speech");
  if (/(speech[\s-]+to[\s-]+text|transcription|automatic speech recognition)/.test(task)) result.push("speech-to-text");
  return result;
};

/** Shown before any discovery so an unconfigured Cloudflare still lists usable defaults. */
const cloudflareStaticModels: ProviderModel[] = [
  { id: "@cf/deepgram/aura-2-en", label: "Aura-2 (English)", capabilities: ["text-to-speech"], detail: "Recommended for narration · fast and consistent" },
  { id: "@cf/deepgram/aura-2-es", label: "Aura-2 (Spanish)", capabilities: ["text-to-speech"], detail: "Spanish narration voices" },
  { id: "@cf/myshell-ai/melotts", label: "MeloTTS", capabilities: ["text-to-speech"], detail: "Multilingual draft narration · returns intermittent errors" },
  { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", capabilities: ["language-model"], detail: "Cast analysis and editorial planning" },
  { id: "@cf/openai/whisper", label: "Whisper", capabilities: ["speech-to-text"], detail: "Audio transcription" },
  { id: "@cf/deepgram/nova-3", label: "Nova-3", capabilities: ["speech-to-text"], detail: "Fast transcription with word timings" },
];

/** Best-effort capability guess for models listed by an OpenAI-compatible endpoint. */
function inferCompatCapabilities(id: string): ProviderCapability[] {
  const lower = id.toLowerCase();
  if (/whisper|transcri|stt/.test(lower)) return ["speech-to-text"];
  if (/tts|speech|aura|voice/.test(lower)) return ["text-to-speech"];
  return ["language-model"];
}

async function cloudflareModels(endpoint: CloudflareEndpoint | null): Promise<ProviderModel[]> {
  if (!endpoint) return [];
  const models = [...cloudflareStaticModels];
  const seen = new Set(models.map((model) => model.id));

  if (endpoint.mode === "native") {
    const response = await fetch(`${endpoint.apiBaseUrl}/models/search?per_page=100`, { headers: cloudflareHeaders(endpoint), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Cloudflare model discovery returned HTTP ${response.status}`);
    const payload = await response.json() as { result?: Array<{ name?: string; description?: string; task?: { name?: string } | string }> };
    for (const model of payload.result || []) {
      const taskName = typeof model.task === "string" ? model.task : model.task?.name || "";
      const id = model.name || "";
      if (!id || seen.has(id)) continue;
      // A realtime-only model cannot serve a stored file, so offering it as a
      // choice would only produce a confusing failure later.
      if (isWebsocketOnlyCloudflareModel(id)) continue;
      const caps = capabilities(taskName);
      if (!caps.length) continue;
      seen.add(id);
      models.push({ id, label: id, detail: taskName || model.description, capabilities: caps });
    }
  } else {
    const response = await fetch(`${endpoint.apiBaseUrl}/models`, { headers: { Authorization: `Bearer ${endpoint.apiKey}` }, signal: AbortSignal.timeout(12_000), redirect: "manual" });
    if (!response.ok) throw new Error(`Cloudflare model discovery returned HTTP ${response.status}`);
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    for (const entry of payload.data || []) {
      const id = entry.id || "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id, detail: "Discovered from your endpoint", capabilities: inferCompatCapabilities(id) });
    }
  }

  // Saved custom model names always appear with their intended capability.
  const saved: Array<[string | undefined, ProviderCapability]> = [[endpoint.ttsModel, "text-to-speech"], [endpoint.sttModel, "speech-to-text"], [endpoint.llmModel, "language-model"]];
  for (const [id, capability] of saved) {
    if (!id) continue;
    const existing = models.find((model) => model.id === id);
    if (existing) {
      if (!existing.capabilities.includes(capability)) existing.capabilities.push(capability);
      continue;
    }
    models.push({ id, label: id, capabilities: [capability], detail: "Saved custom model" });
  }
  return models;
}

async function catalog(ownerId?: number): Promise<ProviderCatalogItem[]> {
  const keys = await providerKeyStates(ownerId);
  const endpoint = await getCloudflareEndpoint(ownerId);
  const cloudflareConfigured = Boolean(endpoint);

  let cloudflare: ProviderModel[] = cloudflareStaticModels;
  let cloudflareError: string | undefined;
  if (cloudflareConfigured) {
    try {
      cloudflare = await cloudflareModels(endpoint);
    } catch (error) {
      // Previously swallowed, which left the screen showing only the handful of
      // static models with no hint that discovery had failed.
      cloudflareError = error instanceof Error ? error.message : "Model discovery failed";
      cloudflare = cloudflareStaticModels;
    }
  }

  /** Connection state plus where the key came from, so the UI can say so. */
  const state = (provider: Exclude<ProviderId, `custom:${string}`>) => {
    const configured = Boolean(keys[provider].apiKey);
    return {
      configured,
      status: (configured ? "connected" : "available") as ProviderCatalogItem["status"],
      keySource: keys[provider].source ?? undefined,
      keyHint: keyHint(keys[provider].apiKey),
      // Whether removing a saved key falls back to one from the deployment.
      environmentKey: Boolean(process.env[PROVIDER_ENV_KEYS[provider]]?.trim()),
    };
  };

  // Which Cloudflare account is in use: one saved in Settings, else the deployment's.
  const db = await getDb();
  const savedCloudflare = db && ownerId != null
    ? (await db.select().from(bookxProviderSettings).where(and(eq(bookxProviderSettings.ownerId, ownerId), eq(bookxProviderSettings.provider, "Cloudflare"))).limit(1))[0]
    : undefined;
  const savedAccount = cloudflareAccountIdFromUrl(savedCloudflare?.apiBaseUrl);
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
  const account = savedAccount
    ? { accountId: savedAccount, accountSource: "app" as const }
    : endpoint?.mode === "native" && envAccount
      ? { accountId: envAccount, accountSource: "environment" as const }
      : {};

  const customProviders: ProviderCatalogItem[] = (await listCustomProviders(ownerId)).map(custom => {
    const caps = customProviderCapabilities(custom);
    const models: ProviderModel[] = [];
    if (custom.ttsModel) models.push({ id: custom.ttsModel, label: custom.ttsModel, capabilities: ["text-to-speech"], detail: `${custom.voices.length} voice${custom.voices.length === 1 ? "" : "s"}` });
    if (custom.sttModel) models.push({ id: custom.sttModel, label: custom.sttModel, capabilities: ["speech-to-text"], detail: "Transcription" });
    return {
      id: custom.id,
      label: custom.label,
      configured: caps.length > 0,
      status: caps.length > 0 ? "connected" : "available",
      keySource: custom.apiKey ? "app" : undefined,
      keyHint: keyHint(custom.apiKey),
      capabilities: caps,
      models,
      custom: { baseUrl: custom.baseUrl, ttsModel: custom.ttsModel ?? "", sttModel: custom.sttModel ?? "", voices: custom.voices },
    };
  });

  return [
    {
      id: "ElevenLabs", label: "ElevenLabs", ...state("ElevenLabs"),
      capabilities: ["text-to-speech", "speech-to-text"],
      models: [
        { id: "eleven_multilingual_v2", label: "Multilingual v2", capabilities: ["text-to-speech"], detail: "Stable long-form narration" },
        { id: "eleven_v3", label: "Eleven v3", capabilities: ["text-to-speech"], detail: "Expressive multi-speaker delivery" },
        { id: "eleven_flash_v2_5", label: "Flash v2.5", capabilities: ["text-to-speech"], detail: "Fast draft narration" },
        { id: "scribe_v2", label: "Scribe v2", capabilities: ["speech-to-text"], detail: "Timed transcription" },
      ],
    },
    {
      id: "Deepgram", label: "Deepgram", ...state("Deepgram"),
      capabilities: ["text-to-speech", "speech-to-text"],
      models: [
        { id: "aura-2-thalia-en", label: "Aura-2 Thalia", capabilities: ["text-to-speech"], detail: "Natural English narration" },
        { id: "aura-2-andromeda-en", label: "Aura-2 Andromeda", capabilities: ["text-to-speech"], detail: "Warm English narration" },
        { id: "aura-2-orpheus-en", label: "Aura-2 Orpheus", capabilities: ["text-to-speech"], detail: "Measured English narration" },
        { id: "nova-3", label: "Nova-3", capabilities: ["speech-to-text"], detail: "Pre-recorded transcription" },
        // `flux` is intentionally absent: it is realtime/WebSocket only and cannot
        // transcribe a stored file, so offering it would only fail later.
      ],
    },
    {
      id: "Cloudflare", label: "Cloudflare Workers AI", configured: cloudflareConfigured,
      status: cloudflareConfigured ? "connected" : "available",
      keySource: keys.Cloudflare.source ?? undefined,
      // The token actually used, which is the saved one when there is one.
      keyHint: keyHint(endpoint?.apiKey ?? keys.Cloudflare.apiKey),
      environmentKey: Boolean(envAccount && process.env.CLOUDFLARE_API_TOKEN?.trim()),
      discoveryError: cloudflareError,
      capabilities: ["text-to-speech", "speech-to-text", "language-model"], models: cloudflare,
      ...account,
    },
    {
      id: "OpenAI", label: "OpenAI", ...state("OpenAI"),
      capabilities: ["text-to-speech", "speech-to-text", "language-model"],
      models: [
        { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", capabilities: ["text-to-speech"], detail: "Narration and voice responses" },
        { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe", capabilities: ["speech-to-text"], detail: "File transcription" },
        { id: "gpt-5", label: "GPT-5", capabilities: ["language-model"], detail: "Project organisation and editorial planning" },
      ],
    },
    {
      id: "OpenRouter", label: "OpenRouter", ...state("OpenRouter"),
      capabilities: ["language-model"],
      models: [
        { id: "openai/gpt-4o-mini", label: "GPT-4o mini", capabilities: ["language-model"], detail: "Fast, affordable editorial planning" },
        { id: "openai/gpt-4o", label: "GPT-4o", capabilities: ["language-model"], detail: "Balanced reasoning and analysis" },
        { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", capabilities: ["language-model"], detail: "Thoughtful long-form analysis" },
        { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash", capabilities: ["language-model"], detail: "Quick, capable reasoning" },
        { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", capabilities: ["language-model"], detail: "Open-weight reasoning" },
      ],
    },
    {
      id: "Fish Audio", label: "Fish Audio", ...state("Fish Audio"),
      capabilities: ["text-to-speech", "speech-to-text"],
      models: [
        { id: "s2.1-pro", label: "S2.1 Pro", capabilities: ["text-to-speech"], detail: "Expressive multilingual narration" },
        { id: "s2-pro", label: "S2 Pro", capabilities: ["text-to-speech"], detail: "Previous generation" },
        { id: "s1", label: "S1", capabilities: ["text-to-speech"], detail: "Earlier model" },
        { id: "s2.1-pro-free", label: "S2.1 Pro (free tier)", capabilities: ["text-to-speech"], detail: "Fish Audio's free developer tier" },
        { id: "transcribe-1", label: "Transcribe 1", capabilities: ["speech-to-text"], detail: "File transcription" },
      ],
    },
    {
      id: "Gradium", label: "Gradium", ...state("Gradium"),
      capabilities: ["text-to-speech"],
      models: [
        { id: "default", label: "Gradium TTS", capabilities: ["text-to-speech"], detail: "Natural narration in English, French, German, Spanish and Portuguese" },
        { id: "gradium-tts-beta", label: "Gradium TTS (beta)", capabilities: ["text-to-speech"], detail: "Newest model; may change" },
      ],
    },
    ...customProviders,
  ];
}

const castVoice = z.object({ id: z.string().min(1).max(160), label: z.string().min(1).max(160), description: z.string().max(300).optional() });

export type DiscoverableVoice = {
  id: string;
  label: string;
  description: string;
  provider: ProviderId;
};

/** Keyword ranking over a voice list; kept under its old name for callers and tests. */
export function rankVoiceMatches(voices: DiscoverableVoice[], query: string) {
  return rankCatalogVoices(voices, query);
}

export function normalizeCastConfidence(value: number) {
  return Math.round(value >= 0 && value <= 1 ? value * 100 : value);
}

const castRecommendation = z.object({
  name: z.string().min(1).max(160),
  role: z.string().max(100),
  voiceId: z.string().min(1).max(160),
  voiceName: z.string().min(1).max(160),
  accent: z.string().max(160),
  rationale: z.string().max(512),
  sampleLine: z.string().max(2000),
  confidence: z.number().min(0).max(100).transform(normalizeCastConfidence),
});



export const providersRouter = router({
  catalog: protectedProcedure.query(({ ctx }) => catalog(ctx.user.id)),
  refreshCloudflareModels: protectedProcedure.mutation(async ({ ctx }) => ({ models: await cloudflareModels(await getCloudflareEndpoint(ctx.user.id)) })),
  modelOptions: protectedProcedure.input(z.object({ capability: z.enum(["text-to-speech", "speech-to-text", "language-model"]) })).query(async ({ ctx, input }) => {
    const providers = await catalog(ctx.user.id);
    return providers.flatMap((provider) => provider.models
      .filter((model) => model.capabilities.includes(input.capability))
      .map((model) => ({ ...model, providerId: provider.id, providerLabel: provider.label, configured: provider.configured })));
  }),
  listPreferences: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, ctx.user.id));
    return rows.map(redactProviderApiKey);
  }),
  /**
   * Patch, not replace. A field the caller omits keeps its stored value; an
   * empty string clears it. Previously every optional field was written as
   * `input.x || null`, so a caller that sent only a fallback policy silently
   * erased the saved endpoint URL and the custom model names alongside it.
   */
  savePreference: protectedProcedure.input(z.object({ provider: builtInProviderSchema, defaultTtsModel: z.string().max(160).optional(), defaultSttModel: z.string().max(160).optional(), defaultLlmModel: z.string().max(160).optional(), fallbackProvider: builtInProviderSchema.optional(), fallbackEnabled: z.boolean().optional(), apiBaseUrl: z.union([z.string().url().max(255), z.literal("")]).optional(), apiKey: z.string().max(512).optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    // The server calls this address itself, so it gets the same checks as a custom provider's.
    if (input.apiBaseUrl) {
      const problem = providerUrlProblem(input.apiBaseUrl);
      if (problem) throw new Error(problem);
    }
    const [existing] = await db.select().from(bookxProviderSettings).where(and(eq(bookxProviderSettings.ownerId, ctx.user.id), eq(bookxProviderSettings.provider, input.provider))).limit(1);

    const values: Record<string, unknown> = { updatedAt: new Date() };
    const patch = (column: string, value: string | undefined) => {
      if (value !== undefined) values[column] = value || null;
    };
    patch("defaultTtsModel", input.defaultTtsModel);
    patch("defaultSttModel", input.defaultSttModel);
    patch("defaultLlmModel", input.defaultLlmModel);
    patch("fallbackProvider", input.fallbackProvider);
    patch("apiBaseUrl", input.apiBaseUrl);
    patch("apiKey", input.apiKey);
    if (input.fallbackEnabled !== undefined) values.fallbackEnabled = input.fallbackEnabled ? 1 : 0;

    // A provider counts as configured when its key is in the environment, the
    // caller just supplied one, or one is already stored. Deriving this from the
    // request alone marked an existing saved connection unconfigured.
    const effectiveKey = input.apiKey !== undefined ? input.apiKey : existing?.apiKey;
    const envKey = process.env[PROVIDER_ENV_KEYS[input.provider]]?.trim();
    values.secretConfigured = Boolean(effectiveKey) || Boolean(envKey) ? 1 : 0;

    if (existing) { await db.update(bookxProviderSettings).set(values).where(eq(bookxProviderSettings.id, existing.id)); return { id: existing.id }; }
    const id = nanoid();
    await db.insert(bookxProviderSettings).values({ id, ownerId: ctx.user.id, provider: input.provider, defaultModel: input.defaultTtsModel || null, defaultPace: null, chapterGapMs: 2000, fallbackEnabled: 0, ...values });
    return { id };
  }),
  /**
   * Removes the key saved in the app. A deployment key, if there is one, then
   * takes over again. Cloudflare's saved account goes with its token.
   */
  removeKey: protectedProcedure.input(z.object({ provider: builtInProviderSchema })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [existing] = await db.select().from(bookxProviderSettings).where(and(eq(bookxProviderSettings.ownerId, ctx.user.id), eq(bookxProviderSettings.provider, input.provider))).limit(1);
    if (!existing) return { removed: false };
    const values: Record<string, unknown> = { apiKey: null, updatedAt: new Date() };
    // An address that only works with the user's own token goes with it too, so
    // the deployment's token is never sent there in its place.
    if (input.provider === "Cloudflare" && (cloudflareAccountIdFromUrl(existing.apiBaseUrl) || cloudflareUrlNeedsOwnToken(existing.apiBaseUrl))) values.apiBaseUrl = null;
    values.secretConfigured = process.env[PROVIDER_ENV_KEYS[input.provider]]?.trim() ? 1 : 0;
    await db.update(bookxProviderSettings).set(values).where(eq(bookxProviderSettings.id, existing.id));
    return { removed: true };
  }),
  /** Adds a provider with an OpenAI-compatible speech API, or edits one. */
  saveCustomProvider: protectedProcedure.input(z.object({
    id: customProviderIdSchema.optional(),
    label: z.string().trim().min(1).max(CUSTOM_PROVIDER_LIMITS.label),
    baseUrl: z.string().trim().min(1).max(CUSTOM_PROVIDER_LIMITS.url),
    apiKey: z.string().max(CUSTOM_PROVIDER_LIMITS.apiKey).optional(),
    ttsModel: z.string().trim().max(CUSTOM_PROVIDER_LIMITS.model).optional(),
    sttModel: z.string().trim().max(CUSTOM_PROVIDER_LIMITS.model).optional(),
    voices: z.array(z.string().trim().min(1).max(CUSTOM_PROVIDER_LIMITS.voice)).max(CUSTOM_PROVIDER_LIMITS.voices).default([]),
  })).mutation(({ ctx, input }) => saveCustomProvider(ctx.user.id, input)),
  removeCustomProvider: protectedProcedure.input(z.object({ id: customProviderIdSchema })).mutation(({ ctx, input }) => deleteCustomProvider(ctx.user.id, input.id)),
  validate: protectedProcedure.input(z.object({ provider: providerId })).mutation(async ({ ctx, input }) => {
    if (isCustomProviderId(input.provider)) {
      // The user's own provider: ask its API for the model list, which needs a
      // working address and key but costs nothing.
      try {
        const custom = await requireCustomProvider(input.provider, ctx.user.id);
        const capabilities = customProviderCapabilities(custom);
        if (!capabilities.length) return { provider: input.provider, status: "not-configured" as const, capabilities };
        const response = await fetch(`${custom.baseUrl}/models`, { headers: customProviderHeaders(custom, false), signal: AbortSignal.timeout(15_000), redirect: "manual" });
        if (response.ok || response.status === 404 || response.status === 405) {
          return { provider: input.provider, status: "connected" as const, capabilities };
        }
        const detail = await response.text().catch(() => "");
        return { provider: input.provider, status: "degraded" as const, capabilities, detail: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
      } catch (error) {
        return { provider: input.provider, status: "degraded" as const, capabilities: [] as RoutingCapability[], detail: error instanceof Error ? error.message : "Connection test failed" };
      }
    }

    const available = await availableProviders(ctx.user.id);
    if (!available.includes(input.provider)) return { provider: input.provider, status: "not-configured" as const, capabilities: providerCapabilities[input.provider] };
    try {
      // Each check reports the provider's own error text, so "Check" tells the
      // user what is actually wrong with the key rather than just failing.
      const failIfNotOk = async (response: Response) => {
        if (response.ok) return;
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      };

      if (input.provider === "Cloudflare") await cloudflareModels(await getCloudflareEndpoint(ctx.user.id));
      if (input.provider === "Deepgram") {
        await failIfNotOk(await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${await requireProviderApiKey("Deepgram", ctx.user.id)}` }, signal: AbortSignal.timeout(15_000) }));
      }
      if (input.provider === "ElevenLabs") {
        await failIfNotOk(await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": await requireProviderApiKey("ElevenLabs", ctx.user.id) }, signal: AbortSignal.timeout(15_000) }));
      }
      if (input.provider === "OpenAI") {
        const route = await openAiRoute(ctx.user.id);
        await failIfNotOk(await fetch(`${route.baseUrl}/models`, { headers: { Authorization: `Bearer ${route.apiKey}` }, signal: AbortSignal.timeout(15_000), redirect: "manual" }));
      }
      if (input.provider === "OpenRouter") {
        await failIfNotOk(await fetch("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${await requireProviderApiKey("OpenRouter", ctx.user.id)}` }, signal: AbortSignal.timeout(15_000) }));
      }
      if (input.provider === "Fish Audio") {
        await failIfNotOk(await fetch("https://api.fish.audio/model?self=true&page_size=1", { headers: { Authorization: `Bearer ${await requireProviderApiKey("Fish Audio", ctx.user.id)}` }, signal: AbortSignal.timeout(15_000) }));
      }
      if (input.provider === "Gradium") {
        await failIfNotOk(await fetch("https://api.gradium.ai/api/voices/?limit=1", { headers: { "x-api-key": await requireProviderApiKey("Gradium", ctx.user.id) }, signal: AbortSignal.timeout(15_000) }));
      }
      return { provider: input.provider, status: "connected" as const, capabilities: providerCapabilities[input.provider] };
    } catch (error) {
      return { provider: input.provider, status: "degraded" as const, capabilities: providerCapabilities[input.provider], detail: error instanceof Error ? error.message : "Connection test failed" };
    }
  }),
  resolve: protectedProcedure.input(z.object({ requested: providerId, capability })).query(async ({ ctx, input }) => ({ ...resolveProvider(input.requested, input.capability as RoutingCapability, await availableProviders(ctx.user.id, input.capability as RoutingCapability)), capability: input.capability })),
  voiceCatalog: protectedProcedure.input(z.object({ provider: providerId.default("ElevenLabs"), query: z.string().trim().max(160).optional() })).query(async ({ ctx, input }) => {
    // Real provider voices with their gender, age and accent. The starter
    // personas are only offered when the provider has no catalog of its own.
    const voices = await voiceCatalogFor(input.provider, ctx.user.id);
    // Searching narrows; an empty query lists the whole catalog so every voice
    // is reachable from the assignment dropdowns.
    return rankCatalogVoices(voices, input.query || "").slice(0, input.query ? 40 : 200);
  }),
  recommendCast: protectedProcedure.input(z.object({
    provider: providerId.optional(),
    model: z.string().min(1).max(160).optional(),
    text: z.string().trim().min(40).max(16_000),
    voices: z.array(castVoice).min(2).max(64),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    const preferences = db ? await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, ctx.user.id)) : [];
    const requested = input.provider || (preferences.find((preference) => preference.defaultLlmModel)?.provider as ProviderId | undefined) || "Cloudflare";
    const routing = resolveProvider(requested, "language-model", await availableProviders(ctx.user.id, "language-model"));
    const provider = routing.provider;
    const preference = preferences.find((item) => item.provider === provider);
    const model = input.model || preference?.defaultLlmModel || (provider === "Cloudflare" ? "@cf/openai/gpt-oss-120b" : provider === "OpenRouter" ? "openai/gpt-4o-mini" : "gpt-5");
    const system = `You are Bookx's casting director. Find the narrator and named speaking characters in the supplied manuscript. Assign every returned character a DISTINCT voice from the approved voice catalog. Respect the character's apparent age, role, temperament, regional cues only when stated, and dialogue style. Return ONLY one compact JSON object, with no analysis or prose: {"characters":[{"name":"","role":"","voiceId":"","voiceName":"","accent":"","rationale":"","sampleLine":"","confidence":0}]}. Do not invent names that are not in the manuscript. Voice IDs must exactly match the catalog.`;
    const result = await languageModelText({ provider, model, system: `${system}\nApproved voice catalog: ${JSON.stringify(input.voices)}`, text: input.text, ownerId: ctx.user.id });
    const parsed = z.object({ characters: z.array(castRecommendation).min(1).max(64) }).parse(extractJson(result));
    const allowed = new Map(input.voices.map((voice) => [voice.id, voice]));
    const usedVoiceIds = new Set<string>();
    const characters = parsed.characters.map((character, index) => {
      const suggested = allowed.get(character.voiceId);
      const voice = suggested && !usedVoiceIds.has(suggested.id) ? suggested : input.voices.find((candidate) => !usedVoiceIds.has(candidate.id)) || suggested;
      if (!voice) throw new Error(`No approved voice is available for ${character.name}`);
      usedVoiceIds.add(voice.id);
      return { ...character, role: character.role || "Character", accent: character.accent || "Neutral", rationale: character.rationale || "Distinct delivery recommended from dialogue context.", sampleLine: character.sampleLine || `A representative line for ${character.name}.`, confidence: Math.round(character.confidence || Math.max(65, 90 - index * 4)), voiceId: voice.id, voiceName: voice.label };
    });
    return { characters, provider, model, fallback: routing.fallback };
  }),
  organiseManuscript: protectedProcedure.input(z.object({
    provider: providerId.optional(),
    model: z.string().min(1).max(160).optional(),
    text: z.string().trim().min(1).max(16_000),
    goal: z.enum(["outline", "cast", "chapters", "polish"]).default("outline"),
  })).mutation(async ({ ctx, input }) => {
    const instructions = `You are Bookx's audiobook production editor. Organise the supplied manuscript for ${input.goal}. Return a concise, practical plan with headings, no preamble, and preserve the author's intent.`;
    const db = await getDb();
    const preferences = db ? await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, ctx.user.id)) : [];
    const requested = input.provider || (preferences.find((preference) => preference.defaultLlmModel)?.provider as z.infer<typeof providerId> | undefined) || "Cloudflare";
    const routing = resolveProvider(requested, "language-model", await availableProviders(ctx.user.id, "language-model"));
    const preference = preferences.find((item) => item.provider === routing.provider);
    const model = input.model || preference?.defaultLlmModel || (routing.provider === "Cloudflare" ? "@cf/openai/gpt-oss-120b" : routing.provider === "OpenRouter" ? "openai/gpt-4o-mini" : "gpt-5");
    const result = await languageModelText({ provider: routing.provider, model, system: instructions, text: input.text, ownerId: ctx.user.id });
    return { result, provider: routing.provider, model, fallback: routing.fallback };
  }),
});
