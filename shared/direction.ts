/**
 * Performance direction: what a voice model can be told besides the words.
 *
 * Shared by the server (which sends it) and the web app (which shows only the
 * controls the chosen model understands). Expressive models take direction in
 * one of two ways: inline audio tags such as `[whispers]` (ElevenLabs Eleven v3
 * and v4) or a separate instructions field (OpenAI gpt-4o-mini-tts). Every
 * other model gets the plain text, because a model that does not understand a
 * bracketed tag reads it aloud.
 */

/** The setting and mood of one scene. */
export type SceneDirection = { setting?: string; mood?: string };

/**
 * A chapter's direction. The top-level setting and mood apply to every scene;
 * `scenes` overrides them for one scene, keyed by its index (0 is the chapter
 * opening, then one more after every scene break).
 */
export type ChapterDirection = SceneDirection & { scenes?: Record<string, SceneDirection> };

/** Voice knobs a model may accept. Missing values mean the model's defaults. */
export type VoiceSettings = {
  stability?: number;
  similarity?: number;
  style?: number;
  speed?: number;
  speakerBoost?: boolean;
  /** Standing delivery notes for models with an instructions field ("warm, unhurried storyteller"). */
  instructions?: string;
};

export type VoiceSettingKey = "stability" | "similarity" | "style" | "speed" | "speakerBoost";

export const DIRECTION_LIMITS = { setting: 160, mood: 80, tag: 60, tagsPerLine: 3, instructions: 500 } as const;

/** Quick picks for the direction editor; any short description works on tag-aware models. */
export const SUGGESTED_LINE_TAGS = [
  "whispers", "softly", "excited", "sarcastic", "curious", "worried", "nervous", "crying", "laughs", "sighs",
  "shouting", "angry", "warm", "cold", "hesitant", "matter-of-fact", "dramatic", "mischievously",
] as const;

export const SUGGESTED_MOODS = ["calm", "tense", "hushed", "warm", "melancholy", "playful", "ominous", "urgent", "wistful", "triumphant"] as const;

/** What a text-to-speech model accepts. */
export type TtsTraits = {
  /** Short family name shown in the UI. */
  label: string;
  /** Inline bracketed audio tags (`[whispers]`). */
  audioTags: boolean;
  /** A separate free-text instructions field. */
  instructions: boolean;
  /** The voice settings the model takes; anything else is not sent. */
  settings: VoiceSettingKey[];
  /** Stability only takes these values (Eleven v3's Creative / Natural / Robust). */
  stabilitySteps?: number[];
  /** Neighbouring text for continuity across joins (`previous_text` / `next_text`). */
  continuity: boolean;
  /** SSML such as `<break>`. */
  ssml: boolean;
  /** IPA written between slashes in the text (`/ˈkɛstrəl/`). */
  ipaInText: boolean;
  /** Documented characters per request. */
  maxChars: number;
  /** One-line notes for the settings screen. */
  notes: string[];
};

const plain = (label: string, maxChars: number, notes: string[] = []): TtsTraits => ({
  label, audioTags: false, instructions: false, settings: [], continuity: false, ssml: false, ipaInText: false, maxChars, notes,
});

