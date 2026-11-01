import { hostname } from "node:os";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  bookxChapters,
  bookxCharacters,
  bookxGenerationJobs,
  bookxProjects,
  bookxPronunciations,
  bookxSegments,
  bookxSoundCues,
  type GenerationJobDetail,
  type SegmentDelivery,
} from "../drizzle/schema";
import { forEachChunk, getDb, insertMany, projectChapterIds } from "./db";
import { auditSegments, planNarrationRun, type PlannableSegment } from "./narrationPlan";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  FATAL_FAILURE_KINDS,
  backoffDelayMs,
  classifyThrownFailure,
  type FailureClassification,
} from "./narrationRetry";
import type { ProviderId } from "./providerRouting";
import { availableProviders } from "./providerCredentials";
import { hashSegmentText, segmentChapter, type SegmentUnit } from "./textSegmentation";
import { attributeSpeakersHeuristically, type CastMember } from "./speakerAttribution";
import { renderSegmentAudio } from "./ttsRender";
import { providerConcurrency } from "./providerSlots";
import { textLimitForModel } from "../shared/narration";
import { applyPronunciationRules, pronunciationHash, type PronunciationRule } from "./pronunciation";
import { chapterDirectionSpecs, directionFor, directionHashFor } from "./direction";
import type { SegmentDirectionSpec, VoiceSettings } from "../shared/direction";

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
/** How often this process looks for runs whose worker went away. */
const RECOVERY_SWEEP_MS = 15_000;
/** A queued run nobody claimed within this long is treated as abandoned. */
const UNCLAIMED_GRACE_MS = 20_000;
/** Automatic resumes allowed without the run getting any further. */
const MAX_RECOVERIES_WITHOUT_PROGRESS = 3;
/** Runs interrupted longer ago than this are paused for the creator, not resumed unasked. */
const AUTO_RESUME_WITHIN_MS = 24 * 60 * 60_000;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** In-flight runs in this process, so pause/cancel can abort the current request. */
const activeRuns = new Map<string, AbortController>();

export const isRunLocal = (jobId: string): boolean => activeRuns.has(jobId);

/** Narration runs executing in this process, so the host is not stopped mid-way. */
export const narrationRunsInProgress = (): number => activeRuns.size;

/** Set as the process exits, so nothing new is claimed on its way out. */
let shuttingDown = false;

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

const nowPlus = (ms: number) => new Date(Date.now() + ms);

function appendCapped<T>(existing: T[] | undefined, entry: T): T[] {
  const next = [...(existing ?? []), entry];
  return next.length > MAX_DETAIL_ENTRIES ? next.slice(next.length - MAX_DETAIL_ENTRIES) : next;
}

/**
 * Lines one run renders at once. The account-wide cap in `providerSlots`
 * still bounds the total across books. `NARRATION_RUN_CONCURRENCY=1` restores
 * strictly one line at a time.
 */
function runConcurrency(): number {
  const configured = Number(process.env.NARRATION_RUN_CONCURRENCY);
  return Number.isInteger(configured) && configured >= 1 ? Math.min(8, configured) : 3;
}

/** Pending read-modify-write of each job's `detail`, so parallel lanes cannot drop each other's entries. */
const detailWrites = new Map<string, Promise<void>>();

