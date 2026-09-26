import { z } from "zod";

/**
 * D1 rows are limited to 2 MB, so a chapter's text must stay under that. A
 * "chapter" that large is almost always a book without chapter headings, so
 * the importer splits it at paragraph breaks into parts rather than refusing
 * the file.
 */
export const MAX_CHAPTER_BODY_BYTES = 1_800_000;

export function splitOversizedChapters<T extends { title: string; body: string }>(chapters: T[], maxBytes = MAX_CHAPTER_BODY_BYTES): T[] {
  return chapters.flatMap(chapter => {
    if (Buffer.byteLength(chapter.body) <= maxBytes) return [chapter];
    const parts: string[] = [];
    let current = "";
    for (const paragraph of chapter.body.split(/\n{2,}/)) {
      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (current && Buffer.byteLength(candidate) > maxBytes) {
        parts.push(current);
        current = paragraph;
      } else {
        current = candidate;
      }
      // A single paragraph over the limit is cut at the limit, on a character boundary.
      while (Buffer.byteLength(current) > maxBytes) {
        const cut = Buffer.from(current).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
        parts.push(cut);
        current = current.slice(cut.length);
      }
    }
    if (current) parts.push(current);
    return parts.map((body, index) => ({ ...chapter, title: index ? `${chapter.title} (part ${index + 1})` : chapter.title, body }));
  });
}

/** Chapter text as accepted from the editor. */
export const chapterBodySchema = z.string().refine(value => Buffer.byteLength(value) <= MAX_CHAPTER_BODY_BYTES, {
  message: "A chapter can hold about 1.8 MB of text. Split it into two chapters.",
});
