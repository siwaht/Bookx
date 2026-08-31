import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { protectedProcedure, router } from "../_core/trpc";
import { bookxProviderSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { configuredProviders, providerCapabilities, resolveProvider, type RoutingCapability } from "../providerRouting";
import { AURA_2_SPEAKERS, availableProviders, cloudflareHeaders, getCloudflareEndpoint, getOpenAiCompatibleBaseUrl, redactProviderApiKey, type CloudflareEndpoint } from "../providerCredentials";

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
  capabilities: ProviderCapability[];
  models: ProviderModel[];
};

const providerId = z.enum(["ElevenLabs", "Deepgram", "Cloudflare", "OpenAI", "Fish Audio"]);
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
  { id: "@cf/deepgram/aura-2-en", label: "Aura-2 (English)", capabilities: ["text-to-speech"], detail: "Context-aware English narration voices" },
  { id: "@cf/myshell-ai/melotts", label: "MeloTTS", capabilities: ["text-to-speech"], detail: "Multilingual draft narration" },
  { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", capabilities: ["language-model"], detail: "Cast analysis and editorial planning" },
  { id: "@cf/openai/whisper", label: "Whisper", capabilities: ["speech-to-text"], detail: "Audio transcription" },
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
      const caps = capabilities(taskName);
      if (!caps.length) continue;
      seen.add(id);
      models.push({ id, label: id, detail: taskName || model.description, capabilities: caps });
    }
  } else {
    const response = await fetch(`${endpoint.apiBaseUrl}/models`, { headers: { Authorization: `Bearer ${endpoint.apiKey}` }, signal: AbortSignal.timeout(12_000) });
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
  const endpoint = await getCloudflareEndpoint(ownerId);
  const cloudflareConfigured = Boolean(endpoint);
  let cloudflare: ProviderModel[] = cloudflareStaticModels;
  if (cloudflareConfigured) {
    try {
      cloudflare = await cloudflareModels(endpoint);
    } catch {
      cloudflare = cloudflareStaticModels;
    }
  }

  return [
    {
      id: "ElevenLabs", label: "ElevenLabs", configured: Boolean(process.env.ELEVENLABS_API_KEY), status: process.env.ELEVENLABS_API_KEY ? "connected" : "available",
      capabilities: ["text-to-speech", "speech-to-text"],
      models: [
        { id: "eleven_multilingual_v2", label: "Multilingual v2", capabilities: ["text-to-speech"], detail: "Stable long-form narration" },
        { id: "eleven_v3", label: "Eleven v3", capabilities: ["text-to-speech"], detail: "Expressive multi-speaker delivery" },
        { id: "eleven_flash_v2_5", label: "Flash v2.5", capabilities: ["text-to-speech"], detail: "Fast draft narration" },
        { id: "scribe_v2", label: "Scribe v2", capabilities: ["speech-to-text"], detail: "Timed transcription" },
      ],
    },
    {
      id: "Deepgram", label: "Deepgram", configured: Boolean(process.env.DEEPGRAM_API_KEY), status: process.env.DEEPGRAM_API_KEY ? "connected" : "available",
      capabilities: ["text-to-speech", "speech-to-text"],
      models: [
        { id: "aura-2-thalia-en", label: "Aura-2 Thalia", capabilities: ["text-to-speech"], detail: "Natural English voice" },
        { id: "nova-3", label: "Nova-3", capabilities: ["speech-to-text"], detail: "Pre-recorded transcription" },
        { id: "flux-general-en", label: "Flux", capabilities: ["speech-to-text"], detail: "Realtime turn-based transcription" },
      ],
    },
    {
      id: "Cloudflare", label: "Cloudflare Workers AI", configured: cloudflareConfigured, status: cloudflareConfigured ? "connected" : "available",
      capabilities: ["text-to-speech", "speech-to-text", "language-model"], models: cloudflare,
    },
    {
      id: "OpenAI", label: "OpenAI", configured: Boolean(process.env.OPENAI_API_KEY), status: process.env.OPENAI_API_KEY ? "connected" : "available",
      capabilities: ["text-to-speech", "speech-to-text", "language-model"],
      models: [
        { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", capabilities: ["text-to-speech"], detail: "Narration and voice responses" },
        { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe", capabilities: ["speech-to-text"], detail: "File transcription" },
        { id: "gpt-5", label: "GPT-5", capabilities: ["language-model"], detail: "Project organisation and editorial planning" },
      ],
    },
    {
      id: "Fish Audio", label: "Fish Audio", configured: false, status: "optional", capabilities: ["text-to-speech", "speech-to-text"],
      models: [{ id: "s2.1-pro", label: "S2.1 Pro", capabilities: ["text-to-speech"], detail: "Connect an API key to enable" }],
    },
  ];
}

const castVoice = z.object({ id: z.string().min(1).max(160), label: z.string().min(1).max(160), description: z.string().max(300).optional() });

export type DiscoverableVoice = {
  id: string;
  label: string;
  description: string;
  provider: "ElevenLabs" | "Deepgram" | "Cloudflare" | "OpenAI" | "Fish Audio";
};

const starterVoices: DiscoverableVoice[] = [
  { id: "iris-narrative", label: "Iris", description: "Warm, calm, intimate narrative delivery", provider: "ElevenLabs" },
  { id: "theo-dramatic", label: "Theo", description: "Measured British dramatic delivery", provider: "ElevenLabs" },
  { id: "sage-conversational", label: "Sage", description: "Bright, friendly American conversational delivery", provider: "ElevenLabs" },
  { id: "noor-global", label: "Noor", description: "Velvet, global, reflective delivery", provider: "ElevenLabs" },
  { id: "rowan-deep", label: "Rowan", description: "Deep, grounded, thoughtful delivery", provider: "ElevenLabs" },
];

/** Aura-2 speakers exposed as selectable Cloudflare voices (native mode). */
const cloudflareAuraVoices: DiscoverableVoice[] = AURA_2_SPEAKERS.map((speaker) => ({
  id: speaker,
  label: speaker.charAt(0).toUpperCase() + speaker.slice(1),
  description: "Cloudflare Aura-2 narration voice",
  provider: "Cloudflare" as const,
}));

/** Standard OpenAI voice names for OpenAI-compatible Cloudflare endpoints. */
const openAiCompatVoices: DiscoverableVoice[] = [
  { id: "alloy", label: "Alloy", description: "Neutral balanced delivery", provider: "Cloudflare" as const },
  { id: "echo", label: "Echo", description: "Grounded male delivery", provider: "Cloudflare" as const },
  { id: "fable", label: "Fable", description: "Storytelling British delivery", provider: "Cloudflare" as const },
  { id: "onyx", label: "Onyx", description: "Deep authoritative delivery", provider: "Cloudflare" as const },
  { id: "nova", label: "Nova", description: "Bright energetic delivery", provider: "Cloudflare" as const },
  { id: "shimmer", label: "Shimmer", description: "Soft airy delivery", provider: "Cloudflare" as const },
];

function tokenize(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function rankVoiceMatches(voices: DiscoverableVoice[], query: string) {
  const terms = tokenize(query);
  if (!terms.length) return voices;
  return [...voices].sort((left, right) => {
    const score = (voice: DiscoverableVoice) => {
      const haystack = `${voice.id} ${voice.label} ${voice.description}`.toLowerCase();
      return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    };
    return score(right) - score(left) || left.label.localeCompare(right.label);
  });
}

async function discoverElevenLabsVoices(): Promise<DiscoverableVoice[]> {
  if (!process.env.ELEVENLABS_API_KEY) return starterVoices;
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ElevenLabs voice discovery returned HTTP ${response.status}`);
  const payload = await response.json() as { voices?: Array<{ voice_id?: string; name?: string; description?: string; labels?: Record<string, string> }> };
  const voices = (payload.voices || []).flatMap((voice) => {
    if (!voice.voice_id || !voice.name) return [];
    const labels = Object.values(voice.labels || {}).filter(Boolean).join(" · ");
    return [{ id: voice.voice_id, label: voice.name, description: voice.description || labels || "Provider voice", provider: "ElevenLabs" as const }];
  });
  return voices.length ? voices : starterVoices;
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

function extractJson(value: string) {
  const fenced = value.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || value.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error("Language model did not return a structured cast plan");
  return JSON.parse(candidate) as unknown;
}

async function languageModelText(input: { provider: z.infer<typeof providerId>; model: string; system: string; text: string; ownerId?: number }) {
  if (input.provider === "Cloudflare") {
    const endpoint = await getCloudflareEndpoint(input.ownerId);
    if (!endpoint) throw new Error("Cloudflare is not configured");
    // Native mode uses the Workers AI OpenAI-compatible chat endpoint; custom
    // endpoints (AI Gateway / proxies) expose `/chat/completions` directly.
    const url = endpoint.mode === "native" ? `${endpoint.apiBaseUrl}/v1/chat/completions` : `${endpoint.apiBaseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: cloudflareHeaders(endpoint),
      body: JSON.stringify({ model: input.model, max_tokens: 4096, messages: [{ role: "system", content: input.system }, { role: "user", content: input.text }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Cloudflare language model request failed with HTTP ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; result?: { response?: string; text?: string } };
    const result = payload.choices?.[0]?.message?.content || payload.result?.response || payload.result?.text;
    if (!result) throw new Error("Cloudflare returned no model text");
    return result;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI is not configured");
  const base = (await getOpenAiCompatibleBaseUrl(input.ownerId)) || "https://api.openai.com/v1";
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: input.model, messages: [{ role: "system", content: input.system }, { role: "user", content: input.text }], temperature: 0.25, response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`OpenAI language model request failed with HTTP ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const result = payload.choices?.[0]?.message?.content;
  if (!result) throw new Error("OpenAI returned no model text");
  return result;
}

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
  savePreference: protectedProcedure.input(z.object({ provider: providerId, defaultTtsModel: z.string().max(160).optional(), defaultSttModel: z.string().max(160).optional(), defaultLlmModel: z.string().max(160).optional(), fallbackProvider: providerId.optional(), fallbackEnabled: z.boolean().default(false), apiBaseUrl: z.string().url().max(255).optional(), apiKey: z.string().max(512).optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [existing] = await db.select().from(bookxProviderSettings).where(and(eq(bookxProviderSettings.ownerId, ctx.user.id), eq(bookxProviderSettings.provider, input.provider))).limit(1);
    const values: Record<string, unknown> = { secretConfigured: configuredProviders().includes(input.provider) || Boolean(input.apiKey) ? 1 : 0, defaultTtsModel: input.defaultTtsModel || null, defaultSttModel: input.defaultSttModel || null, defaultLlmModel: input.defaultLlmModel || null, fallbackProvider: input.fallbackProvider || null, fallbackEnabled: input.fallbackEnabled ? 1 : 0, apiBaseUrl: input.apiBaseUrl || null, updatedAt: new Date() };
    // Only touch the key column when the client sent one (empty string clears it).
    if (input.apiKey !== undefined) values.apiKey = input.apiKey || null;
    if (existing) { await db.update(bookxProviderSettings).set(values).where(eq(bookxProviderSettings.id, existing.id)); return { id: existing.id }; }
    const id = nanoid();
    await db.insert(bookxProviderSettings).values({ id, ownerId: ctx.user.id, provider: input.provider, defaultModel: input.defaultTtsModel || null, defaultPace: null, chapterGapMs: 2000, ...values });
    return { id };
  }),
  validate: protectedProcedure.input(z.object({ provider: providerId })).mutation(async ({ ctx, input }) => {
    const available = await availableProviders(ctx.user.id);
    if (!available.includes(input.provider)) return { provider: input.provider, status: "not-configured" as const, capabilities: providerCapabilities[input.provider] };
    try {
      if (input.provider === "Cloudflare") await cloudflareModels(await getCloudflareEndpoint(ctx.user.id));
      if (input.provider === "Deepgram") { const response = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY || ""}` }, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); }
      if (input.provider === "ElevenLabs") { const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY || "" }, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); }
      if (input.provider === "OpenAI") { const base = (await getOpenAiCompatibleBaseUrl(ctx.user.id)) || "https://api.openai.com/v1"; const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}` }, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); }
      return { provider: input.provider, status: "connected" as const, capabilities: providerCapabilities[input.provider] };
    } catch (error) {
      return { provider: input.provider, status: "degraded" as const, capabilities: providerCapabilities[input.provider], detail: error instanceof Error ? error.message : "Connection test failed" };
    }
  }),
  resolve: protectedProcedure.input(z.object({ requested: providerId, capability })).query(async ({ ctx, input }) => ({ ...resolveProvider(input.requested, input.capability as RoutingCapability, await availableProviders(ctx.user.id)), capability: input.capability })),
  voiceCatalog: protectedProcedure.input(z.object({ provider: providerId.default("ElevenLabs"), query: z.string().trim().max(160).optional() })).query(async ({ ctx, input }) => {
    let voices: DiscoverableVoice[];
    if (input.provider === "ElevenLabs") {
      voices = await discoverElevenLabsVoices();
    } else if (input.provider === "Cloudflare") {
      const personas = starterVoices.map((voice) => ({ ...voice, provider: "Cloudflare" as const }));
      const endpoint = await getCloudflareEndpoint(ctx.user.id);
      voices = endpoint?.mode === "openai-compatible" ? [...personas, ...openAiCompatVoices] : [...personas, ...cloudflareAuraVoices];
    } else {
      voices = starterVoices.filter((voice) => voice.provider === "ElevenLabs").map((voice) => ({ ...voice, provider: input.provider }));
    }
    return rankVoiceMatches(voices, input.query || "").slice(0, 30);
  }),
  recommendCast: protectedProcedure.input(z.object({
    provider: z.enum(["Cloudflare", "OpenAI"]).optional(),
    model: z.string().min(1).max(160).optional(),
    text: z.string().trim().min(40).max(16_000),
    voices: z.array(castVoice).min(2).max(64),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    const preferences = db ? await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, ctx.user.id)) : [];
    const requested = input.provider || (preferences.find((preference) => preference.defaultLlmModel)?.provider as "Cloudflare" | "OpenAI" | undefined) || "Cloudflare";
    const routing = resolveProvider(requested, "language-model", await availableProviders(ctx.user.id));
    const provider = routing.provider === "OpenAI" ? "OpenAI" : "Cloudflare";
    const preference = preferences.find((item) => item.provider === provider);
    const model = input.model || preference?.defaultLlmModel || (provider === "Cloudflare" ? "@cf/openai/gpt-oss-120b" : "gpt-5");
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
    const routing = resolveProvider(requested, "language-model", await availableProviders(ctx.user.id));
    const preference = preferences.find((item) => item.provider === routing.provider);
    const model = input.model || preference?.defaultLlmModel || (routing.provider === "Cloudflare" ? "@cf/openai/gpt-oss-120b" : "gpt-5");
    const result = await languageModelText({ provider: routing.provider, model, system: instructions, text: input.text, ownerId: ctx.user.id });
    return { result, provider: routing.provider, model, fallback: routing.fallback };
  }),
});
