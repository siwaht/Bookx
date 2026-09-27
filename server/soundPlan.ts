import { z } from "zod";
import {
  CUE_TIMING,
  DEFAULT_MUSIC_TAG,
  DEFAULT_SOUND_LEVEL,
  IMPACT_FADE_IN_MS,
  SOUND_LEVELS,
  isSoundTag,
  musicTags,
  sfxTags,
  soundTag,
  type SoundKind,
  type SoundLevel,
} from "./soundLibrary";

/**
 * Deciding where sounds go, and how they sit in the mix.
 *
 * Everything here is pure: the scene analysis (a language model, or keyword
 * rules when there is none) only *proposes* cues, and `finalizeCuePlan`
 * enforces the sparsity rules that keep sound in the background no matter what
 * was proposed. Layout and gain maths live here too so they can be tested
 * without ffmpeg.
 */

export type PlanSegment = {
  id: string;
  text: string;
  kind?: "narration" | "dialogue";
  paragraph?: number;
  sceneBreakBefore?: boolean;
};

export type CueProposal = { kind: SoundKind; index: number; tag: string };

export type PlannedCue = { kind: SoundKind; index: number; tag: string; placement: "before" | "after" };

export const PLAN_RULES = {
  /** A scene change the text does not mark needs this many segments since the last scene start. */
  minSceneSegments: 24,
  /** ...and this many before the next marked one, so two swells never stack up. */
  minSceneTail: 12,
  /** Segments between any two effects, even across a scene change. */
  minEffectSpacing: 4,
  /** A second effect in the same scene needs this much room. */
  sameSceneEffectSpacing: 30,
  /** How far an effect proposed on dialogue may move to the next narration line. */
  anchorSearch: 3,
  /** A model may mark a scene's mood a line or two after it starts. */
  moodLookahead: 6,
};

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const PLAN_CHUNK_CHARS = 16_000;
const PLAN_LINE_CHARS = 1_200;

export type PlanChunk = { text: string; first: number; last: number };

function clipLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PLAN_LINE_CHARS) return flat;
  return `${flat.slice(0, 700)} … ${flat.slice(-400)}`;
}

/**
 * Lays a chapter out as numbered lines for the model: `[S12] narration: …`.
 * Long chapters are split; numbering stays chapter-wide so replies map back.
 */
export function renderForScenePlanning(segments: PlanSegment[], maxChars = PLAN_CHUNK_CHARS): PlanChunk[] {
  const chunks: PlanChunk[] = [];
  let lines: string[] = [];
  let size = 0;
  let first = 0;
  segments.forEach((segment, index) => {
    const line = `${segment.sceneBreakBefore && index > 0 ? "--- scene break ---\n" : ""}[S${index + 1}] ${segment.kind === "dialogue" ? "dialogue" : "narration"}: ${clipLine(segment.text)}`;
    if (lines.length && size + line.length > maxChars) {
      chunks.push({ text: lines.join("\n"), first, last: index - 1 });
      lines = [];
      size = 0;
      first = index;
    }
    lines.push(line);
    size += line.length + 1;
  });
  if (lines.length) chunks.push({ text: lines.join("\n"), first, last: segments.length - 1 });
  return chunks;
}

export function scenePlanSystemPrompt(): string {
  const moods = musicTags().map(definition => `  ${definition.tag}: ${definition.hint}`).join("\n");
  const effects = sfxTags().map(definition => `  ${definition.tag}: ${definition.hint}`).join("\n");
  return [
    "You are the sound designer for an audiobook. The listener should barely notice the sound: it stays far in the background and never competes with the narration.",
    "You get part of one chapter as numbered segments. \"[S12] narration: ...\" is segment 12; \"--- scene break ---\" marks a break in the text.",
    "",
    "Return only JSON:",
    "{\"scenes\":[{\"start\":\"S1\",\"mood\":\"music-calm\"}],\"effects\":[{\"after\":\"S7\",\"sound\":\"rain\"}]}",
    "",
    "Scenes (a short, soft music swell opens each one):",
    "- A scene starts at the chapter's first segment, after every scene break, and where the setting or mood clearly changes: a new place, a jump in time, a fight breaking out. Most chapters have one to four scenes.",
    "- If this part starts in the middle of a chapter, its first segment continues the previous scene unless the text shows a new one.",
    "- Give each scene the single mood that fits it best. A fight or battle is music-action; a threatening or suspenseful stretch music-tense; a love scene music-romantic; a light, happy scene music-light; use music-calm when the scene is neutral.",
    "Moods:",
    moods,
    "",
    "Effects (a sound under a second long, played very quietly in the pause after a line):",
    "- Only for a sound the narration says is actually happening in the scene: rain falling, thunder, swords clashing, a knock, footsteps, a door. \"after\" is the narration segment that describes it.",
    "- Never for metaphors (\"her voice thundered\"), memories, plans, or sounds only mentioned in dialogue.",
    "- Be sparing: at most one effect per scene, and none at all is fine. When in doubt, leave it out.",
    "Effects:",
    effects,
  ].join("\n");
}

