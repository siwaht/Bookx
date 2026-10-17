import { describe, expect, it } from "vitest";
import { describeVoice, filterVoices, matchesVoice, voiceFacets, type PickableVoice } from "../shared/voicePicker";

const catalog: PickableVoice[] = [
  { id: "aura-2-athena-en", label: "Athena", description: "female · adult · american", gender: "female", age: "adult", accent: "american", useCase: "narration" },
  { id: "aura-2-apollo-en", label: "Apollo", description: "male · adult · american", gender: "male", age: "adult", accent: "american", useCase: "characters" },
  { id: "aura-2-odysseus-en", label: "Odysseus", description: "male · mature · british", gender: "male", age: "mature", accent: "british", useCase: "narration" },
  { id: "narrator-warm", label: "Iris", description: "Warm, calm narration", starter: true },
  { id: "neutral-one", label: "Neutral", description: "neutral delivery", gender: "neutral" },
];

describe("casting a character by hand", () => {
  it("offers only the traits the catalog states, without the neutral placeholder", () => {
    const facets = voiceFacets(catalog);
    expect(facets.genders).toEqual(["female", "male"]);
    expect(facets.ages).toEqual(["adult", "mature"]);
    expect(facets.accents).toEqual(["american", "british"]);
  });

  it("searches on name, voice ID, description and traits together", () => {
    expect(filterVoices(catalog, { query: "british" }).map(voice => voice.id)).toEqual(["aura-2-odysseus-en"]);
    expect(filterVoices(catalog, { query: "athena" }).map(voice => voice.id)).toEqual(["aura-2-athena-en"]);
    expect(filterVoices(catalog, { query: "odysseus" }).map(voice => voice.id)).toEqual(["aura-2-odysseus-en"]);
    expect(filterVoices(catalog, { query: "warm narration" }).map(voice => voice.id)).toEqual(["narrator-warm"]);
    expect(filterVoices(catalog, { query: "" })).toHaveLength(catalog.length);
  });

  it("narrows by gender, age and accent, and requires every chosen trait", () => {
    expect(filterVoices(catalog, { gender: "male" }).map(voice => voice.id)).toEqual(["aura-2-apollo-en", "aura-2-odysseus-en"]);
    expect(filterVoices(catalog, { gender: "male", accent: "british" }).map(voice => voice.id)).toEqual(["aura-2-odysseus-en"]);
    expect(filterVoices(catalog, { age: "mature", query: "apollo" })).toHaveLength(0);
  });

  it("keeps a starter persona findable even though it states no traits", () => {
    expect(matchesVoice(catalog[3]!, { query: "iris" })).toBe(true);
    expect(matchesVoice(catalog[3]!, { gender: "male" })).toBe(false);
  });

  it("describes a voice with its traits rather than repeating its description", () => {
    expect(describeVoice(catalog[0]!)).toBe("female · adult · american");
    expect(describeVoice(catalog[3]!)).toBe("Warm, calm narration");
    expect(describeVoice(catalog[4]!)).toBe("neutral delivery");
  });
});