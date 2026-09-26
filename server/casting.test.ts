import { describe, expect, it } from "vitest";
import type { bookxSegments, SegmentDelivery } from "../drizzle/schema";
import { applyParagraphConsensus, castFromCandidates, cleanSpeakerName, extractNameCandidates, renderForAttribution } from "./castAnalysis";
import { buildNameIndex } from "./speakerAttribution";
import { assignVoices, scoreVoice, type CastingSubject } from "./voiceAssignment";
import type { CatalogVoice } from "./voiceCatalog";

type SegmentRow = typeof bookxSegments.$inferSelect;

function row(id: string, text: string, delivery: SegmentDelivery): SegmentRow {
  return {
    id, chapterId: "chapter", characterId: null, text, audioStorageKey: null, orderIndex: 0, delivery,
    textHash: null, voiceProvider: null, voiceModel: null, voiceId: null, audioMimeType: null, audioBytes: null,
    audioDurationMs: null, renderAttempts: 0, lastError: null, renderedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

const voice = (id: string, extra: Partial<CatalogVoice>): CatalogVoice => ({ id, label: id, description: "", provider: "Cloudflare", ...extra });

const CATALOG: CatalogVoice[] = [
  voice("athena", { gender: "female", age: "mature", description: "Calm, smooth, professional", useCase: "narration, storytelling" }),
  voice("luna", { gender: "female", age: "young", description: "Friendly, natural, engaging" }),
  voice("hera", { gender: "female", age: "adult", description: "Smooth, warm, professional" }),
  voice("orion", { gender: "male", age: "adult", description: "Approachable, comfortable, calm" }),
  voice("zeus", { gender: "male", age: "mature", description: "Deep, trustworthy, smooth" }),
  voice("arcas", { gender: "male", age: "young", description: "Natural, smooth, clear" }),
];

describe("default voice assignment", () => {
  const cast: CastingSubject[] = [
    { key: "narrator", name: "Narrator", isNarrator: true, lineCount: 300 },
    { key: "mira", name: "Mira", gender: "female", ageGroup: "young adult", lineCount: 40 },
    { key: "aldric", name: "Aldric", gender: "male", ageGroup: "adult", lineCount: 38 },
    { key: "abbess", name: "The Abbess", gender: "female", ageGroup: "elderly", lineCount: 5 },
  ];

  it("gives the narrator a narration voice and every character a distinct voice of their gender", () => {
    const picks = assignVoices(cast, CATALOG);
    expect(picks.get("narrator")!.voiceId).toBe("athena");
    const ids = cast.map(subject => picks.get(subject.key)!.voiceId);
    expect(new Set(ids).size).toBe(ids.length);
    const gender = (key: string) => CATALOG.find(entry => entry.id === picks.get(key)!.voiceId)!.gender;
    expect(gender("mira")).toBe("female");
    expect(gender("aldric")).toBe("male");
    expect(gender("abbess")).toBe("female");
  });

  it("gives the same answer every time", () => {
    const first = [...assignVoices(cast, CATALOG)].map(([key, pick]) => [key, pick.voiceId]);
    const second = [...assignVoices([...cast].reverse(), CATALOG)].map(([key, pick]) => [key, pick.voiceId]);
    expect(new Map(second as Array<[string, string]>)).toEqual(new Map(first as Array<[string, string]>));
  });

  it("keeps a voice the creator chose and gives it to nobody else", () => {
    const picks = assignVoices(cast.map(subject => (subject.key === "aldric" ? { ...subject, lockedVoiceId: "athena" } : subject)), CATALOG);
    expect(picks.get("aldric")).toMatchObject({ voiceId: "athena", locked: true, confidence: 100 });
    expect(picks.get("narrator")!.voiceId).not.toBe("athena");
  });

  it("spreads voices out when the cast outnumbers the catalog", () => {
    const crowd = Array.from({ length: 12 }, (_, index) => ({ key: `c${index}`, name: `Guard ${index}`, gender: "male", lineCount: 12 - index }));
    const uses = new Map<string, number>();
    for (const pick of assignVoices(crowd, CATALOG).values()) uses.set(pick.voiceId, (uses.get(pick.voiceId) ?? 0) + 1);
    // Twelve male parts over three male voices: never one voice for everyone.
    expect(Math.max(...uses.values())).toBeLessThanOrEqual(4);
  });

  it("penalises a gender mismatch and a starter persona", () => {
    const mira: CastingSubject = { key: "mira", name: "Mira", gender: "female" };
    expect(scoreVoice(CATALOG[1]!, mira, 0, null)).toBeGreaterThan(scoreVoice(CATALOG[3]!, mira, 0, null));
    expect(scoreVoice({ ...CATALOG[1]!, starter: true }, mira, 0, null)).toBeLessThan(scoreVoice(CATALOG[1]!, mira, 0, null));
    expect(assignVoices([mira], []).size).toBe(0);
  });
});

describe("cast discovery helpers", () => {
  const book = [
    "“We ride at dawn,” said Aldric. Mira looked up. “Then we ride,” Mira replied quietly.",
    "“Hush,” she said. “Not here,” said Mira, and Mr. Bennet said nothing at all.",
    "Aldric was silent. “Fine,” said Aldric. “Good,” Mira said.",
  ];

  it("finds speakers from speech tags, never pronouns", () => {
    const candidates = extractNameCandidates(book);
    const byName = new Map(candidates.map(candidate => [candidate.name, candidate]));
    expect(byName.get("Mira")).toMatchObject({ tagCount: 3 });
    expect(byName.get("Aldric")).toMatchObject({ tagCount: 2, mentions: 3 });
    expect(byName.get("Mr. Bennet")).toMatchObject({ tagCount: 1 });
    expect(candidates.some(candidate => /^she$/i.test(candidate.name))).toBe(false);
    expect(candidates[0]!.name).toBe("Mira");
  });

  it("builds a rule-based cast from names tagged at least twice", () => {
    const cast = castFromCandidates(extractNameCandidates(book));
    expect(cast.characters.map(character => character.name).sort()).toEqual(["Aldric", "Mira"]);
  });

  it("cleans a speaker name the model echoed with its cast-list decoration", () => {
    expect(cleanSpeakerName("Mr. Bennet (also: his lady), male")).toBe("Mr. Bennet");
    expect(cleanSpeakerName("“Mira”")).toBe("Mira");
    expect(cleanSpeakerName("Aldric.")).toBe("Aldric");
  });
});

describe("attribution rendering", () => {
  const segments = [
    row("n1", "Mira looked up from the fire.", { kind: "narration", paragraph: 0 }),
    row("q1", "“Hurry,”", { kind: "dialogue", paragraph: 1 }),
    row("n2", "said Mira,", { kind: "narration", paragraph: 1 }),
    row("q2", "“the pass will close.”", { kind: "dialogue", paragraph: 1 }),
    row("q3", "“Then go,”", { kind: "dialogue", paragraph: 2 }),
    row("n3", "Aldric said.", { kind: "narration", paragraph: 2 }),
  ];

  it("numbers every quote, keeps narration plain and maps quotes back to lines", () => {
    const { chunks, quoteToSegment } = renderForAttribution(segments);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.quoteIds).toEqual(["Q1", "Q2", "Q3"]);
    expect(chunks[0]!.text).toBe("Mira looked up from the fire.\n\n[Q1] “Hurry,” said Mira, [Q2] “the pass will close.”\n\n[Q3] “Then go,” Aldric said.");
    expect([...quoteToSegment]).toEqual([["Q1", "q1"], ["Q2", "q2"], ["Q3", "q3"]]);
  });

  it("skips chapters without dialogue", () => {
    expect(renderForAttribution([row("n1", "Nobody spoke.", { kind: "narration", paragraph: 0 })]).chunks).toEqual([]);
  });

  it("gives a split paragraph to the one speaker its narration names", () => {
    const index = buildNameIndex([
      { id: "mira", name: "Mira" },
      { id: "aldric", name: "Aldric" },
    ]);
    const assignments = new Map<string, string | null>([["q1", "aldric"], ["q2", "mira"], ["q3", "aldric"]]);
    applyParagraphConsensus(segments, assignments, index);
    expect(assignments.get("q1")).toBe("mira");
    expect(assignments.get("q2")).toBe("mira");
    expect(assignments.get("q3")).toBe("aldric");
  });

  it("leaves a split paragraph alone when its narration names both or neither", () => {
    const index = buildNameIndex([{ id: "mira", name: "Mira" }, { id: "aldric", name: "Aldric" }]);
    const both = [
      row("a", "“Go,”", { kind: "dialogue", paragraph: 0 }),
      row("b", "said Mira to Aldric,", { kind: "narration", paragraph: 0 }),
      row("c", "“now.”", { kind: "dialogue", paragraph: 0 }),
    ];
    const assignments = new Map<string, string | null>([["a", "mira"], ["c", "aldric"]]);
    applyParagraphConsensus(both, assignments, index);
    expect(assignments.get("a")).toBe("mira");
    expect(assignments.get("c")).toBe("aldric");
  });
});
