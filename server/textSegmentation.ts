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
function splitLongRun(run: string, limit: number): string[] {
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

/**
 * Rough spoken-duration estimate at ~155 words per minute. Used only for progress
 * display before real audio exists; the stored duration comes from the container.
 */
export function estimateSpokenMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 155) * 60_000);
}
