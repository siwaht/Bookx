import { describe, expect, it } from "vitest";
import { hashSegmentText, normalizeProse, segmentProse, splitSentences } from "./textSegmentation";
import { textLimitForModel } from "../shared/narration";

describe("normalizeProse", () => {
  it("collapses whitespace without changing words", () => {
    expect(normalizeProse("The  house\t was   still\r\nawake.")).toBe("The house was still\nawake.");
  });

  it("preserves paragraph breaks but caps blank runs", () => {
    expect(normalizeProse("One.\n\n\n\nTwo.")).toBe("One.\n\nTwo.");
  });
});

describe("splitSentences", () => {
  it("splits on terminators", () => {
    expect(splitSentences("She left. He stayed! Did they speak?")).toEqual([
      "She left.",
      "He stayed!",
      "Did they speak?",
    ]);
  });

  it("does not split on abbreviations", () => {
    expect(splitSentences("Dr. Vale met Mrs. Ellis at St. Anne. They talked.")).toEqual([
      "Dr. Vale met Mrs. Ellis at St. Anne.",
      "They talked.",
    ]);
  });

  it("does not split on initials", () => {
    expect(splitSentences("J. R. R. Tolkien wrote it. She read it.")).toEqual([
      "J. R. R. Tolkien wrote it.",
      "She read it.",
    ]);
  });

  it("does not split inside decimals or ellipses", () => {
    expect(splitSentences("It cost 3.50 and no more.")).toEqual(["It cost 3.50 and no more."]);
  });

  it("keeps a closing quote with its sentence", () => {
    expect(splitSentences('"Do not come back here." She turned away.')).toEqual([
      '"Do not come back here."',
      "She turned away.",
    ]);
  });
});

describe("segmentProse", () => {
  it("returns nothing for empty input", () => {
    expect(segmentProse("   \n\n  ")).toEqual([]);
  });

  it("never crosses a paragraph boundary", () => {
    const units = segmentProse("First para.\n\nSecond para.", { maxChars: 400, minChars: 0 });
    expect(units).toEqual(["First para.", "Second para."]);
  });

  it("respects the limit", () => {
    const sentence = "The corridor hummed with a current that seemed to know her name. ";
    const units = segmentProse(sentence.repeat(40), { maxChars: 200 });
    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) expect(unit.length).toBeLessThanOrEqual(200);
  });

  it("never splits a word", () => {
    const words = "undertow ".repeat(200).trim();
    const units = segmentProse(words, { maxChars: 100 });
    for (const unit of units) {
      for (const token of unit.split(/\s+/)) expect(token).toBe("undertow");
    }
    expect(units.join(" ").split(/\s+/)).toHaveLength(200);
  });

  it("preserves every word across the split", () => {
    const source = Array.from({ length: 120 }, (_, index) => `word${index} and more text here.`).join(" ");
    const units = segmentProse(source, { maxChars: 180 });
    const rebuilt = units.join(" ").replace(/\s+/g, " ").trim();
    const expected = source.replace(/\s+/g, " ").trim();
    expect(rebuilt).toBe(expected);
  });

  it("is deterministic", () => {
    const source = "A sentence that goes on. ".repeat(60);
    expect(segmentProse(source, { maxChars: 250 })).toEqual(segmentProse(source, { maxChars: 250 }));
  });

  it("splits a very long single sentence on clause boundaries", () => {
    const long = `She walked on, ${"past the still windows, ".repeat(30)}and did not look back.`;
    const units = segmentProse(long, { maxChars: 150 });
    for (const unit of units) expect(unit.length).toBeLessThanOrEqual(150);
    expect(units.length).toBeGreaterThan(3);
  });

  it("merges a very short unit into its neighbour", () => {
    const units = segmentProse("Yes. The house was still awake when Mara finally returned home again.", { maxChars: 300, minChars: 20 });
    expect(units).toHaveLength(1);
  });

  it("handles a single token longer than the limit without slicing it", () => {
    const token = "x".repeat(120);
    const units = segmentProse(`start ${token} end`, { maxChars: 50, minChars: 0 });
    expect(units.some(unit => unit.includes(token))).toBe(true);
  });

  it("clamps to the model limit when maxChars is omitted", () => {
    const units = segmentProse("Sentence one is here. ".repeat(200), { model: "@cf/myshell-ai/melotts" });
    const limit = textLimitForModel("@cf/myshell-ai/melotts");
    for (const unit of units) expect(unit.length).toBeLessThanOrEqual(limit);
  });
});

describe("hashSegmentText", () => {
  it("is stable and sensitive to any change", () => {
    expect(hashSegmentText("abc")).toBe(hashSegmentText("abc"));
    expect(hashSegmentText("abc")).not.toBe(hashSegmentText("abc "));
  });
});

describe("textLimitForModel", () => {
  it("uses the exact figure when known", () => {
    expect(textLimitForModel("@cf/deepgram/aura-2-en")).toBe(1800);
  });

  it("falls back to a family match for custom Cloudflare names", () => {
    expect(textLimitForModel("@cf/deepgram/aura-2-en-custom")).toBe(1800);
    expect(textLimitForModel("my-melotts-clone")).toBe(900);
  });

  it("uses the conservative default for anything unrecognised", () => {
    expect(textLimitForModel("something-new")).toBe(1200);
    expect(textLimitForModel(undefined)).toBe(1200);
  });
});
