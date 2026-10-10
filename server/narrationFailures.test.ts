import { describe, expect, it } from "vitest";
import { failureSummary } from "../shared/narration";

const segments = [
  { id: "seg-1", text: "Hour eight of an eleven-hour flight. Cabin lights dimmed.", characterId: "char-marcus" },
  { id: "seg-2", text: "The aisle was quiet.", characterId: "char-narrator" },
];
const characters = [
  { id: "char-marcus", name: "Marcus" },
  { id: "char-narrator", name: "Narrator" },
];

describe("failureSummary", () => {
  it("names the character and the line, then the reason", () => {
    const summary = failureSummary(
      [{ segmentId: "seg-1", message: "The provider will not render this voice through its API. Pick another voice for this character in Cast voices, then retry." }],
      segments,
      characters,
    );
    expect(summary).toContain("Marcus");
    expect(summary).toContain("Hour eight of an eleven-hour flight.");
    expect(summary).toContain("Cast voices");
  });

  it("still reports a failure whose segment is not in the workspace", () => {
    expect(failureSummary([{ segmentId: "gone", message: "Provider is unavailable (HTTP 503)" }], segments, characters))
      .toBe("Provider is unavailable (HTTP 503)");
  });

  it("truncates a long line and counts the ones it hides", () => {
    const long = { id: "seg-3", text: "word ".repeat(40), characterId: "char-narrator" };
    const summary = failureSummary(
      [
        { segmentId: "seg-3", message: "one" },
        { segmentId: "seg-2", message: "two" },
        { segmentId: "seg-1", message: "three" },
        { segmentId: "seg-1", message: "four" },
      ],
      [...segments, long],
      characters,
    );
    expect(summary).toContain("…");
    expect(summary).toContain("(+1 more)");
  });

  it("is empty when nothing failed", () => {
    expect(failureSummary([], segments, characters)).toBe("");
  });
});