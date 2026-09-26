import { createHash } from "node:crypto";
import { ABSOLUTE_TEXT_LIMIT, textLimitForModel } from "../shared/narration";

/**
 * Splits manuscript prose into render units.
 *
 * Three properties matter and are all load-bearing:
 *
 * 1. **Deterministic.** The same text and limit always produce the same units in
 *    the same order. Resume, hashing and "nothing is missing" checks all depend on
 *    a segment's identity being reproducible.
 * 2. **Boundary-respecting.** Cuts land on paragraph, then sentence, then clause
 *    breaks, and never inside a word. A cut in the wrong place is audible as a
 *    clipped or run-together phrase.
 * 3. **Bounded.** No unit exceeds the model's limit, so a request cannot be
 *    truncated by the provider or rejected after the fact.
 */

/** Abbreviations whose trailing period must not be treated as a sentence end. */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "rev", "hon", "gen", "col", "sgt", "capt",
  "lt", "cmdr", "adm", "gov", "sen", "rep", "vs", "etc", "eg", "ie", "al", "inc", "ltd", "co", "no",
  "vol", "fig", "ch", "pp", "ed", "approx", "dept", "est", "min", "max",
]);

const PARAGRAPH_BREAK = /\n\s*\n+/;

/** Normalises whitespace without altering the words, so hashes stay stable. */
export function normalizeProse(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0]+/g, " ")
    .replace(/ {2,}/g, " ")
    .split("\n")
    .map(line => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Splits one paragraph into sentences.
 *
 * A period ends a sentence only when it is followed by whitespace and the token
 * before it is neither a known abbreviation nor a single initial ("J. R. R.").
 */
export function splitSentences(paragraph: string): string[] {
  const text = paragraph.trim();
  if (!text) return [];

  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char !== "." && char !== "!" && char !== "?") continue;

    // Absorb any run of terminators plus trailing quotes/brackets.
    let end = i;
    while (end + 1 < text.length && ".!?".includes(text[end + 1]!)) end++;
    while (end + 1 < text.length && "\"'”’)]".includes(text[end + 1]!)) end++;

    const next = text[end + 1];
    // A terminator that is not followed by a break is mid-token (a decimal, a
    // URL, an ellipsis inside a clause) and does not end the sentence.
    if (next !== undefined && !/\s/.test(next)) {
      i = end;
      continue;
    }

    if (char === ".") {
      const preceding = text.slice(start, i);
      const lastWord = preceding.match(/([A-Za-z]+)$/)?.[1];
      if (lastWord) {
        const lower = lastWord.toLowerCase();
        // Single capital = an initial; known abbreviation = not a sentence end.
        if (ABBREVIATIONS.has(lower) || (lastWord.length === 1 && lastWord === lastWord.toUpperCase())) {
          i = end;
          continue;
        }
      }
    }

    const sentence = text.slice(start, end + 1).trim();
    if (sentence) sentences.push(sentence);
    start = end + 1;
    i = end;
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.length ? sentences : [text];
}

/**
 * Last-resort split for a single run of text with no sentence break inside it.
 * Tries clause punctuation first, then falls back to whitespace. Never splits a
 * word; a word longer than the limit is emitted alone and reported by the caller.
 */
export function splitLongRun(run: string, limit: number): string[] {
  if (run.length <= limit) return [run];

  const pieces: string[] = [];
  let remaining = run;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);

    // Prefer the latest clause boundary in the window, then the latest space.
    const clause = Math.max(
      window.lastIndexOf("; "),
      window.lastIndexOf(": "),
      window.lastIndexOf(" — "),
      window.lastIndexOf(" – "),
      window.lastIndexOf(", "),
    );
    const cut = clause > limit * 0.4 ? clause + 1 : window.lastIndexOf(" ");

    if (cut <= 0) {
      // A single token longer than the limit. Emit it whole rather than slicing
      // through a word; the provider will still accept it or fail loudly.
      const forced = remaining.search(/\s/);
      if (forced <= 0) {
        pieces.push(remaining.trim());
        return pieces.filter(Boolean);
      }
      pieces.push(remaining.slice(0, forced).trim());
      remaining = remaining.slice(forced).trim();
      continue;
    }

    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) pieces.push(remaining);
  return pieces.filter(Boolean);
}

