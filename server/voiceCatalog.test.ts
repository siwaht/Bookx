import { describe, expect, it } from "vitest";
import { elevenLabsVoiceIsReaderOnly, elevenLabsVoiceToCatalog } from "./voiceCatalog";

/**
 * ElevenLabs' Voice Library holds licensed celebrity voices that an account can
 * list but the API refuses to synthesise ("Famous voices can only be used within
 * the Reader App"). Offering one broke a real narration run, so they stay out of
 * the catalog.
 */
describe("elevenLabsVoiceToCatalog", () => {
  it("keeps an ordinary provider voice", () => {
    const voice = elevenLabsVoiceToCatalog({
      voice_id: "JBFqnCBsd6RMkjVDRZzb",
      name: "George",
      category: "premade",
      labels: { gender: "male", age: "middle_aged", accent: "british" },
    });
    expect(voice).toMatchObject({ id: "JBFqnCBsd6RMkjVDRZzb", label: "George", provider: "ElevenLabs" });
    expect(voice?.gender).toBe("male");
  });

  it("keeps the account's own cloned voice", () => {
    const voice = elevenLabsVoiceToCatalog({ voice_id: "M8UDgnf53212Yi6FEzUr", name: "Jleg", category: "cloned" });
    expect(voice?.id).toBe("M8UDgnf53212Yi6FEzUr");
  });

  it("drops a famous library voice", () => {
    expect(elevenLabsVoiceToCatalog({ voice_id: "iWP0zWXsAkUmG0R4IMeO", name: "Burt Reynolds", category: "famous" })).toBeNull();
  });

  it("treats the category case-insensitively", () => {
    expect(elevenLabsVoiceToCatalog({ voice_id: "abc", name: "Someone", category: " Famous " })).toBeNull();
  });

  it("drops a licensed voice that reports another category", () => {
    // The name carries the trademark sign, so the trademark check catches it.
    expect(elevenLabsVoiceIsReaderOnly({ name: "Burt Reynolds\u2122 - Masculine Iconic Storyteller", category: "professional" })).toBe(true);
    expect(elevenLabsVoiceToCatalog({ voice_id: "iWP0zWXsAkUmG0R4IMeO", name: "Burt Reynolds\u2122 - Masculine Iconic Storyteller", category: "professional" })).toBeNull();
    expect(elevenLabsVoiceIsReaderOnly({ name: "Someone\u00AE Else" })).toBe(true);
  });

  it("ignores an entry without an id or a name", () => {
    expect(elevenLabsVoiceToCatalog({ name: "No id" })).toBeNull();
    expect(elevenLabsVoiceToCatalog({ voice_id: "abc" })).toBeNull();
  });
});