export function scenePlanUserPrompt(input: { bookTitle: string; chapterTitle: string; chunk: PlanChunk; total: number }): string {
  const range = input.chunk.first === 0 && input.chunk.last === input.total - 1
    ? `The whole chapter: S1 to S${input.total}.`
    : `This part covers S${input.chunk.first + 1} to S${input.chunk.last + 1} of S${input.total}${input.chunk.first === 0 ? "" : "; it continues from the previous part"}.`;
  return `Book: ${input.bookTitle}\nChapter: ${input.chapterTitle}\n${range}\n\n${input.chunk.text}`;
}

// ---------------------------------------------------------------------------
// Reading replies
// ---------------------------------------------------------------------------

const TAG_ALIASES: Record<string, string> = {
  rainfall: "rain", raining: "rain", downpour: "rain", storm: "thunder", thunderstorm: "thunder", lightning: "thunder",
  gust: "wind", breeze: "wind", gale: "wind", sword: "swords", "sword clash": "swords", "swords clashing": "swords", clash: "swords",
  fight: "battle", war: "battle", melee: "battle", footstep: "footsteps", steps: "footsteps", walking: "footsteps",
  "door creak": "door", "door slam": "door", doors: "door", knocking: "knock", knocks: "knock", hooves: "horse", horses: "horse",
  gallop: "horse", fireplace: "fire", campfire: "fire", crackling: "fire", sea: "waves", ocean: "waves", surf: "waves",
  bird: "birds", birdsong: "birds", cricket: "crickets", bells: "bell", "church bell": "bell", ticking: "clock",
  murmur: "crowd", tavern: "crowd", gun: "gunshot", shot: "gunshot", gunfire: "gunshot", blast: "explosion",
  heart: "heartbeat", clink: "glass", "breaking glass": "glass", paper: "page", "page turn": "page",
};

/** Maps a model's tag (or a near miss like "romantic" / "sword") onto the vocabulary. */
export function normalizeTag(raw: string, kind: SoundKind): string | null {
  const value = raw.trim().toLowerCase().replace(/[_]+/g, "-").replace(/\s+/g, " ");
  if (!value || value === "none") return null;
  if (kind === "music") {
    const tag = value.startsWith("music-") ? value : `music-${value.replace(/^music /, "")}`;
    return isSoundTag(tag, "music") ? tag : null;
  }
  if (isSoundTag(value, "sfx")) return value;
  const alias = TAG_ALIASES[value] ?? TAG_ALIASES[value.replace(/-/g, " ")];
  return alias && isSoundTag(alias, "sfx") ? alias : null;
}

function segmentIndex(raw: unknown, chunk: PlanChunk): number | null {
  const match = /(\d+)/.exec(String(raw ?? ""));
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= chunk.first && index <= chunk.last ? index : null;
}

const loose = z.array(z.record(z.string(), z.unknown())).catch([]);
const replySchema = z.object({ scenes: loose.optional(), effects: loose.optional() }).passthrough();

