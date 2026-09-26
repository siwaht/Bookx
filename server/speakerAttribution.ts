/**
 * Rule-based speaker attribution.
 *
 * This is the instant, offline pass: it runs whenever a chapter is split so that
 * dialogue already has a sensible speaker before any language model is involved,
 * and it is the fallback when no model is configured. The model pass in
 * `castAnalysis.ts` refines it, and a creator's own choice always wins over both.
 *
 * The rules follow how English prose is typeset:
 *  - one paragraph is one speaker, so a speaker found anywhere in a paragraph
 *    applies to every quote in it;
 *  - a dialogue tag ("said Mara", "Elias asked") names the speaker;
 *  - a pronoun tag ("she said") refers to the last-mentioned character of that
 *    gender;
 *  - an action beat with a single name ("Mara laughed. “...”") names the speaker;
 *  - an unclosed quote continues into the next paragraph with the same speaker;
 *  - untagged back-and-forth alternates between the last two speakers.
 */

export type CastMember = {
  id: string;
  name: string;
  aliases?: string[] | null;
  gender?: string | null;
  isNarrator?: boolean | number | null;
};

export type AttributableUnit = {
  text: string;
  kind: "narration" | "dialogue";
  paragraph: number;
  continuesQuote?: boolean;
};

export const SPEECH_VERBS = [
  "said", "says", "say", "asked", "asks", "replied", "replies", "answered", "answers", "whispered", "whispers",
  "shouted", "shouts", "yelled", "yells", "cried", "cries", "called", "calls", "murmured", "murmurs", "muttered",
  "mutters", "added", "adds", "continued", "continues", "told", "tells", "snapped", "snaps", "hissed", "hisses",
  "growled", "growls", "laughed", "laughs", "sighed", "sighs", "breathed", "admitted", "admits", "agreed", "agrees",
  "argued", "insisted", "insists", "explained", "explains", "demanded", "demands", "exclaimed", "exclaims", "pleaded",
  "protested", "offered", "suggested", "suggests", "warned", "warns", "repeated", "repeats", "wondered", "mused",
  "observed", "noted", "remarked", "retorted", "stammered", "stuttered", "sobbed", "screamed", "roared", "bellowed",
  "grunted", "groaned", "interrupted", "declared", "announced", "whimpered", "spat", "barked", "purred", "drawled",
  "croaked", "rasped", "chuckled", "giggled", "teased", "joked", "promised", "confessed", "conceded", "countered",
  "corrected", "prompted", "urged", "ordered", "commanded", "begged", "gasped", "panted", "wailed", "moaned", "sang",
  "hummed", "ventured", "persisted", "pressed", "inquired", "enquired", "queried", "began", "went on", "managed",
  "shrieked", "howled", "sneered", "scoffed", "smiled", "grinned", "nodded", "shrugged",
];

const VERB = `(?:${SPEECH_VERBS.map(verb => verb.replace(/ /g, "\\s+")).join("|")})`;
const ADVERB = "(?:\\p{L}+ly\\s+)?";
const TITLES = /^(mr|mrs|ms|miss|dr|doctor|lady|lord|sir|madam|madame|captain|capt|professor|prof|father|mother|aunt|uncle|king|queen|prince|princess|master|mistress|sergeant|sgt|general|colonel|major|lieutenant|detective|inspector|officer|agent|reverend|rev|sister|brother)\.?$/i;
const MALE_PRONOUN = /^(he|him|his)$/i;
const FEMALE_PRONOUN = /^(she|her|hers)$/i;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type NameIndex = { pattern: RegExp | null; lookup: Map<string, string> };

