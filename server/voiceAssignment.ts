import { normalizeVoiceAge, normalizeVoiceGender, type CatalogVoice, type VoiceAge } from "./voiceCatalog";

/**
 * Deterministic default casting.
 *
 * Given who is in the book (gender, age, a few words about how they speak) and
 * the voices the project's provider offers, pick a distinct, plausible voice for
 * each. It is instant, needs no model, and gives the same answer every time, so
 * it doubles as the fallback whenever a language model is unavailable.
 *
 * The creator's own choices are never touched: a locked voice is kept and
 * reserved so nobody else is given it.
 */

export type CastingSubject = {
  key: string;
  name: string;
  isNarrator?: boolean;
  gender?: string | null;
  ageGroup?: string | null;
  description?: string | null;
  /** How many lines the character speaks; the biggest parts are cast first. */
  lineCount?: number;
  /** A voice the creator chose; kept as-is. */
  lockedVoiceId?: string | null;
};

export type VoicePick = {
  voiceId: string;
  voiceName: string;
  confidence: number;
  rationale: string;
  locked: boolean;
};

const AGE_ORDER: VoiceAge[] = ["young", "adult", "mature", "old"];

const ACCENTS = ["british", "english", "scottish", "irish", "welsh", "american", "southern", "australian", "indian", "filipino", "french", "german", "italian", "spanish", "russian"];

const STOPWORDS = new Set(["and", "the", "with", "voice", "who", "that", "very", "a", "an", "of", "to", "in", "is", "his", "her", "their", "speaks", "speaking", "tone", "delivery"]);

function words(text: string | null | undefined): Set<string> {
  return new Set((text ?? "").toLowerCase().match(/[a-z]+/g)?.filter(word => word.length > 2 && !STOPWORDS.has(word)) ?? []);
}

function wantsNarration(voice: CatalogVoice): boolean {
  return /narrat|story|audiobook|documentary|informative/i.test(`${voice.useCase ?? ""} ${voice.description}`);
}

/** Higher is better. Exported for tests. */
export function scoreVoice(voice: CatalogVoice, subject: CastingSubject, uses: number, narratorVoiceId: string | null): number {
  let score = 0;
  const gender = normalizeVoiceGender(subject.gender);
  if (gender && voice.gender) {
    if (gender === voice.gender) score += 6;
    else if (voice.gender === "neutral") score += 1;
    else score -= 10;
  }

  const age = normalizeVoiceAge(subject.ageGroup);
  if (age && voice.age) {
    const distance = Math.abs(AGE_ORDER.indexOf(age) - AGE_ORDER.indexOf(voice.age));
    score += distance === 0 ? 2.5 : distance === 1 ? 0.75 : -1.5;
  }

  if (subject.isNarrator) {
    if (wantsNarration(voice)) score += 3;
  } else if (/character|animation|video game|game/i.test(`${voice.useCase ?? ""} ${voice.description}`)) {
    score += 0.5;
  }

  const wanted = words(subject.description);
  if (wanted.size) {
    const offered = words(`${voice.description} ${voice.useCase ?? ""}`);
    let overlap = 0;
    for (const word of wanted) if (offered.has(word)) overlap++;
    score += Math.min(3, overlap * 0.75);
    const accent = ACCENTS.find(candidate => wanted.has(candidate));
    if (accent && voice.accent?.toLowerCase().includes(accent === "english" ? "british" : accent)) score += 2;
  }

  if (voice.starter) score -= 4;
  // Distinct voices matter more than a perfect match: two characters sharing a
  // voice is the thing a listener notices.
  score -= uses * 8;
  if (!subject.isNarrator && narratorVoiceId && voice.id === narratorVoiceId) score -= 12;
  return score;
}

function confidenceFor(score: number): number {
  if (score >= 10) return 92;
  if (score >= 7) return 86;
  if (score >= 4) return 78;
  if (score >= 1) return 70;
  return 60;
}

function describe(voice: CatalogVoice): string {
  const parts = [voice.gender && voice.gender !== "neutral" ? voice.gender : null, voice.age === "young" ? "young" : voice.age === "mature" || voice.age === "old" ? "mature" : null, voice.accent].filter(Boolean);
  return parts.length ? `${parts.join(", ")} voice` : "voice";
}

function rationaleFor(voice: CatalogVoice, subject: CastingSubject): string {
  const traits = voice.description.split("·")[0]?.trim();
  if (subject.isNarrator) return `${voice.label}: ${describe(voice)} with a ${traits ? traits.toLowerCase() : "steady"} delivery for the narration.`.slice(0, 500);
  const fit = [normalizeVoiceGender(subject.gender) && voice.gender === normalizeVoiceGender(subject.gender) ? "matches the character's gender" : null,
    normalizeVoiceAge(subject.ageGroup) && voice.age === normalizeVoiceAge(subject.ageGroup) ? "suits their age" : null].filter(Boolean);
  return `${voice.label}: ${describe(voice)}${traits ? `, ${traits.toLowerCase()}` : ""}${fit.length ? `; ${fit.join(" and ")}` : ""}. Kept distinct from the rest of the cast.`.slice(0, 500);
}

/**
 * Assigns a voice to every subject.
 *
 * Order: the narrator first (they carry the most text), then characters by how
 * much they speak, so the leads get the best-fitting voices and minor parts
 * take what is left. Ties break on catalog order, which keeps it deterministic.
 */
export function assignVoices(subjects: CastingSubject[], catalog: CatalogVoice[]): Map<string, VoicePick> {
  const picks = new Map<string, VoicePick>();
  if (!catalog.length) return picks;

  const uses = new Map<string, number>();
  const byId = new Map(catalog.map(voice => [voice.id, voice]));
  let narratorVoiceId: string | null = null;

  // Locked voices are honoured and counted before anyone else is cast.
  for (const subject of subjects) {
    if (!subject.lockedVoiceId) continue;
    const voice = byId.get(subject.lockedVoiceId);
    uses.set(subject.lockedVoiceId, (uses.get(subject.lockedVoiceId) ?? 0) + 1);
    if (subject.isNarrator) narratorVoiceId = subject.lockedVoiceId;
    picks.set(subject.key, {
      voiceId: subject.lockedVoiceId,
      voiceName: voice?.label ?? subject.lockedVoiceId,
      confidence: 100,
      rationale: "Chosen by you.",
      locked: true,
    });
  }

  const order = subjects
    .filter(subject => !subject.lockedVoiceId)
    .sort((left, right) => Number(Boolean(right.isNarrator)) - Number(Boolean(left.isNarrator)) || (right.lineCount ?? 0) - (left.lineCount ?? 0) || left.name.localeCompare(right.name));

  for (const subject of order) {
    let best: { voice: CatalogVoice; score: number } | null = null;
    for (const voice of catalog) {
      const score = scoreVoice(voice, subject, uses.get(voice.id) ?? 0, narratorVoiceId);
      if (!best || score > best.score) best = { voice, score };
    }
    if (!best) continue;
    uses.set(best.voice.id, (uses.get(best.voice.id) ?? 0) + 1);
    if (subject.isNarrator) narratorVoiceId = best.voice.id;
    picks.set(subject.key, {
      voiceId: best.voice.id,
      voiceName: best.voice.label,
      confidence: confidenceFor(best.score),
      rationale: rationaleFor(best.voice, subject),
      locked: false,
    });
  }
  return picks;
}
