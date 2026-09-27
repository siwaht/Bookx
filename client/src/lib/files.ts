/** Manuscript formats the importer understands. Kept in sync with server/manuscriptImport.ts. */
export const MANUSCRIPT_ACCEPT = ".epub,.docx,.txt,.md,.markdown,.html,.htm,.xhtml";

/** Mirrors MAX_MANUSCRIPT_BYTES on the server. */
export const MAX_MANUSCRIPT_BYTES = 30 * 1024 * 1024;

export type ManuscriptUpload = { name: string; size: number; base64: string };

/** Reads a file as bare base64 (no `data:` prefix). */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Prosecast could not read ${file.name}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** Validates and reads a manuscript file chosen by the user. */
export async function readManuscriptFile(file: File): Promise<ManuscriptUpload> {
  if (file.size > MAX_MANUSCRIPT_BYTES) {
    throw new Error(`${file.name} is larger than 30 MB. Try an EPUB without embedded images, or a DOCX.`);
  }
  if (!file.size) throw new Error(`${file.name} is empty.`);
  return { name: file.name, size: file.size, base64: await readFileAsBase64(file) };
}

export function formatWordCount(words: number): string {
  if (words >= 10_000) return `${Math.round(words / 1000)}k words`;
  if (words >= 1000) return `${(words / 1000).toFixed(1)}k words`;
  return `${words} word${words === 1 ? "" : "s"}`;
}
