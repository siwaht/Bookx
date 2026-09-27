import { isCustomProviderId } from "../shared/providers";
import { getCustomProvider } from "./customProviders";
import type { ProviderId } from "./providerRouting";
import { AURA_2_SPEAKERS, getCloudflareEndpoint, getProviderApiKey } from "./providerCredentials";

/**
 * Voice catalogs with the metadata casting needs.
 *
 * The UI only ever needed a name and a description, but choosing a sensible
 * default voice for "a gruff old sailor" needs gender, age and accent. ElevenLabs
 * provides these as voice labels; for Aura-2 and OpenAI they are fixed and
 * documented, so they are written down here.
 */

export type VoiceGender = "male" | "female" | "neutral";
export type VoiceAge = "young" | "adult" | "mature" | "old";

export type CatalogVoice = {
  id: string;
  label: string;
  description: string;
  provider: ProviderId;
  gender?: VoiceGender;
  age?: VoiceAge;
  accent?: string;
  /** What the voice is designed for, e.g. "narration" or "characters". */
  useCase?: string;
  /** A Prosecast starter persona rather than a real provider voice. */
  starter?: boolean;
};

export const STARTER_VOICES: CatalogVoice[] = [
  { id: "iris-narrative", label: "Iris", description: "Warm, calm, intimate narrative delivery", provider: "ElevenLabs", gender: "female", age: "adult", useCase: "narration", starter: true },
  { id: "theo-dramatic", label: "Theo", description: "Measured British dramatic delivery", provider: "ElevenLabs", gender: "male", age: "adult", accent: "British", starter: true },
  { id: "sage-conversational", label: "Sage", description: "Bright, friendly American conversational delivery", provider: "ElevenLabs", gender: "female", age: "young", accent: "American", starter: true },
  { id: "noor-global", label: "Noor", description: "Velvet, global, reflective delivery", provider: "ElevenLabs", gender: "female", age: "adult", starter: true },
  { id: "rowan-deep", label: "Rowan", description: "Deep, grounded, thoughtful delivery", provider: "ElevenLabs", gender: "male", age: "mature", starter: true },
];

type Profile = { gender: VoiceGender; age: VoiceAge; accent: string; traits: string; useCase: string };

