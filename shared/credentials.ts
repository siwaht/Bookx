/**
 * API keys and tokens, as they arrive from a paste.
 *
 * A key copied out of a web page or an assistant's chat pane frequently carries
 * invisible formatting characters: U+2060 WORD JOINER is inserted at wrap points
 * by some sites, a zero-width space rides along with text copied from a document,
 * and a non-breaking space survives a copy out of a PDF. None of them belong in a
 * key, and one is enough to break every request to that provider: Node's `fetch`
 * refuses a header value holding any code point above 0xFF with
 * "Cannot convert argument to a ByteString because the character at index N has a
 * value of M", which names neither the key nor the provider it came from.
 *
 * Providers issue ASCII keys, so removing whitespace and formatting characters
 * can never damage a real one, and cleaning the value on the way in and on the
 * way out heals keys that were already saved with one.
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Zs}]/gu;

/**
 * `value` without the invisible characters a key can never contain, or
 * `undefined` when nothing is left. Callers that treat an empty string as
 * "remove the saved key" should map this back to `""` themselves.
 */
export function sanitizeCredential(value?: string | null): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(INVISIBLE, "").trim();
  return cleaned || undefined;
}