/** The traits of `model` on `provider`. Unknown models are treated as plain text-to-speech. */
export function ttsTraits(provider: string | null | undefined, model: string | null | undefined): TtsTraits {
  const id = (model ?? "").trim().toLowerCase();
  if (provider === "ElevenLabs") {
    if (/^eleven_v4/.test(id)) {
      return {
        label: id.includes("turbo") ? "Eleven v4 Turbo" : "Eleven v4",
        audioTags: true, instructions: false, settings: ["stability", "similarity"], continuity: false, ssml: false, ipaInText: true,
        maxChars: 10_000,
        notes: [
          "Direct each line with audio tags such as [whispers] or [sarcastic]; scenes carry a setting and a mood.",
          "Only Stability and Similarity apply. Style, speed and SSML are not supported.",
          "Pronunciation rules with IPA are written as /ipa/ in the text, which v4 reads natively.",
        ],
      };
    }
    if (/^eleven_v3/.test(id)) {
      return {
        label: "Eleven v3",
        audioTags: true, instructions: false, settings: ["stability", "similarity"], stabilitySteps: [0, 0.5, 1], continuity: false, ssml: false, ipaInText: false,
        maxChars: 5_000,
        notes: ["Audio tags direct the delivery. Stability snaps to Creative (0), Natural (0.5) or Robust (1)."],
      };
    }
    const flash = /^eleven_(flash|turbo)/.test(id);
    return {
      label: flash ? "ElevenLabs Flash" : "ElevenLabs v2",
      audioTags: false, instructions: false,
      settings: flash ? ["stability", "similarity", "speed", "speakerBoost"] : ["stability", "similarity", "style", "speed", "speakerBoost"],
      continuity: true, ssml: true, ipaInText: false,
      maxChars: /flash_v2_5|turbo_v2_5/.test(id) ? 40_000 : /flash_v2|turbo_v2/.test(id) ? 30_000 : 10_000,
      notes: ["No audio tags: switch to Eleven v4 for directed, emotional delivery."],
    };
  }
  if (provider === "OpenAI" || provider === "Cloudflare") {
    if (/gpt-4o(-mini)?-tts|gpt-.*-tts/.test(id)) {
      return {
        label: "GPT-4o mini TTS",
        audioTags: false, instructions: true, settings: [], continuity: false, ssml: false, ipaInText: false, maxChars: 4_096,
        notes: ["Takes direction as instructions (tone, setting, emotion), which are not read aloud."],
      };
    }
    if (/^tts-1/.test(id)) return { ...plain("OpenAI TTS", 4_096, ["No direction support."]), settings: ["speed"] };
  }
  if (provider === "Deepgram" || id.includes("aura")) return plain("Deepgram Aura", 2_000, ["No direction support."]);
  if (provider === "Fish Audio") return plain("Fish Audio", 15_000, ["No direction support in Prosecast yet."]);
  if (provider === "Gradium") return plain("Gradium", 5_000, ["No direction support."]);
  return plain("Text to speech", 4_000);
}

/** What a model can take direction through, if at all. */
export const takesDirection = (traits: TtsTraits): boolean => traits.audioTags || traits.instructions;

/** Default voice settings, matching what Prosecast always sent before settings existed. */
export const DEFAULT_VOICE_SETTINGS: Required<Omit<VoiceSettings, "instructions">> = {
  stability: 0.45,
  similarity: 0.75,
  style: 0,
  speed: 1,
  speakerBoost: true,
};

/** Bounds per setting, for the sliders and for server-side clamping. */
export const VOICE_SETTING_RANGES: Record<Exclude<VoiceSettingKey, "speakerBoost">, { min: number; max: number; step: number }> = {
  stability: { min: 0, max: 1, step: 0.05 },
  similarity: { min: 0, max: 1, step: 0.05 },
  style: { min: 0, max: 1, step: 0.05 },
  speed: { min: 0.7, max: 1.2, step: 0.05 },
};

const clean = (value: string | undefined | null, limit: number) =>
  (value ?? "").replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/** A line tag as it will be sent: no brackets or line breaks, bounded length. */
export const cleanTag = (tag: string) => clean(tag, DIRECTION_LIMITS.tag);

/** The direction that applies to one segment. */
export type SegmentDirectionSpec = {
  /** Per-line delivery, e.g. ["whispers"]. */
  lineTags?: string[];
  /** The scene's setting and mood (chapter values unless the scene overrides them). */
  setting?: string;
  mood?: string;
  /** The first line of its scene, where the setting is voiced. */
  sceneStart?: boolean;
};

