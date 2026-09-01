import { bigint, int, json, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const bookxProjects = mysqlTable("bookxProjects", {
  id: varchar("id", { length: 32 }).primaryKey(),
  ownerId: int("ownerId").notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  author: varchar("author", { length: 120 }),
  kind: mysqlEnum("kind", ["audiobook", "podcast"]).notNull(),
  narrationStyle: mysqlEnum("narrationStyle", ["single", "cast", "narrator-cast"]).notNull(),
  voiceProvider: varchar("voiceProvider", { length: 80 }).notNull().default("ElevenLabs"),
  voiceModel: varchar("voiceModel", { length: 64 }).notNull(),
  languageModelProvider: varchar("languageModelProvider", { length: 80 }).notNull().default("Cloudflare"),
  languageModel: varchar("languageModel", { length: 160 }).notNull().default("@cf/openai/gpt-oss-120b"),
  language: varchar("language", { length: 40 }).notNull(),
  manuscriptName: varchar("manuscriptName", { length: 255 }),
  manuscriptStorageKey: varchar("manuscriptStorageKey", { length: 512 }),
  coverStyle: varchar("coverStyle", { length: 255 }),
  status: mysqlEnum("status", ["draft", "producing", "review", "published"]).default("draft").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const bookxChapters = mysqlTable("bookxChapters", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  body: text("body"),
  orderIndex: int("orderIndex").notNull().default(0),
  generatedSegments: int("generatedSegments").notNull().default(0),
  totalSegments: int("totalSegments").notNull().default(0),
  /** The chapter's segments joined into one file by the export assembler. */
  audioStorageKey: varchar("audioStorageKey", { length: 512 }),
  audioDurationMs: int("audioDurationMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const bookxSegments = mysqlTable("bookxSegments", {
  id: varchar("id", { length: 32 }).primaryKey(),
  chapterId: varchar("chapterId", { length: 32 }).notNull(),
  characterId: varchar("characterId", { length: 32 }),
  text: text("text").notNull(),
  audioStorageKey: varchar("audioStorageKey", { length: 512 }),
  orderIndex: int("orderIndex").notNull().default(0),
  delivery: json("delivery").$type<{ pace?: string; tags?: string[]; pauseMs?: number }>(),

  // ---- Render provenance -------------------------------------------------
  // Together these answer "is the stored audio still the right audio?".
  // A segment may only be reused when `textHash` matches the current text and
  // the voice columns match the voice the run is pinned to; otherwise it is
  // re-rendered. This is what keeps a resumed book free of stale or mismatched
  // audio.
  /** SHA-256 of the exact text that produced `audioStorageKey`. */
  textHash: varchar("textHash", { length: 64 }),
  voiceProvider: varchar("voiceProvider", { length: 80 }),
  voiceModel: varchar("voiceModel", { length: 160 }),
  voiceId: varchar("voiceId", { length: 160 }),
  audioMimeType: varchar("audioMimeType", { length: 80 }),
  audioBytes: int("audioBytes"),
  audioDurationMs: int("audioDurationMs"),
  renderAttempts: int("renderAttempts").notNull().default(0),
  lastError: varchar("lastError", { length: 512 }),
  renderedAt: timestamp("renderedAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const bookxCharacters = mysqlTable("bookxCharacters", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  role: varchar("role", { length: 100 }).notNull(),
  voiceId: varchar("voiceId", { length: 160 }),
  voiceName: varchar("voiceName", { length: 160 }),
  accent: varchar("accent", { length: 160 }),
  voiceRationale: varchar("voiceRationale", { length: 512 }),
  sampleLine: text("sampleLine"),
  previewStorageKey: varchar("previewStorageKey", { length: 512 }),
  assignmentConfidence: int("assignmentConfidence"),
  assignmentSource: mysqlEnum("assignmentSource", ["manual", "llm"]).default("manual").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const bookxPronunciations = mysqlTable("bookxPronunciations", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  word: varchar("word", { length: 255 }).notNull(),
  alias: varchar("alias", { length: 255 }),
  phoneme: varchar("phoneme", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

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
};

export const bookxGenerationJobs = mysqlTable("bookxGenerationJobs", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  scope: mysqlEnum("scope", ["project", "chapter", "segment"]).notNull(),
  status: mysqlEnum("status", ["queued", "running", "paused", "completed", "failed", "cancelled"]).default("queued").notNull(),
  totalSegments: int("totalSegments").notNull().default(0),
  completedSegments: int("completedSegments").notNull().default(0),
  failedSegments: int("failedSegments").notNull().default(0),
  /** Segments reused from a previous run because their audio was still valid. */
  skippedSegments: int("skippedSegments").notNull().default(0),

  // ---- Pinned voice ------------------------------------------------------
  // A batch run never silently switches provider: changing narrator mid-book is
  // worse than failing. These record what the run committed to.
  provider: varchar("provider", { length: 80 }),
  model: varchar("model", { length: 160 }),
  voiceId: varchar("voiceId", { length: 160 }),

  // ---- Checkpoint / resume ----------------------------------------------
  /** Last segment the worker was working on; a resume restarts before this. */
  cursorSegmentId: varchar("cursorSegmentId", { length: 32 }),
  /** Position of the cursor in the run's ordered segment list. */
  cursorIndex: int("cursorIndex").notNull().default(0),
  /** How many already-rendered segments to redo ahead of the cursor on resume. */
  rewindSegments: int("rewindSegments").notNull().default(1),

  // ---- Single-runner lease ----------------------------------------------
  // Prevents two workers rendering the same job and doubling up its audio.
  leaseOwner: varchar("leaseOwner", { length: 64 }),
  leaseExpiresAt: timestamp("leaseExpiresAt"),
  /** Updated as work proceeds; a stale heartbeat marks the run interruptible. */
  heartbeatAt: timestamp("heartbeatAt"),

  // ---- Cooperative control ---------------------------------------------
  // Flags rather than status writes, so a request is never lost to a race and
  // the worker only ever stops at a segment boundary.
  pauseRequested: int("pauseRequested").notNull().default(0),
  cancelRequested: int("cancelRequested").notNull().default(0),

  renderedBytes: bigint("renderedBytes", { mode: "number" }).notNull().default(0),
  renderedDurationMs: int("renderedDurationMs").notNull().default(0),
  startedAt: timestamp("startedAt"),
  finishedAt: timestamp("finishedAt"),

  detail: json("detail").$type<GenerationJobDetail>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Files and chapter marks produced by an export. */
export type ExportDetail = {
  /** One entry per chapter, in playback order. */
  chapters?: Array<{ chapterId: string; title: string; storageKey: string; durationMs: number; startMs: number }>;
  /** Chapter marks against the single combined file. */
  marks?: Array<{ label: string; startMs: number; durationMs: number }>;
  container?: "mp3" | "wav";
  segmentGapMs?: number;
  chapterGapMs?: number;
};

export const bookxExports = mysqlTable("bookxExports", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  format: mysqlEnum("format", ["ACX", "Podcast", "InAudio package"]).notNull(),
  status: mysqlEnum("status", ["queued", "assembling", "ready", "failed"]).default("queued").notNull(),
  /** The single combined file. Per-chapter files live in `detail.chapters`. */
  storageKey: varchar("storageKey", { length: 512 }),
  durationMs: int("durationMs"),
  bytes: bigint("bytes", { mode: "number" }),
  error: varchar("error", { length: 512 }),
  detail: json("detail").$type<ExportDetail>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const bookxProviderSettings = mysqlTable("bookxProviderSettings", {
  id: varchar("id", { length: 32 }).primaryKey(),
  ownerId: int("ownerId").notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  secretConfigured: int("secretConfigured").notNull().default(0),
  defaultModel: varchar("defaultModel", { length: 100 }),
  defaultTtsModel: varchar("defaultTtsModel", { length: 160 }),
  defaultSttModel: varchar("defaultSttModel", { length: 160 }),
  defaultLlmModel: varchar("defaultLlmModel", { length: 160 }),
  defaultPace: varchar("defaultPace", { length: 80 }),
  chapterGapMs: int("chapterGapMs").notNull().default(2000),
  fallbackProvider: varchar("fallbackProvider", { length: 80 }),
  fallbackEnabled: int("fallbackEnabled").notNull().default(0),
  apiBaseUrl: varchar("apiBaseUrl", { length: 255 }),
  apiKey: varchar("apiKey", { length: 512 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").onUpdateNow().defaultNow().notNull(),
});

export const bookxStudioAssets = mysqlTable("bookxStudioAssets", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  type: mysqlEnum("type", ["music", "sound-effect", "recording"]).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
  durationMs: int("durationMs").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const bookxTimelineClips = mysqlTable("bookxTimelineClips", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  assetId: varchar("assetId", { length: 32 }),
  segmentId: varchar("segmentId", { length: 32 }),
  trackType: mysqlEnum("trackType", ["narration", "music", "sound-effect"]).notNull(),
  startMs: int("startMs").notNull().default(0),
  durationMs: int("durationMs").notNull().default(0),
  volume: int("volume").notNull().default(80),
  fadeInMs: int("fadeInMs").notNull().default(0),
  fadeOutMs: int("fadeOutMs").notNull().default(0),
  duckUnderNarration: int("duckUnderNarration").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type BookxProject = typeof bookxProjects.$inferSelect;
export type InsertBookxProject = typeof bookxProjects.$inferInsert;