/** Aura-2 English speakers, from Deepgram's published voice list. */
export const AURA_2_PROFILES: Record<string, Profile> = {
  amalthea: { gender: "female", age: "young", accent: "Filipino", traits: "Engaging, natural, cheerful", useCase: "casual chat" },
  andromeda: { gender: "female", age: "adult", accent: "American", traits: "Casual, expressive, comfortable", useCase: "customer service" },
  apollo: { gender: "male", age: "adult", accent: "American", traits: "Confident, comfortable, casual", useCase: "casual chat" },
  arcas: { gender: "male", age: "adult", accent: "American", traits: "Natural, smooth, clear, comfortable", useCase: "casual chat" },
  aries: { gender: "male", age: "adult", accent: "American", traits: "Warm, energetic, caring", useCase: "casual chat" },
  asteria: { gender: "female", age: "adult", accent: "American", traits: "Clear, confident, knowledgeable, energetic", useCase: "advertising" },
  athena: { gender: "female", age: "mature", accent: "American", traits: "Calm, smooth, professional", useCase: "storytelling" },
  atlas: { gender: "male", age: "mature", accent: "American", traits: "Enthusiastic, confident, approachable, friendly", useCase: "advertising" },
  aurora: { gender: "female", age: "adult", accent: "American", traits: "Cheerful, expressive, energetic", useCase: "interview" },
  callista: { gender: "female", age: "adult", accent: "American", traits: "Clear, energetic, professional, smooth", useCase: "IVR" },
  cora: { gender: "female", age: "adult", accent: "American", traits: "Smooth, melodic, caring", useCase: "storytelling" },
  cordelia: { gender: "female", age: "young", accent: "American", traits: "Approachable, warm, polite", useCase: "storytelling" },
  delia: { gender: "female", age: "young", accent: "American", traits: "Casual, friendly, cheerful, breathy", useCase: "interview" },
  draco: { gender: "male", age: "adult", accent: "British", traits: "Warm, approachable, trustworthy, baritone", useCase: "storytelling" },
  electra: { gender: "female", age: "adult", accent: "American", traits: "Professional, engaging, knowledgeable", useCase: "advertising" },
  harmonia: { gender: "female", age: "adult", accent: "American", traits: "Empathetic, clear, calm, confident", useCase: "customer service" },
  helena: { gender: "female", age: "adult", accent: "American", traits: "Caring, natural, positive, friendly, raspy", useCase: "casual chat" },
  hera: { gender: "female", age: "adult", accent: "American", traits: "Smooth, warm, professional", useCase: "informative" },
  hermes: { gender: "male", age: "adult", accent: "American", traits: "Expressive, engaging, professional", useCase: "informative" },
  hyperion: { gender: "male", age: "adult", accent: "Australian", traits: "Caring, warm, empathetic", useCase: "interview" },
  iris: { gender: "female", age: "young", accent: "American", traits: "Cheerful, positive, approachable", useCase: "advertising" },
  janus: { gender: "female", age: "adult", accent: "Southern American", traits: "Southern, smooth, trustworthy", useCase: "storytelling" },
  juno: { gender: "female", age: "adult", accent: "American", traits: "Natural, engaging, melodic, breathy", useCase: "interview" },
  jupiter: { gender: "male", age: "adult", accent: "American", traits: "Expressive, knowledgeable, baritone", useCase: "informative" },
  luna: { gender: "female", age: "young", accent: "American", traits: "Friendly, natural, engaging", useCase: "IVR" },
  mars: { gender: "male", age: "adult", accent: "American", traits: "Smooth, patient, trustworthy, baritone", useCase: "customer service" },
  minerva: { gender: "female", age: "adult", accent: "American", traits: "Positive, friendly, natural", useCase: "storytelling" },
  neptune: { gender: "male", age: "adult", accent: "American", traits: "Professional, patient, polite", useCase: "customer service" },
  odysseus: { gender: "male", age: "adult", accent: "American", traits: "Calm, smooth, comfortable, professional", useCase: "advertising" },
  ophelia: { gender: "female", age: "adult", accent: "American", traits: "Expressive, enthusiastic, cheerful", useCase: "interview" },
  orion: { gender: "male", age: "adult", accent: "American", traits: "Approachable, comfortable, calm, polite", useCase: "informative" },
  orpheus: { gender: "male", age: "adult", accent: "American", traits: "Professional, clear, confident, trustworthy", useCase: "storytelling" },
  pandora: { gender: "female", age: "adult", accent: "British", traits: "Smooth, calm, melodic, breathy", useCase: "informative" },
  phoebe: { gender: "female", age: "adult", accent: "American", traits: "Energetic, warm, casual", useCase: "customer service" },
  pluto: { gender: "male", age: "adult", accent: "American", traits: "Smooth, calm, empathetic, baritone", useCase: "storytelling" },
  saturn: { gender: "male", age: "adult", accent: "American", traits: "Knowledgeable, confident, baritone", useCase: "customer service" },
  thalia: { gender: "female", age: "adult", accent: "American", traits: "Clear, confident, energetic, enthusiastic", useCase: "casual chat" },
  theia: { gender: "female", age: "adult", accent: "Australian", traits: "Expressive, polite, sincere", useCase: "informative" },
  vesta: { gender: "female", age: "adult", accent: "American", traits: "Natural, expressive, patient, empathetic", useCase: "storytelling" },
  zeus: { gender: "male", age: "adult", accent: "American", traits: "Deep, trustworthy, smooth", useCase: "IVR" },
};

/** OpenAI speech voices. */
export const OPENAI_PROFILES: Record<string, Profile> = {
  alloy: { gender: "neutral", age: "adult", accent: "American", traits: "Neutral, balanced", useCase: "narration" },
  ash: { gender: "male", age: "adult", accent: "American", traits: "Clear, steady", useCase: "conversational" },
  ballad: { gender: "male", age: "adult", accent: "British", traits: "Soft, lyrical", useCase: "storytelling" },
  coral: { gender: "female", age: "adult", accent: "American", traits: "Warm, friendly", useCase: "conversational" },
  echo: { gender: "male", age: "adult", accent: "American", traits: "Grounded, even", useCase: "narration" },
  fable: { gender: "male", age: "adult", accent: "British", traits: "Storytelling, expressive", useCase: "storytelling" },
  nova: { gender: "female", age: "young", accent: "American", traits: "Bright, energetic", useCase: "conversational" },
  onyx: { gender: "male", age: "mature", accent: "American", traits: "Deep, authoritative", useCase: "narration" },
  sage: { gender: "female", age: "adult", accent: "American", traits: "Calm, thoughtful", useCase: "narration" },
  shimmer: { gender: "female", age: "adult", accent: "American", traits: "Soft, airy", useCase: "conversational" },
  verse: { gender: "male", age: "adult", accent: "American", traits: "Versatile, expressive", useCase: "characters" },
};

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function fromProfile(id: string, name: string, profile: Profile, provider: ProviderId): CatalogVoice {
  return {
    id,
    label: capitalise(name),
    description: `${profile.traits} · ${profile.accent} ${profile.gender === "neutral" ? "" : profile.gender} voice`.replace(/\s+/g, " ").trim(),
    provider,
    gender: profile.gender,
    age: profile.age,
    accent: profile.accent,
    useCase: profile.useCase,
  };
}