async function withDetailLock(jobId: string, work: () => Promise<void>): Promise<void> {
  const previous = detailWrites.get(jobId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  const settled = current.catch(() => undefined);
  detailWrites.set(jobId, settled);
  try {
    await current;
  } finally {
    if (detailWrites.get(jobId) === settled) detailWrites.delete(jobId);
  }
}

/** Adds an entry to a job's event log, keeping the log bounded. */
async function appendEvent(db: Db, jobId: string, kind: string, message: string): Promise<void> {
  await withDetailLock(jobId, async () => {
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
  });
}

// ---------------------------------------------------------------------------
// Segment preparation
// ---------------------------------------------------------------------------

/**
 * Chapters that are part of the audiobook.
 *
 * Excluded chapters (front matter, anything the creator switched off) keep their
 * text and any audio they already have, but narration, the audit and export all
 * behave as if they were not there.
 */
export async function includedChapters(db: Db, projectId: string) {
  return db
    .select()
    .from(bookxChapters)
    .where(and(eq(bookxChapters.projectId, projectId), eq(bookxChapters.included, 1)))
    .orderBy(bookxChapters.orderIndex);
}

/** Layout hints for a unit, keeping performance fields a creator or analysis set. */
function deliveryFor(unit: SegmentUnit, previous?: SegmentDelivery | null): SegmentDelivery {
  const delivery: SegmentDelivery = {
    ...(previous?.pace ? { pace: previous.pace } : {}),
    ...(previous?.tags?.length ? { tags: previous.tags } : {}),
    ...(previous?.speakerSource ? { speakerSource: previous.speakerSource } : {}),
    kind: unit.kind,
    paragraph: unit.paragraph,
    pauseMs: unit.pauseMs,
  };
  if (unit.sceneBreakBefore) delivery.sceneBreakBefore = true;
  if (unit.continuesQuote) delivery.continuesQuote = true;
  return delivery;
}

const sameDelivery = (left: SegmentDelivery | null | undefined, right: SegmentDelivery) =>
  JSON.stringify(left ?? {}) === JSON.stringify(right);

/** Pops the first queued entry for a text, so duplicate lines each keep their own. */
function takeQueued<T>(map: Map<string, T[]>, key: string): T | undefined {
  const queue = map.get(key);
  if (!queue?.length) return undefined;
  return queue.shift();
}

function enqueue<T>(map: Map<string, T[]>, key: string, value: T) {
  const queue = map.get(key) ?? [];
  queue.push(value);
  map.set(key, queue);
}

/**
 * Ensures every chapter in scope has segments to render.
 *
 * A chapter body is split into units sized for the target model; for a
 * multi-voice project, quoted speech becomes its own unit so a character can
 * voice it. Existing segments are left alone when they already match the split,
 * because replacing them would throw away valid audio; they are rebuilt only when
 * the text genuinely changed, and even then audio, speakers and sound cues are
 * carried over for every unit whose text is unchanged.
 */
export async function ensureChapterSegments(input: {
  projectId: string;
  chapterIds?: string[];
  model: string;
}): Promise<{ created: number; rebuiltChapters: string[] }> {
  const db = await requireDb();
  const limit = textLimitForModel(input.model);

  const [project] = await db
    .select({ narrationStyle: bookxProjects.narrationStyle, kind: bookxProjects.kind })
    .from(bookxProjects)
    .where(eq(bookxProjects.id, input.projectId))
    .limit(1);

  // A listener hears the chapter's name between chapters, so the title is
  // narrated — from the title itself. Keeping a second copy of it at the top of
  // the body is what made every chapter show its own title twice, once as its
  // name and once as text. A podcast's chapter names ("Segment 1") are labels
  // rather than lines to read aloud.
  const announceTitles = (project?.kind ?? "audiobook") === "audiobook";
  const splitDialogue = (project?.narrationStyle ?? "single") !== "single";

  const chapters = await includedChapters(db, input.projectId);
  const scoped = input.chapterIds?.length ? chapters.filter(chapter => input.chapterIds!.includes(chapter.id)) : chapters;

  let cast: CastMember[] | null = null;
  const loadCast = async () => {
    cast ??= (await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId)))
      .map(character => ({ id: character.id, name: character.name, aliases: character.aliases, gender: character.gender, isNarrator: character.isNarrator }));
    return cast;
  };

  let created = 0;
  const rebuiltChapters: string[] = [];

  for (const chapter of scoped) {
    const spokenText = [announceTitles ? chapter.title.trim() : "", chapter.body || ""].filter(Boolean).join("\n\n");
    const units = segmentChapter(spokenText, { maxChars: limit, splitDialogue });
    const existing = await db
      .select()
      .from(bookxSegments)
      .where(eq(bookxSegments.chapterId, chapter.id))
      .orderBy(bookxSegments.orderIndex);

    if (!units.length) {
      // The chapter's text was removed, so its segments narrate text that no
      // longer exists. Leaving them in place used to keep narrating it.
      if (existing.length) {
        await db.delete(bookxSegments).where(eq(bookxSegments.chapterId, chapter.id));
        await db.delete(bookxSoundCues).where(eq(bookxSoundCues.chapterId, chapter.id));
        rebuiltChapters.push(chapter.id);
      }
      await db
        .update(bookxChapters)
        .set({ totalSegments: 0, generatedSegments: 0, updatedAt: new Date() })
        .where(eq(bookxChapters.id, chapter.id));
      continue;
    }

    // The split already matches, so keep the rows (and their audio) as they are,
    // refreshing only the layout hints.
    const matches =
      existing.length === units.length &&
      existing.every((segment, index) => segment.text === units[index]!.text);
    if (matches) {
      for (const [index, segment] of existing.entries()) {
        const delivery = deliveryFor(units[index]!, segment.delivery);
        if (!sameDelivery(segment.delivery, delivery)) {
          await db.update(bookxSegments).set({ delivery }).where(eq(bookxSegments.id, segment.id));
        }
      }
      await db
        .update(bookxChapters)
        .set({ totalSegments: units.length, updatedAt: new Date() })
        .where(eq(bookxChapters.id, chapter.id));
      continue;
    }

    // The manuscript changed. Rebuild, carrying audio and speakers across for any
    // unit whose text is unchanged so a small edit does not force a full
    // re-render or lose the creator's casting of a line.
    const audioByText = new Map<string, Array<(typeof existing)[number]>>();
    const speakerByText = new Map<string, Array<{ characterId: string | null; speakerSource?: SegmentDelivery["speakerSource"] }>>();
    for (const segment of existing) {
      if (segment.audioStorageKey) enqueue(audioByText, segment.text, segment);
      if (segment.characterId || segment.delivery?.speakerSource) {
        enqueue(speakerByText, segment.text, { characterId: segment.characterId, speakerSource: segment.delivery?.speakerSource });
      }
    }

    const rows = units.map((unit, index) => {
      const carried = takeQueued(audioByText, unit.text);
      const speaker = takeQueued(speakerByText, unit.text);
      const delivery = deliveryFor(unit);
      if (speaker?.speakerSource) delivery.speakerSource = speaker.speakerSource;
      return {
        id: nanoid(),
        chapterId: chapter.id,
        characterId: speaker?.characterId ?? null,
        text: unit.text,
        orderIndex: index,
        delivery,
        audioStorageKey: carried?.audioStorageKey ?? null,
        textHash: carried?.audioStorageKey ? hashSegmentText(unit.text) : null,
        // Carried with the audio: without it every kept line looked rendered
        // under different pronunciation rules and was narrated (and paid for) again.
        pronunciationHash: carried?.pronunciationHash ?? null,
        // Likewise the direction it was performed with.
        directionHash: carried?.directionHash ?? null,
        voiceProvider: carried?.voiceProvider ?? null,
        voiceModel: carried?.voiceModel ?? null,
        voiceId: carried?.voiceId ?? null,
        audioMimeType: carried?.audioMimeType ?? null,
        audioBytes: carried?.audioBytes ?? null,
        audioDurationMs: carried?.audioDurationMs ?? null,
        renderedAt: carried?.renderedAt ?? null,
      };
    });

    // New dialogue gets an instant rule-based speaker; the cast analysis refines it.
    const needsSpeaker = (row: (typeof rows)[number]) =>
      row.delivery.kind === "dialogue" && !row.characterId && !row.delivery.speakerSource;
    if (splitDialogue && rows.some(needsSpeaker)) {
      const members = await loadCast();
      if (members.some(member => !member.isNarrator)) {
        const guesses = attributeSpeakersHeuristically(units, members);
        rows.forEach((row, index) => {
          if (needsSpeaker(row) && guesses[index]) {
            row.characterId = guesses[index]!;
            row.delivery.speakerSource = "heuristic";
          }
        });
      }
    }

    const cues = await db.select().from(bookxSoundCues).where(eq(bookxSoundCues.chapterId, chapter.id));
    const oldTextById = new Map(existing.map(segment => [segment.id, segment.text]));

    await db.delete(bookxSegments).where(eq(bookxSegments.chapterId, chapter.id));
    await insertMany(db, bookxSegments, rows);

    // Sound cues follow their anchor line; a cue whose line was deleted goes too.
    for (const cue of cues) {
      const anchorText = oldTextById.get(cue.segmentId);
      const target = anchorText === undefined ? undefined : rows.find(row => row.text === anchorText);
      if (target) await db.update(bookxSoundCues).set({ segmentId: target.id, updatedAt: new Date() }).where(eq(bookxSoundCues.id, cue.id));
      else await db.delete(bookxSoundCues).where(eq(bookxSoundCues.id, cue.id));
    }

    created += rows.length;
    rebuiltChapters.push(chapter.id);

    await db
      .update(bookxChapters)
      .set({ totalSegments: rows.length, generatedSegments: rows.filter(row => row.audioStorageKey).length, updatedAt: new Date() })
      .where(eq(bookxChapters.id, chapter.id));
  }

  return { created, rebuiltChapters };
}

/**
 * The voice each segment must be narrated in.
 *
 * Narration, and any dialogue whose speaker is unknown, uses the narrator's
 * voice. A single-narrator project uses it for everything, whatever the
 * segments are attributed to.
 */
export function resolveTargetVoice(input: {
  narrationStyle: string | null | undefined;
  characterId: string | null;
  voiceByCharacter: Map<string, string | null>;
  narratorVoiceId: string | null;
}): string | null {
  if (input.narrationStyle === "single") return input.narratorVoiceId;
  const characterVoice = input.characterId ? input.voiceByCharacter.get(input.characterId) ?? null : null;
  return characterVoice ?? input.narratorVoiceId;
}

