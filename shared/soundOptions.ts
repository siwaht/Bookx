/**
 * How background music and sound effects sit under the narration, beyond the
 * on/off toggles and the overall level. Shared by the server (mixer) and the
 * Audio studio screen.
 *
 * Everything is optional: a project with no options mixes exactly as before,
 * with short music swells where a scene opens and brief effects after lines.
 */

/** "swells": a few seconds of music as each scene opens. "bed": one track under the whole chapter. */
export type MusicMode = "swells" | "bed";
export type DuckDepth = "light" | "medium" | "strong";
export type EffectLength = "short" | "medium" | "long";

export type SoundOptions = {
  musicMode?: MusicMode;
  /** Library music for the bed, intro and outro (a `music-*` tag). */
  bedTag?: string;
  /** An uploaded or generated track used instead of `bedTag`. */
  bedAssetId?: string | null;
  /** Trim on top of the level for all music, and for all effects, in dB. */
  musicGainDb?: number;
  sfxGainDb?: number;
  /** Fades for the bed, intro and outro. */
  musicFadeInMs?: number;
  musicFadeOutMs?: number;
  /** How far music and effects dip while someone is speaking. */
  duck?: DuckDepth;
  /** Music on its own before the first line of every chapter. */
  intro?: { enabled: boolean; seconds: number };
  /** Music on its own after the last line of every chapter. */
  outro?: { enabled: boolean; seconds: number };
  /** How long an effect may ring on. */
  effectLength?: EffectLength;
};

/** One chapter's departure from the book's music. */
export type ChapterSoundOptions = {
  /** "off" plays no music at all in this chapter. */
  music?: "inherit" | "off";
  bedTag?: string;
  bedAssetId?: string | null;
};

export const SOUND_OPTION_LIMITS = {
  gainDb: { min: -12, max: 12 },
  fadeInMs: { min: 200, max: 8_000 },
  fadeOutMs: { min: 200, max: 12_000 },
  introSeconds: { min: 1, max: 20 },
  outroSeconds: { min: 1, max: 30 },
  /** Per-cue nudge and length set on a single cue. */
  cueOffsetMs: { min: -3_000, max: 5_000 },
  cueLengthMs: { min: 300, max: 30_000 },
} as const;

export const EFFECT_MAX_MS: Record<EffectLength, number> = { short: 1_600, medium: 3_200, long: 6_000 };

/** Sidechain settings per ducking depth: how hard and from how quiet the voice pushes the bed down. */
export const DUCKING: Record<DuckDepth, { ratio: number; thresholdScale: number }> = {
  light: { ratio: 2, thresholdScale: 1.6 },
  medium: { ratio: 4, thresholdScale: 1 },
  strong: { ratio: 8, thresholdScale: 0.6 },
};

export type ResolvedSoundOptions = {
  musicMode: MusicMode;
  bedTag: string;
  bedAssetId: string | null;
  musicGainDb: number;
  sfxGainDb: number;
  musicFadeInMs: number;
  musicFadeOutMs: number;
  duck: DuckDepth;
  intro: { enabled: boolean; seconds: number };
  outro: { enabled: boolean; seconds: number };
  effectLength: EffectLength;
};

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export const DEFAULT_BED_TAG = "music-calm";

/** Options with every gap filled and every number in range. */
export function resolveSoundOptions(raw: SoundOptions | null | undefined): ResolvedSoundOptions {
  const limits = SOUND_OPTION_LIMITS;
  return {
    musicMode: raw?.musicMode === "bed" ? "bed" : "swells",
    bedTag: typeof raw?.bedTag === "string" && raw.bedTag.startsWith("music-") ? raw.bedTag : DEFAULT_BED_TAG,
    bedAssetId: typeof raw?.bedAssetId === "string" && raw.bedAssetId ? raw.bedAssetId : null,
    musicGainDb: clamp(raw?.musicGainDb, limits.gainDb.min, limits.gainDb.max, 0),
    sfxGainDb: clamp(raw?.sfxGainDb, limits.gainDb.min, limits.gainDb.max, 0),
    musicFadeInMs: clamp(raw?.musicFadeInMs, limits.fadeInMs.min, limits.fadeInMs.max, 2_000),
    musicFadeOutMs: clamp(raw?.musicFadeOutMs, limits.fadeOutMs.min, limits.fadeOutMs.max, 4_000),
    duck: raw?.duck === "light" || raw?.duck === "strong" ? raw.duck : "medium",
    intro: { enabled: Boolean(raw?.intro?.enabled), seconds: clamp(raw?.intro?.seconds, limits.introSeconds.min, limits.introSeconds.max, 6) },
    outro: { enabled: Boolean(raw?.outro?.enabled), seconds: clamp(raw?.outro?.seconds, limits.outroSeconds.min, limits.outroSeconds.max, 8) },
    effectLength: raw?.effectLength === "medium" || raw?.effectLength === "long" ? raw.effectLength : "short",
  };
}

/** Whether a chapter plays any music, and which track, after its own override. */
export function chapterMusic(options: ResolvedSoundOptions, chapter: ChapterSoundOptions | null | undefined): { on: boolean; bedTag: string; bedAssetId: string | null } {
  if (chapter?.music === "off") return { on: false, bedTag: options.bedTag, bedAssetId: options.bedAssetId };
  const tag = typeof chapter?.bedTag === "string" && chapter.bedTag.startsWith("music-") ? chapter.bedTag : null;
  const asset = typeof chapter?.bedAssetId === "string" && chapter.bedAssetId ? chapter.bedAssetId : null;
  return { on: true, bedTag: tag ?? options.bedTag, bedAssetId: asset ?? (tag ? null : options.bedAssetId) };
}
