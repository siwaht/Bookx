/**
 * Pronunciation rules: how a project's names, places and technical terms are
 * spoken. A rule either replaces the word with a phonetic alias ("Aurelia" →
 * "aw-REE-lee-ah") or wraps it in an SSML phoneme tag for providers that read
 * IPA ("Kestrel" → `<phoneme alphabet="ipa" ph="ˈkɛstrəl">Kestrel</phoneme>`).
 *
 * The rules are applied to a segment's text just before it is sent to the
 * voice provider, so the stored audio already says the word correctly.
 */

export type PronunciationRule = {
  word: string;
  alias?: string | null;
  phoneme?: string | null;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (value: string) => value.replace(/[&<>"']/g, character => XML_ESCAPES[character]!);

/** The voice the text is going to, which decides whether SSML is understood. */
export type PronunciationTarget = { provider?: string | null; model?: string | null };

/**
 * Whether a voice reads SSML `<phoneme>` tags. ElevenLabs documents them for
 * these models only and silently drops the word on the others; no other
 * provider used here reads them, so the markup would be spoken or rejected.
 * With no target given the tags are kept, as before.
 */
export function supportsPhonemeTags(target?: PronunciationTarget): boolean {
  if (!target) return true;
  return target.provider === "ElevenLabs" && /^(eleven_flash_v2|eleven_turbo_v2|eleven_monolingual_v1)$/.test((target.model ?? "").trim());
}

/**
 * Applies rules to `text` in a single pass, so one rule's replacement is never
 * rewritten by another. Longer words win, so a rule for "Kestrel" cannot be
 * half-eaten by a rule for "Kes". The word must stand alone: no letter or digit
 * either side (accented letters included), so a rule for "May" leaves
 * "Mayflower" alone and a rule for "Jos" leaves "José" alone.
 *
 * A phoneme-only rule becomes an SSML tag where the voice reads them, and
 * otherwise leaves the word as written.
 */
export function applyPronunciationRules(text: string, rules: PronunciationRule[], target?: PronunciationTarget): string {
  const phonemes = supportsPhonemeTags(target);
  const usable = rules
    .map(rule => ({ word: rule.word.trim(), alias: rule.alias?.trim() || "", phoneme: rule.phoneme?.trim() || "" }))
    .filter(rule => rule.word && (rule.alias || (rule.phoneme && phonemes)))
    .sort((left, right) => right.word.length - left.word.length);
  if (!usable.length) return text;

  // One capture group per rule tells the replacer which rule matched.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${usable.map(rule => `(${escapeRegex(rule.word)})`).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return text.replace(pattern, (match: string, ...groups: unknown[]) => {
    const rule = usable[groups.findIndex(group => typeof group === "string")];
    if (!rule) return match;
    // A function result is inserted as-is, so "$&" or "$1" in an alias stays literal.
    if (rule.alias) return rule.alias;
    return `<phoneme alphabet="ipa" ph="${escapeXml(rule.phoneme)}">${escapeXml(rule.word)}</phoneme>`;
  });
}

/** A stable hash of the rules, so a rule change invalidates stored audio. */
export function pronunciationHash(rules: PronunciationRule[]): string {
  const canonical = rules
    .map(rule => `${rule.word.trim()}\u0000${rule.alias?.trim() ?? ""}\u0000${rule.phoneme?.trim() ?? ""}`)
    .sort()
    .join("\u0001");
  return canonical;
}