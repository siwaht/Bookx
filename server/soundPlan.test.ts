import { describe, expect, it } from "vitest";
import { CUE_TIMING, DEFAULT_MUSIC_TAG, IMPACT_FADE_IN_MS, SOUND_TAGS } from "./soundLibrary";
import {
  PLAN_RULES,
  cueEnvelope,
  cueGainDb,
  cueStartMs,
  duckThreshold,
  finalizeCuePlan,
  keywordMood,
  keywordProposals,
  layoutChapterCues,
  normalizeTag,
  parseScenePlanReply,
  renderForScenePlanning,
  type CueProposal,
  type PlanSegment,
} from "./soundPlan";

/** A chapter of `count` one-paragraph narration lines; `patch` overrides by index. */
function chapter(count: number, patch: Record<number, Partial<PlanSegment>> = {}): PlanSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    text: "The road went on between the hedges.",
    kind: "narration" as const,
    paragraph: index,
    ...patch[index],
  }));
}

const sfx = (index: number, tag: string): CueProposal => ({ kind: "sfx", index, tag });
const music = (index: number, tag: string): CueProposal => ({ kind: "music", index, tag });

describe("sound vocabulary", () => {
  it("has unique tags, and a prompt and recipe for every one", () => {
    const tags = SOUND_TAGS.map(definition => definition.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const definition of SOUND_TAGS) {
      expect(definition.prompt.length).toBeGreaterThan(10);
      expect(definition.synth.layers.length).toBeGreaterThan(0);
      expect(definition.durationSeconds).toBeGreaterThanOrEqual(0.5);
      expect(definition.kind === "music").toBe(definition.tag.startsWith("music-"));
    }
    expect(tags).toContain(DEFAULT_MUSIC_TAG);
  });

  it("keeps every expression free of characters that would break filtergraph quoting", () => {
    for (const definition of SOUND_TAGS) {
      for (const layer of definition.synth.layers) {
        const quoted = [...layer.source.matchAll(/'([^']*)'/g), ...(layer.filters ?? "").matchAll(/'([^']*)'/g)].map(match => match[1]!);
        for (const expression of quoted) expect(expression, definition.tag).not.toMatch(/[:;[\]]/);
      }
    }
  });
});

describe("renderForScenePlanning", () => {
  it("numbers lines chapter-wide and marks scene breaks", () => {
    const segments = chapter(3, { 1: { kind: "dialogue", text: "“Hurry,” she said." }, 2: { sceneBreakBefore: true, text: "Morning came." } });
    const [only, ...rest] = renderForScenePlanning(segments);
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({ first: 0, last: 2 });
    expect(only!.text).toBe([
      "[S1] narration: The road went on between the hedges.",
      "[S2] dialogue: “Hurry,” she said.",
      "--- scene break ---",
      "[S3] narration: Morning came.",
    ].join("\n"));
  });

  it("splits long chapters without restarting the numbering", () => {
    const chunks = renderForScenePlanning(chapter(40), 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.first).toBe(0);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index]!.first).toBe(chunks[index - 1]!.last + 1);
      expect(chunks[index]!.text.startsWith(`[S${chunks[index]!.first + 1}] `)).toBe(true);
    }
    expect(chunks.at(-1)!.last).toBe(39);
  });

  it("clips very long lines but keeps both ends, where sounds are often described", () => {
    const text = `Opening words. ${"filler ".repeat(400)}The thunder rolled.`;
    const [only] = renderForScenePlanning(chapter(1, { 0: { text } }));
    expect(only!.text.length).toBeLessThan(1_300);
    expect(only!.text).toContain("Opening words.");
    expect(only!.text).toContain("The thunder rolled.");
    expect(only!.text).toContain(" … ");
  });
});