export type SegmentationOptions = {
  /** Hard ceiling per unit. Defaults to the model's limit. */
  maxChars?: number;
  model?: string | null;
  /**
   * Units shorter than this are merged forward when they sit in the same
   * paragraph, so a one-word line does not become its own request.
   */
  minChars?: number;
};

/**
 * Splits prose into ordered render units.
 *
 * Paragraph boundaries are never crossed: a paragraph break is a natural pause in
 * the finished audio, and keeping it as a unit boundary means the assembled book
 * breathes in the same places the manuscript does.
 */
export function segmentProse(input: string, options: SegmentationOptions = {}): string[] {
  const limit = Math.min(options.maxChars ?? textLimitForModel(options.model), ABSOLUTE_TEXT_LIMIT);
  if (limit <= 0) throw new Error("Segment limit must be positive");
  const minChars = options.minChars ?? Math.min(80, Math.floor(limit / 4));

  const normalized = normalizeProse(input);
  if (!normalized) return [];

  const units: string[] = [];

  for (const paragraph of normalized.split(PARAGRAPH_BREAK)) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;

    if (trimmedParagraph.length <= limit) {
      units.push(trimmedParagraph);
      continue;
    }

    // Pack sentences greedily up to the limit.
    let buffer = "";
    const flush = () => {
      if (buffer.trim()) units.push(buffer.trim());
      buffer = "";
    };

    for (const sentence of splitSentences(trimmedParagraph)) {
      for (const piece of splitLongRun(sentence, limit)) {
        if (!buffer) {
          buffer = piece;
          continue;
        }
        if (buffer.length + 1 + piece.length <= limit) {
          buffer = `${buffer} ${piece}`;
          continue;
        }
        flush();
        buffer = piece;
      }
    }
    flush();
  }

  return mergeShortNeighbours(units, limit, minChars);
}

/**
 * Merges a too-short unit into its neighbour when the result still fits. Very
 * short requests waste a round trip and often render with an unnatural clip.
 */
function mergeShortNeighbours(units: string[], limit: number, minChars: number): string[] {
  if (units.length < 2) return units;
  const merged: string[] = [];

  for (const unit of units) {
    const previous = merged[merged.length - 1];
    const shouldMerge =
      previous !== undefined &&
      (previous.length < minChars || unit.length < minChars) &&
      previous.length + 1 + unit.length <= limit;

    if (shouldMerge) merged[merged.length - 1] = `${previous} ${unit}`;
    else merged.push(unit);
  }

  return merged;
}

/** Stable content hash. Any text change flips this and invalidates stored audio. */
export function hashSegmentText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Scene breaks and dialogue
// ---------------------------------------------------------------------------

/** The paragraph used to mark a scene break inside a chapter body. */
export const SCENE_BREAK = "* * *";

/** Paragraph-level text that is only a scene-break ornament ("* * *", "#", "⁂"). */
export function isSceneBreakText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 24) return false;
  return /^[\s*#~⁂•·.\-–—_=+o0]+$/u.test(trimmed) && !/^\d+\.?$/.test(trimmed) && /[*#~⁂•·\-–—_=+]/u.test(trimmed);
}

/** Silence after a unit, by what follows it. */
export const PAUSE_WITHIN_PARAGRAPH_MS = 150;
export const PAUSE_SENTENCE_SPLIT_MS = 200;
export const PAUSE_PARAGRAPH_MS = 350;
export const PAUSE_SCENE_BREAK_MS = 1_400;

