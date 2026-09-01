import { hostname } from "node:os";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  bookxChapters,
  bookxCharacters,
  bookxGenerationJobs,
  bookxProjects,
  bookxSegments,
  type GenerationJobDetail,
} from "../drizzle/schema";
import { getDb } from "./db";
import { auditSegments, planNarrationRun, type PlannableSegment } from "./narrationPlan";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  backoffDelayMs,
  classifyThrownFailure,
  type FailureClassification,
} from "./narrationRetry";
import type { ProviderId } from "./providerRouting";
import { availableProviders } from "./providerCredentials";
import { hashSegmentText, segmentProse } from "./textSegmentation";
import { renderSegmentAudio } from "./ttsRender";
import { textLimitForModel } from "../shared/narration";

/**
 * The durable narration worker.
 *
 * Runs in-process and survives interruption by writing a checkpoint after every
 * single segment. Nothing about the run lives only in memory: if the process dies
 * mid-book, the next start reads the job row, sees where it stopped, and picks up
 * just before that point.
 *
 * Three invariants hold throughout:
 *
 * 1. **One runner per job.** A lease, taken with a conditional UPDATE, stops two
 *    workers rendering the same book and doubling its audio.
 * 2. **A segment is written or it is not.** Audio is verified before storage and
 *    the segment row is only updated after the write succeeds, so a crash can never
 *    leave a half-written segment marked as done.
 * 3. **The voice never drifts.** The provider and model are pinned when the run
 *    starts and every retry uses them, so an outage cannot silently re-voice the
 *    back half of a book.
 */

const WORKER_ID = `${hostname()}-${process.pid}-${nanoid(6)}`;

/** How long a claim is held before another worker may take over. */
const LEASE_MS = 90_000;
/** Pause between segments; keeps a long run from tripping provider rate limits. */
const SEGMENT_GAP_MS = 120;
/** Cap on stored failure/event entries so a long book cannot bloat the row. */
const MAX_DETAIL_ENTRIES = 50;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** In-flight runs in this process, so pause/cancel can abort the current request. */
const activeRuns = new Map<string, AbortController>();

export const isRunLocal = (jobId: string): boolean => activeRuns.has(jobId);

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

/** `affectedRows` from a drizzle mysql2 write, used for conditional updates. */
function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

const nowPlus = (ms: number) => new Date(Date.now() + ms);

function appendCapped<T>(existing: T[] | undefined, entry: T): T[] {
  const next = [...(existing ?? []), entry];
  return next.length > MAX_DETAIL_ENTRIES ? next.slice(next.length - MAX_DETAIL_ENTRIES) : next;
}

// ---------------------------------------------------------------------------
// Segment preparation
// ---------------------------------------------------------------------------

/**
 * Ensures every chapter in scope has segments to render.
 *
 * A chapter body is split into units sized for the target model. Existing segments
 * are left alone when they already match the split, because replacing them would
 * throw away valid audio; they are rebuilt only when the text genuinely changed.
 */
