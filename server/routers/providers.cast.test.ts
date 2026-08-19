import { describe, expect, it } from "vitest";
import { normalizeCastConfidence } from "./providers";

describe("normalizeCastConfidence", () => {
  it("converts unit-interval model confidence to the Bookx percentage contract", () => {
    expect(normalizeCastConfidence(0.92)).toBe(92);
    expect(normalizeCastConfidence(0.805)).toBe(81);
  });

  it("preserves percentage-style confidence while rounding fractional values", () => {
    expect(normalizeCastConfidence(90.4)).toBe(90);
    expect(normalizeCastConfidence(99.6)).toBe(100);
  });
});