/** Aura-2 speakers supported by Cloudflare's aura-2-en, addressed by speaker name. */
export function cloudflareAuraCatalog(): CatalogVoice[] {
  return AURA_2_SPEAKERS.filter(speaker => AURA_2_PROFILES[speaker]).map(speaker => fromProfile(speaker, speaker, AURA_2_PROFILES[speaker]!, "Cloudflare"));
}

/** Aura-2 voices on Deepgram directly, where the voice is the model id. */
export function deepgramCatalog(): CatalogVoice[] {
  return Object.entries(AURA_2_PROFILES).map(([name, profile]) => fromProfile(`aura-2-${name}-en`, name, profile, "Deepgram"));
}

export function openAiCatalog(provider: ProviderId = "OpenAI"): CatalogVoice[] {
  return Object.entries(OPENAI_PROFILES).map(([name, profile]) => fromProfile(name, name, profile, provider));
}

export function normalizeVoiceGender(value?: string | null): VoiceGender | undefined {
  const lower = (value ?? "").trim().toLowerCase();
  if (/^(male|man|masculine|m|boy)$/.test(lower)) return "male";
  if (/^(female|woman|feminine|f|girl)$/.test(lower)) return "female";
  if (/^(neutral|non-binary|nonbinary|androgynous)$/.test(lower)) return "neutral";
  return undefined;
}

export function normalizeVoiceAge(value?: string | null): VoiceAge | undefined {
  const lower = (value ?? "").trim().toLowerCase().replace(/[_-]/g, " ");
  if (!lower) return undefined;
  if (/child|kid|teen|young|youth|boy|girl/.test(lower)) return "young";
  if (/middle|mature|forties|fifties/.test(lower)) return "mature";
  if (/old|elder|senior|aged|grand/.test(lower)) return "old";
  if (/adult/.test(lower)) return "adult";
  return undefined;
}

type ElevenLabsVoice = {
  voice_id?: string;
  name?: string;
  description?: string;
  category?: string;
  labels?: Record<string, string | undefined>;
};

/** Maps an ElevenLabs `/v1/voices` entry onto the catalog shape, keeping its labels. */
export function elevenLabsVoiceToCatalog(voice: ElevenLabsVoice): CatalogVoice | null {
  if (!voice.voice_id || !voice.name) return null;
  const labels = voice.labels ?? {};
  const useCase = labels.use_case || labels["use case"] || labels.usecase;
  const descriptive = [labels.description, labels.accent, labels.age, labels.gender, useCase].filter(Boolean).map(value => String(value).replace(/_/g, " "));
  return {
    id: voice.voice_id,
    label: voice.name,
    description: voice.description || descriptive.join(" · ") || "Provider voice",
    provider: "ElevenLabs",
    gender: normalizeVoiceGender(labels.gender),
    age: normalizeVoiceAge(labels.age),
    accent: labels.accent ? capitalise(labels.accent.replace(/_/g, " ")) : undefined,
    useCase: useCase ? useCase.replace(/_/g, " ") : undefined,
  };
}

const ELEVENLABS_CACHE_MS = 5 * 60 * 1000;
const elevenLabsCache = new Map<string, { at: number; voices: CatalogVoice[] }>();

async function elevenLabsCatalog(ownerId?: number): Promise<CatalogVoice[]> {
  const key = await getProviderApiKey("ElevenLabs", ownerId);
  if (!key) return STARTER_VOICES;
  const cacheKey = `${ownerId ?? "env"}:${key.slice(-6)}`;
  const cached = elevenLabsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ELEVENLABS_CACHE_MS) return cached.voices;

  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": key },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ElevenLabs voice discovery returned HTTP ${response.status}`);
  const payload = await response.json() as { voices?: ElevenLabsVoice[] };
  const voices = (payload.voices ?? []).map(elevenLabsVoiceToCatalog).filter((voice): voice is CatalogVoice => Boolean(voice));
  const result = voices.length ? voices : STARTER_VOICES;
  elevenLabsCache.set(cacheKey, { at: Date.now(), voices: result });
  return result;
}

