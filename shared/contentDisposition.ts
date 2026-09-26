/**
 * `Content-Disposition` for a download with a human file name, e.g.
 * "03 - The Storm at Harrow Pass.mp3". The quoted ASCII fallback is for old
 * clients; `filename*` carries the exact UTF-8 name.
 */
export function attachmentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 200) || "download";
  const fallback = clean.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
