import { describe, expect, it } from "vitest";
import { projectReadiness, projectSetupSchema } from "../shared/bookx";

describe("Bookx project setup", () => {
  it("accepts a complete audiobook setup", () => {
    const result = projectSetupSchema.safeParse({
      title: "A Quiet Current",
      author: "Mira Ellis",
      kind: "audiobook",
      narrationStyle: "cast",
      voiceModel: "Eleven v3",
      language: "English",
      manuscriptName: "quiet-current.epub",
    });
    expect(result.success).toBe(true);
  });

  it("requires a title and reports export readiness only when each production stage is complete", () => {
    expect(projectSetupSchema.safeParse({ kind: "audiobook" }).success).toBe(false);
    expect(projectReadiness({ chapterCount: 4, generatedChapters: 4, hasCast: true, hasTimeline: true })).toEqual({
      completed: 4,
      total: 4,
      readyToExport: true,
    });
  });
});
