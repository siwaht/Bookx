import { voiceKey } from "../shared/narration";
import { hashSegmentText } from "./textSegmentation";

/**
 * Decides what a run should render and what it may reuse.
 *
 * ## Why a segment is the unit
 *
 * Audio is never appended to a file. Each segment owns one slot in the ordered
 * timeline, and re-rendering a segment *replaces* that slot. That is what makes the
 * "go back a bit and start again" behaviour safe: replaying a segment cannot
 * duplicate audio the way resuming a byte offset in a single stream could.
 *
 * ## When stored audio may be reused
 *
 * Only when all three hold:
 *   - audio exists,
 *   - its `textHash` still matches the segment's current text, and
 *   - its voice key still matches the voice this run is pinned to.
 *
 * Anything else is re-rendered. This is what prevents the two silent corruptions
 * that matter: audio left over from edited text, and a book half-narrated by one
 * voice and half by another.
 *
 * ## The rewind
 *
 * On resume, the segment the previous run was working on is discarded outright
 * (it may have been mid-flight), and the `rewindSegments` units *before* it are
 * re-rendered too even though they look valid. Those are the units written while
 * the connection was degrading, so they are the ones worth not trusting.
 */

export type PlannableSegment = {
  id: string;
  chapterId: string;
  /** Order within the chapter. */
  orderIndex: number;
  /** Order of the owning chapter within the project. */
  chapterOrderIndex: number;
  text: string;
  textHash: string | null;
  /** Hash of the pronunciation rules applied when the audio was made. */
  pronunciationHash?: string | null;
  audioStorageKey: string | null;
  voiceProvider: string | null;
  voiceModel: string | null;
  voiceId: string | null;
  /** Voice this segment's character requires, if the project is multi-cast. */
  targetVoiceId?: string | null;
  /** Silence after the segment when a chapter is assembled. */
  pauseMs?: number | null;
  /** A scene break precedes this segment. */
  sceneBreakBefore?: boolean;
  kind?: "narration" | "dialogue";
};

export type PlanInput = {
  segments: PlannableSegment[];
  /** Voice the run is pinned to. */
  pinned: { provider: string; model: string };
  /** Hash of the pronunciation rules in force for this run. */
  pronunciationHash?: string | null;
  /** Where the previous run stopped, if this is a resume. */
  cursorSegmentId?: string | null;
  /** How many valid segments before the cursor to redo. */
  rewindSegments?: number;
  /** Re-render everything, ignoring reusable audio. */
  force?: boolean;
  /** Restrict the run to these chapters. */
  chapterIds?: string[];
};

export type PlanResult = {
  /** Every segment in the run, in playback order. */
  ordered: PlannableSegment[];
  /** Segments that must be rendered, in playback order. */
  pending: PlannableSegment[];
  /** Segments whose stored audio is still valid. */
  reusable: PlannableSegment[];
  /** Ids re-queued by the rewind despite having valid audio. */
  rewound: string[];
  /** Index in `ordered` where rendering begins. */
  resumeIndex: number;
  totalSegments: number;
  /** Human-readable note for the job event log. */
  note: string;
};

/**
 * Deterministic playback order: chapter, then position in chapter, then id as a
 * final tie-break so duplicate order indexes cannot make the plan unstable
 * between runs.
 */
export function orderSegments(segments: PlannableSegment[]): PlannableSegment[] {
  return [...segments].sort((left, right) =>
    left.chapterOrderIndex - right.chapterOrderIndex ||
    left.orderIndex - right.orderIndex ||
    left.id.localeCompare(right.id));
}

/** The voice a segment's stored audio was produced with. */
const storedVoiceKey = (segment: PlannableSegment): string | null =>
  segment.voiceProvider && segment.voiceModel
    ? voiceKey({ provider: segment.voiceProvider, model: segment.voiceModel, voiceId: segment.voiceId })
    : null;

/** The voice the segment should be narrated with on this run. */
export const targetVoiceKeyFor = (segment: PlannableSegment, pinned: { provider: string; model: string }): string =>
  voiceKey({ provider: pinned.provider, model: pinned.model, voiceId: segment.targetVoiceId });

