import { describe, expect, it } from "vitest";
import { applyPronunciationRules, pronunciationHash } from "./pronunciation";

describe("applyPronunciationRules", () => {
  it("replaces a word with its phonetic alias", () => {
    const rules = [{ word: "Aurelia", alias: "aw-REE-lee-ah", phoneme: null }];
    expect(applyPronunciationRules("Aurelia opened the door.", rules)).toBe("aw-REE-lee-ah opened the door.");
  });

  it("wraps a word in an SSML phoneme tag when only a phoneme is given", () => {
    const rules = [{ word: "Kestrel", alias: null, phoneme: "ˈkɛstrəl" }];
    expect(applyPronunciationRules("A kestrel flew past.", rules)).toBe('A <phoneme alphabet="ipa" ph="ˈkɛstrəl">Kestrel</phoneme> flew past.');
  });

  it("prefers the alias over the phoneme when both are set", () => {
    const rules = [{ word: "Kestrel", alias: "KES-truhl", phoneme: "ˈkɛstrəl" }];
    expect(applyPronunciationRules("A kestrel.", rules)).toBe("A KES-truhl.");
  });

  it("respects word boundaries and case", () => {
    const rules = [{ word: "May", alias: "MAY", phoneme: null }];
    expect(applyPronunciationRules("May met Mayflower in May.", rules)).toBe("MAY met Mayflower in MAY.");
  });

  it("applies longer words first so a short rule cannot eat a longer one", () => {
    const rules = [
      { word: "Kes", alias: "KES", phoneme: null },
      { word: "Kestrel", alias: "KES-truhl", phoneme: null },
    ];
    expect(applyPronunciationRules("A kestrel.", rules)).toBe("A KES-truhl.");
  });

  it("leaves text untouched with no rules or empty rules", () => {
    expect(applyPronunciationRules("Plain text.", [])).toBe("Plain text.");
    expect(applyPronunciationRules("Plain text.", [{ word: "", alias: "", phoneme: "" }])).toBe("Plain text.");
  });
});

describe("pronunciationHash", () => {
  it("is stable regardless of rule order", () => {
    const a = [{ word: "Aurelia", alias: "aw-REE-lee-ah", phoneme: null }, { word: "Kestrel", alias: null, phoneme: "ˈkɛstrəl" }];
    const b = [{ word: "Kestrel", alias: null, phoneme: "ˈkɛstrəl" }, { word: "Aurelia", alias: "aw-REE-lee-ah", phoneme: null }];
    expect(pronunciationHash(a)).toBe(pronunciationHash(b));
  });

  it("changes when a rule changes", () => {
    const a = [{ word: "Aurelia", alias: "aw-REE-lee-ah", phoneme: null }];
    const b = [{ word: "Aurelia", alias: "aw-REE-lee-uh", phoneme: null }];
    expect(pronunciationHash(a)).not.toBe(pronunciationHash(b));
  });
});