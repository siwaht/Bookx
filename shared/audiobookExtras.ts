/**
 * The spoken and written extras an audiobook package needs for distributors:
 * opening and closing credits, narrated chapter headers, and a retail sample.
 *
 * ACX (Audible) requires every submission to open with a credits announcement
 * naming the title, author and narrator, and to close by telling the listener
 * the book has ended. Each chapter file must also speak its section header.
 * Spotify for Authors and Apple Books take the first five minutes of the book
 * as the retail sample, so the sample is simply the opening of chapter one.
 */

export type CreditsInput = {
  title: string;
  author?: string | null;
  /** The narrator's name as it should be spoken; defaults to the author. */
  narrator?: string | null;
};

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/**
 * The opening credits announcement, exactly as it should be narrated:
 * "This is Harrow Pass, written by A. Author, narrated by A. Author."
 */
export function openingCreditsText(input: CreditsInput): string {
  const title = clean(input.title);
  if (!title) return "";
  const parts = [`This is ${title}`];
  const author = clean(input.author);
  if (author) parts.push(`written by ${author}`);
  const narrator = clean(input.narrator) || author;
  if (narrator) parts.push(`narrated by ${narrator}`);
  return `${parts.join(", ")}.`;
}

/**
 * The closing credits announcement: "You have been listening to Harrow Pass,
 * written by A. Author, narrated by A. Author. The End."
 */
export function closingCreditsText(input: CreditsInput): string {
  const title = clean(input.title);
  if (!title) return "";
  const parts = [`You have been listening to ${title}`];
  const author = clean(input.author);
  if (author) parts.push(`written by ${author}`);
  const narrator = clean(input.narrator) || author;
  if (narrator) parts.push(`narrated by ${narrator}`);
  return `${parts.join(", ")}. The End.`;
}

/**
 * The spoken header for one chapter file: "Chapter One. The Storm at Harrow Pass."
 * ACX asks that each file open with its section header so a listener landing on
 * any file knows where they are.
 */
export function chapterHeaderText(title: string): string {
  const cleanTitle = clean(title);
  return cleanTitle ? `${cleanTitle}.` : "";
}

/** The download name for the credits and sample files inside a package. */
export const OPENING_CREDITS_FILE_NAME = "Opening Credits";
export const CLOSING_CREDITS_FILE_NAME = "Closing Credits";
export const RETAIL_SAMPLE_FILE_NAME = "Retail Sample";

/** ACX's ceiling for the retail sample. */
export const RETAIL_SAMPLE_MAX_MS = 5 * 60 * 1000;
