/**
 * Choosing a voice by hand.
 *
 * Provider catalogs are large (Deepgram lists a few dozen, ElevenLabs
 * thousands), so a bare dropdown is not a workable way to cast a character: the
 * list has to be searchable, filterable by the traits the catalog actually
 * states, and previewable on the character's own line before the choice is
 * committed. These helpers are pure so the behaviour can be tested without a
 * browser, and they take a structural type so both the client and the server
 * catalog can use them.
 */

export type PickableVoice = {
  id: string;
  label: string;
  description?: string | null;
  gender?: string | null;
  age?: string | null;
  accent?: string | null;
  /** What the voice is designed for, e.g. "narration" or "characters". */
  useCase?: string | null;
  /** A Prosecast starter persona rather than a real provider voice. */
  starter?: boolean;
};

export type VoiceFilter = {
  query?: string;
  gender?: string | null;
  age?: string | null;
  accent?: string | null;
};

export type VoiceFacets = { genders: string[]; ages: string[]; accents: string[] };

const lower = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/** The traits worth offering as filters, de-duplicated in catalog order. */
export function voiceFacets(voices: readonly PickableVoice[]): VoiceFacets {
  const genders = new Set<string>();
  const ages = new Set<string>();
  const accents = new Set<string>();
  for (const voice of voices) {
    // "neutral" is a real catalog value but useless as a filter: it matches the
    // voices that are not described either way, which the unfiltered list shows.
    if (voice.gender && lower(voice.gender) !== "neutral") genders.add(voice.gender);
    if (voice.age) ages.add(voice.age);
    if (voice.accent) accents.add(voice.accent);
  }
  return { genders: [...genders], ages: [...ages], accents: [...accents] };
}

/** Every term must appear somewhere in the voice's name, traits or description. */
export function matchesVoice(voice: PickableVoice, filter: VoiceFilter): boolean {
  if (filter.gender && lower(voice.gender) !== lower(filter.gender)) return false;
  if (filter.age && lower(voice.age) !== lower(filter.age)) return false;
  if (filter.accent && lower(voice.accent) !== lower(filter.accent)) return false;
  const terms = (filter.query ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (!terms.length) return true;
  const haystack = [voice.id, voice.label, voice.description, voice.useCase, voice.gender, voice.age, voice.accent]
    .map(lower)
    .join(" ");
  return terms.every(term => haystack.includes(term));
}

export function filterVoices(voices: readonly PickableVoice[], filter: VoiceFilter): PickableVoice[] {
  return voices.filter(voice => matchesVoice(voice, filter));
}

/** "female · adult · british" — only what the catalog states. */
export function describeVoice(voice: PickableVoice): string {
  const traits = [
    voice.gender && lower(voice.gender) !== "neutral" ? voice.gender : null,
    voice.age,
    voice.accent,
  ].filter((trait): trait is string => Boolean(trait));
  const summary = voice.description?.split("·")[0]?.trim();
  const stated = traits.join(" · ");
  const parts = stated ? [stated] : [];
  // A description that opens with the same words ("female · adult · american")
  // would otherwise be repeated as "female · adult · american — female".
  if (summary && !lower(stated).includes(lower(summary))) parts.push(summary);
  return parts.join(" — ") || "voice";
}
