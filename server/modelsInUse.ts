import { and, eq } from "drizzle-orm";
import { bookxProjects, bookxProviderSettings } from "../drizzle/schema";
import { getDb } from "./db";
import { resolveLanguageModel } from "./languageModel";
import { availableProviders } from "./providerCredentials";
import { ELEVENLABS_SOUND_MODEL } from "./soundModels";
import { ttsTraits } from "../shared/direction";

/**
 * Which provider and model each capability is using right now, so the app can
 * say "Narration: ElevenLabs · Eleven v4" instead of leaving it to guesswork.
 */

export type InUseEntry = {
  provider: string | null;
  model: string | null;
  /** Ready to use: the provider has a key (or endpoint) configured. */
  connected: boolean;
  /** Why this is the choice: the project's own, the account default, or a fallback. */
  source: "project" | "default" | "fallback" | "none";
  note?: string;
};

export type ModelsInUse = {
  tts: InUseEntry & { traits: ReturnType<typeof ttsTraits> | null };
  stt: InUseEntry;
  llm: InUseEntry;
  sound: InUseEntry;
};

const STT_DEFAULTS: Record<string, string> = {
  ElevenLabs: "scribe_v2",
  Deepgram: "nova-3",
  OpenAI: "gpt-4o-transcribe",
  Cloudflare: "@cf/openai/whisper",
  "Fish Audio": "transcribe-1",
};

export async function modelsInUse(input: { ownerId: number; projectId?: string }): Promise<ModelsInUse> {
  const db = await getDb();
  const project = db && input.projectId
    ? (await db.select().from(bookxProjects).where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId))).limit(1))[0]
    : undefined;
  const preferences = db ? await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, input.ownerId)) : [];
  const [ttsAvailable, sttAvailable] = await Promise.all([
    availableProviders(input.ownerId, "text-to-speech"),
    availableProviders(input.ownerId, "speech-to-text"),
  ]);

  // Narration: the project's pinned choice, else the first saved default.
  const ttsPreference = preferences.find(row => row.defaultTtsModel);
  const ttsProvider = project?.voiceProvider ?? ttsPreference?.provider ?? null;
  const ttsModel = project?.voiceModel ?? ttsPreference?.defaultTtsModel ?? null;
  const tts = {
    provider: ttsProvider,
    model: ttsModel,
    connected: Boolean(ttsProvider && (ttsAvailable as string[]).includes(ttsProvider)),
    source: project ? "project" as const : ttsPreference ? "default" as const : "none" as const,
    traits: ttsProvider && ttsModel ? ttsTraits(ttsProvider, ttsModel) : null,
  };

  // Transcription: the saved default, else the first connected provider that can.
  const sttPreference = preferences.find(row => row.defaultSttModel && (sttAvailable as string[]).includes(row.provider));
  const sttFallback = !sttPreference ? (sttAvailable as string[]).find(provider => STT_DEFAULTS[provider]) : undefined;
  const stt: InUseEntry = sttPreference
    ? { provider: sttPreference.provider, model: sttPreference.defaultSttModel, connected: true, source: "default" }
    : sttFallback
      ? { provider: sttFallback, model: STT_DEFAULTS[sttFallback]!, connected: true, source: "fallback", note: "No transcription default is saved, so the first connected provider is used." }
      : { provider: null, model: null, connected: false, source: "none", note: "Connect ElevenLabs, Deepgram, OpenAI, Cloudflare or Fish Audio to transcribe audio." };

  const resolved = await resolveLanguageModel({ ownerId: input.ownerId, provider: project?.languageModelProvider, model: project?.languageModel }).catch(() => null);
  const llm: InUseEntry = resolved
    ? {
      provider: resolved.provider,
      model: resolved.model,
      connected: true,
      source: resolved.fallback ? "fallback" : project ? "project" : "default",
      note: resolved.fallback && project ? `${project.languageModelProvider} is not connected, so ${resolved.provider} is used instead.` : undefined,
    }
    : { provider: null, model: null, connected: false, source: "none", note: "No language model is connected; casting and scene planning use built-in rules." };

  const elevenLabs = (ttsAvailable as string[]).includes("ElevenLabs");
  const soundSource = project?.soundSource ?? "auto";
  const sound: InUseEntry = soundSource === "builtin" || (soundSource === "auto" && !elevenLabs)
    ? { provider: "Built-in", model: "Prosecast synthesiser", connected: true, source: project ? "project" : "default", note: soundSource === "auto" ? "Connect ElevenLabs to generate richer sounds." : undefined }
    : { provider: "ElevenLabs", model: ELEVENLABS_SOUND_MODEL, connected: elevenLabs, source: project ? "project" : "default" };

  return { tts, stt, llm, sound };
}