describe("reading the model's reply", () => {
  const chunk = { text: "", first: 10, last: 19 };

  it("maps segment ids back and keeps only known tags inside the chunk", () => {
    const proposals = parseScenePlanReply({
      scenes: [{ start: "S11", mood: "romantic" }, { start: "S5", mood: "music-tense" }, { start: "S12", mood: "disco" }],
      effects: [{ after: "[S12]", sound: "Sword" }, { after: "S13", sound: "none" }, { after: "S14", sound: "kazoo" }, { after: "S30", sound: "rain" }],
    }, chunk);
    expect(proposals).toEqual([
      { kind: "music", index: 10, tag: "music-romantic" },
      { kind: "sfx", index: 11, tag: "swords" },
    ]);
  });

  it("treats a malformed reply as no proposals", () => {
    expect(parseScenePlanReply(null, chunk)).toEqual([]);
    expect(parseScenePlanReply({ scenes: "S11", effects: [42] }, chunk)).toEqual([]);
  });

  it("normalizes near-miss tags", () => {
    expect(normalizeTag("music-tense", "music")).toBe("music-tense");
    expect(normalizeTag("Tense", "music")).toBe("music-tense");
    expect(normalizeTag("rainfall", "sfx")).toBe("rain");
    expect(normalizeTag("Church Bell", "sfx")).toBe("bell");
    expect(normalizeTag("sword_clash", "sfx")).toBe("swords");
    expect(normalizeTag("none", "sfx")).toBeNull();
    expect(normalizeTag("rain", "music")).toBeNull();
  });
});

describe("keyword rules", () => {
  it("reads a scene's mood only when the wording clearly leans one way", () => {
    expect(keywordMood("They fought on. Swords clashed and he struck again, then charged the gate.")).toBe("music-action");
    expect(keywordMood("She kissed him, and her love for him was tender and certain.")).toBe("music-romantic");
    expect(keywordMood("The kettle boiled and the post arrived.")).toBeNull();
  });

  it("proposes effects from narration only, and a mood for every scene", () => {
    const segments = chapter(4, {
      0: { text: "Rain drummed on the roof all evening." },
      1: { kind: "dialogue", text: "“Listen to the rain!”" },
      3: { sceneBreakBefore: true, text: "Somebody knocked twice at the door." },
    });
    expect(keywordProposals(segments)).toEqual([
      { kind: "music", index: 0, tag: DEFAULT_MUSIC_TAG },
      { kind: "music", index: 3, tag: DEFAULT_MUSIC_TAG },
      { kind: "sfx", index: 0, tag: "rain" },
      { kind: "sfx", index: 3, tag: "knock" },
    ]);
  });
});