export type ReuseCheck =
  | { reusable: true }
  | { reusable: false; reason: "missing-audio" | "text-changed" | "voice-changed" | "pronunciation-changed" };

/** Whether a segment's stored audio can stand as-is for this run. */
export function checkReusable(segment: PlannableSegment, pinned: { provider: string; model: string }, pronunciationHash?: string | null): ReuseCheck {
  if (!segment.audioStorageKey) return { reusable: false, reason: "missing-audio" };
  if (!segment.textHash || segment.textHash !== hashSegmentText(segment.text)) {
    return { reusable: false, reason: "text-changed" };
  }
  if (storedVoiceKey(segment) !== targetVoiceKeyFor(segment, pinned)) {
    return { reusable: false, reason: "voice-changed" };
  }
  if (pronunciationHash !== undefined && segment.pronunciationHash !== pronunciationHash) {
    return { reusable: false, reason: "pronunciation-changed" };
  }
  return { reusable: true };
}

export function planNarrationRun(input: PlanInput): PlanResult {
  const rewindSegments = Math.max(0, input.rewindSegments ?? 1);
  const scoped = input.chapterIds?.length
    ? input.segments.filter(segment => input.chapterIds!.includes(segment.chapterId))
    : input.segments;
  const ordered = orderSegments(scoped);

  if (!ordered.length) {
    return { ordered, pending: [], reusable: [], rewound: [], resumeIndex: 0, totalSegments: 0, note: "No segments to render" };
  }

  if (input.force) {
    return {
      ordered,
      pending: ordered,
      reusable: [],
      rewound: [],
      resumeIndex: 0,
      totalSegments: ordered.length,
      note: `Re-rendering all ${ordered.length} segments by request`,
    };
  }

  // Locate the interruption point and rewind before it. A cursor we can no longer
  // find (the segment was deleted, or the manuscript was re-split) is treated as
  // "no cursor": planning falls back to whatever is genuinely missing, which is
  // always safe because reuse is validated per segment anyway.
  const cursorIndex = input.cursorSegmentId
    ? ordered.findIndex(segment => segment.id === input.cursorSegmentId)
    : -1;
  const resumeIndex = cursorIndex >= 0 ? Math.max(0, cursorIndex - rewindSegments) : 0;

  const rewound: string[] = [];
  const pending: PlannableSegment[] = [];
  const reusable: PlannableSegment[] = [];

  ordered.forEach((segment, index) => {
    const check = checkReusable(segment, input.pinned, input.pronunciationHash);

    // Inside the rewind window (the cursor itself plus the units immediately
    // before it) we distrust stored audio even when it verifies.
    const insideRewindWindow = cursorIndex >= 0 && index >= resumeIndex && index <= cursorIndex;

    if (check.reusable && insideRewindWindow) {
      rewound.push(segment.id);
      pending.push(segment);
      return;
    }
    if (check.reusable) {
      reusable.push(segment);
      return;
    }
    pending.push(segment);
  });

  const note = cursorIndex >= 0
    ? `Resuming at segment ${resumeIndex + 1} of ${ordered.length}` +
      (rewound.length ? `, re-rendering ${rewound.length} segment(s) before the interruption` : "") +
      `; reusing ${reusable.length}`
    : `Rendering ${pending.length} of ${ordered.length} segments; reusing ${reusable.length}`;

  return { ordered, pending, reusable, rewound, resumeIndex, totalSegments: ordered.length, note };
}

/**
 * Audits stored audio against current text and voice, independent of any job
 * record. This is the "is my book actually intact?" check, and because it derives
 * everything from the segments themselves it stays correct even if progress
 * counters or job rows were lost.
 */