/** Builds a matcher for every name and alias, preferring the longest match. */
export function buildNameIndex(cast: CastMember[]): NameIndex {
  const lookup = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (form: string, id: string) => {
    const key = form.trim().toLowerCase();
    if (key.length < 2) return;
    const existing = lookup.get(key);
    if (existing && existing !== id) ambiguous.add(key);
    else lookup.set(key, id);
  };

  const people = cast.filter(member => !member.isNarrator);
  for (const member of people) {
    add(member.name, member.id);
    for (const alias of member.aliases ?? []) add(alias, member.id);
  }
  // Single tokens ("Elizabeth" from "Elizabeth Bennet") only when unambiguous.
  const tokenOwners = new Map<string, Set<string>>();
  for (const member of people) {
    for (const form of [member.name, ...(member.aliases ?? [])]) {
      for (const token of form.split(/\s+/)) {
        const clean = token.replace(/[^\p{L}'’-]/gu, "");
        if (clean.length < 3 || TITLES.test(clean)) continue;
        const owners = tokenOwners.get(clean.toLowerCase()) ?? new Set<string>();
        owners.add(member.id);
        tokenOwners.set(clean.toLowerCase(), owners);
      }
    }
  }
  for (const [token, owners] of tokenOwners) {
    if (owners.size === 1 && !lookup.has(token)) lookup.set(token, [...owners][0]!);
  }
  for (const key of ambiguous) lookup.delete(key);

  const forms = [...lookup.keys()].sort((left, right) => right.length - left.length);
  if (!forms.length) return { pattern: null, lookup };
  const alternatives = forms.map(form => form.split(/\s+/).map(escapeRegExp).join("\\s+"));
  // Case-insensitive so "O'Brien" matches however it is capitalised; matches that
  // start lower-case are discarded by `nameMatches`, so ordinary words such as
  // "will" or "hope" are never taken for Will or Hope.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return { pattern, lookup };
}

/** Name matches in `text` that start with a capital letter, as names do in prose. */
function nameMatches(text: string, index: NameIndex): Array<{ form: string; id: string; at: number }> {
  if (!index.pattern) return [];
  const found: Array<{ form: string; id: string; at: number }> = [];
  for (const match of text.matchAll(index.pattern)) {
    const form = match[1]!;
    if (!/^\p{Lu}/u.test(form)) continue;
    const id = index.lookup.get(form.replace(/\s+/g, " ").toLowerCase());
    if (id) found.push({ form, id, at: match.index ?? 0 });
  }
  return found;
}

function namesIn(text: string, index: NameIndex): Array<{ id: string; at: number }> {
  return nameMatches(text, index).map(({ id, at }) => ({ id, at }));
}

/** Ids of the characters named in `text`. */
export function mentionedCharacterIds(text: string, index: NameIndex): Set<string> {
  return new Set(nameMatches(text, index).map(hit => hit.id));
}

function genderOf(cast: CastMember[], id: string): "male" | "female" | null {
  const gender = cast.find(member => member.id === id)?.gender?.toLowerCase() ?? "";
  if (/^(male|man|m|boy)$/.test(gender)) return "male";
  if (/^(female|woman|f|girl)$/.test(gender)) return "female";
  return null;
}

/**
 * Finds the speaker named by a dialogue tag.
 *
 * `position` says where the tag sits relative to the quote: "after" for
 * `"…," she said`, "before" for `Mara said, "…"`.
 */
function speakerFromTag(
  tag: string,
  position: "before" | "after",
  index: NameIndex,
  resolvePronoun: (gender: "male" | "female") => string | null,
): string | null {
  const text = tag.trim();
  if (!text) return null;
  const names = [...new Set(nameMatches(text, index).map(hit => hit.form))];
  const namePattern = names.length ? `(${names.map(name => escapeRegExp(name).replace(/\s+/g, "\\s+")).join("|")})` : null;
  const verb = `(?:${VERB})\\b`;

  const tryPattern = (source: string) => {
    const match = new RegExp(source, "iu").exec(text);
    return match?.[1] ?? null;
  };

  // "said Mara" / "Mara said" / "Mara quietly said", anchored near the quote.
  if (namePattern) {
    const nearQuote = position === "after"
      ? tryPattern(`^[\\s,—–-]*${verb}\\s+${namePattern}`) ?? tryPattern(`^[\\s,—–-]*${namePattern}\\s+${ADVERB}${verb}`)
      : tryPattern(`${namePattern}\\s+${ADVERB}${verb}[\\s\\p{L},]*[,:—–-]?\\s*$`) ?? tryPattern(`${verb}\\s+${namePattern}[,:—–-]?\\s*$`);
    const direct = nearQuote ?? tryPattern(`${verb}\\s+${namePattern}`) ?? tryPattern(`${namePattern}\\s+${ADVERB}${verb}`);
    if (direct) {
      const id = index.lookup.get(direct.replace(/\s+/g, " ").toLowerCase());
      if (id) return id;
    }
  }

  // "she said" / "said he"
  const pronoun = position === "after"
    ? tryPattern(`^[\\s,—–-]*(he|she)\\s+${ADVERB}${verb}`) ?? tryPattern(`^[\\s,—–-]*${verb}\\s+(he|she)\\b`)
    : tryPattern(`\\b(he|she)\\s+${ADVERB}${verb}[\\s\\p{L},]*[,:—–-]?\\s*$`);
  if (pronoun) {
    if (MALE_PRONOUN.test(pronoun)) return resolvePronoun("male");
    if (FEMALE_PRONOUN.test(pronoun)) return resolvePronoun("female");
  }
  return null;
}

/**
 * Assigns a character id to every dialogue unit it can, `null` elsewhere.
 * Narration units are always `null`: the narrator voices them.
 */
export function attributeSpeakersHeuristically(units: AttributableUnit[], cast: CastMember[]): Array<string | null> {
  const result: Array<string | null> = units.map(() => null);
  const people = cast.filter(member => !member.isNarrator);
  if (!people.length) return result;

  const index = buildNameIndex(people);
  // Most recent mention of each character, by unit position.
  const lastMention = new Map<string, number>();
  const recentByGender = (gender: "male" | "female", before: number): string | null => {
    let best: { id: string; at: number } | null = null;
    for (const [id, at] of lastMention) {
      if (at >= before || genderOf(people, id) !== gender) continue;
      if (!best || at > best.at) best = { id, at };
    }
    return best?.id ?? null;
  };

  // Paragraph -> unit indexes, in order.
  const paragraphs = new Map<number, number[]>();
  units.forEach((unit, position) => {
    const list = paragraphs.get(unit.paragraph) ?? [];
    list.push(position);
    paragraphs.set(unit.paragraph, list);
  });

  const speakerHistory: string[] = []; // speakers of recent dialogue paragraphs, newest last
  let previousParagraphHadDialogue = false;
  let continuing: string | null = null;

  for (const [, positions] of [...paragraphs.entries()].sort((left, right) => left[0] - right[0])) {
    const dialogue = positions.filter(position => units[position]!.kind === "dialogue");
    const narration = positions.filter(position => units[position]!.kind === "narration");
    let speaker: string | null = null;

    if (dialogue.length) {
      // 1. An open quote from the previous paragraph keeps its speaker.
      if (continuing && dialogue[0] === positions[0]) speaker = continuing;

      // 2. A dialogue tag right after or before a quote.
      for (const position of dialogue) {
        if (speaker) break;
        const after = units[position + 1];
        const before = units[position - 1];
        const resolve = (gender: "male" | "female") => recentByGender(gender, position);
        if (after && after.kind === "narration" && after.paragraph === units[position]!.paragraph) {
          speaker = speakerFromTag(after.text, "after", index, resolve);
        }
        if (!speaker && before && before.kind === "narration" && before.paragraph === units[position]!.paragraph) {
          speaker = speakerFromTag(before.text, "before", index, resolve);
        }
      }

      // 3. An action beat naming exactly one character.
      if (!speaker && narration.length) {
        const mentioned = new Set(narration.flatMap(position => namesIn(units[position]!.text, index).map(hit => hit.id)));
        if (mentioned.size === 1) speaker = [...mentioned][0]!;
      }

      // 4. Untagged back-and-forth alternates between the last two speakers, as
      //    long as the conversation has not been interrupted by pure narration.
      if (!speaker && !narration.length && previousParagraphHadDialogue && speakerHistory.length >= 2) {
        const last = speakerHistory[speakerHistory.length - 1]!;
        const beforeLast = speakerHistory[speakerHistory.length - 2]!;
        if (last !== beforeLast) speaker = beforeLast;
      }

      if (speaker) {
        for (const position of dialogue) result[position] = speaker;
        speakerHistory.push(speaker);
        if (speakerHistory.length > 6) speakerHistory.shift();
      }
      const lastDialogue = units[dialogue[dialogue.length - 1]!]!;
      continuing = lastDialogue.continuesQuote ? speaker : null;
    } else {
      continuing = null;
    }

    previousParagraphHadDialogue = dialogue.length > 0;
    // A narration-only paragraph ends the exchange; alternation restarts after it.
    if (!dialogue.length) speakerHistory.length = 0;

    // Record mentions after deciding this paragraph, so a name inside a tag
    // counts as the most recent mention for the next pronoun.
    for (const position of positions) {
      for (const hit of namesIn(units[position]!.text, index)) lastMention.set(hit.id, position);
    }
    if (speaker) lastMention.set(speaker, positions[positions.length - 1]!);
  }

  return result;
}