/** Loads the segments in scope, joined to the voice their character requires. */
export async function loadPlannableSegments(projectId: string, chapterIds?: string[]): Promise<PlannableSegment[]> {
  const db = await requireDb();

  const chapters = await includedChapters(db, projectId);
  const scoped = chapterIds?.length ? chapters.filter(chapter => chapterIds.includes(chapter.id)) : chapters;
  if (!scoped.length) return [];

  const [project] = await db
    .select({ narrationStyle: bookxProjects.narrationStyle })
    .from(bookxProjects)
    .where(eq(bookxProjects.id, projectId))
    .limit(1);

  const chapterOrder = new Map(scoped.map(chapter => [chapter.id, chapter.orderIndex]));
  const characters = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, projectId));
  const voiceByCharacter = new Map(characters.map(character => [character.id, character.voiceId]));
  const narratorVoiceId = characters.find(character => character.isNarrator)?.voiceId ?? null;

  // A subquery keeps this one statement however many chapters the book has.
  const inScope = new Set(scoped.map(chapter => chapter.id));
  const rows = (await db
    .select()
    .from(bookxSegments)
    .where(inArray(bookxSegments.chapterId, projectChapterIds(db, projectId, { includedOnly: true }))))
    .filter(row => inScope.has(row.chapterId));

  // Direction depends on a line's place in its chapter (which scene it is in).
  const directionById = new Map<string, SegmentDirectionSpec>();
  for (const chapter of scoped) {
    const own = rows.filter(row => row.chapterId === chapter.id).sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id));
    chapterDirectionSpecs(chapter.direction, own).forEach((spec, index) => directionById.set(own[index]!.id, spec));
  }

  return rows.map(row => ({
    id: row.id,
    chapterId: row.chapterId,
    orderIndex: row.orderIndex,
    chapterOrderIndex: chapterOrder.get(row.chapterId) ?? 0,
    text: row.text,
    textHash: row.textHash,
    pronunciationHash: row.pronunciationHash,
    audioStorageKey: row.audioStorageKey,
    voiceProvider: row.voiceProvider,
    voiceModel: row.voiceModel,
    voiceId: row.voiceId,
    targetVoiceId: resolveTargetVoice({ narrationStyle: project?.narrationStyle, characterId: row.characterId, voiceByCharacter, narratorVoiceId }),
    pauseMs: row.delivery?.pauseMs ?? null,
    sceneBreakBefore: Boolean(row.delivery?.sceneBreakBefore),
    kind: row.delivery?.kind ?? "narration",
    directionHash: row.directionHash,
    direction: directionById.get(row.id) ?? null,
    renderedAt: row.renderedAt,
  }));
}

/** Loads the project's pronunciation rules, longest word first. */
async function loadPronunciationRules(db: Db, projectId: string): Promise<PronunciationRule[]> {
  const rows = await db.select().from(bookxPronunciations).where(eq(bookxPronunciations.projectId, projectId));
  return rows.map(row => ({ word: row.word, alias: row.alias, phoneme: row.phoneme }));
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
  /** Regenerate: redo audio made before this moment, resumably (stored on the job). */
  forceBefore?: Date;
  /** How many valid segments before the interruption point to redo on resume. */
  rewindSegments?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  stallTimeoutMs?: number;
};

/** Whether two runs cover the same chapters (no list means the whole book). */
function sameChapterScope(left?: string[] | null, right?: string[] | null): boolean {
  const key = (ids?: string[] | null) => [...new Set(ids ?? [])].sort().join("\n");
  return key(left) === key(right);
}

/** Whether some worker holds an unexpired lease on a job. */
function leaseHeld(job: { leaseOwner: string | null; leaseExpiresAt: Date | null }): boolean {
  return Boolean(job.leaseOwner && job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() > Date.now());
}

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
  const available = await availableProviders(input.ownerId, "text-to-speech");
  if (!available.includes(provider)) {
    throw new Error(
      `${provider} is not configured, so narration cannot start. Connect it in Settings, or pick a connected provider for this project.`,
    );
  }

  const model = project.voiceModel;

  // Reuse a live job for this project instead of creating a rival one. Looked up
  // before the chapters are split, so a book being rendered is never re-split
  // underneath its own run.
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

  let existing: (typeof live)[number] | undefined = live[live.length - 1];
  const sameRun = existing
    ? sameChapterScope((existing.detail as GenerationJobDetail | null)?.chapterIds, input.chapterIds) && !input.force && !input.forceBefore
    : false;

  if (existing && (activeRuns.has(existing.id) || leaseHeld(existing))) {
    // It is rendering right now. Starting the same run again just keeps it
    // going (and withdraws a pause it has not reached yet); anything else
    // would silently render a different selection than the one asked for.
    if (!sameRun) {
      throw new Error("This book is already being narrated. Pause or cancel the current run before starting a different one.");
    }
    await db
      .update(bookxGenerationJobs)
      .set({ pauseRequested: 0, cancelRequested: 0, updatedAt: new Date() })
      .where(eq(bookxGenerationJobs.id, existing.id));
    return { jobId: existing.id, resumed: true };
  }

  await ensureChapterSegments({ projectId: input.projectId, chapterIds: input.chapterIds, model });

  if (existing && !sameRun) {
    // A paused or queued run for other chapters (or without force): it used to
    // be resumed as it was, so "narrate chapter B" rendered chapter A. Replace it.
    await db
      .update(bookxGenerationJobs)
      .set({ status: "cancelled", pauseRequested: 0, cancelRequested: 0, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookxGenerationJobs.id, existing.id));
    existing = undefined;
  }

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
      ...(input.forceBefore ? { forceBefore: input.forceBefore.toISOString() } : {}),
      events: [{
        at: new Date().toISOString(),
        kind: "queued",
        message: input.forceBefore ? `Regeneration queued with ${provider} · ${model}` : `Queued with ${provider} · ${model}`,
      }],
    } satisfies GenerationJobDetail,
  });

  void driveJob(jobId, input).catch(error => {
    console.error("[Narration] Run failed to start:", error);
  });
  return { jobId, resumed: false };
}

/**
 * Asks a run to stop at the next segment boundary, keeping everything rendered.
 *
 * The job must belong to `projectId`: the caller has proven they own the
 * project, not the job, so a job id from another project changes nothing.
 */
export async function requestPause(jobId: string, projectId: string): Promise<boolean> {
  const db = await requireDb();
  const updated = await db
    .update(bookxGenerationJobs)
    .set({ pauseRequested: 1, updatedAt: new Date() })
    .where(and(eq(bookxGenerationJobs.id, jobId), eq(bookxGenerationJobs.projectId, projectId)))
    .returning({ id: bookxGenerationJobs.id });
  if (!updated.length) return false;
  const local = activeRuns.get(jobId);
  // Abort the in-flight request too, so a pause during a slow call is immediate.
  if (local) local.abort();
  else await settleUnattendedStop(db, jobId, "paused");
  return true;
}

