/**
 * `Content-Disposition` for a download with a human file name, e.g.
 * "03 - The Storm at Harrow Pass.mp3". The quoted ASCII fallback is for old
 * clients; `filename*` carries the exact UTF-8 name.
 */
export function attachmentDisposition(name: string): string {
  // Cut by code point: slicing UTF-16 units could split an emoji's surrogate
  // pair, and encodeURIComponent throws on half a pair, which took the Worker
  // down for any download named after a title with an emoji in it. Lone
  // surrogates already in the name are dropped for the same reason.
  const characters = Array.from(name.replace(/[\u0000-\u001f\u007f\\/]+/g, " ").trim()).filter(character => !/^[\ud800-\udfff]$/.test(character));
  const clean = characters.slice(0, 200).join("").trim() || "download";
  const fallback = clean.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