export async function ensureChapterSegments(input: {
  projectId: string;
  chapterIds?: string[];
  model: string;
}): Promise<{ created: number; rebuiltChapters: string[] }> {
  const db = await requireDb();
  const limit = textLimitForModel(input.model);

  const chapters = await db.select().from(bookxChapters).where(eq(bookxChapters.projectId, input.projectId));
  const scoped = input.chapterIds?.length ? chapters.filter(chapter => input.chapterIds!.includes(chapter.id)) : chapters;

  let created = 0;
  const rebuiltChapters: string[] = [];

  for (const chapter of scoped) {
    const desired = segmentProse(chapter.body || "", { maxChars: limit });
    if (!desired.length) continue;

    const existing = await db
      .select()
      .from(bookxSegments)
      .where(eq(bookxSegments.chapterId, chapter.id))
      .orderBy(bookxSegments.orderIndex);

    // The split already matches, so keep the rows (and their audio) as they are.
    const matches =
      existing.length === desired.length &&
      existing.every((segment, index) => segment.text === desired[index]);
    if (matches) {
      await db
        .update(bookxChapters)
        .set({ totalSegments: desired.length, updatedAt: new Date() })
        .where(eq(bookxChapters.id, chapter.id));
      continue;
    }

    // The manuscript changed. Rebuild the chapter's segments, carrying audio
    // across for any unit whose text is unchanged so a small edit does not force
    // a full re-render of the chapter.
    const audioByText = new Map(
      existing
        .filter(segment => segment.audioStorageKey)
        .map(segment => [segment.text, segment] as const),
    );

    await db.delete(bookxSegments).where(eq(bookxSegments.chapterId, chapter.id));

    await db.insert(bookxSegments).values(desired.map((text, index) => {
      const carried = audioByText.get(text);
      return {
        id: nanoid(),
        chapterId: chapter.id,
        characterId: carried?.characterId ?? null,
        text,
        orderIndex: index,
        audioStorageKey: carried?.audioStorageKey ?? null,
        textHash: carried?.audioStorageKey ? hashSegmentText(text) : null,
        voiceProvider: carried?.voiceProvider ?? null,
        voiceModel: carried?.voiceModel ?? null,
        voiceId: carried?.voiceId ?? null,
        audioMimeType: carried?.audioMimeType ?? null,
        audioBytes: carried?.audioBytes ?? null,
        audioDurationMs: carried?.audioDurationMs ?? null,
        renderedAt: carried?.renderedAt ?? null,
      };
    }));

    created += desired.length;
    rebuiltChapters.push(chapter.id);

    await db
      .update(bookxChapters)
      .set({ totalSegments: desired.length, updatedAt: new Date() })
      .where(eq(bookxChapters.id, chapter.id));
  }

  return { created, rebuiltChapters };
}

