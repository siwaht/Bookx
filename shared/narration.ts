/**
 * Contract shared by the narration worker and the Generate screen.
 *
 * Long-form rendering is organised around one rule: **the segment is the unit of
 * work.** A segment is rendered whole or not at all, its audio is addressed by a
 * stable id, and the text + voice that produced it are recorded alongside it. Any
 * interruption therefore costs at most one segment, and a resume can prove which
 * segments are still valid instead of guessing.
 */

export type NarrationJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** Statuses from which no further work will happen without a new request. */
export const TERMINAL_JOB_STATUSES: readonly NarrationJobStatus[] = ["completed", "failed", "cancelled"];

export const isTerminalJobStatus = (status: NarrationJobStatus): boolean =>
  TERMINAL_JOB_STATUSES.includes(status);

/**
 * Per-model input ceilings, in characters.
 *
 * These are deliberately below each vendor's documented maximum: long inputs are
 * where truncation and clipped endings show up, and a book is long enough that a
 * smaller unit costs nothing but buys much cheaper retries.
 */
export const MODEL_TEXT_LIMITS: Record<string, number> = {
  // Cloudflare Workers AI
  "@cf/deepgram/aura-2-en": 1800,
  "@cf/deepgram/aura-1-en": 1800,
  "@cf/myshell-ai/melotts": 900,
  // ElevenLabs
  eleven_multilingual_v2: 2400,
  eleven_v3: 2400,
  eleven_turbo_v2_5: 2400,
  // Deepgram direct
  "aura-2-thalia-en": 1800,
  // OpenAI
  "gpt-4o-mini-tts": 3500,
  "tts-1": 3500,
  "tts-1-hd": 3500,
};

/** Conservative ceiling for a model we have no specific figure for. */
export const DEFAULT_TEXT_LIMIT = 1200;

/**
 * Hard cap enforced by `validateNarrationRequest`. No computed limit may exceed
 * it, or the request would be rejected after segmentation had already committed.
 */
export const ABSOLUTE_TEXT_LIMIT = 4000;

export function textLimitForModel(model?: string | null): number {
  if (!model) return DEFAULT_TEXT_LIMIT;
  const exact = MODEL_TEXT_LIMITS[model];
  if (exact) return Math.min(exact, ABSOLUTE_TEXT_LIMIT);

  // Saved custom Cloudflare model names are common, so fall back to a family
  // match before giving up and using the conservative default.
  const lower = model.toLowerCase();
  if (lower.includes("melotts")) return MODEL_TEXT_LIMITS["@cf/myshell-ai/melotts"]!;
  if (lower.includes("aura")) return MODEL_TEXT_LIMITS["@cf/deepgram/aura-2-en"]!;
  if (lower.includes("eleven")) return MODEL_TEXT_LIMITS.eleven_multilingual_v2!;
  if (lower.includes("tts")) return MODEL_TEXT_LIMITS["tts-1"]!;
  return DEFAULT_TEXT_LIMIT;
}

/**
 * Identity of the voice that produced a piece of audio.
 *
 * Stored per segment and compared on resume. If the project's voice changes, every
 * segment's key stops matching and the affected audio is re-rendered rather than
 * leaving a book narrated by two different voices.
 */
export function voiceKey(input: { provider: string; model: string; voiceId?: string | null }): string {
  return `${input.provider}|${input.model}|${input.voiceId || ""}`;
}

export type SegmentProgress = {
  segmentId: string;
  chapterId: string;
  orderIndex: number;
  state: "pending" | "rendered" | "failed";
  bytes?: number;
  durationMs?: number;
  attempts: number;
  lastError?: string;
};

export type ChapterProgress = {
  chapterId: string;
  title: string;
  orderIndex: number;
  totalSegments: number;
  renderedSegments: number;
  failedSegments: number;
  durationMs: number;
};

export type NarrationProgress = {
  jobId: string | null;
  status: NarrationJobStatus | "idle";
  totalSegments: number;
  completedSegments: number;
  failedSegments: number;
  skippedSegments: number;
  /** Whole-run completion, 0-100, derived from segments rather than a timer. */
  percent: number;
  renderedDurationMs: number;
  renderedBytes: number;
  cursorIndex: number;
  cursorSegmentId: string | null;
  pinnedVoice: { provider: string; model: string; voiceId?: string } | null;
  /** True while a pause or cancel has been asked for but not yet observed. */
  stopping: boolean;
  /** Seconds since the worker last checkpointed; large values mean it stalled. */
  secondsSinceHeartbeat: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  chapters: ChapterProgress[];
  failures: Array<{ segmentId: string; chapterId: string; message: string; at: string }>;
  events: Array<{ at: string; kind: string; message: string }>;
  /** Set when a previous run left work behind and can be picked up again. */
  resumable: boolean;
};

/**
 * Result of auditing a project's rendered audio.
 *
 * This is the answer to "is my book actually intact?" — it is computed from the
 * stored hashes rather than from a progress counter, so it stays correct even if a
 * job record is lost.
 */
export type AudioAudit = {
  totalSegments: number;
  renderedSegments: number;
  /** Never rendered. */
  missingSegments: string[];
  /** Rendered, but the text has changed since. */
  staleSegments: string[];
  /** Rendered by a different voice than the project now specifies. */
  mismatchedVoiceSegments: string[];
  /** Rendered but the stored payload failed its integrity check. */
  suspectSegments: string[];
  totalDurationMs: number;
  complete: boolean;
};
