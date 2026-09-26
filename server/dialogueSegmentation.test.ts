import { describe, expect, it } from "vitest";
import {
  PAUSE_PARAGRAPH_MS,
  PAUSE_SCENE_BREAK_MS,
  PAUSE_WITHIN_PARAGRAPH_MS,
  detectQuoteStyle,
  segmentChapter,
  segmentProse,
  splitQuotedSpans,
} from "./textSegmentation";
import { attributeSpeakersHeuristically, type CastMember } from "./speakerAttribution";

describe("splitQuotedSpans", () => {
  it("separates curly-quoted speech from its tag", () => {
    expect(splitQuotedSpans("“Are you coming?” Mara asked. “It’s late.”")).toEqual([
      { text: "“Are you coming?”", kind: "dialogue" },
      { text: "Mara asked.", kind: "narration" },
      { text: "“It’s late.”", kind: "dialogue" },
    ]);
  });

  it("handles straight quotes and a tag before the speech", () => {
    expect(splitQuotedSpans('Elias said, "Not tonight."')).toEqual([
      { text: "Elias said,", kind: "narration" },
      { text: '"Not tonight."', kind: "dialogue" },
    ]);
  });

  it("marks a quote left open at the end of a paragraph", () => {
    expect(splitQuotedSpans("“It began in the winter of that year, and nobody")).toEqual([
      { text: "“It began in the winter of that year, and nobody", kind: "dialogue", unclosed: true },
    ]);
  });

  it("reads single-quote dialogue without breaking on apostrophes", () => {
    const text = "‘I don’t know,’ said James. ‘It was James’ idea, not mine.’";
    expect(detectQuoteStyle(`${text} ‘Fine.’`)).toBe("single");
    expect(splitQuotedSpans(text, "single")).toEqual([
      { text: "‘I don’t know,’", kind: "dialogue" },
      { text: "said James.", kind: "narration" },
      { text: "‘It was James’ idea, not mine.’", kind: "dialogue" },
    ]);
  });

  it("drops fragments that are only punctuation", () => {
    expect(splitQuotedSpans("“Wait”—“No!”").map(span => span.text)).toEqual(["“Wait”", "“No!”"]);
  });
});

describe("segmentChapter", () => {
  const chapter = [
    "Chapter One",
    "",
    "The rain had not stopped for three days.",
    "",
    "“Are you coming?” Mara asked.",
    "",
    "* * *",
    "",
    "Morning came slowly.",
  ].join("\n");

  it("gives every dialogue line its own unit and honours scene breaks", () => {
    const units = segmentChapter(chapter, { maxChars: 400, splitDialogue: true });
    expect(units.map(unit => [unit.text, unit.kind])).toEqual([
      ["Chapter One", "narration"],
      ["The rain had not stopped for three days.", "narration"],
      ["“Are you coming?”", "dialogue"],
      ["Mara asked.", "narration"],
      ["Morning came slowly.", "narration"],
    ]);
    expect(units[2]!.pauseMs).toBe(PAUSE_WITHIN_PARAGRAPH_MS);
    expect(units[3]!.pauseMs).toBe(PAUSE_SCENE_BREAK_MS);
    expect(units[4]!.sceneBreakBefore).toBe(true);
    expect(units[0]!.pauseMs).toBe(PAUSE_PARAGRAPH_MS);
    // The ornament itself is never narrated.
    expect(units.some(unit => unit.text.includes("*"))).toBe(false);
  });

  it("matches the old single-narrator segmentation when dialogue is not split", () => {
    const plain = "First paragraph of the chapter, long enough to stand on its own as a unit.\n\nSecond paragraph, also long enough that it will not be merged with the first one.";
    const units = segmentChapter(plain, { maxChars: 400 });
    expect(units.map(unit => unit.text)).toEqual(segmentProse(plain, { maxChars: 400 }));
    expect(units.every(unit => unit.kind === "narration")).toBe(true);
  });

  it("keeps single-narrator units within one scene", () => {
    const units = segmentChapter("Short.\n\n* * *\n\nAlso short.", { maxChars: 400 });
    expect(units.map(unit => unit.text)).toEqual(["Short.", "Also short."]);
    expect(units[0]!.pauseMs).toBe(PAUSE_SCENE_BREAK_MS);
    expect(units[1]!.sceneBreakBefore).toBe(true);
  });

  it("splits long dialogue at sentence boundaries without leaving the quote", () => {
    const speech = `“${"This is a sentence that goes on. ".repeat(12).trim()}”`;
    const units = segmentChapter(speech, { maxChars: 120, splitDialogue: true });
    expect(units.length).toBeGreaterThan(1);
    expect(units.every(unit => unit.kind === "dialogue" && unit.text.length <= 120)).toBe(true);
  });
});

describe("attributeSpeakersHeuristically", () => {
  const cast: CastMember[] = [
    { id: "narrator", name: "Narrator", isNarrator: true },
    { id: "mara", name: "Mara Vale", aliases: ["Mara"], gender: "female" },
    { id: "elias", name: "Elias Thorn", aliases: ["Elias"], gender: "male" },
  ];

  const attribute = (text: string) => {
    const units = segmentChapter(text, { maxChars: 400, splitDialogue: true });
    const speakers = attributeSpeakersHeuristically(units, cast);
    return units.map((unit, index) => [unit.text, speakers[index]]);
  };

  it("uses dialogue tags, pronouns, action beats and alternation", () => {
    const text = [
      "Mara looked out at the river. Elias stood behind her.",
      "“Are you coming?” Mara asked.",
      "“Not tonight,” he said.",
      "“Then when?”",
      "“Soon.”",
      "Elias shrugged. “I promise.”",
    ].join("\n\n");

    expect(attribute(text)).toEqual([
      ["Mara looked out at the river. Elias stood behind her.", null],
      ["“Are you coming?”", "mara"],
      ["Mara asked.", null],
      ["“Not tonight,”", "elias"],
      ["he said.", null],
      ["“Then when?”", "mara"],
      ["“Soon.”", "elias"],
      ["Elias shrugged.", null],
      ["“I promise.”", "elias"],
    ]);
  });

  it("recognises a tag before the speech and a surname tag", () => {
    expect(attribute("Thorn said, “Stay here.”")).toEqual([
      ["Thorn said,", null],
      ["“Stay here.”", "elias"],
    ]);
  });

  it("carries the speaker across a quote that spans paragraphs", () => {
    const text = "“It began in winter,” said Mara, “and nobody\n\n“knew where it would end.”";
    const result = attribute(text);
    expect(result.filter(([, speaker]) => speaker !== null).map(([, speaker]) => speaker)).toEqual(["mara", "mara", "mara"]);
  });

  it("leaves unknown speakers to the narrator instead of guessing", () => {
    expect(attribute("“Who goes there?” someone called.")).toEqual([
      ["“Who goes there?”", null],
      ["someone called.", null],
    ]);
  });

  it("does not mistake ordinary lower-case words for names", () => {
    const willCast: CastMember[] = [{ id: "will", name: "Will", gender: "male" }];
    const units = segmentChapter("“I will go,” she said, and she will.", { maxChars: 400, splitDialogue: true });
    expect(attributeSpeakersHeuristically(units, willCast)).toEqual([null, null]);
  });
});
