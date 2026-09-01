import { describe, expect, it } from "vitest";
import { auditSegments, checkReusable, orderSegments, planNarrationRun, type PlannableSegment } from "./narrationPlan";
import { hashSegmentText } from "./textSegmentation";

const PINNED = { provider: "Cloudflare", model: "@cf/deepgram/aura-2-en" };

/** A segment whose stored audio is valid for PINNED unless overridden. */
function rendered(id: string, orderIndex: number, overrides: Partial<PlannableSegment> = {}): PlannableSegment {
  const text = overrides.text ?? `Segment ${id} text body.`;
  return {
    id,
    chapterId: overrides.chapterId ?? "ch1",
    orderIndex,
    chapterOrderIndex: overrides.chapterOrderIndex ?? 0,
    text,
    textHash: hashSegmentText(text),
    audioStorageKey: `key/${id}.mp3`,
    voiceProvider: PINNED.provider,
    voiceModel: PINNED.model,
    voiceId: null,
    ...overrides,
  };
}

/** A segment with no audio yet. */
function pending(id: string, orderIndex: number, overrides: Partial<PlannableSegment> = {}): PlannableSegment {
  return {
    ...rendered(id, orderIndex, overrides),
    textHash: null,
    audioStorageKey: null,
    voiceProvider: null,
    voiceModel: null,
    ...overrides,
  };
}

const ids = (segments: PlannableSegment[]) => segments.map(segment => segment.id);