export async function requestCancel(jobId: string, projectId: string): Promise<boolean> {
  const db = await requireDb();
  const updated = await db
    .update(bookxGenerationJobs)
    .set({ cancelRequested: 1, updatedAt: new Date() })
    .where(and(eq(bookxGenerationJobs.id, jobId), eq(bookxGenerationJobs.projectId, projectId)))
    .returning({ id: bookxGenerationJobs.id });
  if (!updated.length) return false;
  const local = activeRuns.get(jobId);
  if (local) local.abort();
  else await settleUnattendedStop(db, jobId, "cancelled");
  return true;
}

/**
 * Applies a pause or cancel to a run that no worker is attending.
 *
 * A run whose process went away (a restart, a crash, a deploy mid-book) has
 * nobody left to read its stop flags, so the request used to sit there and the
 * Generate screen said "Stopping…" for good. When no live lease is held the
 * stop takes effect here. A run another process is still working on keeps the
 * flag, and that process acts on it at its next segment.
 */
async function settleUnattendedStop(db: Db, jobId: string, stop: "paused" | "cancelled"): Promise<void> {
  const settled = await db
    .update(bookxGenerationJobs)
    .set({
      status: stop,
      pauseRequested: 0,
      cancelRequested: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: stop === "cancelled" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bookxGenerationJobs.id, jobId),
        inArray(bookxGenerationJobs.status, stop === "cancelled" ? ["queued", "running", "paused"] : ["queued", "running"]),
        or(isNull(bookxGenerationJobs.leaseExpiresAt), lt(bookxGenerationJobs.leaseExpiresAt, new Date())),
      ),
    )
    .returning({ completedSegments: bookxGenerationJobs.completedSegments, totalSegments: bookxGenerationJobs.totalSegments });
  const [row] = settled;
  if (!row) return;
  await appendEvent(db, jobId, stop, stop === "paused"
    ? `Paused after ${row.completedSegments} of ${row.totalSegments} segments. Everything rendered so far is kept.`
    : `Cancelled after ${row.completedSegments} of ${row.totalSegments} segments.`).catch(() => {});
}

/**
 * Takes the lease for a job.
 *
 * The `WHERE` clause is the whole point: only a job with no owner or an expired
 * lease can be claimed, and the database decides the winner, so two processes
 * racing to resume the same book cannot both proceed.
 */
