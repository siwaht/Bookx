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

/**
 * Applies rules to `text`. Longer words are replaced first so a rule for
 * "Kestrel" cannot be half-eaten by a rule for "Kes". Word boundaries keep a
 * rule for "May" from rewriting the month inside "Mayflower".
 */
export function applyPronunciationRules(text: string, rules: PronunciationRule[]): string {
  if (!rules.length) return text;
  const ordered = [...rules]
    .filter(rule => rule.word.trim() && (rule.alias?.trim() || rule.phoneme?.trim()))
    .sort((left, right) => right.word.length - left.word.length);

  let result = text;
  for (const rule of ordered) {
    const regex = new RegExp(`\\b${escapeRegex(rule.word.trim())}\\b`, "gi");
    const alias = rule.alias?.trim();
    const phoneme = rule.phoneme?.trim();
    if (alias) {
      result = result.replace(regex, alias);
    } else if (phoneme) {
      result = result.replace(regex, `<phoneme alphabet="ipa" ph="${phoneme}">${rule.word.trim()}</phoneme>`);
    }
  }
  return result;
}

/** A stable hash of the rules, so a rule change invalidates stored audio. */
export function pronunciationHash(rules: PronunciationRule[]): string {
  const canonical = rules
    .map(rule => `${rule.word.trim()}\u0000${rule.alias?.trim() ?? ""}\u0000${rule.phoneme?.trim() ?? ""}`)
    .sort()
    .join("\u0001");
  return canonical;
}