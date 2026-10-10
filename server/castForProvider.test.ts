import { describe, expect, it } from "vitest";
import { charactersNeedingRecast, isPlaceholderCatalog, type CastRow } from "./castForProvider";
import type { CatalogVoice } from "./voiceCatalog";

const catalog: CatalogVoice[] = [
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George", description: "Warm storyteller", provider: "ElevenLabs", gender: "male", age: "mature" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", description: "Confident and warm", provider: "ElevenLabs", gender: "female", age: "adult" },
];

const row = (over: Partial<CastRow>): CastRow => ({ id: "c1", name: "Marcus", voiceId: "JBFqnCBsd6RMkjVDRZzb", voiceName: "George", ...over });

describe("charactersNeedingRecast", () => {
  it("keeps a character whose voice this provider offers", () => {
    expect(charactersNeedingRecast([row({})], catalog)).toEqual([]);
  });

  it("flags a voice carried over from another provider", () => {
    // What a provider switch leaves behind: an id the new provider never heard of.
    const carried = row({ voiceId: "iWP0zWXsAkUmG0R4IMeO", voiceName: "Burt Reynolds" });
    expect(charactersNeedingRecast([carried], catalog).map(r => r.name)).toEqual(["Marcus"]);
  });

  it("flags a character that has no voice at all", () => {
    expect(charactersNeedingRecast([row({ voiceId: null, voiceName: null })], catalog)).toHaveLength(1);
  });

  it("judges nothing when the provider's voices could not be listed", () => {
    expect(charactersNeedingRecast([row({ voiceId: "whatever" })], [])).toEqual([]);
  });

  it("recognises the built-in starter list, which is not a provider's own", () => {
    const starter: CatalogVoice[] = [{ id: "iris-narrative", label: "Iris", description: "Warm", provider: "ElevenLabs", starter: true }];
    expect(isPlaceholderCatalog(starter)).toBe(true);
    expect(isPlaceholderCatalog(catalog)).toBe(false);
  });
});