// ---------------------------------------------------------------------------
// Fish Audio
// ---------------------------------------------------------------------------

type FishAudioModel = { _id?: string; title?: string; description?: string; type?: string; state?: string; tags?: string[]; languages?: string[] };

/** A Fish Audio voice model as a catalog voice; tags carry gender and age when set. */
export function fishAudioVoiceToCatalog(model: FishAudioModel, own: boolean): CatalogVoice | null {
  if (!model._id || !model.title || (model.type && model.type !== "tts") || (model.state && model.state !== "trained")) return null;
  const tags = (model.tags ?? []).map(tag => String(tag));
  const gender = tags.map(normalizeVoiceGender).find(Boolean);
  const age = tags.map(normalizeVoiceAge).find(Boolean);
  const languages = (model.languages ?? []).join(", ");
  const description = [model.description?.trim(), languages && `Languages: ${languages}`, own ? "Your voice" : undefined].filter(Boolean).join(" · ");
  return { id: model._id, label: model.title, description: description.slice(0, 240) || "Fish Audio voice", provider: "Fish Audio", gender, age };
}

/** Fish Audio's documented example voice, offered until the account's voices load. */
const FISH_AUDIO_FALLBACK: CatalogVoice[] = [
  { id: "9a9cf47702da476aa4629e2506d4a857", label: "Hannah", description: "Fish Audio's example voice", provider: "Fish Audio", gender: "female", age: "adult" },
];

const DISCOVERY_CACHE_MS = 5 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; voices: CatalogVoice[] }>();

async function cachedDiscovery(cacheKey: string, load: () => Promise<CatalogVoice[]>): Promise<CatalogVoice[]> {
  const cached = discoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) return cached.voices;
  const voices = await load();
  if (discoveryCache.size > 200) discoveryCache.clear();
  discoveryCache.set(cacheKey, { at: Date.now(), voices });
  return voices;
}

/** The account's own voices first, then Fish Audio's licensed public voices. */
async function fishAudioCatalog(ownerId?: number): Promise<CatalogVoice[]> {
  const key = await getProviderApiKey("Fish Audio", ownerId);
  if (!key) return FISH_AUDIO_FALLBACK;
  return cachedDiscovery(`fish:${ownerId ?? "env"}:${key.slice(-6)}`, async () => {
    const list = async (query: string, own: boolean) => {
      const response = await fetch(`https://api.fish.audio/model?${query}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Fish Audio voice discovery returned HTTP ${response.status}`);
      const payload = await response.json() as { items?: FishAudioModel[] };
      return (payload.items ?? []).map(model => fishAudioVoiceToCatalog(model, own)).filter((voice): voice is CatalogVoice => Boolean(voice));
    };
    const [own, shared] = await Promise.all([
      list("self=true&page_size=100", true),
      list("page_size=60&sort_by=score&licensed=true", false).catch(() => [] as CatalogVoice[]),
    ]);
    const seen = new Set<string>();
    const voices = [...own, ...shared].filter(voice => (seen.has(voice.id) ? false : (seen.add(voice.id), true)));
    return voices.length ? voices : FISH_AUDIO_FALLBACK;
  });
}

// ---------------------------------------------------------------------------
// Gradium
// ---------------------------------------------------------------------------

type GradiumVoice = { uid?: string; name?: string; description?: string | null; language?: string | null; is_catalog?: boolean; tags?: Array<{ category?: string | null; value?: string }> };

export function gradiumVoiceToCatalog(voice: GradiumVoice): CatalogVoice | null {
  if (!voice.uid || !voice.name) return null;
  const tags = voice.tags ?? [];
  const tagValue = (category: string) => tags.find(tag => tag.category?.toLowerCase() === category)?.value;
  const gender = normalizeVoiceGender(tagValue("gender")) ?? tags.map(tag => normalizeVoiceGender(tag.value)).find(Boolean);
  const age = normalizeVoiceAge(tagValue("age")) ?? tags.map(tag => normalizeVoiceAge(tag.value)).find(Boolean);
  const accent = tagValue("accent") ?? tagValue("country") ?? undefined;
  const description = [voice.description?.trim(), voice.language && `Language: ${voice.language}`, voice.is_catalog === false ? "Your voice" : undefined].filter(Boolean).join(" · ");
  return { id: voice.uid, label: voice.name, description: description.slice(0, 240) || "Gradium voice", provider: "Gradium", gender, age, accent };
}