/** Turns a model reply into proposals, dropping anything outside the chunk or the vocabulary. */
export function parseScenePlanReply(reply: unknown, chunk: PlanChunk): CueProposal[] {
  const parsed = replySchema.parse(reply ?? {});
  const proposals: CueProposal[] = [];
  for (const scene of parsed.scenes ?? []) {
    const index = segmentIndex(scene.start ?? scene.segment ?? scene.at, chunk);
    const tag = normalizeTag(String(scene.mood ?? scene.music ?? scene.tag ?? ""), "music");
    if (index !== null && tag) proposals.push({ kind: "music", index, tag });
  }
  for (const effect of parsed.effects ?? []) {
    const index = segmentIndex(effect.after ?? effect.segment ?? effect.at, chunk);
    const tag = normalizeTag(String(effect.sound ?? effect.effect ?? effect.tag ?? ""), "sfx");
    if (index !== null && tag) proposals.push({ kind: "sfx", index, tag });
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Rule-based proposals (no language model)
// ---------------------------------------------------------------------------

const MOOD_WORDS: Array<[string, RegExp]> = [
  ["music-action", /\b(fight\w*|fought|battle\w*|sword\w*|blades?|clash\w*|charg(?:e|ed|ing)|attack\w*|struck|strike|lunged|parr\w*|chase\w*|fled|ran)\b/gi],
  ["music-romantic", /\b(kiss\w*|lov(?:e|ed|er|ers|ing)|tender\w*|embrac\w*|caress\w*|blush\w*|darling|beloved|longing)\b/gi],
  ["music-tense", /\b(fear\w*|dread\w*|afraid|terror|creep\w*|shadows?|trembl\w*|danger\w*|menac\w*|uneas\w*|suspicio\w*)\b/gi],
  ["music-sad", /\b(tears?|wept|weep\w*|grief|griev\w*|mourn\w*|sorrow\w*|funeral|lonely|sobb\w*)\b/gi],
  ["music-dark", /\b(death|dead|corpse\w*|blood\w*|evil|curse\w*|graves?|doom\w*|cruel\w*)\b/gi],
  ["music-mystery", /\b(myster\w*|strange\w*|secret\w*|puzzl\w*|riddle\w*|clues?|uncanny|whisper\w*)\b/gi],
  ["music-light", /\b(laugh\w*|smil\w*|sunny|sunshine|cheer\w*|merr\w*|jok(?:e|es|ed|ing)|delight\w*|grinn\w*|giggl\w*)\b/gi],
  ["music-hopeful", /\b(hope\w*|dawn\w*|promise\w*|relie(?:f|ved)|at last|new day)\b/gi],
  ["music-epic", /\b(kings?|kingdom|armies|army|legions?|throne|glory|destiny|empire)\b/gi],
];

/** The mood with the most keyword hits, when it clearly leads; null when unclear. */
export function keywordMood(text: string): string | null {
  const scores = MOOD_WORDS.map(([tag, pattern]) => [tag, (text.match(pattern) ?? []).length] as const).sort((left, right) => right[1] - left[1]);
  const [best, runnerUp] = scores;
  if (!best || best[1] < 2) return null;
  if (runnerUp && runnerUp[1] * 1.5 > best[1] && runnerUp[1] >= 2) {
    // A fight scene full of fear words is still a fight scene; otherwise too close to call.
    return best[0] === "music-action" ? best[0] : null;
  }
  return best[0];
}

function hardSceneStarts(segments: PlanSegment[]): number[] {
  return segments.map((segment, index) => (index === 0 || segment.sceneBreakBefore ? index : -1)).filter(index => index >= 0);
}

/** Effects from sound words in the narration, moods from scene vocabulary. */
export function keywordProposals(segments: PlanSegment[]): CueProposal[] {
  const proposals: CueProposal[] = [];
  const starts = hardSceneStarts(segments);
  starts.forEach((start, position) => {
    const end = starts[position + 1] ?? segments.length;
    const text = segments.slice(start, end).map(segment => segment.text).join("\n");
    proposals.push({ kind: "music", index: start, tag: keywordMood(text) ?? DEFAULT_MUSIC_TAG });
  });
  segments.forEach((segment, index) => {
    if (segment.kind === "dialogue") return;
    const match = sfxTags().find(definition => definition.keywords?.test(segment.text));
    if (match) proposals.push({ kind: "sfx", index, tag: match.tag });
  });
  return proposals;
}

// ---------------------------------------------------------------------------
// The sparsity rules
// ---------------------------------------------------------------------------

/**
 * Turns proposals into the cues that will actually play.
 *
 * - Music only opens scenes: the chapter start, marked scene breaks, and model
 *   scene changes that begin a paragraph and leave a real scene either side.
 *   Two neighbouring scenes with the same mood get one swell.
 * - Effects hang off narration (never dialogue), are at least
 *   `minEffectSpacing` segments apart, rarely repeat within a scene, and never
 *   share a pause with a music swell.
 */
export function finalizeCuePlan(segments: PlanSegment[], proposals: CueProposal[]): PlannedCue[] {
  const count = segments.length;
  if (!count) return [];
  const valid = proposals.filter(proposal => proposal.index >= 0 && proposal.index < count && isSoundTag(proposal.tag, proposal.kind));
  const startsParagraph = (index: number) =>
    index === 0 || segments[index]!.paragraph === undefined || segments[index]!.paragraph !== segments[index - 1]!.paragraph;

  // ---- Scenes ---------------------------------------------------------------
  const hard = new Set(hardSceneStarts(segments));
  const starts = [...hard].sort((left, right) => left - right);
  const musicProposals = valid.filter(proposal => proposal.kind === "music").sort((left, right) => left.index - right.index);
  for (const proposal of musicProposals) {
    if (hard.has(proposal.index) || starts.includes(proposal.index) || !startsParagraph(proposal.index)) continue;
    const previous = Math.max(...starts.filter(start => start < proposal.index));
    const next = starts.find(start => start > proposal.index);
    if (proposal.index - previous < PLAN_RULES.minSceneSegments) continue;
    if (next !== undefined && next - proposal.index < PLAN_RULES.minSceneTail) continue;
    starts.push(proposal.index);
    starts.sort((left, right) => left - right);
  }

  const scenes = starts.map((start, position) => ({ start, end: starts[position + 1] ?? count, mood: DEFAULT_MUSIC_TAG, merged: false }));
  for (const scene of scenes) {
    const exact = musicProposals.find(proposal => proposal.index === scene.start);
    const near = musicProposals.find(proposal => proposal.index > scene.start && proposal.index < Math.min(scene.end, scene.start + PLAN_RULES.moodLookahead));
    scene.mood = exact?.tag ?? near?.tag ?? keywordMood(segments.slice(scene.start, scene.end).map(segment => segment.text).join("\n")) ?? DEFAULT_MUSIC_TAG;
  }
  for (let position = 1; position < scenes.length; position++) {
    const scene = scenes[position]!;
    if (!hard.has(scene.start) && scene.mood === scenes[position - 1]!.mood) scene.merged = true;
  }
  const cues: PlannedCue[] = scenes.filter(scene => !scene.merged).map(scene => ({ kind: "music", index: scene.start, tag: scene.mood, placement: "before" }));
  const musicAt = new Set(cues.map(cue => cue.index));
  const sceneStarts = scenes.filter(scene => !scene.merged).map(scene => scene.start);
  const sceneOf = (index: number) => sceneStarts.filter(start => start <= index).length - 1;

  // ---- Effects --------------------------------------------------------------
  const seen = new Set<number>();
  const effects = valid.filter(proposal => proposal.kind === "sfx").sort((left, right) => left.index - right.index);
  let lastIndex = -Infinity;
  let lastScene = -1;
  const tagsInScene = new Set<string>();
  for (const proposal of effects) {
    let anchor: number | null = proposal.index;
    if (segments[anchor]!.kind === "dialogue") {
      anchor = null;
      for (let step = 1; step <= PLAN_RULES.anchorSearch && proposal.index + step < count; step++) {
        const candidate = proposal.index + step;
        if (segments[candidate]!.sceneBreakBefore) break;
        if (segments[candidate]!.kind !== "dialogue") {
          anchor = candidate;
          break;
        }
      }
    }
    if (anchor === null || seen.has(anchor)) continue;
    if (musicAt.has(anchor + 1)) continue;
    if (anchor - lastIndex < PLAN_RULES.minEffectSpacing) continue;
    const scene = sceneOf(anchor);
    if (scene === lastScene && (anchor - lastIndex < PLAN_RULES.sameSceneEffectSpacing || tagsInScene.has(proposal.tag))) continue;
    if (scene !== lastScene) tagsInScene.clear();
    cues.push({ kind: "sfx", index: anchor, tag: proposal.tag, placement: "after" });
    seen.add(anchor);
    tagsInScene.add(proposal.tag);
    lastIndex = anchor;
    lastScene = scene;
  }

  return cues.sort((left, right) => left.index - right.index || (left.kind === "music" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Layout and levels
// ---------------------------------------------------------------------------

export type LayoutCue = { index: number; kind: SoundKind; placement: "before" | "after" };

export type ChapterLayout = {
  /** Silence after each segment, lengthened where a cue needs room. */
  gaps: number[];
  /** Silence before the first segment, for a swell that opens the chapter. */
  leadInMs: number;
  /** Silence after the last segment, for an effect on the final line. */
  tailMs: number;
};

/** Widens the pauses a chapter's cues play in; untouched pauses stay as they are. */
export function layoutChapterCues(pauses: Array<number | null | undefined>, cues: LayoutCue[], defaultGapMs: number): ChapterLayout {
  const gaps = pauses.map(pause => Math.max(0, Math.round(pause ?? defaultGapMs)));
  const last = gaps.length - 1;
  let leadInMs = 0;
  let tailMs = 0;
  for (const cue of cues) {
    if (cue.index < 0 || cue.index > last) continue;
    const timing = CUE_TIMING[cue.kind];
    if (cue.placement === "after") {
      if (cue.index === last) tailMs = Math.max(tailMs, timing.afterOffsetMs + timing.maxMs);
      else gaps[cue.index] = Math.max(gaps[cue.index]!, timing.gapAfterMs);
    } else if (cue.index === 0) {
      leadInMs = Math.max(leadInMs, timing.gapBeforeMs);
    } else {
      gaps[cue.index - 1] = Math.max(gaps[cue.index - 1]!, timing.gapBeforeMs);
    }
  }
  if (last >= 0) gaps[last] = 0;
  return { gaps, leadInMs, tailMs };
}

/** Where a cue starts, given where its anchor segment sits in the assembled chapter. */
export function cueStartMs(anchor: { startMs: number; durationMs: number }, cue: { kind: SoundKind; placement: "before" | "after" }): number {
  const timing = CUE_TIMING[cue.kind];
  return cue.placement === "after"
    ? Math.round(anchor.startMs + anchor.durationMs + timing.afterOffsetMs)
    : Math.max(0, Math.round(anchor.startMs - timing.preRollMs));
}

/** How long a cue plays and how it fades, from its measured length. */
export function cueEnvelope(tag: string, kind: SoundKind, assetDurationMs: number): { lengthMs: number; fadeInMs: number; fadeOutMs: number } {
  const timing = CUE_TIMING[kind];
  const lengthMs = Math.max(200, Math.min(timing.maxMs, assetDurationMs || timing.maxMs));
  const impact = kind === "sfx" && soundTag(tag)?.texture === "impact";
  return {
    lengthMs,
    fadeInMs: Math.min(impact ? IMPACT_FADE_IN_MS : timing.fadeInMs, Math.floor(lengthMs / 3)),
    fadeOutMs: Math.min(timing.fadeOutMs, Math.floor(lengthMs / 2)),
  };
}

/** Narration mean assumed when it cannot be measured (silence, an empty file). */
const FALLBACK_NARRATION_DB = -20;

/**
 * Gain for one cue, in dB.
 *
 * The cue is placed relative to the narration's measured mean. Of the two
 * limits (average level, peak level) the quieter wins, then the creator's
 * trim is applied.
 */
export function cueGainDb(input: { narrationMeanDb: number; kind: SoundKind; level: SoundLevel; assetMeanDb: number | null; assetPeakDb: number | null; trimDb?: number }): number {
  const target = SOUND_LEVELS[input.level][input.kind];
  const narration = input.narrationMeanDb > -80 ? input.narrationMeanDb : FALLBACK_NARRATION_DB;
  const assetMean = input.assetMeanDb ?? -20;
  const assetPeak = input.assetPeakDb ?? assetMean + 14;
  const byMean = narration + target.meanDb - assetMean;
  const byPeak = narration + target.peakDb - assetPeak;
  const gain = Math.min(byMean, byPeak) + (input.trimDb ?? 0);
  return Math.round(Math.max(-70, Math.min(12, gain)) * 10) / 10;
}

/**
 * Sidechain threshold (linear) for ducking cues under speech: about 10 dB
 * under the narration's mean, so any spoken word pulls the bed down and a
 * pause lets it back up.
 */
export function duckThreshold(narrationMeanDb: number): number {
  const narration = narrationMeanDb > -80 ? narrationMeanDb : FALLBACK_NARRATION_DB;
  const linear = 10 ** ((narration - 10) / 20);
  return Math.max(0.001, Math.min(0.5, Number(linear.toFixed(5))));
}

export const isSoundLevel = (value: string): value is SoundLevel =>
  value === "ultra-subtle" || value === "extra-subtle" || value === "subtle";

/** "very-subtle" was renamed "extra-subtle"; older projects still hold the old value. */
const LEGACY_SOUND_LEVELS: Record<string, SoundLevel> = { "very-subtle": "extra-subtle" };

/** A project's level, with legacy names mapped and unknown values at the default. */
export function normalizeSoundLevel(value: string): SoundLevel {
  return isSoundLevel(value) ? value : LEGACY_SOUND_LEVELS[value] ?? DEFAULT_SOUND_LEVEL;
}