describe("orderSegments", () => {
  it("orders by chapter, then position, then id", () => {
    const segments = [
      rendered("b", 1, { chapterOrderIndex: 1 }),
      rendered("a", 0, { chapterOrderIndex: 1 }),
      rendered("z", 0, { chapterOrderIndex: 0 }),
      rendered("y", 0, { chapterOrderIndex: 0 }),
    ];
    expect(ids(orderSegments(segments))).toEqual(["y", "z", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const segments = [rendered("b", 1), rendered("a", 0)];
    orderSegments(segments);
    expect(ids(segments)).toEqual(["b", "a"]);
  });
});

describe("checkReusable", () => {
  it("reuses audio that matches text and voice", () => {
    expect(checkReusable(rendered("s1", 0), PINNED)).toEqual({ reusable: true });
  });

  it("re-renders when audio is missing", () => {
    expect(checkReusable(pending("s1", 0), PINNED)).toEqual({ reusable: false, reason: "missing-audio" });
  });

  it("re-renders when the text has changed since the audio was made", () => {
    const segment = rendered("s1", 0);
    const edited = { ...segment, text: "Edited text body." };
    expect(checkReusable(edited, PINNED)).toEqual({ reusable: false, reason: "text-changed" });
  });

  it("re-renders when the audio has no recorded hash", () => {
    const segment = { ...rendered("s1", 0), textHash: null };
    expect(checkReusable(segment, PINNED)).toEqual({ reusable: false, reason: "text-changed" });
  });

  it("re-renders when the project voice changed", () => {
    const segment = rendered("s1", 0);
    expect(checkReusable(segment, { provider: "ElevenLabs", model: "eleven_v3" })).toEqual({
      reusable: false,
      reason: "voice-changed",
    });
  });

  it("re-renders when a character's voice id changed", () => {
    const segment = rendered("s1", 0, { voiceId: "iris-narrative", targetVoiceId: "theo-dramatic" });
    expect(checkReusable(segment, PINNED)).toEqual({ reusable: false, reason: "voice-changed" });
  });

  it("reuses when the character voice id still matches", () => {
    const segment = rendered("s1", 0, { voiceId: "iris-narrative", targetVoiceId: "iris-narrative" });
    expect(checkReusable(segment, PINNED)).toEqual({ reusable: true });
  });
});

describe("planNarrationRun", () => {
  it("handles an empty project", () => {
    const plan = planNarrationRun({ segments: [], pinned: PINNED });
    expect(plan).toMatchObject({ totalSegments: 0, pending: [], reusable: [] });
  });

  it("renders everything on a first run", () => {
    const segments = [pending("s1", 0), pending("s2", 1), pending("s3", 2)];
    const plan = planNarrationRun({ segments, pinned: PINNED });
    expect(ids(plan.pending)).toEqual(["s1", "s2", "s3"]);
    expect(plan.reusable).toHaveLength(0);
  });

  it("reuses valid audio and only renders the gaps", () => {
    const segments = [rendered("s1", 0), pending("s2", 1), rendered("s3", 2)];
    const plan = planNarrationRun({ segments, pinned: PINNED });
    expect(ids(plan.pending)).toEqual(["s2"]);
    expect(ids(plan.reusable)).toEqual(["s1", "s3"]);
  });

  it("re-renders everything when forced", () => {
    const segments = [rendered("s1", 0), rendered("s2", 1)];
    const plan = planNarrationRun({ segments, pinned: PINNED, force: true });
    expect(ids(plan.pending)).toEqual(["s1", "s2"]);
    expect(plan.reusable).toHaveLength(0);
  });

  // The behaviour the whole design exists for.
  it("rewinds before the interruption point on resume", () => {
    const segments = Array.from({ length: 10 }, (_, index) => rendered(`s${index}`, index));
    const plan = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "s5", rewindSegments: 2 });

    // s3 and s4 verified fine but were written as the connection degraded, and s5
    // was in flight, so all three are redone.
    expect(plan.resumeIndex).toBe(3);
    expect(plan.rewound).toEqual(["s3", "s4", "s5"]);
    expect(ids(plan.pending)).toEqual(["s3", "s4", "s5"]);
    // Everything before the window, and everything already valid after it, is kept.
    expect(ids(plan.reusable)).toEqual(["s0", "s1", "s2", "s6", "s7", "s8", "s9"]);
  });

  it("re-renders only the in-flight segment when the rewind is zero", () => {
    const segments = Array.from({ length: 6 }, (_, index) => rendered(`s${index}`, index));
    const plan = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "s4", rewindSegments: 0 });
    expect(plan.resumeIndex).toBe(4);
    expect(plan.rewound).toEqual(["s4"]);
  });

  it("clamps the rewind at the start of the book", () => {
    const segments = Array.from({ length: 5 }, (_, index) => rendered(`s${index}`, index));
    const plan = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "s1", rewindSegments: 10 });
    expect(plan.resumeIndex).toBe(0);
    expect(plan.rewound).toEqual(["s0", "s1"]);
  });

  it("still renders unrendered segments after the cursor", () => {
    const segments = [rendered("s0", 0), rendered("s1", 1), pending("s2", 2), pending("s3", 3)];
    const plan = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "s1", rewindSegments: 1 });
    expect(ids(plan.pending)).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("falls back to a full gap-fill when the cursor no longer exists", () => {
    const segments = [rendered("s0", 0), pending("s1", 1)];
    const plan = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "deleted", rewindSegments: 2 });
    expect(plan.resumeIndex).toBe(0);
    expect(plan.rewound).toEqual([]);
    expect(ids(plan.pending)).toEqual(["s1"]);
  });

  it("scopes the run to selected chapters", () => {
    const segments = [
      pending("a1", 0, { chapterId: "ch1", chapterOrderIndex: 0 }),
      pending("b1", 0, { chapterId: "ch2", chapterOrderIndex: 1 }),
    ];
    const plan = planNarrationRun({ segments, pinned: PINNED, chapterIds: ["ch2"] });
    expect(ids(plan.pending)).toEqual(["b1"]);
    expect(plan.totalSegments).toBe(1);
  });

  it("keeps pending order in playback order across chapters", () => {
    const segments = [
      pending("b2", 1, { chapterId: "ch2", chapterOrderIndex: 1 }),
      pending("a1", 0, { chapterId: "ch1", chapterOrderIndex: 0 }),
      pending("b1", 0, { chapterId: "ch2", chapterOrderIndex: 1 }),
    ];
    const plan = planNarrationRun({ segments, pinned: PINNED });
    expect(ids(plan.pending)).toEqual(["a1", "b1", "b2"]);
  });

  it("describes what it decided", () => {
    const segments = Array.from({ length: 4 }, (_, index) => rendered(`s${index}`, index));
    const resumed = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "s2", rewindSegments: 1 });
    expect(resumed.note).toMatch(/Resuming at segment 2 of 4/);
    expect(resumed.note).toMatch(/re-rendering 2 segment\(s\)/);
  });

  it("is deterministic for the same input", () => {
    const segments = Array.from({ length: 8 }, (_, index) => rendered(`s${index}`, index));
    const first = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "s4", rewindSegments: 2 });
    const second = planNarrationRun({ segments, pinned: PINNED, cursorSegmentId: "s4", rewindSegments: 2 });
    expect(ids(first.pending)).toEqual(ids(second.pending));
    expect(first.rewound).toEqual(second.rewound);
  });
});

describe("auditSegments", () => {
  it("reports a complete book", () => {
    const segments = [rendered("s1", 0), rendered("s2", 1)];
    const durations = new Map([["s1", 1000], ["s2", 2000]]);
    const audit = auditSegments(segments, PINNED, durations);
    expect(audit).toMatchObject({ complete: true, renderedSegments: 2, totalDurationMs: 3000 });
    expect(audit.missingSegments).toEqual([]);
  });

  it("separates missing, stale and mismatched-voice segments", () => {
    const stale = { ...rendered("s2", 1), text: "changed" };
    const wrongVoice = rendered("s3", 2, { voiceId: "old", targetVoiceId: "new" });
    const audit = auditSegments([pending("s1", 0), stale, wrongVoice], PINNED, new Map());
    expect(audit.missingSegments).toEqual(["s1"]);
    expect(audit.staleSegments).toEqual(["s2"]);
    expect(audit.mismatchedVoiceSegments).toEqual(["s3"]);
    expect(audit.complete).toBe(false);
  });

  it("flags rendered audio with no measured duration as suspect", () => {
    const audit = auditSegments([rendered("s1", 0)], PINNED, new Map([["s1", null]]));
    expect(audit.suspectSegments).toEqual(["s1"]);
    expect(audit.complete).toBe(false);
  });

  it("is never complete for a project with no segments", () => {
    expect(auditSegments([], PINNED).complete).toBe(false);
  });
});
