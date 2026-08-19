import { int, json, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

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

export const bookxGenerationJobs = mysqlTable("bookxGenerationJobs", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  scope: mysqlEnum("scope", ["project", "chapter", "segment"]).notNull(),
  status: mysqlEnum("status", ["queued", "running", "completed", "failed", "cancelled"]).default("queued").notNull(),
  totalSegments: int("totalSegments").notNull().default(0),
  completedSegments: int("completedSegments").notNull().default(0),
  failedSegments: int("failedSegments").notNull().default(0),
  detail: json("detail").$type<{ errors?: string[]; chapterIds?: string[] }>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const bookxExports = mysqlTable("bookxExports", {
  id: varchar("id", { length: 32 }).primaryKey(),
  projectId: varchar("projectId", { length: 32 }).notNull(),
  format: mysqlEnum("format", ["ACX", "Podcast", "InAudio package"]).notNull(),
  status: mysqlEnum("status", ["queued", "ready", "failed"]).default("queued").notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
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
