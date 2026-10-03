import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ExportOutput } from "../shared/exportOptions";
import type { ChapterDirection, VoiceSettings } from "../shared/direction";
import type { ChapterSoundOptions, SoundOptions } from "../shared/soundOptions";

/**
 * Bookx's database, in SQLite form for Cloudflare D1.
 *
 * The same schema runs locally (Node's built-in SQLite) and in production
 * (D1), so development and tests exercise exactly what ships. Timestamps are
 * stored as epoch milliseconds and read back as `Date`s; JSON columns are
 * parsed and serialised by drizzle.
 */

/**
 * Epoch milliseconds, read back as a Date. Defaults are set by drizzle in
 * JavaScript rather than by SQL: a SQL default would win over them and round
 * to whole seconds, which makes "the latest job" ambiguous.
 */
const moment = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => moment("createdAt").notNull().$defaultFn(() => new Date());
const updatedAt = () => moment("updatedAt").notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date());

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  openId: text("openId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  loginMethod: text("loginMethod"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastSignedIn: moment("lastSignedIn").notNull().$defaultFn(() => new Date()),
});

export const bookxProjects = sqliteTable("bookxProjects", {
  id: text("id").primaryKey(),
  ownerId: integer("ownerId").notNull(),
  title: text("title").notNull(),
  author: text("author"),
  kind: text("kind", { enum: ["audiobook", "podcast"] }).notNull(),
  narrationStyle: text("narrationStyle", { enum: ["single", "cast", "narrator-cast"] }).notNull(),
  voiceProvider: text("voiceProvider").notNull().default("ElevenLabs"),
  voiceModel: text("voiceModel").notNull(),
  languageModelProvider: text("languageModelProvider").notNull().default("Cloudflare"),
  languageModel: text("languageModel").notNull().default("@cf/openai/gpt-oss-120b"),
  language: text("language").notNull(),
  manuscriptName: text("manuscriptName"),
  manuscriptStorageKey: text("manuscriptStorageKey"),
  coverStyle: text("coverStyle"),
  status: text("status", { enum: ["draft", "producing", "review", "published"] }).default("draft").notNull(),

  // ---- Sound design -------------------------------------------------------
  // Both default off: a book is narration only until the creator opts in.
  /** Brief, very soft scene sounds (rain, a door, distant swords). */
  soundEffectsEnabled: integer("soundEffectsEnabled").notNull().default(0),
  /** Short, soft mood swells at scene openings. */
  backgroundMusicEnabled: integer("backgroundMusicEnabled").notNull().default(0),
  /** "ultra-subtle", "extra-subtle" or "subtle"; sets the level of every cue under the voice. */
  soundLevel: text("soundLevel").notNull().default("extra-subtle"),
  /** "auto" (ElevenLabs when connected, else built-in), "elevenlabs" or "builtin". */
  soundSource: text("soundSource").notNull().default("auto"),
  /** Music bed, intro/outro, volumes and ducking; null means the original swells-only behaviour. */
  soundOptions: text("soundOptions", { mode: "json" }).$type<SoundOptions>(),
  /** Stability, similarity and the other knobs the chosen voice model accepts; null means its defaults. */
  voiceSettings: text("voiceSettings", { mode: "json" }).$type<VoiceSettings>(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxProjects_owner_idx").on(table.ownerId)]);

export const bookxChapters = sqliteTable("bookxChapters", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  title: text("title").notNull(),
  /** Chapter text. D1 rows are limited to 2 MB, which the importer enforces. */
  body: text("body"),
  orderIndex: integer("orderIndex").notNull().default(0),
  /**
   * Whether the chapter is part of the audiobook. Excluded chapters stay in the
   * manuscript for reference but are never narrated, audited or exported.
   */
  included: integer("included").notNull().default(1),
  /** "chapter", "front-matter" or "back-matter", as detected on import. */
  kind: text("kind").notNull().default("chapter"),
  /** Hash of the segment texts when speakers were last attributed. */
  attributionHash: text("attributionHash"),
  /** Hash of the segment texts when sound cues were last planned. */
  sceneHash: text("sceneHash"),
  generatedSegments: integer("generatedSegments").notNull().default(0),
  totalSegments: integer("totalSegments").notNull().default(0),
  /** The chapter file of the most recent export. */
  audioStorageKey: text("audioStorageKey"),
  audioDurationMs: integer("audioDurationMs"),
  /** Scene setting and mood for the chapter and each of its scenes, voiced by models that take direction. */
  direction: text("direction", { mode: "json" }).$type<ChapterDirection>(),
  /** Per-chapter music override (off, or a different track). */
  soundOptions: text("soundOptions", { mode: "json" }).$type<ChapterSoundOptions>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxChapters_project_idx").on(table.projectId, table.orderIndex)]);

/** Per-segment performance and layout hints. */
export type SegmentDelivery = {
  pace?: string;
  tags?: string[];
  /** Silence after this segment in the assembled chapter. */
  pauseMs?: number;
  /** Quoted speech or narration; only dialogue is voiced by a character. */
  kind?: "narration" | "dialogue";
  /** Index of the source paragraph within the chapter. */
  paragraph?: number;
  /** A scene break (e.g. "* * *") precedes this segment. */
  sceneBreakBefore?: boolean;
  /** How `characterId` was decided; "manual" is never overwritten by analysis. */
  speakerSource?: "heuristic" | "llm" | "manual";
  /** The quote is still open at the end of its paragraph and continues in the next. */
  continuesQuote?: boolean;
};

export const bookxSegments = sqliteTable("bookxSegments", {
  id: text("id").primaryKey(),
  chapterId: text("chapterId").notNull(),
  characterId: text("characterId"),
  text: text("text").notNull(),
  audioStorageKey: text("audioStorageKey"),
  orderIndex: integer("orderIndex").notNull().default(0),
  delivery: text("delivery", { mode: "json" }).$type<SegmentDelivery>(),

  // ---- Render provenance -------------------------------------------------
  // Together these answer "is the stored audio still the right audio?".
  // A segment may only be reused when `textHash` matches the current text and
  // the voice columns match the voice the run is pinned to; otherwise it is
  // re-rendered. This is what keeps a resumed book free of stale or mismatched
  // audio.
  /** SHA-256 of the exact text that produced `audioStorageKey`. */
  textHash: text("textHash"),
  /** Hash of the pronunciation rules applied when `audioStorageKey` was made. */
  pronunciationHash: text("pronunciationHash"),
  /** Hash of the performance direction (audio tags or instructions) sent with the text; null means none. */
  directionHash: text("directionHash"),
  voiceProvider: text("voiceProvider"),
  voiceModel: text("voiceModel"),
  voiceId: text("voiceId"),
  audioMimeType: text("audioMimeType"),
  audioBytes: integer("audioBytes"),
  audioDurationMs: integer("audioDurationMs"),
  renderAttempts: integer("renderAttempts").notNull().default(0),
  lastError: text("lastError"),
  renderedAt: moment("renderedAt"),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  index("bookxSegments_chapter_idx").on(table.chapterId, table.orderIndex),
  index("bookxSegments_character_idx").on(table.characterId),
]);

export const bookxCharacters = sqliteTable("bookxCharacters", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  voiceId: text("voiceId"),
  voiceName: text("voiceName"),
  accent: text("accent"),
  voiceRationale: text("voiceRationale"),
  sampleLine: text("sampleLine"),
  previewStorageKey: text("previewStorageKey"),
  assignmentConfidence: integer("assignmentConfidence"),
  /** "auto" is Bookx's own default pick; "manual" is never replaced by re-casting. */
  assignmentSource: text("assignmentSource", { enum: ["manual", "llm", "auto"] }).default("manual").notNull(),
  /** The narrator voices every line that is not attributed to a character. */
  isNarrator: integer("isNarrator").notNull().default(0),
  gender: text("gender"),
  ageGroup: text("ageGroup"),
  /** Other names the manuscript uses for this character ("Mr. Darcy", "Darcy"). */
  aliases: text("aliases", { mode: "json" }).$type<string[]>(),
  description: text("description"),
  /** Dialogue segments attributed to this character. */
  lineCount: integer("lineCount").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxCharacters_project_idx").on(table.projectId)]);

export const bookxPronunciations = sqliteTable("bookxPronunciations", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  word: text("word").notNull(),
  alias: text("alias"),
  phoneme: text("phoneme"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxPronunciations_project_idx").on(table.projectId)]);

/** Structured job detail. Kept small and bounded so a long book cannot grow it without limit. */
export type GenerationJobDetail = {
  chapterIds?: string[];
  errors?: string[];
  /** Per-segment failures that survived every retry, capped by the worker. */
  failures?: Array<{ segmentId: string; chapterId: string; message: string; at: string }>;
  /** Human-readable timeline of stalls, retries, pauses and resumes. */
  events?: Array<{ at: string; kind: string; message: string }>;
  /** Voice the run is pinned to, recorded so a resume cannot drift. */
  pinnedVoice?: { provider: string; model: string; voiceId?: string };
  /**
   * A regeneration: audio rendered before this moment is redone even when it
   * is still current. Stored (rather than a one-off "force") so a paused
   * regeneration resumes where it stopped instead of redoing finished lines.
   */
  forceBefore?: string;
};

export const bookxGenerationJobs = sqliteTable("bookxGenerationJobs", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  scope: text("scope", { enum: ["project", "chapter", "segment"] }).notNull(),
  status: text("status", { enum: ["queued", "running", "paused", "completed", "failed", "cancelled"] }).default("queued").notNull(),
  totalSegments: integer("totalSegments").notNull().default(0),
  completedSegments: integer("completedSegments").notNull().default(0),
  failedSegments: integer("failedSegments").notNull().default(0),
  /** Segments reused from a previous run because their audio was still valid. */
  skippedSegments: integer("skippedSegments").notNull().default(0),

  // ---- Pinned voice ------------------------------------------------------
  // A batch run never silently switches provider: changing narrator mid-book is
  // worse than failing. These record what the run committed to.
  provider: text("provider"),
  model: text("model"),
  voiceId: text("voiceId"),

  // ---- Checkpoint / resume ----------------------------------------------
  /** Last segment the worker was working on; a resume restarts before this. */
  cursorSegmentId: text("cursorSegmentId"),
  /** Position of the cursor in the run's ordered segment list. */
  cursorIndex: integer("cursorIndex").notNull().default(0),
  /** How many already-rendered segments to redo ahead of the cursor on resume. */
  rewindSegments: integer("rewindSegments").notNull().default(1),

  // ---- Single-runner lease ----------------------------------------------
  // Prevents two workers rendering the same job and doubling up its audio.
  leaseOwner: text("leaseOwner"),
  leaseExpiresAt: moment("leaseExpiresAt"),
  /** Updated as work proceeds; a stale heartbeat marks the run interruptible. */
  heartbeatAt: moment("heartbeatAt"),

  // ---- Cooperative control ---------------------------------------------
  // Flags rather than status writes, so a request is never lost to a race and
  // the worker only ever stops at a segment boundary.
  pauseRequested: integer("pauseRequested").notNull().default(0),
  cancelRequested: integer("cancelRequested").notNull().default(0),

  renderedBytes: integer("renderedBytes").notNull().default(0),
  renderedDurationMs: integer("renderedDurationMs").notNull().default(0),
  startedAt: moment("startedAt"),
  finishedAt: moment("finishedAt"),

  detail: text("detail", { mode: "json" }).$type<GenerationJobDetail>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxGenerationJobs_project_idx").on(table.projectId, table.createdAt)]);

/** One chapter file of an export. */
export type ExportChapterFile = {
  chapterId: string;
  title: string;
  storageKey: string;
  /** Download name, e.g. "03 - The Storm at Harrow Pass.mp3". */
  fileName?: string;
  bytes?: number;
  durationMs: number;
  /** Where the chapter starts in the whole-book file. */
  startMs: number;
  /** Measured whole-file RMS and sample peak of the delivered file, in dBFS. */
  rmsDb?: number | null;
  peakDb?: number | null;
};

/** Files and chapter marks produced by an export. */
export type ExportDetail = {
  /** One entry per chapter, in playback order. */
  chapters?: ExportChapterFile[];
  /** Chapter marks against the whole-book file. */
  marks?: Array<{ label: string; startMs: number; durationMs: number }>;
  container?: "mp3" | "wav" | "flac";
  /** Preset and encoding settings the export was made with. */
  preset?: string;
  output?: ExportOutput;
  /** The optional single file for the whole book. */
  fullBook?: { storageKey: string; fileName: string; bytes: number; durationMs: number } | null;
  /** The opening and closing credits files, when they were narrated. */
  credits?: { opening?: { storageKey: string; fileName: string; bytes: number; durationMs: number } | null; closing?: { storageKey: string; fileName: string; bytes: number; durationMs: number } | null } | null;
  /** The retail sample file, when one was cut. */
  retailSample?: { storageKey: string; fileName: string; bytes: number; durationMs: number } | null;
  segmentGapMs?: number;
  chapterGapMs?: number;
  /** Things the creator should know about this package; none of them stopped it. */
  warnings?: string[];
  /** Live progress while the package is assembled. */
  progress?: { done: number; total: number; stage: string };
  /** Present when background sounds or music were mixed in. */
  soundDesign?: { effects: boolean; music: boolean; level: string; cues: number; encoding: string };
  /** Measured quality of the delivered files against the audiobook standard. */
  quality?: { noiseFloorDb?: number | null; checkedFiles?: number };
};

export const bookxExports = sqliteTable("bookxExports", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  /** Export preset id ("spotify", "wav", "flac", "mp3", "original"). */
  format: text("format").notNull(),
  status: text("status", { enum: ["queued", "assembling", "ready", "failed"] }).default("queued").notNull(),
  /** The whole-book file, when one was made. Chapter files live in `detail.chapters`. */
  storageKey: text("storageKey"),
  durationMs: integer("durationMs"),
  bytes: integer("bytes"),
  error: text("error"),
  detail: text("detail", { mode: "json" }).$type<ExportDetail>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxExports_project_idx").on(table.projectId, table.createdAt)]);

export const bookxProviderSettings = sqliteTable("bookxProviderSettings", {
  id: text("id").primaryKey(),
  ownerId: integer("ownerId").notNull(),
  provider: text("provider").notNull(),
  secretConfigured: integer("secretConfigured").notNull().default(0),
  defaultModel: text("defaultModel"),
  defaultTtsModel: text("defaultTtsModel"),
  defaultSttModel: text("defaultSttModel"),
  defaultLlmModel: text("defaultLlmModel"),
  defaultPace: text("defaultPace"),
  chapterGapMs: integer("chapterGapMs").notNull().default(2000),
  fallbackProvider: text("fallbackProvider"),
  fallbackEnabled: integer("fallbackEnabled").notNull().default(0),
  apiBaseUrl: text("apiBaseUrl"),
  apiKey: text("apiKey"),
  /** Display name of a provider the user added themselves (`custom:*` rows). */
  label: text("label"),
  /** Provider-specific settings, such as the voices a custom provider offers. */
  options: text("options", { mode: "json" }).$type<ProviderOptions>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxProviderSettings_owner_idx").on(table.ownerId, table.provider)]);

export type ProviderOptions = {
  /** Voice names a custom (OpenAI-compatible) provider accepts. */
  voices?: string[];
};

export const bookxStudioAssets = sqliteTable("bookxStudioAssets", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  type: text("type", { enum: ["music", "sound-effect", "recording"] }).notNull(),
  title: text("title").notNull(),
  storageKey: text("storageKey"),
  durationMs: integer("durationMs").notNull().default(0),
  /** Identity of a generated sound, so the same cue is only paid for once. */
  promptHash: text("promptHash"),
  /** Sound-design vocabulary tag, e.g. "rain" or "music-romantic". */
  tag: text("tag"),
  /** "elevenlabs", "builtin" or "upload". */
  source: text("source"),
  /** Measured loudness, used to set every cue to the same level under the voice. */
  meanVolumeDb: integer("meanVolumeDb"),
  peakVolumeDb: integer("peakVolumeDb"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  index("bookxStudioAssets_project_idx").on(table.projectId),
  index("bookxStudioAssets_prompt_idx").on(table.promptHash),
]);

/**
 * One planned sound under the narration: a brief effect after a line, or a soft
 * music swell at the start of a scene. Anchored to a segment so it moves with
 * the text rather than with a clock position.
 */
export const bookxSoundCues = sqliteTable("bookxSoundCues", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  chapterId: text("chapterId").notNull(),
  segmentId: text("segmentId").notNull(),
  kind: text("kind", { enum: ["sfx", "music"] }).notNull(),
  tag: text("tag").notNull(),
  /** "before" plays into the anchor segment; "after" plays in the pause after it. */
  placement: text("placement", { enum: ["before", "after"] }).notNull().default("after"),
  source: text("source", { enum: ["llm", "keyword", "manual"] }).notNull().default("llm"),
  note: text("note"),
  enabled: integer("enabled").notNull().default(1),
  /** Creator trim relative to the project's sound level, in dB. */
  gainDb: integer("gainDb").notNull().default(0),
  assetId: text("assetId"),
  /** Creator nudge of the start time, in ms (negative plays earlier). */
  offsetMs: integer("offsetMs").notNull().default(0),
  /** Creator override of how long the cue plays, in ms; null uses the sound's own envelope. */
  lengthMs: integer("lengthMs"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  index("bookxSoundCues_project_idx").on(table.projectId),
  index("bookxSoundCues_chapter_idx").on(table.chapterId),
]);

export type AnalysisJobDetail = {
  chapterIds?: string[];
  events?: Array<{ at: string; kind: string; message: string }>;
  errors?: string[];
  summary?: Record<string, number | string>;
};

/**
 * Background analysis runs (casting, scene cues, sound generation). Separate
 * from narration jobs so a long analysis never shadows narration progress.
 */
export const bookxAnalysisJobs = sqliteTable("bookxAnalysisJobs", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  kind: text("kind", { enum: ["cast", "scenes", "sounds"] }).notNull(),
  status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled"] }).default("queued").notNull(),
  totalSteps: integer("totalSteps").notNull().default(0),
  completedSteps: integer("completedSteps").notNull().default(0),
  message: text("message"),
  cancelRequested: integer("cancelRequested").notNull().default(0),
  detail: text("detail", { mode: "json" }).$type<AnalysisJobDetail>(),
  heartbeatAt: moment("heartbeatAt"),
  startedAt: moment("startedAt"),
  finishedAt: moment("finishedAt"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxAnalysisJobs_project_idx").on(table.projectId, table.kind, table.createdAt)]);

export const bookxTimelineClips = sqliteTable("bookxTimelineClips", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull(),
  assetId: text("assetId"),
  segmentId: text("segmentId"),
  trackType: text("trackType", { enum: ["narration", "music", "sound-effect"] }).notNull(),
  startMs: integer("startMs").notNull().default(0),
  durationMs: integer("durationMs").notNull().default(0),
  volume: integer("volume").notNull().default(80),
  fadeInMs: integer("fadeInMs").notNull().default(0),
  fadeOutMs: integer("fadeOutMs").notNull().default(0),
  duckUnderNarration: integer("duckUnderNarration").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("bookxTimelineClips_project_idx").on(table.projectId)]);

/**
 * One provider call Prosecast made on a user's behalf: characters sent to a
 * voice, seconds transcribed, tokens used by a language model. Written after
 * the call succeeds, so the ledger never counts work that was not done.
 */
export const bookxUsageEvents = sqliteTable("bookxUsageEvents", {
  id: text("id").primaryKey(),
  ownerId: integer("ownerId").notNull(),
  projectId: text("projectId"),
  provider: text("provider").notNull(),
  /** "tts", "stt", "llm", "sfx" or "music". */
  capability: text("capability").notNull(),
  model: text("model"),
  /** What the call was for: "narration", "preview", "cast-analysis", "direction", "transcription", "sound". */
  purpose: text("purpose"),
  characters: integer("characters").notNull().default(0),
  inputTokens: integer("inputTokens").notNull().default(0),
  outputTokens: integer("outputTokens").notNull().default(0),
  /** Audio processed (STT) or produced (sounds), in ms. */
  audioMs: integer("audioMs").notNull().default(0),
  /** Cost the provider reported for the call, in its own unit (ElevenLabs credits, OpenRouter USD). */
  providerCost: real("providerCost"),
  createdAt: createdAt(),
}, table => [index("bookxUsageEvents_owner_idx").on(table.ownerId, table.provider, table.createdAt)]);

/**
 * The app's own settings, keyed by a fixed single row (id = 1). Holds the
 * salted scrypt hash of the one account's password, so the configured
 * password is never stored in the database in plain form.
 */
export const appSettings = sqliteTable("appSettings", {
  id: integer("id").primaryKey(),
  /** `scrypt$<salt-hex>$<hash-hex>` for the single sign-in account. */
  signinHash: text("signinHash"),
  updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type BookxProject = typeof bookxProjects.$inferSelect;
export type InsertBookxProject = typeof bookxProjects.$inferInsert;