export type SegmentKind = "narration" | "dialogue";

export type SegmentUnit = {
  text: string;
  kind: SegmentKind;
  /** Index of the source paragraph within the chapter (-1 when unknown). */
  paragraph: number;
  /** Silence after this unit in the assembled chapter. */
  pauseMs: number;
  /** A scene break precedes this unit. */
  sceneBreakBefore: boolean;
  /** The quote is still open at the end of the paragraph (it continues in the next). */
  continuesQuote?: boolean;
};

type QuoteSpan = { text: string; kind: SegmentKind; unclosed?: boolean };

const DOUBLE_OPENERS: Record<string, string[]> = {
  "“": ["”", "\""],
  "„": ["“", "”"],
  "«": ["»"],
  "\"": ["\"", "”"],
};

/** Which quotation style a chapter uses for dialogue. */
export function detectQuoteStyle(text: string): "double" | "single" {
  const doubles = (text.match(/[“”„«»"]/g) ?? []).length;
  if (doubles >= 2) return "double";
  // A single quote that opens dialogue sits at a word start and is followed by
  // a capital: ‘Hello,’ she said. Apostrophes (don’t, James’) never match this.
  const singles = (text.match(/(^|[\s(\[—–])['‘](?=\p{Lu})/gmu) ?? []).length;
  return singles >= 2 ? "single" : "double";
}

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** Splits one paragraph into alternating narration and quoted-speech spans. */
export function splitQuotedSpans(paragraph: string, style: "double" | "single" = "double"): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  const push = (text: string, kind: SegmentKind, unclosed = false) => {
    const trimmed = text.trim();
    if (!trimmed || !hasWords(trimmed)) return;
    spans.push({ text: trimmed, kind, ...(unclosed ? { unclosed: true } : {}) });
  };

  let start = 0;
  let closers: string[] | null = null;

  for (let index = 0; index < paragraph.length; index++) {
    const char = paragraph[index]!;
    const previous = paragraph[index - 1] ?? "";
    const next = paragraph[index + 1] ?? "";

    if (!closers) {
      const opensDouble = style === "double" && DOUBLE_OPENERS[char] !== undefined;
      const opensSingle = style === "single" && (char === "‘" || char === "'") && (!previous || /[\s(\[—–“]/.test(previous)) && Boolean(next) && !/\s/.test(next);
      if (opensDouble || opensSingle) {
        push(paragraph.slice(start, index), "narration");
        start = index;
        closers = opensDouble ? DOUBLE_OPENERS[char]! : ["’", "'"];
      }
      continue;
    }

    if (!closers.includes(char)) continue;
    if (style === "single") {
      // An apostrophe inside a word (don’t) or a possessive (James’ coat) does
      // not close the quote; one after punctuation or before a break does.
      const afterPunctuation = /[,.!?…—–;:-]/.test(previous);
      const beforeBreak = !next || /[\s,.;:!?)\]—–”]/.test(next);
      const possessive = /[sS]/.test(previous) && /\s/.test(next) && !afterPunctuation;
      if (/\p{L}/u.test(next) || !(afterPunctuation || (beforeBreak && !possessive))) continue;
    }
    push(paragraph.slice(start, index + 1), "dialogue");
    start = index + 1;
    closers = null;
  }

  if (closers) push(paragraph.slice(start), "dialogue", true);
  else push(paragraph.slice(start), "narration");
  return spans;
}

/** Splits text into pieces within the limit at sentence, then clause, boundaries. */
export function splitToLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let buffer = "";
  for (const sentence of splitSentences(text)) {
    for (const piece of splitLongRun(sentence, limit)) {
      if (!buffer) {
        buffer = piece;
        continue;
      }
      if (buffer.length + 1 + piece.length <= limit) {
        buffer = `${buffer} ${piece}`;
        continue;
      }
      pieces.push(buffer);
      buffer = piece;
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

export type ChapterSegmentationOptions = SegmentationOptions & {
  /** Separate quoted speech from narration so characters can voice their own lines. */
  splitDialogue?: boolean;
};

/**
 * Splits a chapter into render units with layout hints.
 *
 * Without `splitDialogue` the units are exactly those of `segmentProse` (so an
 * existing single-narrator book keeps its rendered audio), except that scene
 * breaks are honoured: the ornament is never narrated and the pause before the
 * next scene is longer.
 *
 * With `splitDialogue` every unit has a single speaker: quoted speech becomes its
 * own unit, and units never cross a paragraph or change between narration and
 * dialogue. Short units are kept rather than merged, because merging a line of
 * dialogue into its tag would put a character's words in the narrator's voice.
 */
export function segmentChapter(input: string, options: ChapterSegmentationOptions = {}): SegmentUnit[] {
  const limit = Math.min(options.maxChars ?? textLimitForModel(options.model), ABSOLUTE_TEXT_LIMIT);
  if (limit <= 0) throw new Error("Segment limit must be positive");
  const normalized = normalizeProse(input);
  if (!normalized) return [];

  const paragraphs = normalized.split(PARAGRAPH_BREAK).map(paragraph => paragraph.trim()).filter(Boolean);
  const units: SegmentUnit[] = [];
  let sceneBreakPending = false;

  const markSceneBreak = () => {
    if (!units.length) return; // a break before any text is just an ornament
    units[units.length - 1]!.pauseMs = PAUSE_SCENE_BREAK_MS;
    sceneBreakPending = true;
  };

  if (!options.splitDialogue) {
    // Group paragraphs into scenes, then segment each scene exactly as before.
    let scene: string[] = [];
    const flushScene = () => {
      if (!scene.length) return;
      const texts = segmentProse(scene.join("\n\n"), { maxChars: limit, minChars: options.minChars });
      texts.forEach((text, index) => {
        units.push({
          text,
          kind: "narration",
          paragraph: -1,
          pauseMs: PAUSE_PARAGRAPH_MS,
          sceneBreakBefore: index === 0 && sceneBreakPending,
        });
      });
      if (texts.length) sceneBreakPending = false;
      scene = [];
    };
    for (const paragraph of paragraphs) {
      if (isSceneBreakText(paragraph)) {
        flushScene();
        markSceneBreak();
        continue;
      }
      scene.push(paragraph);
    }
    flushScene();
    return units;
  }

  const style = detectQuoteStyle(normalized);
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (isSceneBreakText(paragraph)) {
      markSceneBreak();
      return;
    }
    const spans = splitQuotedSpans(paragraph, style);
    spans.forEach((span, spanIndex) => {
      const pieces = splitToLimit(span.text, limit);
      pieces.forEach((piece, pieceIndex) => {
        const lastPiece = pieceIndex === pieces.length - 1;
        const lastSpan = spanIndex === spans.length - 1;
        units.push({
          text: piece,
          kind: span.kind,
          paragraph: paragraphIndex,
          pauseMs: !lastPiece ? PAUSE_SENTENCE_SPLIT_MS : lastSpan ? PAUSE_PARAGRAPH_MS : PAUSE_WITHIN_PARAGRAPH_MS,
          sceneBreakBefore: sceneBreakPending,
          ...(span.unclosed && lastPiece ? { continuesQuote: true } : {}),
        });
        sceneBreakPending = false;
      });
    });
  });

  return units;
}

/** Hash of a chapter's unit texts, used to tell whether an analysis is still current. */
export function hashUnitTexts(texts: string[]): string {
  const hash = createHash("sha256");
  for (const text of texts) hash.update(text, "utf8").update("\u0000");
  return hash.digest("hex");
}

/**
 * Rough spoken-duration estimate at ~155 words per minute. Used only for progress
 * display before real audio exists; the stored duration comes from the container.
 */
export function estimateSpokenMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 155) * 60_000);
}