export function auditSegments(
  segments: PlannableSegment[],
  pinned: { provider: string; model: string },
  durations: Map<string, number | null> = new Map(),
  pronunciationHash?: string | null,
) {
  const ordered = orderSegments(segments);
  const missingSegments: string[] = [];
  const staleSegments: string[] = [];
  const mismatchedVoiceSegments: string[] = [];
  const suspectSegments: string[] = [];
  let renderedSegments = 0;
  let totalDurationMs = 0;

  for (const segment of ordered) {
    const check = checkReusable(segment, pinned, pronunciationHash);
    if (check.reusable) {
      renderedSegments++;
      const duration = durations.get(segment.id);
      if (duration && duration > 0) totalDurationMs += duration;
      // Audio present and matching but with no measured duration means the stored
      // payload was never verified; surface it rather than assume it plays.
      else if (duration === null) suspectSegments.push(segment.id);
      continue;
    }
    if (check.reason === "missing-audio") missingSegments.push(segment.id);
    else if (check.reason === "text-changed" || check.reason === "pronunciation-changed") staleSegments.push(segment.id);
    else mismatchedVoiceSegments.push(segment.id);
  }

  return {
    totalSegments: ordered.length,
    renderedSegments,
    missingSegments,
    staleSegments,
    mismatchedVoiceSegments,
    suspectSegments,
    totalDurationMs,
    complete: ordered.length > 0 && renderedSegments === ordered.length && suspectSegments.length === 0,
  };
}

/**
 * Where a chapter stands for export.
 *
 * - `ready`: every line has current, verified audio in the right voice.
 * - `outdated`: every line has audio, but some of it predates an edit, was
 *   voiced differently, or was never verified. It can still be exported as-is.
 * - `partial`: some lines have no audio yet.
 * - `unrendered`: no line has audio.
 * - `empty`: the chapter has no text to narrate.
 */
export type ChapterAudioState = "ready" | "outdated" | "partial" | "unrendered" | "empty";

export type ChapterAudioStatus = {
  chapterId: string;
  state: ChapterAudioState;
  totalSegments: number;
  /** Lines with any stored audio, current or not. */
  segmentsWithAudio: number;
  missing: number;
  stale: number;
  mismatchedVoice: number;
  unverified: number;
  /** Measured length of the stored audio. */
  durationMs: number;
};

/**
 * Per-chapter view of the same checks as `auditSegments`, so an export can
 * include the chapters that are done and leave out the ones that are not,
 * instead of refusing the whole book over one unfinished chapter.
 */
export function chapterAudioStates(
  segments: PlannableSegment[],
  pinned: { provider: string; model: string },
  durations: Map<string, number | null> = new Map(),
  chapterIds: string[] = [],
  pronunciationHash?: string | null,
): Map<string, ChapterAudioStatus> {
  const statuses = new Map<string, ChapterAudioStatus>();
  const blank = (chapterId: string): ChapterAudioStatus => ({
    chapterId, state: "empty", totalSegments: 0, segmentsWithAudio: 0, missing: 0, stale: 0, mismatchedVoice: 0, unverified: 0, durationMs: 0,
  });
  for (const chapterId of chapterIds) statuses.set(chapterId, blank(chapterId));

  for (const segment of orderSegments(segments)) {
    const status = statuses.get(segment.chapterId) ?? blank(segment.chapterId);
    statuses.set(segment.chapterId, status);
    status.totalSegments++;
    if (segment.audioStorageKey) {
      status.segmentsWithAudio++;
      const duration = durations.get(segment.id);
      if (duration && duration > 0) status.durationMs += duration;
    }
    const check = checkReusable(segment, pinned, pronunciationHash);
    if (check.reusable) {
      if (durations.get(segment.id) === null) status.unverified++;
      continue;
    }
    if (check.reason === "missing-audio") status.missing++;
    else if (check.reason === "text-changed" || check.reason === "pronunciation-changed") status.stale++;
    else status.mismatchedVoice++;
  }

  for (const status of statuses.values()) {
    status.state = !status.totalSegments
      ? "empty"
      : !status.segmentsWithAudio
        ? "unrendered"
        : status.missing
          ? "partial"
          : status.stale || status.mismatchedVoice || status.unverified
            ? "outdated"
            : "ready";
  }
  return statuses;
}

/** A chapter can go into an export when every line has audio. */
export const isExportableState = (state: ChapterAudioState): boolean => state === "ready" || state === "outdated";