export type ComposedDirection = {
  /** Inline tags placed before the text, with a trailing space; "" when none. */
  prefix: string;
  /** Instructions for models with an instructions field; "" when none. */
  instructions: string;
  /** Canonical form of everything sent besides the words; "" means no direction. */
  fingerprint: string;
};

const NO_DIRECTION: ComposedDirection = { prefix: "", instructions: "", fingerprint: "" };

/**
 * Turns a segment's direction into what this model receives.
 *
 * Tag-aware models get the line's own tags, or the scene's mood when the line
 * has none, so the emotion carries across separately rendered segments. The
 * setting is voiced once, on the first line of its scene, because every tag is
 * also billed as text. Instruction models get everything as instructions.
 */
export function composeDirection(spec: SegmentDirectionSpec | null | undefined, traits: TtsTraits, standingInstructions?: string | null): ComposedDirection {
  const tags = (spec?.lineTags ?? []).map(cleanTag).filter(Boolean).slice(0, DIRECTION_LIMITS.tagsPerLine);
  const setting = clean(spec?.setting, DIRECTION_LIMITS.setting);
  const mood = clean(spec?.mood, DIRECTION_LIMITS.mood);

  if (traits.audioTags) {
    const parts: string[] = [];
    if (spec?.sceneStart && setting) parts.push(`[scene: ${setting}]`);
    if (tags.length) parts.push(...tags.map(tag => `[${tag}]`));
    else if (mood) parts.push(`[${mood}]`);
    if (!parts.length) return NO_DIRECTION;
    const prefix = `${parts.join(" ")} `;
    return { prefix, instructions: "", fingerprint: `tags:${prefix.trim()}` };
  }

  if (traits.instructions) {
    const standing = clean(standingInstructions, DIRECTION_LIMITS.instructions);
    const sentences = [
      standing,
      setting ? `Scene: ${setting}.` : "",
      mood ? `Mood: ${mood}.` : "",
      tags.length ? `Deliver this line ${tags.join(", ")}.` : "",
    ].filter(Boolean);
    if (!sentences.length) return NO_DIRECTION;
    const instructions = sentences.join(" ");
    return { prefix: "", instructions, fingerprint: `instructions:${instructions}` };
  }

  return NO_DIRECTION;
}

/** The effective setting and mood of scene `index` in a chapter. */
export function sceneDirection(direction: ChapterDirection | null | undefined, index: number): SceneDirection {
  const override = direction?.scenes?.[String(index)];
  return {
    setting: clean(override?.setting, DIRECTION_LIMITS.setting) || clean(direction?.setting, DIRECTION_LIMITS.setting) || undefined,
    mood: clean(override?.mood, DIRECTION_LIMITS.mood) || clean(direction?.mood, DIRECTION_LIMITS.mood) || undefined,
  };
}

/** Snaps and clamps voice settings to what `traits` accepts; keys the model does not take are dropped. */
export function effectiveVoiceSettings(settings: VoiceSettings | null | undefined, traits: TtsTraits): Partial<Required<Omit<VoiceSettings, "instructions">>> {
  const out: Partial<Required<Omit<VoiceSettings, "instructions">>> = {};
  for (const key of traits.settings) {
    if (key === "speakerBoost") {
      out.speakerBoost = settings?.speakerBoost ?? DEFAULT_VOICE_SETTINGS.speakerBoost;
      continue;
    }
    const range = VOICE_SETTING_RANGES[key];
    let value = settings?.[key];
    if (typeof value !== "number" || !Number.isFinite(value)) value = DEFAULT_VOICE_SETTINGS[key];
    value = Math.min(range.max, Math.max(range.min, value));
    if (key === "stability" && traits.stabilitySteps?.length) {
      value = traits.stabilitySteps.reduce((best, step) => (Math.abs(step - value!) < Math.abs(best - value!) ? step : best), traits.stabilitySteps[0]!);
    }
    out[key] = Math.round(value * 100) / 100;
  }
  return out;
}