/** A few of Gradium's flagship English voices, offered until the account's voices load. */
const GRADIUM_FALLBACK: CatalogVoice[] = [
  { id: "YTpq7expH9539ERJ", label: "Gradium default", description: "Gradium's example voice", provider: "Gradium" },
  { id: "POBHtemksfWQbng0", label: "Garrett", description: "Smooth, low-pitched, calm confidence · American male voice", provider: "Gradium", gender: "male", age: "adult", accent: "American" },
  { id: "4SZHfMpw-p46Ywgs", label: "Harper", description: "Modern, confident and friendly · American female voice", provider: "Gradium", gender: "female", age: "adult", accent: "American" },
  { id: "6MFfc37kq0sBjBjy", label: "Sterling", description: "Warm, energetic, theatrical · American male voice", provider: "Gradium", gender: "male", age: "adult", accent: "American" },
  { id: "4rdlkbxRv4m3UQTW", label: "Tilly", description: "Bright and welcoming · British female voice", provider: "Gradium", gender: "female", age: "adult", accent: "British" },
  { id: "CF0NgaMwHMMrHZn0", label: "Reuben", description: "Confident and upbeat · British male voice", provider: "Gradium", gender: "male", age: "adult", accent: "British" },
  { id: "gqn4ytOULe-TQfjl", label: "Saoirse", description: "Warm, natural, expressive · Irish female voice", provider: "Gradium", gender: "female", age: "adult", accent: "Irish" },
  { id: "I7GYfpcKbafFrYUv", label: "Declan", description: "Calm and steady · Irish male voice", provider: "Gradium", gender: "male", age: "adult", accent: "Irish" },
];

async function gradiumCatalog(ownerId?: number): Promise<CatalogVoice[]> {
  const key = await getProviderApiKey("Gradium", ownerId);
  if (!key) return GRADIUM_FALLBACK;
  return cachedDiscovery(`gradium:${ownerId ?? "env"}:${key.slice(-6)}`, async () => {
    const response = await fetch("https://api.gradium.ai/api/voices/?include_catalog=true&limit=200", { headers: { "x-api-key": key }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Gradium voice discovery returned HTTP ${response.status}`);
    const payload = await response.json() as GradiumVoice[] | { voices?: GradiumVoice[] };
    const list = Array.isArray(payload) ? payload : payload.voices ?? [];
    const voices = list.map(gradiumVoiceToCatalog).filter((voice): voice is CatalogVoice => Boolean(voice));
    // The account's own voices first.
    voices.sort((left, right) => Number(right.description.includes("Your voice")) - Number(left.description.includes("Your voice")));
    return voices.length ? voices : GRADIUM_FALLBACK;
  });
}

/** Every voice a project using `provider` can be cast with. */
export async function voiceCatalogFor(provider: string, ownerId?: number): Promise<CatalogVoice[]> {
  if (isCustomProviderId(provider)) {
    const custom = await getCustomProvider(provider, ownerId);
    return (custom?.voices ?? []).map(voice => ({ id: voice, label: voice, description: `${custom!.label} voice`, provider }));
  }
  switch (provider) {
    case "ElevenLabs":
      return elevenLabsCatalog(ownerId);
    case "Cloudflare": {
      const endpoint = await getCloudflareEndpoint(ownerId);
      return endpoint?.mode === "openai-compatible" ? openAiCatalog("Cloudflare") : cloudflareAuraCatalog();
    }
    case "Deepgram":
      return deepgramCatalog();
    case "OpenAI":
      return openAiCatalog();
    case "Fish Audio":
      return fishAudioCatalog(ownerId);
    case "Gradium":
      return gradiumCatalog(ownerId);
    default:
      return STARTER_VOICES.map(voice => ({ ...voice, provider: provider as ProviderId }));
  }
}

function tokenize(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/** Keyword ranking over name, id, description and labels; best matches first. */
export function rankCatalogVoices<T extends { id: string; label: string; description: string; gender?: string; age?: string; accent?: string; useCase?: string }>(voices: T[], query: string): T[] {
  const terms = tokenize(query);
  if (!terms.length) return voices;
  const score = (voice: T) => {
    const haystack = `${voice.id} ${voice.label} ${voice.description} ${voice.gender ?? ""} ${voice.age ?? ""} ${voice.accent ?? ""} ${voice.useCase ?? ""}`.toLowerCase();
    return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
  };
  return [...voices].sort((left, right) => score(right) - score(left) || left.label.localeCompare(right.label));
}
