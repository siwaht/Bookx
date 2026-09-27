import { describe, expect, it } from "vitest";
import {
  CLOSING_CREDITS_FILE_NAME,
  OPENING_CREDITS_FILE_NAME,
  RETAIL_SAMPLE_FILE_NAME,
  RETAIL_SAMPLE_MAX_MS,
  chapterHeaderText,
  closingCreditsText,
  openingCreditsText,
} from "../shared/audiobookExtras";
import { parseNoiseFloor } from "./ffmpeg";

describe("opening credits", () => {
  it("names the title, author and narrator", () => {
    expect(openingCreditsText({ title: "Harrow Pass", author: "A. Author", narrator: "N. Rator" }))
      .toBe("This is Harrow Pass, written by A. Author, narrated by N. Rator.");
  });

  it("falls back to the author as narrator, and drops what is missing", () => {
    expect(openingCreditsText({ title: "Harrow Pass", author: "A. Author" }))
      .toBe("This is Harrow Pass, written by A. Author, narrated by A. Author.");
    expect(openingCreditsText({ title: "Harrow Pass" })).toBe("This is Harrow Pass.");
    expect(openingCreditsText({ title: "  ", author: "A. Author" })).toBe("");
  });

  it("collapses whitespace in every field", () => {
    expect(openingCreditsText({ title: "  Harrow   Pass ", author: " A.  Author " }))
      .toBe("This is Harrow Pass, written by A. Author, narrated by A. Author.");
  });
});

describe("closing credits", () => {
  it("tells the listener the book has ended", () => {
    expect(closingCreditsText({ title: "Harrow Pass", author: "A. Author", narrator: "N. Rator" }))
      .toBe("You have been listening to Harrow Pass, written by A. Author, narrated by N. Rator. The End.");
  });

  it("works with a title alone", () => {
    expect(closingCreditsText({ title: "Harrow Pass" })).toBe("You have been listening to Harrow Pass. The End.");
  });
});

describe("chapter headers", () => {
  it("speaks the chapter's title as the file's opening line", () => {
    expect(chapterHeaderText("Chapter One: The Storm")).toBe("Chapter One: The Storm.");
    expect(chapterHeaderText("  Dust  Falls  ")).toBe("Dust Falls.");
    expect(chapterHeaderText("")).toBe("");
  });
});

describe("file names", () => {
  it("are stable, human-readable labels", () => {
    expect(OPENING_CREDITS_FILE_NAME).toBe("Opening Credits");
    expect(CLOSING_CREDITS_FILE_NAME).toBe("Closing Credits");
    expect(RETAIL_SAMPLE_FILE_NAME).toBe("Retail Sample");
    expect(RETAIL_SAMPLE_MAX_MS).toBe(300_000);
  });
});

describe("noise floor parsing", () => {
  it("takes the loudest quiet window as the floor", () => {
    const stderr = [
      "frame=0 fps=0.0 q=-0.0 size=N/A time=00:00:00.00",
      "RMS level dB: -91.0",
      "RMS level dB: -72.4",
      "RMS level dB: -65.1",
      "time=00:00:12.50",
    ].join("\n");
    expect(parseNoiseFloor(stderr)).toEqual({ floorDb: -65.1, durationMs: 12_500 });
  });

  it("treats -inf as digital silence and survives an empty log", () => {
    expect(parseNoiseFloor("RMS level dB: -inf\nRMS level dB: -inf").floorDb).toBe(-91);
    expect(parseNoiseFloor("no astats here").floorDb).toBeNull();
  });
});