describe("finalizeCuePlan", () => {
  it("opens the chapter and every marked scene break with music, even with no proposals", () => {
    const cues = finalizeCuePlan(chapter(30, { 15: { sceneBreakBefore: true } }), []);
    expect(cues).toEqual([
      { kind: "music", index: 0, tag: DEFAULT_MUSIC_TAG, placement: "before" },
      { kind: "music", index: 15, tag: DEFAULT_MUSIC_TAG, placement: "before" },
    ]);
  });

  it("takes the model's mood, including one marked a line after the scene starts", () => {
    const cues = finalizeCuePlan(chapter(20), [music(1, "music-tense")]);
    expect(cues).toEqual([{ kind: "music", index: 0, tag: "music-tense", placement: "before" }]);
  });

  it("accepts an unmarked scene change only at a paragraph start with a real scene on either side", () => {
    const segments = chapter(80, { 31: { paragraph: 30 }, 70: { sceneBreakBefore: true } });
    const cues = finalizeCuePlan(segments, [
      music(31, "music-sad"), // mid-paragraph
      music(40, "music-action"), // accepted
      music(50, "music-dark"), // too soon after 40
      music(66, "music-light"), // far enough from 40, but too close to the break at 70
    ]).filter(cue => cue.kind === "music");
    expect(cues.map(cue => [cue.index, cue.tag])).toEqual([[0, DEFAULT_MUSIC_TAG], [40, "music-action"], [70, DEFAULT_MUSIC_TAG]]);
  });

  it("gives two neighbouring scenes with the same mood one swell, unless the text marks a break", () => {
    const unmarked = finalizeCuePlan(chapter(60), [music(0, "music-romantic"), music(30, "music-romantic")]);
    expect(unmarked.map(cue => cue.index)).toEqual([0]);
    const marked = finalizeCuePlan(chapter(60, { 30: { sceneBreakBefore: true } }), [music(0, "music-romantic"), music(30, "music-romantic")]);
    expect(marked.map(cue => cue.index)).toEqual([0, 30]);
  });

  it("moves an effect proposed on dialogue to the next narration line, never across a scene break", () => {
    const segments = chapter(30, {
      1: { kind: "dialogue" }, 2: { kind: "dialogue" },
      20: { kind: "dialogue" }, 21: { sceneBreakBefore: true },
    });
    const effects = finalizeCuePlan(segments, [sfx(1, "rain"), sfx(20, "thunder")]).filter(cue => cue.kind === "sfx");
    expect(effects).toEqual([{ kind: "sfx", index: 3, tag: "rain", placement: "after" }]);
  });

  it("never puts an effect in the pause that belongs to a music swell", () => {
    const effects = finalizeCuePlan(chapter(20, { 10: { sceneBreakBefore: true } }), [sfx(9, "door")]).filter(cue => cue.kind === "sfx");
    expect(effects).toEqual([]);
  });

  it("keeps effects apart and rarely repeats one within a scene", () => {
    const segments = chapter(90, { 50: { sceneBreakBefore: true } });
    const effects = finalizeCuePlan(segments, [
      sfx(5, "rain"),
      sfx(7, "thunder"), // too close to the rain
      sfx(20, "thunder"), // same scene, too soon
      sfx(40, "rain"), // same scene, same sound
      sfx(45, "thunder"), // same scene, far enough apart
      sfx(49, "wind"), // its pause opens the next scene
      sfx(52, "rain"), // a new scene
    ]).filter(cue => cue.kind === "sfx");
    expect(effects.map(cue => [cue.index, cue.tag])).toEqual([[5, "rain"], [45, "thunder"], [52, "rain"]]);
    for (let index = 1; index < effects.length; index++) {
      expect(effects[index]!.index - effects[index - 1]!.index).toBeGreaterThanOrEqual(PLAN_RULES.minEffectSpacing);
    }
  });

  it("drops unknown tags and positions outside the chapter", () => {
    const cues = finalizeCuePlan(chapter(10), [sfx(3, "kazoo"), sfx(99, "rain"), music(0, "music-disco")]);
    expect(cues).toEqual([{ kind: "music", index: 0, tag: DEFAULT_MUSIC_TAG, placement: "before" }]);
  });

  it("plans nothing for an empty chapter", () => {
    expect(finalizeCuePlan([], [sfx(0, "rain")])).toEqual([]);
  });
});