/** Loads the segments in scope, joined to the voice their character requires. */
export async function loadPlannableSegments(projectId: string, chapterIds?: string[]): Promise<PlannableSegment[]> {
  const db = await requireDb();

  const chapters = await db.select().from(bookxChapters).where(eq(bookxChapters.projectId, projectId));
  const scoped = chapterIds?.length ? chapters.filter(chapter => chapterIds.includes(chapter.id)) : chapters;
  if (!scoped.length) return [];

  const chapterOrder = new Map(scoped.map(chapter => [chapter.id, chapter.orderIndex]));
  const characters = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, projectId));
  const voiceByCharacter = new Map(characters.map(character => [character.id, character.voiceId]));

  const rows = await db
    .select()
    .from(bookxSegments)
    .where(inArray(bookxSegments.chapterId, scoped.map(chapter => chapter.id)));

  return rows.map(row => ({
    id: row.id,
    chapterId: row.chapterId,
    orderIndex: row.orderIndex,
    chapterOrderIndex: chapterOrder.get(row.chapterId) ?? 0,
    text: row.text,
    textHash: row.textHash,
    audioStorageKey: row.audioStorageKey,
    voiceProvider: row.voiceProvider,
    voiceModel: row.voiceModel,
    voiceId: row.voiceId,
    targetVoiceId: (row.characterId ? voiceByCharacter.get(row.characterId) : null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export type StartRunInput = {
  projectId: string;
  ownerId: number;
  chapterIds?: string[];
  /** Re-render segments that already have valid audio. */
  force?: boolean;
  /** How many valid segments before the interruption point to redo on resume. */
  rewindSegments?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  stallTimeoutMs?: number;
};

/**
 * Creates or reuses a job for a project and starts it.
 *
 * A project has at most one live job. Asking again while one is running returns
 * the existing job rather than starting a second, which is what stops a
 * double-click from rendering everything twice.
 */
export async function startNarrationRun(input: StartRunInput): Promise<{ jobId: string; resumed: boolean }> {
  const db = await requireDb();

  const [project] = await db
    .select()
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const provider = project.voiceProvider as ProviderId;
  const available = await availableProviders(input.ownerId);
  if (!available.includes(provider)) {
    throw new Error(
      `${provider} is not configured, so narration cannot start. Connect it in Settings, or pick a connected provider for this project.`,
    );
  }

  const model = project.voiceModel;
  await ensureChapterSegments({ projectId: input.projectId, chapterIds: input.chapterIds, model });

  // Reuse a live job for this project instead of creating a rival one.
  const live = await db
    .select()
    .from(bookxGenerationJobs)
    .where(
      and(
        eq(bookxGenerationJobs.projectId, input.projectId),
        inArray(bookxGenerationJobs.status, ["queued", "running", "paused"]),
      ),
    )
    .orderBy(bookxGenerationJobs.createdAt);

  const existing = live[live.length - 1];
  if (existing) {
    await db
      .update(bookxGenerationJobs)
      .set({
        status: "queued",
        pauseRequested: 0,
        cancelRequested: 0,
        rewindSegments: input.rewindSegments ?? existing.rewindSegments,
        updatedAt: new Date(),
      })
      .where(eq(bookxGenerationJobs.id, existing.id));

    void driveJob(existing.id, input).catch(error => {
      console.error("[Narration] Run failed to start:", error);
    });
    return { jobId: existing.id, resumed: true };
  }

  const jobId = nanoid();
  await db.insert(bookxGenerationJobs).values({
    id: jobId,
    projectId: input.projectId,
    scope: input.chapterIds?.length ? "chapter" : "project",
    status: "queued",
    provider,
    model,
    rewindSegments: input.rewindSegments ?? 1,
    detail: {
      chapterIds: input.chapterIds,
      pinnedVoice: { provider, model },
      events: [{ at: new Date().toISOString(), kind: "queued", message: `Queued with ${provider} · ${model}` }],
    } satisfies GenerationJobDetail,
  });

  void driveJob(jobId, input).catch(error => {
    console.error("[Narration] Run failed to start:", error);
  });
  return { jobId, resumed: false };
}

/** Asks a run to stop at the next segment boundary, keeping everything rendered. */
export async function requestPause(jobId: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(bookxGenerationJobs)
    .set({ pauseRequested: 1, updatedAt: new Date() })
    .where(eq(bookxGenerationJobs.id, jobId));
  // Abort the in-flight request too, so a pause during a slow call is immediate.
  activeRuns.get(jobId)?.abort();
}

export async function requestCancel(jobId: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(bookxGenerationJobs)
    .set({ cancelRequested: 1, updatedAt: new Date() })
    .where(eq(bookxGenerationJobs.id, jobId));
  activeRuns.get(jobId)?.abort();
}

/**
 * Takes the lease for a job.
 *
 * The `WHERE` clause is the whole point: only a job with no owner or an expired
 * lease can be claimed, and MySQL decides the winner, so two processes racing to
 * resume the same book cannot both proceed.
 */
async function claimJob(db: Db, jobId: string): Promise<boolean> {
  const result = await db
    .update(bookxGenerationJobs)
    .set({
      leaseOwner: WORKER_ID,
      leaseExpiresAt: nowPlus(LEASE_MS),
      heartbeatAt: new Date(),
      status: "running",
      startedAt: sql`COALESCE(${bookxGenerationJobs.startedAt}, NOW())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bookxGenerationJobs.id, jobId),
        inArray(bookxGenerationJobs.status, ["queued", "running", "paused"]),
        or(
          isNull(bookxGenerationJobs.leaseOwner),
          eq(bookxGenerationJobs.leaseOwner, WORKER_ID),
          lt(bookxGenerationJobs.leaseExpiresAt, new Date()),
        ),
      ),
    );

  return affectedRows(result) > 0;
}

async function releaseLease(db: Db, jobId: string): Promise<void> {
  await db
    .update(bookxGenerationJobs)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(bookxGenerationJobs.id, jobId), eq(bookxGenerationJobs.leaseOwner, WORKER_ID)));
}

/** Recomputes a chapter's rendered count from its segments. */
async function rollUpChapter(db: Db, chapterId: string): Promise<void> {
  const segments = await db
    .select({ id: bookxSegments.id, audioStorageKey: bookxSegments.audioStorageKey })
    .from(bookxSegments)
    .where(eq(bookxSegments.chapterId, chapterId));

  await db
    .update(bookxChapters)
    .set({
      totalSegments: segments.length,
      generatedSegments: segments.filter(segment => segment.audioStorageKey).length,
      updatedAt: new Date(),
    })
    .where(eq(bookxChapters.id, chapterId));
}

type StopReason = "paused" | "cancelled" | null;

/** Reads the control flags. One small query per segment; segments take seconds. */
async function readStopRequest(db: Db, jobId: string): Promise<StopReason> {
  const [row] = await db
    .select({
      pauseRequested: bookxGenerationJobs.pauseRequested,
      cancelRequested: bookxGenerationJobs.cancelRequested,
      leaseOwner: bookxGenerationJobs.leaseOwner,
    })
    .from(bookxGenerationJobs)
    .where(eq(bookxGenerationJobs.id, jobId))
    .limit(1);

  if (!row) return "cancelled";
  if (row.cancelRequested) return "cancelled";
  if (row.pauseRequested) return "paused";
  // Another worker took the lease; stand down rather than render in parallel.
  if (row.leaseOwner && row.leaseOwner !== WORKER_ID) return "paused";
  return null;
}

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------

/**
 * Renders one segment with bounded retries against the pinned voice.
 *
 * Retry decisions come from `classifyThrownFailure`, so a rate limit or a stalled
 * stream waits and tries again while a credential problem stops immediately
 * instead of burning the budget on every remaining segment.
 */
async function renderWithRetries(input: {
  db: Db;
  jobId: string;
  projectId: string;
  ownerId: number;
  segment: PlannableSegment;
  provider: ProviderId;
  model: string;
  language?: string | null;
  maxAttempts: number;
  requestTimeoutMs: number;
  stallTimeoutMs: number;
  controller: AbortController;
  onEvent: (kind: string, message: string) => Promise<void>;
}): Promise<{ ok: true; bytes: number; durationMs: number } | { ok: false; classification: FailureClassification; fatal: boolean }> {
  const { db, segment } = input;
  let lastClassification: FailureClassification = { kind: "unknown", retryable: false, message: "Not attempted" };

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    if (input.controller.signal.aborted) {
      return { ok: false, classification: { kind: "unknown", retryable: true, message: "Run stopped" }, fatal: false };
    }

    try {
      const result = await renderSegmentAudio({
        projectId: input.projectId,
        segmentId: segment.id,
        provider: input.provider,
        model: input.model,
        voiceId: segment.targetVoiceId,
        text: segment.text,
        language: input.language,
        ownerId: input.ownerId,
        requestTimeoutMs: input.requestTimeoutMs,
        stallTimeoutMs: input.stallTimeoutMs,
        signal: input.controller.signal,
      });

      // Only now is the segment considered done. Recording the text hash and the
      // voice alongside the key is what lets a later run prove this audio is still
      // the right audio.
      await db
        .update(bookxSegments)
        .set({
          audioStorageKey: result.storageKey,
          textHash: hashSegmentText(segment.text),
          voiceProvider: input.provider,
          voiceModel: input.model,
          voiceId: segment.targetVoiceId ?? null,
          audioMimeType: result.inspection.mimeType,
          audioBytes: result.inspection.bytes,
          audioDurationMs: result.inspection.durationMs ?? null,
          renderAttempts: attempt,
          lastError: null,
          renderedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bookxSegments.id, segment.id));

      if (attempt > 1) {
        await input.onEvent("recovered", `Segment recovered on attempt ${attempt}`);
      }
      return { ok: true, bytes: result.inspection.bytes, durationMs: result.inspection.durationMs ?? 0 };
    } catch (error) {
      // `renderSegmentAudio` attaches a classification for HTTP failures.
      // A pause or cancel aborts the in-flight request, which surfaces here as a
      // timeout. Bail out immediately rather than waiting out a backoff delay for a
      // retry the caller is about to abandon anyway.
      if (input.controller.signal.aborted) {
        return { ok: false, classification: { kind: "unknown", retryable: true, message: "Run stopped" }, fatal: false };
      }

      const attached = (error as { classification?: FailureClassification }).classification;
      const classification = attached ?? classifyThrownFailure(error);
      lastClassification = classification;

      await db
        .update(bookxSegments)
        .set({ renderAttempts: attempt, lastError: classification.message.slice(0, 500), updatedAt: new Date() })
        .where(eq(bookxSegments.id, segment.id));

      // A credential or configuration failure will repeat for every segment.
      if (classification.kind === "auth") {
        return { ok: false, classification, fatal: true };
      }
      if (!classification.retryable || attempt === input.maxAttempts) {
        return { ok: false, classification, fatal: false };
      }

      const delay = backoffDelayMs(attempt, classification.retryAfterMs);
      await input.onEvent(
        classification.kind,
        `${classification.message} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1} of ${input.maxAttempts})`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { ok: false, classification: lastClassification, fatal: false };
}

/**
 * Claims a job and renders its pending segments, checkpointing as it goes.
 *
 * Exits cleanly on pause, cancel, a fatal configuration error, or completion. Any
 * other exit (a crash, a killed process) leaves the lease to expire, at which point
 * the job is resumable with everything rendered so far intact.
 */
async function driveJob(jobId: string, options: StartRunInput): Promise<void> {
  const db = await requireDb();

  if (activeRuns.has(jobId)) return; // Already running in this process.
  if (!(await claimJob(db, jobId))) return; // Another worker owns it.

  const controller = new AbortController();
  activeRuns.set(jobId, controller);

  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  const recordEvent = async (kind: string, message: string) => {
    const [row] = await db
      .select({ detail: bookxGenerationJobs.detail })
      .from(bookxGenerationJobs)
      .where(eq(bookxGenerationJobs.id, jobId))
      .limit(1);
    const detail = (row?.detail ?? {}) as GenerationJobDetail;
    await db
      .update(bookxGenerationJobs)
      .set({
        detail: { ...detail, events: appendCapped(detail.events, { at: new Date().toISOString(), kind, message }) },
        updatedAt: new Date(),
      })
      .where(eq(bookxGenerationJobs.id, jobId));
  };

  try {
    const [job] = await db.select().from(bookxGenerationJobs).where(eq(bookxGenerationJobs.id, jobId)).limit(1);
    if (!job) return;

    const [project] = await db.select().from(bookxProjects).where(eq(bookxProjects.id, job.projectId)).limit(1);
    if (!project) throw new Error("Project not found");

    // Pinned when the job was created, so a resume renders in the same voice even
    // if the project has been edited since.
    const provider = (job.provider || project.voiceProvider) as ProviderId;
    const model = job.model || project.voiceModel;
    const chapterIds = (job.detail as GenerationJobDetail | null)?.chapterIds ?? options.chapterIds;

    const segments = await loadPlannableSegments(job.projectId, chapterIds);
    const plan = planNarrationRun({
      segments,
      pinned: { provider, model },
      cursorSegmentId: job.cursorSegmentId,
      rewindSegments: job.rewindSegments,
      force: options.force,
      chapterIds,
    });

    if (!plan.totalSegments) {
      await db
        .update(bookxGenerationJobs)
        .set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(bookxGenerationJobs.id, jobId));
      await recordEvent("empty", "No narration segments exist yet. Add chapter text first.");
      return;
    }

    await db
      .update(bookxGenerationJobs)
      .set({
        totalSegments: plan.totalSegments,
        skippedSegments: plan.reusable.length,
        completedSegments: plan.reusable.length,
        failedSegments: 0,
        updatedAt: new Date(),
      })
      .where(eq(bookxGenerationJobs.id, jobId));
    await recordEvent("plan", plan.note);

    let completed = plan.reusable.length;
    let failed = 0;
    let renderedBytes = 0;
    let renderedDurationMs = 0;
    let currentChapter: string | null = null;
    const touchedChapters = new Set<string>();

    for (const [position, segment] of plan.pending.entries()) {
      const stop = await readStopRequest(db, jobId);
      if (stop) {
        await db
          .update(bookxGenerationJobs)
          .set({
            status: stop,
            pauseRequested: 0,
            cancelRequested: 0,
            finishedAt: stop === "cancelled" ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(bookxGenerationJobs.id, jobId));
        await recordEvent(stop, stop === "paused"
          ? `Paused after ${completed} of ${plan.totalSegments} segments. Everything rendered so far is kept.`
          : `Cancelled after ${completed} of ${plan.totalSegments} segments.`);
        return;
      }

      if (currentChapter && currentChapter !== segment.chapterId) {
        await rollUpChapter(db, currentChapter);
      }
      currentChapter = segment.chapterId;
      touchedChapters.add(segment.chapterId);

      // Record the cursor *before* rendering. If the process dies during this
      // segment, the resume knows exactly which one was in flight and rewinds
      // from there rather than guessing.
      const orderedIndex = plan.ordered.findIndex(candidate => candidate.id === segment.id);
      await db
        .update(bookxGenerationJobs)
        .set({
          cursorSegmentId: segment.id,
          cursorIndex: orderedIndex >= 0 ? orderedIndex : position,
          leaseExpiresAt: nowPlus(LEASE_MS),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bookxGenerationJobs.id, jobId));

      const result = await renderWithRetries({
        db,
        jobId,
        projectId: job.projectId,
        ownerId: project.ownerId,
        segment,
        provider,
        model,
        language: project.language,
        maxAttempts,
        requestTimeoutMs,
        stallTimeoutMs,
        controller,
        onEvent: recordEvent,
      });

      if (result.ok) {
        completed++;
        renderedBytes += result.bytes;
        renderedDurationMs += result.durationMs;
      } else if (controller.signal.aborted) {
        // Stopped by a pause/cancel mid-request; the loop head handles the state.
        continue;
      } else {
        failed++;
        const [row] = await db
          .select({ detail: bookxGenerationJobs.detail })
          .from(bookxGenerationJobs)
          .where(eq(bookxGenerationJobs.id, jobId))
          .limit(1);
        const detail = (row?.detail ?? {}) as GenerationJobDetail;
        await db
          .update(bookxGenerationJobs)
          .set({
            detail: {
              ...detail,
              failures: appendCapped(detail.failures, {
                segmentId: segment.id,
                chapterId: segment.chapterId,
                message: result.classification.message.slice(0, 300),
                at: new Date().toISOString(),
              }),
            },
            updatedAt: new Date(),
          })
          .where(eq(bookxGenerationJobs.id, jobId));

        if (result.fatal) {
          await db
            .update(bookxGenerationJobs)
            .set({
              status: "failed",
              completedSegments: completed,
              failedSegments: failed,
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(bookxGenerationJobs.id, jobId));
          await recordEvent("fatal", `Stopped: ${result.classification.message}`);
          return;
        }
      }

      // Checkpoint. This is the write that makes the run resumable.
      await db
        .update(bookxGenerationJobs)
        .set({
          completedSegments: completed,
          failedSegments: failed,
          renderedBytes: sql`${bookxGenerationJobs.renderedBytes} + ${result.ok ? result.bytes : 0}`,
          renderedDurationMs: sql`${bookxGenerationJobs.renderedDurationMs} + ${result.ok ? result.durationMs : 0}`,
          leaseExpiresAt: nowPlus(LEASE_MS),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bookxGenerationJobs.id, jobId));

      if (SEGMENT_GAP_MS > 0) await new Promise(resolve => setTimeout(resolve, SEGMENT_GAP_MS));
    }

    for (const chapterId of touchedChapters) await rollUpChapter(db, chapterId);

    const finalStatus = failed > 0 ? "failed" : "completed";
    await db
      .update(bookxGenerationJobs)
      .set({
        status: finalStatus,
        completedSegments: completed,
        failedSegments: failed,
        cursorSegmentId: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bookxGenerationJobs.id, jobId));

    await recordEvent(
      finalStatus,
      failed > 0
        ? `Finished with ${failed} segment(s) still unrendered. Retry them without redoing the rest.`
        : `All ${completed} segments rendered.`,
    );

    if (finalStatus === "completed") {
      await db
        .update(bookxProjects)
        .set({ status: "review", updatedAt: new Date() })
        .where(eq(bookxProjects.id, job.projectId));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Narration run failed";
    console.error("[Narration] Run error:", error);
    await db
      .update(bookxGenerationJobs)
      .set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookxGenerationJobs.id, jobId))
      .catch(() => {});
    await recordEvent("error", message).catch(() => {});
  } finally {
    activeRuns.delete(jobId);
    await releaseLease(db, jobId).catch(() => {});
  }
}

/**
 * Re-queues jobs whose worker vanished.
 *
 * Called on boot. A job left `running` with an expired lease is exactly the
 * "the process died halfway through my book" case: it is put back to `queued` so it
 * can be resumed, and the rewind on resume covers the segment that was in flight.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const stale = await db
    .select({ id: bookxGenerationJobs.id, projectId: bookxGenerationJobs.projectId })
    .from(bookxGenerationJobs)
    .where(
      and(
        eq(bookxGenerationJobs.status, "running"),
        or(isNull(bookxGenerationJobs.leaseExpiresAt), lt(bookxGenerationJobs.leaseExpiresAt, new Date())),
      ),
    );

  for (const job of stale) {
    await db
      .update(bookxGenerationJobs)
      .set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(bookxGenerationJobs.id, job.id));
  }

  if (stale.length) {
    console.log(`[Narration] ${stale.length} interrupted run(s) marked resumable`);
  }
  return stale.length;
}

/** Resumes a paused or interrupted job. */
export async function resumeNarrationRun(input: { jobId: string; ownerId: number }): Promise<void> {
  const db = await requireDb();
  const [job] = await db.select().from(bookxGenerationJobs).where(eq(bookxGenerationJobs.id, input.jobId)).limit(1);
  if (!job) throw new Error("Job not found");

  const [project] = await db
    .select({ id: bookxProjects.id })
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, job.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Job not found");

  await db
    .update(bookxGenerationJobs)
    .set({ status: "queued", pauseRequested: 0, cancelRequested: 0, finishedAt: null, updatedAt: new Date() })
    .where(eq(bookxGenerationJobs.id, input.jobId));

  void driveJob(input.jobId, { projectId: job.projectId, ownerId: input.ownerId }).catch(error => {
    console.error("[Narration] Resume failed:", error);
  });
}

/**
 * Clears the audio of failed segments so the next run retries just those.
 *
 * Nothing that rendered successfully is touched, which is the point: one bad
 * paragraph should not cost a re-render of the book.
 */
export async function retryFailedSegments(input: { projectId: string; ownerId: number }): Promise<number> {
  const db = await requireDb();
  const [project] = await db
    .select({ id: bookxProjects.id })
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const chapters = await db
    .select({ id: bookxChapters.id })
    .from(bookxChapters)
    .where(eq(bookxChapters.projectId, input.projectId));
  if (!chapters.length) return 0;

  const result = await db
    .update(bookxSegments)
    .set({ renderAttempts: 0, lastError: null, updatedAt: new Date() })
    .where(and(inArray(bookxSegments.chapterId, chapters.map(chapter => chapter.id)), isNull(bookxSegments.audioStorageKey)));

  return affectedRows(result);
}

/** Audits a project's rendered audio against its current text and voice. */
export async function auditProjectAudio(input: { projectId: string; ownerId: number }) {
  const db = await requireDb();
  const [project] = await db
    .select()
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const segments = await loadPlannableSegments(input.projectId);
  const chapters = await db
    .select({ id: bookxChapters.id })
    .from(bookxChapters)
    .where(eq(bookxChapters.projectId, input.projectId));

  const durations = new Map<string, number | null>();
  if (chapters.length) {
    const rows = await db
      .select({ id: bookxSegments.id, audioDurationMs: bookxSegments.audioDurationMs, audioStorageKey: bookxSegments.audioStorageKey })
      .from(bookxSegments)
      .where(inArray(bookxSegments.chapterId, chapters.map(chapter => chapter.id)));
    for (const row of rows) {
      // `null` marks "audio present but never measured", which the audit surfaces
      // as suspect rather than counting as good.
      durations.set(row.id, row.audioStorageKey ? row.audioDurationMs ?? null : 0);
    }
  }

  return auditSegments(segments, { provider: project.voiceProvider, model: project.voiceModel }, durations);
}