async function claimJob(db: Db, jobId: string): Promise<boolean> {
  const claimed = await db
    .update(bookxGenerationJobs)
    .set({
      leaseOwner: WORKER_ID,
      leaseExpiresAt: nowPlus(LEASE_MS),
      heartbeatAt: new Date(),
      status: "running",
      startedAt: sql`COALESCE(${bookxGenerationJobs.startedAt}, ${Date.now()})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bookxGenerationJobs.id, jobId),
        // Resume and Start re-queue a paused run before driving it, so a paused
        // (or settled) run is never claimed out from under the creator's pause.
        inArray(bookxGenerationJobs.status, ["queued", "running"]),
        or(
          isNull(bookxGenerationJobs.leaseOwner),
          eq(bookxGenerationJobs.leaseOwner, WORKER_ID),
          lt(bookxGenerationJobs.leaseExpiresAt, new Date()),
        ),
      ),
    )
    .returning({ id: bookxGenerationJobs.id });

  return claimed.length > 0;
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

/** Why a run stops early. "lease-lost": another worker owns the job now, so leave its state alone. */
type StopReason = "paused" | "cancelled" | "lease-lost" | null;

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
  // Another worker took the lease; stand down rather than render in parallel,
  // and without touching a job that is no longer ours: clearing its flags here
  // would swallow a pause or cancel meant for the new owner.
  if (row.leaseOwner && row.leaseOwner !== WORKER_ID) return "lease-lost";
  if (row.cancelRequested) return "cancelled";
  if (row.pauseRequested) return "paused";
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
  previousText?: string;
  nextText?: string;
  provider: ProviderId;
  model: string;
  language?: string | null;
  pronunciationRules: PronunciationRule[];
  pronunciationHash: string;
  maxAttempts: number;
  requestTimeoutMs: number;
  stallTimeoutMs: number;
  controller: AbortController;
  onEvent: (kind: string, message: string) => Promise<void>;
  voiceSettings?: VoiceSettings | null;
}): Promise<{ ok: true; bytes: number; durationMs: number; characters: number } | { ok: false; classification: FailureClassification; fatal: boolean }> {
  const { db, segment } = input;
  let lastClassification: FailureClassification = { kind: "unknown", retryable: false, message: "Not attempted" };
  // Tags go in front of the words for tag-aware models; instructions travel
  // separately; every other model gets the words alone.
  const direction = directionFor(segment.direction, input.provider, input.model, input.voiceSettings?.instructions);
  const directionHash = directionHashFor(segment.direction, input.provider, input.model, input.voiceSettings?.instructions);
  const spoken = `${direction.prefix}${applyPronunciationRules(segment.text, input.pronunciationRules, { provider: input.provider, model: input.model })}`;

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
        text: spoken,
        instructions: direction.instructions || undefined,
        voiceSettings: input.voiceSettings,
        previousText: input.previousText,
        nextText: input.nextText,
        language: input.language,
        ownerId: input.ownerId,
        requestTimeoutMs: input.requestTimeoutMs,
        stallTimeoutMs: input.stallTimeoutMs,
        signal: input.controller.signal,
      });

      // Only now is the segment considered done. Recording the text hash and the
      // voice alongside the key is what lets a later run prove this audio is still
      // the right audio.
      const saved = await db
        .update(bookxSegments)
        .set({
          audioStorageKey: result.storageKey,
          textHash: hashSegmentText(segment.text),
          pronunciationHash: input.pronunciationHash,
          directionHash: directionHash || null,
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
        .where(and(eq(bookxSegments.id, segment.id), eq(bookxSegments.text, segment.text)))
        .returning({ id: bookxSegments.id });
      if (!saved.length) {
        // The chapter was edited or re-split while this rendered, so the line is
        // gone (or says something else). Counting it as rendered would report
        // audio the book does not have.
        return {
          ok: false,
          classification: { kind: "unknown", retryable: false, message: "This line changed while it was being narrated. Run narration again to voice the new text." },
          fatal: false,
        };
      }

      if (attempt > 1) {
        await input.onEvent("recovered", `Segment recovered on attempt ${attempt}`);
      }
      return { ok: true, bytes: result.inspection.bytes, durationMs: result.inspection.durationMs ?? 0, characters: spoken.length };
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

      // A credential, quota or configuration failure will repeat for every segment.
      if (FATAL_FAILURE_KINDS.has(classification.kind)) {
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
      // A pause or cancel ends the wait at once instead of after up to a minute.
      await abortableDelay(delay, input.controller.signal);
    }
  }

  return { ok: false, classification: lastClassification, fatal: false };
}

/** Waits `ms`, or less if `signal` aborts first. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Extends the lease while a run is alive, so one slow request cannot let it lapse. */
async function renewLease(db: Db, jobId: string): Promise<void> {
  await db
    .update(bookxGenerationJobs)
    .set({ leaseExpiresAt: nowPlus(LEASE_MS) })
    .where(and(eq(bookxGenerationJobs.id, jobId), eq(bookxGenerationJobs.leaseOwner, WORKER_ID)));
}

/**
 * Claims a job and renders its pending segments, checkpointing as it goes.
 *
 * Exits cleanly on pause, cancel, a fatal configuration error, or completion. Any
 * other exit (a crash, a killed process) leaves the lease to expire, at which point
 * the recovery sweep resumes the job with everything rendered so far intact.
 */
async function driveJob(jobId: string, options: StartRunInput): Promise<void> {
  // Checked and reserved before the first await. Two calls in the same moment
  // (a double Resume, or the recovery sweep racing a Start) both used to pass
  // the check, and both won the claim because this process may re-claim its
  // own lease: the book was then rendered, and paid for, twice.
  if (activeRuns.has(jobId) || shuttingDown) return; // Already running in this process.
  // Replaced when a pause or cancel is withdrawn before the loop sees it: an
  // aborted controller would otherwise make every later segment "stop" at once.
  let controller = new AbortController();
  activeRuns.set(jobId, controller);

  let db: Db;
  try {
    db = await requireDb();
    if (!(await claimJob(db, jobId))) {
      activeRuns.delete(jobId); // Another worker owns it.
      return;
    }
  } catch (error) {
    activeRuns.delete(jobId);
    throw error;
  }

  // A request can take longer than the lease (120 s against 90 s), so the lease
  // is renewed on a timer rather than only between segments.
  const leaseTimer = setInterval(() => void renewLease(db, jobId).catch(() => undefined), Math.floor(LEASE_MS / 3));
  const touchedChapters = new Set<string>();
  let rolledUp = false;

  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  const recordEvent = (kind: string, message: string) => appendEvent(db, jobId, kind, message);

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
    const pronunciationRules = await loadPronunciationRules(db, job.projectId);
    const pronHash = pronunciationHash(pronunciationRules);
    const forceBefore = (job.detail as GenerationJobDetail | null)?.forceBefore;
    const plan = planNarrationRun({
      segments,
      pinned: { provider, model },
      pronunciationHash: pronHash,
      cursorSegmentId: job.cursorSegmentId,
      rewindSegments: job.rewindSegments,
      force: options.force,
      forceBefore: forceBefore ? new Date(forceBefore) : null,
      chapterIds,
      context: { voiceInstructions: project.voiceSettings?.instructions },
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
    const orderedPosition = new Map(plan.ordered.map((candidate, index) => [candidate.id, index]));

    // Lines still to render per chapter, so a chapter's counts are rolled up as
    // soon as its last line lands, not only when the whole run ends.
    const remainingInChapter = new Map<string, number>();
    for (const segment of plan.pending) remainingInChapter.set(segment.chapterId, (remainingInChapter.get(segment.chapterId) ?? 0) + 1);

    // Positions (in book order) of the lines being rendered right now. The
    // cursor is the earliest of them, so a resume rewinds to before anything
    // that was in flight and keeps every later line that finished.
    const inFlight = new Set<number>();
    // Why the lanes stopped taking lines. Held in an object so the checks after
    // the lanes finish see what the lanes wrote.
    const run: { halt: { kind: "stop"; stop: Exclude<StopReason, null> } | { kind: "fatal"; message: string } | null } = { halt: null };
    let nextPending = 0;

    const stopRun = async (stop: Exclude<StopReason, null>) => {
      // Someone else's job now: leave its status and flags for its new owner.
      if (stop === "lease-lost") return;
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
    };

    /** The earliest line in flight, as the job's cursor. */
    const cursorFields = (fallback: { id: string; index: number }) => {
      const earliest = inFlight.size ? Math.min(...inFlight) : fallback.index;
      return { cursorSegmentId: plan.ordered[earliest]?.id ?? fallback.id, cursorIndex: earliest };
    };

    /**
     * Renders one pending line and checkpoints it. Several run at once (see
     * `lanes` below); everything they share is updated between awaits, so the
     * counts stay exact.
     */
    const renderOne = async (segment: PlannableSegment, position: number): Promise<void> => {
      touchedChapters.add(segment.chapterId);

      const orderedIndex = orderedPosition.get(segment.id) ?? -1;
      const bookIndex = orderedIndex >= 0 ? orderedIndex : position;
      inFlight.add(bookIndex);
      // Neighbouring text in the same chapter lets the provider match intonation
      // across the join, which matters once dialogue and its tag are separate units.
      const previousUnit = orderedIndex > 0 ? plan.ordered[orderedIndex - 1] : undefined;
      const nextUnit = orderedIndex >= 0 ? plan.ordered[orderedIndex + 1] : undefined;
      const continuity = {
        previousText: previousUnit?.chapterId === segment.chapterId ? previousUnit.text : undefined,
        nextText: nextUnit?.chapterId === segment.chapterId ? nextUnit.text : undefined,
      };
      // Record the cursor *before* rendering. If the process dies during this
      // line, the resume knows which lines were in flight and rewinds from the
      // earliest of them rather than guessing.
      await db
        .update(bookxGenerationJobs)
        .set({
          // A Resume or Start while this loop was running re-queued the row.
          status: "running",
          ...cursorFields({ id: segment.id, index: bookIndex }),
          leaseExpiresAt: nowPlus(LEASE_MS),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bookxGenerationJobs.id, jobId));

      const render = (used: AbortController) => renderWithRetries({
        db,
        jobId,
        projectId: job.projectId,
        ownerId: project.ownerId,
        segment,
        ...continuity,
        provider,
        model,
        language: project.language,
        pronunciationRules,
        pronunciationHash: pronHash,
        maxAttempts,
        requestTimeoutMs,
        stallTimeoutMs,
        controller: used,
        onEvent: recordEvent,
        voiceSettings: project.voiceSettings,
      });

      let used = controller;
      let result = await render(used);
      // A pause or cancel aborts the requests in flight. If it still stands, stop
      // here. If it was withdrawn first (a quick Resume clears it), carry on with
      // a fresh controller and voice this line again. Skipping it instead used
      // to let the rest of the book "finish" without a single line rendered.
      // `used` is the controller this line rendered with: another lane may
      // already have replaced the shared one, and only one replacement is needed.
      while (!result.ok && used.signal.aborted) {
        if (run.halt) {
          // Another lane stopped the run; this line stays pending for the resume.
          inFlight.delete(bookIndex);
          return;
        }
        const stopNow = await readStopRequest(db, jobId);
        if (stopNow) {
          run.halt ??= { kind: "stop", stop: stopNow };
          inFlight.delete(bookIndex);
          return;
        }
        if (controller === used) {
          controller = new AbortController();
          activeRuns.set(jobId, controller);
        }
        used = controller;
        result = await render(used);
      }
      inFlight.delete(bookIndex);

      if (result.ok) {
        completed++;
      } else {
        failed++;
        const classification = result.classification;
        await withDetailLock(jobId, async () => {
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
                  message: classification.message.slice(0, 300),
                  at: new Date().toISOString(),
                }),
              },
              updatedAt: new Date(),
            })
            .where(eq(bookxGenerationJobs.id, jobId));
        });

        if (result.fatal) {
          // Every other line would fail the same way: stop the lanes and the
          // requests they have in flight.
          if (!run.halt) {
            run.halt = { kind: "fatal", message: classification.message };
            controller.abort();
          }
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
          ...(inFlight.size ? cursorFields({ id: segment.id, index: bookIndex }) : {}),
          leaseExpiresAt: nowPlus(LEASE_MS),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bookxGenerationJobs.id, jobId));

      const left = (remainingInChapter.get(segment.chapterId) ?? 1) - 1;
      remainingInChapter.set(segment.chapterId, left);
      if (left <= 0) await rollUpChapter(db, segment.chapterId);
    };

    /** One lane: takes the next pending line until there are none or the run stops. */
    const lane = async (): Promise<void> => {
      while (!run.halt && nextPending < plan.pending.length) {
        const stop = await readStopRequest(db, jobId);
        if (stop) {
          if (!run.halt) {
            run.halt = { kind: "stop", stop };
            // Stop the other lanes' requests too, so a pause is immediate.
            controller.abort();
          }
          return;
        }
        // Another lane may have taken the last line, or stopped, during the read.
        if (run.halt || nextPending >= plan.pending.length) return;
        const position = nextPending++;
        await renderOne(plan.pending[position]!, position);
        if (SEGMENT_GAP_MS > 0 && !run.halt) await new Promise(resolve => setTimeout(resolve, SEGMENT_GAP_MS));
      }
    };

    // Lines render a few at a time. The provider's account-wide cap
    // (providerSlots) still applies across every book, so more lanes than the
    // account allows would only queue.
    const laneCount = Math.max(1, Math.min(runConcurrency(), providerConcurrency(provider), plan.pending.length));
    if (laneCount > 1) await recordEvent("lanes", `Rendering ${laneCount} lines at a time`);
    // A lane that throws (a database error) stops the others before the run is
    // failed, so no lane keeps rendering after the lease is released.
    const laneErrors: unknown[] = [];
    await Promise.all(Array.from({ length: laneCount }, () => lane().catch(error => {
      laneErrors.push(error);
      if (!run.halt) {
        run.halt = { kind: "fatal", message: error instanceof Error ? error.message : "Narration run failed" };
        controller.abort();
      }
    })));
    if (laneErrors.length) throw laneErrors[0];

    const halt = run.halt;
    if (halt?.kind === "stop") {
      await stopRun(halt.stop);
      return;
    }
    if (halt?.kind === "fatal") {
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
      await recordEvent("fatal", `Stopped: ${halt.message}`);
      return;
    }

    for (const chapterId of touchedChapters) await rollUpChapter(db, chapterId);
    rolledUp = true;

    // Complete only when every planned segment has audio, not merely when none
    // was counted as failed.
    const unrendered = Math.max(0, plan.totalSegments - completed);
    const finalStatus = failed === 0 && unrendered === 0 ? "completed" : "failed";
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
      finalStatus === "failed"
        ? `Finished with ${Math.max(failed, unrendered)} segment(s) still unrendered. Retry them without redoing the rest.`
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
    clearInterval(leaseTimer);
    // A pause, cancel or fatal stop used to skip this, leaving the chapter
    // counts behind what was actually rendered.
    if (!rolledUp) {
      for (const chapterId of touchedChapters) await rollUpChapter(db, chapterId).catch(() => {});
    }
    activeRuns.delete(jobId);
    await releaseLease(db, jobId).catch(() => {});
    await pickUpRequeued(db, jobId, options).catch(() => {});
  }
}

/**
 * Drives a run again if it was re-queued while this loop was winding down.
 *
 * A Resume (or Start) that lands just after the loop decided to stop finds the
 * run still active here and leaves it alone, expecting this loop to carry on;
 * the loop then exits, and the run used to sit "Queued" with nobody to render it.
 */
async function pickUpRequeued(db: Db, jobId: string, options: StartRunInput): Promise<void> {
  if (shuttingDown) return;
  const [row] = await db
    .select({
      status: bookxGenerationJobs.status,
      pauseRequested: bookxGenerationJobs.pauseRequested,
      cancelRequested: bookxGenerationJobs.cancelRequested,
    })
    .from(bookxGenerationJobs)
    .where(eq(bookxGenerationJobs.id, jobId))
    .limit(1);
  if (row?.status !== "queued" || row.pauseRequested || row.cancelRequested) return;
  void driveJob(jobId, options).catch(error => {
    console.error("[Narration] Run failed to restart:", error);
  });
}

/**
 * Renders one segment now, outside a run, and records it exactly as a run
 * does: text hash, pronunciation, voice and audio details together. A clip
 * stored with only its key kept the previous audio's details, so the planner,
 * audit and export trusted audio they knew nothing about.
 */
export async function renderSegmentNow(input: {
  projectId: string;
  ownerId: number;
  segmentId: string;
  provider: ProviderId;
  model: string;
  voiceId?: string | null;
  language?: string | null;
  purpose?: string;
}): Promise<{ storageKey: string; audioUrl: string; durationMs: number | null }> {
  const db = await requireDb();
  const [segment] = await db.select().from(bookxSegments).where(eq(bookxSegments.id, input.segmentId)).limit(1);
  if (!segment) throw new Error("Segment not found");
  const rules = await loadPronunciationRules(db, input.projectId);
  const [project] = await db.select({ voiceSettings: bookxProjects.voiceSettings }).from(bookxProjects).where(eq(bookxProjects.id, input.projectId)).limit(1);
  // The line's direction, worked out exactly as a run works it out.
  const plannable = (await loadPlannableSegments(input.projectId, [segment.chapterId])).find(candidate => candidate.id === segment.id);
  const instructions = project?.voiceSettings?.instructions;
  const direction = directionFor(plannable?.direction, input.provider, input.model, instructions);
  const result = await renderSegmentAudio({
    projectId: input.projectId,
    segmentId: segment.id,
    provider: input.provider,
    model: input.model,
    voiceId: input.voiceId ?? undefined,
    text: `${direction.prefix}${applyPronunciationRules(segment.text, rules, { provider: input.provider, model: input.model })}`,
    instructions: direction.instructions || undefined,
    voiceSettings: project?.voiceSettings,
    language: input.language,
    ownerId: input.ownerId,
    purpose: input.purpose ?? "retake",
  });
  const saved = await db
    .update(bookxSegments)
    .set({
      audioStorageKey: result.storageKey,
      textHash: hashSegmentText(segment.text),
      pronunciationHash: pronunciationHash(rules),
      directionHash: directionHashFor(plannable?.direction, input.provider, input.model, instructions) || null,
      voiceProvider: input.provider,
      voiceModel: input.model,
      voiceId: input.voiceId ?? null,
      audioMimeType: result.inspection.mimeType,
      audioBytes: result.inspection.bytes,
      audioDurationMs: result.inspection.durationMs ?? null,
      lastError: null,
      renderedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(bookxSegments.id, segment.id), eq(bookxSegments.text, segment.text)))
    .returning({ id: bookxSegments.id });
  if (!saved.length) throw new Error("This line changed while it was being narrated. Try again.");
  await rollUpChapter(db, segment.chapterId);
  return { storageKey: result.storageKey, audioUrl: result.audioUrl, durationMs: result.inspection.durationMs ?? null };
}

const lapsed = () => or(isNull(bookxGenerationJobs.leaseExpiresAt), lt(bookxGenerationJobs.leaseExpiresAt, new Date()));

/** " after 12 of 40 segments", or nothing for a run that never got as far as planning. */
const progressSoFar = (job: { completedSegments: number; totalSegments: number }) =>
  job.totalSegments > 0 ? ` after ${job.completedSegments} of ${job.totalSegments} segments` : "";

let sweeping = false;
let recoveryTimer: NodeJS.Timeout | undefined;

/**
 * Picks up runs whose worker went away mid-book: a restart, a crash, or a
 * deploy replacing the container.
 *
 * This used to run once, at boot, and only re-labelled such a run "queued".
 * Nothing ever drove it again, and the lease the dying process held was usually
 * still valid at boot anyway, so the run was skipped: the Generate screen kept
 * showing it as rendering, and the book simply stopped until the creator found a
 * way to start it again. It now runs at boot and every few seconds after, and:
 *
 * - applies a pause or cancel that was asked for while nobody was attending it;
 * - resumes anything else where it stopped, exactly as Resume would, so the
 *   segment in flight is redone and everything already rendered is kept;
 * - pauses, rather than resumes, a run that keeps going down without getting any
 *   further, or one interrupted long ago, so the creator decides what to spend.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  if (shuttingDown || sweeping) return 0;
  sweeping = true;
  try {
    const db = await getDb();
    if (!db) return 0;
    const now = Date.now();

    const candidates = await db
      .select()
      .from(bookxGenerationJobs)
      .where(and(inArray(bookxGenerationJobs.status, ["queued", "running"]), lapsed()));

    let resumed = 0;
    for (const job of candidates) {
      if (activeRuns.has(job.id)) continue; // This process is driving it.
      // Queued a moment ago: whoever queued it is about to claim it.
      if (job.status === "queued" && !job.leaseOwner && now - new Date(job.updatedAt).getTime() < UNCLAIMED_GRACE_MS) continue;

      if (job.cancelRequested || job.pauseRequested) {
        await settleUnattendedStop(db, job.id, job.cancelRequested ? "cancelled" : "paused");
        continue;
      }

      const [project] = await db
        .select({ ownerId: bookxProjects.ownerId })
        .from(bookxProjects)
        .where(eq(bookxProjects.id, job.projectId))
        .limit(1);
      if (!project) {
        // The book was deleted while its run had no worker.
        await db
          .update(bookxGenerationJobs)
          .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null, finishedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(bookxGenerationJobs.id, job.id), lapsed()));
        continue;
      }

      const detail = (job.detail ?? {}) as GenerationJobDetail;
      const progressed = !detail.recovery || job.completedSegments > detail.recovery.completedSegments;
      const attempt = progressed ? 1 : detail.recovery!.count + 1;
      const lastSeen = Math.max(
        ...[job.leaseExpiresAt, job.heartbeatAt, job.updatedAt].map(value => (value ? new Date(value).getTime() : 0)),
      );
      const longAgo = now - lastSeen > AUTO_RESUME_WITHIN_MS;

      if (attempt > MAX_RECOVERIES_WITHOUT_PROGRESS || longAgo) {
        const paused = await db
          .update(bookxGenerationJobs)
          .set({ status: "paused", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
          .where(and(eq(bookxGenerationJobs.id, job.id), inArray(bookxGenerationJobs.status, ["queued", "running"]), lapsed()))
          .returning({ id: bookxGenerationJobs.id });
        if (paused.length) {
          await appendEvent(db, job.id, "paused", longAgo
            ? `Paused: this run was interrupted a while ago${progressSoFar(job)}. Resume it when you are ready; everything rendered is kept.`
            : `Paused: the run stopped unexpectedly ${attempt - 1} times in a row without getting further. Resume it when you are ready; everything rendered is kept.`).catch(() => {});
        }
        continue;
      }

      // Take it over the way Resume does. Conditional, so if another process got
      // there first (or the creator acted meanwhile) this one leaves it alone.
      const taken = await db
        .update(bookxGenerationJobs)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          detail: {
            ...detail,
            recovery: { count: attempt, completedSegments: job.completedSegments },
            events: appendCapped(detail.events, {
              at: new Date().toISOString(),
              kind: "recovered",
              message: `The server restarted mid-run, so narration picked up again${progressSoFar(job)}.`,
            }),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bookxGenerationJobs.id, job.id),
            inArray(bookxGenerationJobs.status, ["queued", "running"]),
            eq(bookxGenerationJobs.pauseRequested, 0),
            eq(bookxGenerationJobs.cancelRequested, 0),
            lapsed(),
          ),
        )
        .returning({ id: bookxGenerationJobs.id });
      if (!taken.length) continue;

      resumed++;
      void driveJob(job.id, { projectId: job.projectId, ownerId: project.ownerId }).catch(error => {
        console.error("[Narration] Interrupted run failed to resume:", error);
      });
    }

    if (resumed) console.log(`[Narration] Resumed ${resumed} interrupted run(s)`);
    return resumed;
  } finally {
    sweeping = false;
  }
}

/** Starts the recovery sweep: once now, then every few seconds for the life of the process. */
export function startNarrationRecovery(): void {
  if (recoveryTimer) return;
  const sweep = () => {
    void recoverInterruptedRuns().catch(error => {
      console.error("[Narration] Recovery scan failed:", error);
    });
  };
  sweep();
  recoveryTimer = setInterval(sweep, RECOVERY_SWEEP_MS);
  recoveryTimer.unref();
}

/**
 * Lets go of this process's runs as it exits mid-book (a deploy's drain ran
 * out), so the next process resumes them as soon as it starts instead of
 * waiting out the lease. Nothing new is claimed after this.
 */
export async function releaseNarrationLeases(): Promise<void> {
  shuttingDown = true;
  if (recoveryTimer) clearInterval(recoveryTimer);
  const db = await getDb();
  if (!db) return;
  await db
    .update(bookxGenerationJobs)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(eq(bookxGenerationJobs.leaseOwner, WORKER_ID));
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
export async function retryFailedSegments(input: { projectId: string; ownerId: number; chapterIds?: string[] }): Promise<number> {
  const db = await requireDb();
  const [project] = await db
    .select({ id: bookxProjects.id })
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const chapters = await includedChapters(db, input.projectId);
  const scoped = input.chapterIds?.length ? chapters.filter(chapter => input.chapterIds!.includes(chapter.id)) : chapters;
  if (!scoped.length) return 0;

  let reset = 0;
  await forEachChunk(scoped.map(chapter => chapter.id), async part => {
    const rows = await db
      .update(bookxSegments)
      .set({ renderAttempts: 0, lastError: null, updatedAt: new Date() })
      .where(and(inArray(bookxSegments.chapterId, part), isNull(bookxSegments.audioStorageKey)))
      .returning({ id: bookxSegments.id });
    reset += rows.length;
  });
  return reset;
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
  const chapters = await includedChapters(db, input.projectId);
  const pronunciationRules = await loadPronunciationRules(db, input.projectId);
  const pronHash = pronunciationHash(pronunciationRules);

  const durations = new Map<string, number | null>();
  if (chapters.length) {
    const rows = await db
      .select({ id: bookxSegments.id, audioDurationMs: bookxSegments.audioDurationMs, audioStorageKey: bookxSegments.audioStorageKey })
      .from(bookxSegments)
      .where(inArray(bookxSegments.chapterId, projectChapterIds(db, input.projectId, { includedOnly: true })));
    for (const row of rows) {
      // `null` marks "audio present but never measured", which the audit surfaces
      // as suspect rather than counting as good.
      durations.set(row.id, row.audioStorageKey ? row.audioDurationMs ?? null : 0);
    }
  }

  return auditSegments(segments, { provider: project.voiceProvider, model: project.voiceModel }, durations, pronHash, { voiceInstructions: project.voiceSettings?.instructions });
}

// ---------------------------------------------------------------------------
// Regenerating and re-taking
// ---------------------------------------------------------------------------

async function ownedProject(db: Db, projectId: string, ownerId: number) {
  const [project] = await db
    .select()
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, projectId), eq(bookxProjects.ownerId, ownerId)))
    .limit(1);
  if (!project) throw new Error("Project not found");
  return project;
}

/**
 * Re-voices one line with the voice a run would give it (its character's, or
 * the narrator's), its direction, and the project's model.
 */
export async function retakeSegment(input: { projectId: string; ownerId: number; segmentId: string }) {
  const db = await requireDb();
  const project = await ownedProject(db, input.projectId, input.ownerId);
  const [row] = await db
    .select({ chapterId: bookxSegments.chapterId })
    .from(bookxSegments)
    .innerJoin(bookxChapters, eq(bookxSegments.chapterId, bookxChapters.id))
    .where(and(eq(bookxSegments.id, input.segmentId), eq(bookxChapters.projectId, input.projectId)))
    .limit(1);
  if (!row) throw new Error("Segment not found");
  const plannable = (await loadPlannableSegments(input.projectId, [row.chapterId])).find(segment => segment.id === input.segmentId);
  if (!plannable) throw new Error("This line is in a chapter that is not part of the book. Include the chapter first.");
  const provider = project.voiceProvider as ProviderId;
  if (!(await availableProviders(input.ownerId, "text-to-speech")).includes(provider)) {
    throw new Error(`${provider} is not configured. Connect it in Settings to re-take this line.`);
  }
  return renderSegmentNow({
    projectId: input.projectId,
    ownerId: input.ownerId,
    segmentId: input.segmentId,
    provider,
    model: project.voiceModel,
    voiceId: plannable.targetVoiceId,
    language: project.language,
    purpose: "retake",
  });
}

/**
 * Re-renders whole chapters even where their audio is current. Starts at once
 * unless a run is rendering right now, in which case the caller is asked to
 * pause it first rather than having two runs race over the same book.
 */
export async function regenerateChapters(input: { projectId: string; ownerId: number; chapterIds: string[] }) {
  const db = await requireDb();
  await ownedProject(db, input.projectId, input.ownerId);
  const included = new Set((await includedChapters(db, input.projectId)).map(chapter => chapter.id));
  const chapterIds = [...new Set(input.chapterIds)].filter(id => included.has(id));
  if (!chapterIds.length) throw new Error("Choose a chapter that is part of the book.");
  const live = await db
    .select({ id: bookxGenerationJobs.id, leaseOwner: bookxGenerationJobs.leaseOwner, leaseExpiresAt: bookxGenerationJobs.leaseExpiresAt })
    .from(bookxGenerationJobs)
    .where(and(eq(bookxGenerationJobs.projectId, input.projectId), inArray(bookxGenerationJobs.status, ["queued", "running"])));
  if (live.some(job => activeRuns.has(job.id) || leaseHeld(job))) {
    throw new Error("Narration is running. Pause it first: the regeneration starts straight away, and Continue narration picks up the rest afterwards.");
  }
  return startNarrationRun({ projectId: input.projectId, ownerId: input.ownerId, chapterIds, forceBefore: new Date() });
}

/**
 * What a run (or a regeneration) would send: how many lines and characters,
 * including the direction tags that are billed as text.
 */
export async function estimateNarration(input: { projectId: string; ownerId: number; chapterIds?: string[]; regenerate?: boolean }) {
  const db = await requireDb();
  const project = await ownedProject(db, input.projectId, input.ownerId);
  const provider = project.voiceProvider;
  const model = project.voiceModel;
  const segments = await loadPlannableSegments(input.projectId, input.chapterIds);
  const rules = await loadPronunciationRules(db, input.projectId);
  const plan = planNarrationRun({
    segments,
    pinned: { provider, model },
    pronunciationHash: pronunciationHash(rules),
    forceBefore: input.regenerate ? new Date() : null,
    chapterIds: input.chapterIds,
    context: { voiceInstructions: project.voiceSettings?.instructions },
  });
  let characters = 0;
  let directionCharacters = 0;
  for (const segment of plan.pending) {
    const direction = directionFor(segment.direction, provider, model, project.voiceSettings?.instructions);
    const text = applyPronunciationRules(segment.text, rules, { provider, model });
    characters += direction.prefix.length + text.length;
    directionCharacters += direction.prefix.length;
  }
  return {
    provider,
    model,
    segments: plan.pending.length,
    totalSegments: plan.totalSegments,
    characters,
    directionCharacters,
  };
}