describe("layout", () => {
  it("widens only the pauses a cue plays in", () => {
    const layout = layoutChapterCues([350, 150, 350, 1400, 350], [
      { index: 1, kind: "sfx", placement: "after" },
      { index: 4, kind: "music", placement: "before" },
    ], 350);
    expect(layout).toEqual({ gaps: [350, CUE_TIMING.sfx.gapAfterMs, 350, CUE_TIMING.music.gapBeforeMs, 0], leadInMs: 0, tailMs: 0 });
  });

  it("opens the chapter with a lead-in and lets an effect on the last line ring out", () => {
    const layout = layoutChapterCues([350, 350], [
      { index: 0, kind: "music", placement: "before" },
      { index: 1, kind: "sfx", placement: "after" },
    ], 350);
    expect(layout.leadInMs).toBe(CUE_TIMING.music.gapBeforeMs);
    expect(layout.tailMs).toBe(CUE_TIMING.sfx.afterOffsetMs + CUE_TIMING.sfx.maxMs);
    expect(layout.gaps).toEqual([350, 0]);
  });

  it("never shortens a pause that is already long enough, and fills missing pauses", () => {
    const layout = layoutChapterCues([3000, null, undefined], [{ index: 0, kind: "sfx", placement: "after" }], 350);
    expect(layout.gaps).toEqual([3000, 350, 0]);
  });

  it("starts effects after their line and music swells before theirs", () => {
    expect(cueStartMs({ startMs: 5000, durationMs: 3000 }, { kind: "sfx", placement: "after" })).toBe(8000 + CUE_TIMING.sfx.afterOffsetMs);
    expect(cueStartMs({ startMs: 5000, durationMs: 3000 }, { kind: "music", placement: "before" })).toBe(5000 - CUE_TIMING.music.preRollMs);
    expect(cueStartMs({ startMs: 1000, durationMs: 3000 }, { kind: "music", placement: "before" })).toBe(0);
  });

  it("shapes cues: impacts keep their attack, textures fade in, nothing outlasts its cap", () => {
    expect(cueEnvelope("knock", "sfx", 1300)).toEqual({ lengthMs: 1300, fadeInMs: IMPACT_FADE_IN_MS, fadeOutMs: 650 });
    expect(cueEnvelope("rain", "sfx", 3210)).toEqual({ lengthMs: CUE_TIMING.sfx.maxMs, fadeInMs: CUE_TIMING.sfx.fadeInMs, fadeOutMs: CUE_TIMING.sfx.fadeOutMs });
    expect(cueEnvelope("music-calm", "music", 6190)).toEqual({ lengthMs: CUE_TIMING.music.maxMs, fadeInMs: CUE_TIMING.music.fadeInMs, fadeOutMs: CUE_TIMING.music.fadeOutMs });
    expect(cueEnvelope("rain", "sfx", 0).lengthMs).toBe(CUE_TIMING.sfx.maxMs);
  });
});

describe("levels", () => {
  const rain = { assetMeanDb: -26, assetPeakDb: -9 };

  it("places a cue under the narration by whichever limit is quieter", () => {
    // Mean limit: -20 - 24 + 26 = -18 dB. Peak limit: -20 - 10 + 9 = -21 dB.
    expect(cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "very-subtle", ...rain })).toBe(-21);
    // A steady texture with little crest is set by its average instead.
    expect(cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "very-subtle", assetMeanDb: -26, assetPeakDb: -20 })).toBe(-18);
  });

  it("makes Subtle 6 dB louder than Very subtle and applies the creator's trim", () => {
    const quiet = cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "very-subtle", ...rain });
    expect(cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "subtle", ...rain })).toBe(quiet + 6);
    expect(cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "very-subtle", ...rain, trimDb: -3 })).toBe(quiet - 3);
  });

  it("puts music lower than effects at the same level", () => {
    const asset = { assetMeanDb: -26, assetPeakDb: -14 };
    expect(cueGainDb({ narrationMeanDb: -20, kind: "music", level: "very-subtle", ...asset }))
      .toBeLessThan(cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "very-subtle", ...asset }));
  });

  it("survives silent narration and silent assets", () => {
    expect(cueGainDb({ narrationMeanDb: -91, kind: "sfx", level: "very-subtle", ...rain })).toBe(cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "very-subtle", ...rain }));
    expect(cueGainDb({ narrationMeanDb: -20, kind: "sfx", level: "subtle", assetMeanDb: -91, assetPeakDb: -91 })).toBe(12);
  });

  it("ducks from about 10 dB under the narration's mean", () => {
    expect(duckThreshold(-20)).toBeCloseTo(10 ** (-30 / 20), 4);
    expect(duckThreshold(-95)).toBe(duckThreshold(-20));
    expect(duckThreshold(10)).toBe(0.5);
  });
});
