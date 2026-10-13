import path from "node:path";
import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import mammoth from "mammoth";
import { SCENE_BREAK, isSceneBreakText } from "./textSegmentation";

/**
 * Turns an uploaded manuscript into chapters.
 *
 * Supports EPUB (2 and 3), DOCX, HTML, Markdown and plain text. The output is
 * plain prose with paragraphs separated by blank lines, which is exactly what the
 * segmenter expects, plus a classification of each section so that covers,
 * copyright pages, tables of contents and "about the author" pages start out
 * excluded from the audiobook instead of being narrated.
 *
 * Nothing here touches the database; `importManuscript` in the router does that.
 */

export type ChapterKind = "chapter" | "front-matter" | "back-matter";

export type ImportedChapter = {
  title: string;
  /** Paragraphs separated by a blank line. Scene breaks are a "* * *" paragraph. */
  body: string;
  kind: ChapterKind;
  /** Whether the chapter should be narrated by default. */
  included: boolean;
  wordCount: number;
};

export type ManuscriptFormat = "epub" | "docx" | "html" | "markdown" | "text";

export type ImportResult = {
  format: ManuscriptFormat;
  title?: string;
  author?: string;
  language?: string;
  chapters: ImportedChapter[];
  warnings: string[];
};

export class ManuscriptImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManuscriptImportError";
  }
}

/** Largest upload accepted, in bytes. EPUBs with many images can be large. */
export const MAX_MANUSCRIPT_BYTES = 30 * 1024 * 1024;
/** Upper bound on decompressed text read from an archive (zip-bomb guard). */
const MAX_ARCHIVE_TEXT_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_CHAPTERS = 1_000;

// Scene-break handling is shared with the segmenter, which must recognise the
// same ornaments when a creator types one by hand.
export { SCENE_BREAK, isSceneBreakText };

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

export function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\f\v\r\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, " ").replace(/ *\n */g, "\n").trim();
}

const ROMAN_NUMERAL = /^(?=[mdclxvi])m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/i;

/** "CHAPTER ONE: THE STORM" -> "Chapter One: The Storm"; mixed case is left alone. */
export function tidyTitle(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  // Strip a dotted leader and page number that some tables of contents include.
  title = title.replace(/\s*\.{3,}\s*\d+$/, "");
  if (title.length > 3 && title === title.toUpperCase() && /[A-Z]/.test(title)) {
    title = title
      .toLowerCase()
      .replace(/(^|[\s(“"'‘-])(\p{L})/gu, (_match, lead: string, letter: string) => lead + letter.toUpperCase())
      // "Chapter Iv" -> "Chapter IV": numerals read better in capitals, but only
      // where a numeral is expected, so "Mix" does not become "MIX".
      .replace(/\b(chapter|part|book|volume|act|canto)\s+([ivxlcdm]+)\b/gi, (match, word: string, numeral: string) =>
        ROMAN_NUMERAL.test(numeral) ? `${word} ${numeral.toUpperCase()}` : match)
      .replace(/^([ivxlcdm]+)(?=[.:]?(\s|$))/i, (numeral: string) => (ROMAN_NUMERAL.test(numeral) ? numeral.toUpperCase() : numeral));
  } else {
    // "CHAPTER I. The Door" -> "Chapter I. The Door".
    title = title.replace(/^(CHAPTER|PART|BOOK|VOLUME|ACT|CANTO|PROLOGUE|EPILOGUE|INTERLUDE)\b/, word => word.charAt(0) + word.slice(1).toLowerCase());
  }
  return title.slice(0, 255);
}

function titleFromFile(filePath: string): string {
  const base = path.posix.basename(filePath).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\d+$/, "").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Section";
}

/** Windows-1252 code points for bytes 0x80-0x9F; the rest match Latin-1. */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/**
 * Decodes Windows-1252 by hand. Node's `TextDecoder("windows-1252")` decodes as
 * ISO-8859-1, which turns curly quotes into invisible C1 control characters.
 */
function decodeWindows1252(data: Buffer): string {
  let out = "";
  for (let offset = 0; offset < data.length; offset += 8192) {
    const codes: number[] = [];
    const end = Math.min(data.length, offset + 8192);
    for (let index = offset; index < end; index++) {
      const byte = data[index]!;
      codes.push(byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : byte);
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

function decodeText(data: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // Not valid UTF-8: most older .txt files are Windows-1252.
    text = decodeWindows1252(data);
  }
  return text.replace(/^\uFEFF/, "");
}

// ---------------------------------------------------------------------------
// DOM -> blocks
// ---------------------------------------------------------------------------

/** Structural view of the htmlparser2 DOM, so `domhandler` need not be a dependency. */
type DomNode = {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
  data?: string;
};

type Block = {
  text: string;
  /** 1-6 for headings, 0 otherwise. */
  heading: number;
  sceneBreak?: boolean;
};

type ParsedDoc = {
  blocks: Block[];
  /** Element id -> index of the first block at or after it. */
  anchors: Map<string, number>;
  /** `epub:type` / `role` values found on the body and top-level sections. */
  semantics: Set<string>;
  htmlTitle?: string;
};

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "center", "dd", "div", "dl", "dt", "figcaption",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "html", "li", "main", "ol", "p", "pre",
  "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

const SKIP_TAGS = new Set([
  "audio", "button", "canvas", "embed", "figure", "form", "head", "iframe", "img", "image", "input", "map",
  "math", "noscript", "object", "script", "select", "style", "svg", "template", "textarea", "title", "video",
]);

/** Semantic markers for content that is never read aloud. */
const NON_NARRATED_SEMANTICS = /\b(footnotes?|endnotes?|rearnotes?|noteref|doc-footnote|doc-endnotes?|doc-noteref|pagebreak|doc-pagebreak)\b/i;

function semanticsOf(node: DomNode): string {
  const attribs = node.attribs ?? {};
  return `${attribs["epub:type"] ?? ""} ${attribs.role ?? ""}`.trim();
}

function localName(name: string | undefined): string {
  if (!name) return "";
  const index = name.indexOf(":");
  return (index >= 0 ? name.slice(index + 1) : name).toLowerCase();
}

function textContent(node: DomNode): string {
  if (node.type === "text") return node.data ?? "";
  if (!node.children) return "";
  return node.children.map(textContent).join("");
}

function findAll(node: DomNode, predicate: (node: DomNode) => boolean, out: DomNode[] = []): DomNode[] {
  for (const child of node.children ?? []) {
    if (child.type === "tag" || child.type === "script" || child.type === "style") {
      if (predicate(child)) out.push(child);
      findAll(child, predicate, out);
    }
  }
  return out;
}

function findFirst(node: DomNode, predicate: (node: DomNode) => boolean): DomNode | undefined {
  for (const child of node.children ?? []) {
    if (child.type !== "tag") continue;
    if (predicate(child)) return child;
    const nested = findFirst(child, predicate);
    if (nested) return nested;
  }
  return undefined;
}

function parseHtml(html: string): DomNode {
  return parseDocument(html, {
    xmlMode: false,
    decodeEntities: true,
    lowerCaseTags: true,
    // XHTML content uses `<a id="x"/>`; without this an anchor swallows the text after it.
    recognizeSelfClosing: true,
  }) as unknown as DomNode;
}

function parseXml(xml: string): DomNode {
  return parseDocument(xml, { xmlMode: true, decodeEntities: true }) as unknown as DomNode;
}

/** Flattens an (X)HTML document into narration blocks, tracking anchor positions. */
export function htmlToBlocks(html: string): ParsedDoc {
  const root = parseHtml(html);
  const blocks: Block[] = [];
  const anchors = new Map<string, number>();
  const semantics = new Set<string>();
  let buffer = "";
  let bufferHeading = 0;

  const htmlTitleNode = findFirst(root, node => node.name === "title");
  const htmlTitle = htmlTitleNode ? collapseWhitespace(textContent(htmlTitleNode)) : undefined;

  // Scene breaks are de-duplicated as they are pushed, never afterwards:
  // anchors record block indexes, and removing a block later would shift them.
  const pushSceneBreak = () => {
    if (!blocks.length || blocks[blocks.length - 1]!.sceneBreak) return;
    blocks.push({ text: SCENE_BREAK, heading: 0, sceneBreak: true });
  };

  const flush = () => {
    const text = collapseWhitespace(buffer);
    buffer = "";
    // Keep the heading level across an empty flush: a heading that wraps a
    // block (`<h1><div>Title</div></h1>`) flushes once before its text arrives.
    if (!text) return;
    const heading = bufferHeading;
    bufferHeading = 0;
    if (isSceneBreakText(text)) {
      pushSceneBreak();
      return;
    }
    blocks.push({ text, heading });
  };

  const walk = (node: DomNode, depth: number) => {
    if (node.type === "text") {
      buffer += node.data ?? "";
      return;
    }
    if (node.type !== "tag" && node.type !== "root") return;

    const name = localName(node.name);
    if (SKIP_TAGS.has(name)) return;

    const semantic = semanticsOf(node);
    if (semantic && NON_NARRATED_SEMANTICS.test(semantic)) return;
    if (semantic && (name === "body" || name === "section" || depth <= 3)) {
      for (const value of semantic.split(/\s+/)) if (value) semantics.add(value.toLowerCase());
    }
    // A superscript that is only a number is a footnote marker.
    if (name === "sup" && /^\s*[\d*†‡§]+\s*$/.test(textContent(node))) return;

    const id = node.attribs?.id || (name === "a" ? node.attribs?.name : undefined);
    const isBlock = BLOCK_TAGS.has(name);

    if (isBlock) flush();
    if (id && !anchors.has(id)) anchors.set(id, blocks.length);

    if (name === "br") {
      buffer += "\n";
      return;
    }
    if (name === "hr") {
      flush();
      pushSceneBreak();
      return;
    }

    const headingMatch = /^h([1-6])$/.exec(name);
    if (headingMatch) bufferHeading = Number(headingMatch[1]);

    for (const child of node.children ?? []) walk(child, depth + 1);

    if (isBlock) flush();
    if (headingMatch) bufferHeading = 0; // an empty heading must not tag the next paragraph
  };

  walk(root, 0);
  flush();

  // Trailing scene breaks carry no meaning. Popping from the end cannot shift
  // any anchor that points at real content.
  while (blocks.length && blocks[blocks.length - 1]!.sceneBreak) blocks.pop();
  for (const [key, value] of anchors) if (value > blocks.length) anchors.set(key, blocks.length);

  return { blocks, anchors, semantics, htmlTitle };
}

function blocksToBody(blocks: Block[]): string {
  const paragraphs: string[] = [];
  for (const block of blocks) {
    if (block.sceneBreak) {
      if (paragraphs.length && paragraphs[paragraphs.length - 1] !== SCENE_BREAK) paragraphs.push(SCENE_BREAK);
      continue;
    }
    paragraphs.push(block.text);
  }
  while (paragraphs.length && paragraphs[paragraphs.length - 1] === SCENE_BREAK) paragraphs.pop();
  return paragraphs.join("\n\n");
}

/**
 * The block that named a section is also the section's first block, so the body
 * opened with that title as well: every chapter showed its own title twice, and
 * the narrator read it twice. The block stays in `section.blocks` because the
 * front-matter classifiers count words there; it is simply not part of the text.
 */
function dropRepeatedHeading(title: string, blocks: Block[]): Block[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = normalize(title);
  if (!wanted) return blocks;
  let index = 0;
  while (index < blocks.length && normalize(blocks[index]!.text) === wanted) index++;
  return index ? blocks.slice(index) : blocks;
}

// ---------------------------------------------------------------------------
// Front / back matter classification
// ---------------------------------------------------------------------------

const FRONT_TITLES = /^(?:cover|front ?cover|title( page)?|half[- ]title|copyright( page)?|imprint|contents|table of contents|toc|dedication|also by.*|other (books|titles|works) by.*|books by.*|by the same author.*|praise for.*|advance praise.*|epigraph|list of (illustrations|maps|figures|tables)|maps?|frontispiece|cast of characters|dramatis personae|characters|welcome|about this (e)?book)$/i;
const BACK_TITLES = /^(?:about the authors?|about the illustrator|acknowledg(e)?ments?|appendix.*|glossary|index|notes|endnotes|footnotes|bibliography|references|further reading|sources|permissions|credits|colophon|reading group guide|discussion questions|questions for discussion|a conversation with.*|excerpt.*|preview.*|sneak peek.*|bonus.*|newsletter|sign up.*|also available.*|coming soon.*|back ?cover|copyright|about the publisher|thank you for reading.*)$/i;
const FRONT_SEMANTICS = new Set(["cover", "titlepage", "halftitlepage", "copyright-page", "toc", "dedication", "frontmatter", "imprint", "loi", "lot", "seriespage", "other-credits", "doc-toc", "doc-dedication", "doc-cover"]);
const BACK_SEMANTICS = new Set(["backmatter", "index", "glossary", "bibliography", "colophon", "acknowledgments", "acknowledgements", "appendix", "endnotes", "rearnotes", "footnotes", "doc-acknowledgments", "doc-appendix", "doc-bibliography", "doc-colophon", "doc-endnotes", "doc-glossary", "doc-index"]);
const FRONT_FILES = /(^|\/)(cover|title(page)?|toc|nav|copyright|dedication|halftitle|imprint|frontmatter|front)[-_\d]*\.x?html?$/i;
const BACK_FILES = /(^|\/)(about(the)?author|acknowledg\w*|backmatter|back|colophon|index|glossary|appendix|endnotes|notes|excerpt|preview|newsletter)[-_\d]*\.x?html?$/i;
const CHAPTER_LIKE = /^(?:chapter|chap\.|part|book|volume|act|canto|letter|prologue|epilogue|interlude|preface|foreword|introduction|afterword|author['’]?s note)\b|^\d+\b|^[ivxlcdm]+(?:[.:]\s|\.?$)/i;
const LEGAL_TEXT = /\b(copyright|all rights reserved|isbn|published by|printed in|library of congress|©)\b/i;

type Section = {
  title: string;
  blocks: Block[];
  semantics: Set<string>;
  href?: string;
  /** Title was invented because the source had none. */
  untitled?: boolean;
};

function sectionWords(section: Section): number {
  return section.blocks.reduce((total, block) => total + (block.sceneBreak ? 0 : countWords(block.text)), 0);
}

function sectionText(section: Section): string {
  return section.blocks.map(block => block.text).join(" ");
}

function explicitKind(section: Section): ChapterKind | null {
  const title = section.title.trim();
  for (const value of section.semantics) {
    if (FRONT_SEMANTICS.has(value)) return "front-matter";
    if (BACK_SEMANTICS.has(value)) return "back-matter";
  }
  if (!section.untitled) {
    if (FRONT_TITLES.test(title)) return "front-matter";
    if (BACK_TITLES.test(title)) return "back-matter";
  }
  if (section.href && FRONT_FILES.test(section.href)) return "front-matter";
  if (section.href && BACK_FILES.test(section.href)) return "back-matter";
  const words = sectionWords(section);
  if (words < 120 && LEGAL_TEXT.test(sectionText(section))) return "front-matter";
  return null;
}

/**
 * Decides chapter / front-matter / back-matter for every section.
 *
 * Explicit signals (EPUB semantics, well-known titles, file names) win. For the
 * rest, anything short that sits before the first real chapter is front matter.
 */
export function classifySections(sections: Section[]): ChapterKind[] {
  const kinds = sections.map(section => explicitKind(section));
  const isChapterLike = (section: Section, index: number) =>
    kinds[index] === null && (CHAPTER_LIKE.test(section.title.trim()) || sectionWords(section) >= 300);

  const firstChapter = sections.findIndex(isChapterLike);
  return sections.map((section, index) => {
    const explicit = kinds[index];
    if (explicit) return explicit;
    if (firstChapter >= 0 && index < firstChapter && sectionWords(section) < 150 && !CHAPTER_LIKE.test(section.title.trim())) {
      return "front-matter";
    }
    return "chapter";
  });
}

/**
 * Merges tiny divider pages ("Part One") into the chapter that follows, so the
 * divider is still read but does not become a 3-second track of its own.
 */
function mergeDividers(sections: Section[], kinds: ChapterKind[]): { sections: Section[]; kinds: ChapterKind[] } {
  const outSections: Section[] = [];
  const outKinds: ChapterKind[] = [];
  let pending: Section | null = null;

  sections.forEach((section, index) => {
    const kind = kinds[index]!;
    const words = sectionWords(section);
    const next = sections[index + 1];
    const nextKind = kinds[index + 1];
    const textBlocks = section.blocks.filter(block => !block.sceneBreak);
    // A divider is a title page for a part: a few heading-like lines, no prose.
    const looksLikeDivider =
      textBlocks.length <= 3 &&
      (/^(part|book|volume)\b/i.test(section.title.trim()) || textBlocks.every(block => block.heading > 0 || !/[.!?]["”’]?$/.test(block.text)));
    const isDivider = kind === "chapter" && words > 0 && words < 20 && looksLikeDivider && next !== undefined && nextKind === "chapter";

    if (isDivider) {
      pending = pending
        ? { ...pending, blocks: [...pending.blocks, ...section.blocks] }
        : { ...section, blocks: [...section.blocks] };
      return;
    }
    if (pending && kind === "chapter") {
      outSections.push({ ...section, blocks: [...(pending as Section).blocks, ...section.blocks] });
      outKinds.push(kind);
      pending = null;
      return;
    }
    if (pending) {
      outSections.push(pending);
      outKinds.push("chapter");
      pending = null;
    }
    outSections.push(section);
    outKinds.push(kind);
  });
  if (pending) {
    outSections.push(pending);
    outKinds.push("chapter");
  }
  return { sections: outSections, kinds: outKinds };
}

function finalizeSections(sections: Section[], warnings: string[]): ImportedChapter[] {
  const nonEmpty = sections.filter(section => sectionWords(section) > 0);
  const classified = classifySections(nonEmpty);
  const merged = mergeDividers(nonEmpty, classified);

  const chapters = merged.sections.map((section, index) => {
    const kind = merged.kinds[index]!;
    const title = tidyTitle(section.title) || `Section ${index + 1}`;
    const body = blocksToBody(dropRepeatedHeading(title, section.blocks));
    return {
      title,
      body,
      kind,
      included: kind === "chapter",
      wordCount: countWords(body),
    } satisfies ImportedChapter;
  }).filter(chapter => chapter.body.trim().length > 0);

  if (chapters.length > MAX_CHAPTERS) {
    warnings.push(`The manuscript has ${chapters.length} sections; only the first ${MAX_CHAPTERS} were imported.`);
    return chapters.slice(0, MAX_CHAPTERS);
  }
  if (!chapters.some(chapter => chapter.included) && chapters.length) {
    // Never hand back a book with nothing selected; the classifier was wrong.
    chapters.forEach(chapter => { chapter.included = true; });
    warnings.push("Prosecast could not tell the chapters from the front matter, so every section is selected.");
  }
  return chapters;
}

// ---------------------------------------------------------------------------
// Splitting a single document on its headings (DOCX, HTML, one-file EPUBs)
// ---------------------------------------------------------------------------

function splitBlocksOnHeadings(blocks: Block[], fallbackTitle: string): Section[] {
  const levels = [1, 2, 3].map(level => ({ level, count: blocks.filter(block => block.heading === level).length }));
  const chosen = levels.find(entry => entry.count >= 2);
  if (!chosen) {
    const fromText = splitBlocksOnChapterLines(blocks);
    if (fromText) return fromText;
    return [{ title: blocks.find(block => block.heading)?.text || fallbackTitle, blocks, semantics: new Set(), untitled: !blocks.some(block => block.heading) }];
  }

  const sections: Section[] = [];
  let current: Section = { title: "Opening", blocks: [], semantics: new Set(), untitled: true };
  for (const block of blocks) {
    if (block.heading && block.heading <= chosen.level) {
      if (current.blocks.length) sections.push(current);
      current = { title: block.text, blocks: [block], semantics: new Set() };
      continue;
    }
    current.blocks.push(block);
  }
  if (current.blocks.length) sections.push(current);
  return sections;
}

/** Plain-text chapter headings on their own line. */
const CHAPTER_LINE = /^(?:(?:chapter|chap\.|book|part|volume|act|canto|letter)\s+(?:\d+|[ivxlcdm]+|[a-z]+(?:[- ][a-z]+)?)\b(?:\s*[:.\-—–]?\s*.{0,80})?|prologue|epilogue|interlude|preface|foreword|introduction|afterword)\s*\.?$/i;
const ROMAN_LINE = /^(?=[MDCLXVI])M*(C[MD]|D?C{0,3})(X[CL]|L?X{0,3})(I[XV]|V?I{0,3})\.?$/;

function isChapterLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 90 || trimmed.includes("\n")) return false;
  if (/[,;]$/.test(trimmed)) return false;
  return CHAPTER_LINE.test(trimmed);
}

function splitBlocksOnChapterLines(blocks: Block[]): Section[] | null {
  let headingIndexes = blocks.map((block, index) => (isChapterLine(block.text) ? index : -1)).filter(index => index >= 0);
  if (headingIndexes.length < 2) {
    const roman = blocks.map((block, index) => (ROMAN_LINE.test(block.text.trim()) ? index : -1)).filter(index => index >= 0);
    if (roman.length >= 3) headingIndexes = roman;
  }
  if (headingIndexes.length < 2) return null;

  const sections: Section[] = [];
  if (headingIndexes[0]! > 0) {
    sections.push({ title: "Opening", blocks: blocks.slice(0, headingIndexes[0]), semantics: new Set(), untitled: true });
  }
  headingIndexes.forEach((start, position) => {
    const end = headingIndexes[position + 1] ?? blocks.length;
    sections.push({ title: blocks[start]!.text, blocks: blocks.slice(start, end), semantics: new Set() });
  });

  // A table of contents is a run of headings with nothing between them.
  // Collapse it into one front-matter section instead of forty empty chapters.
  const result: Section[] = [];
  let tocRun: Section[] = [];
  const flushToc = () => {
    if (tocRun.length >= 3) {
      result.push({ title: "Contents", blocks: tocRun.flatMap(section => section.blocks), semantics: new Set(["toc"]) });
    } else {
      result.push(...tocRun);
    }
    tocRun = [];
  };
  for (const section of sections) {
    const bodyWords = sectionWords(section) - countWords(section.title);
    if (bodyWords < 8 && section.title !== "Opening") {
      tocRun.push(section);
      continue;
    }
    flushToc();
    result.push(section);
  }
  flushToc();
  return result;
}

/** Chops a heading-less manuscript into readable parts at paragraph breaks. */
function chunkLongSection(section: Section, targetWords = 5_000): Section[] {
  const words = sectionWords(section);
  if (words <= targetWords * 1.5) return [section];
  const parts: Section[] = [];
  let current: Block[] = [];
  let count = 0;
  for (const block of section.blocks) {
    current.push(block);
    count += countWords(block.text);
    if (count >= targetWords) {
      parts.push({ title: `Part ${parts.length + 1}`, blocks: current, semantics: new Set() });
      current = [];
      count = 0;
    }
  }
  if (current.length) parts.push({ title: `Part ${parts.length + 1}`, blocks: current, semantics: new Set() });
  return parts;
}

// ---------------------------------------------------------------------------
// Plain text and Markdown
// ---------------------------------------------------------------------------

/** Removes Project Gutenberg's licence header and footer when present. */
function stripGutenberg(text: string): string {
  const start = text.search(/^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG.*\*{3}\s*$/im);
  const end = text.search(/^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG.*\*{3}\s*$/im);
  let result = text;
  if (end > 0) result = result.slice(0, end);
  if (start >= 0) {
    const lineEnd = result.indexOf("\n", start);
    result = lineEnd >= 0 ? result.slice(lineEnd + 1) : "";
  }
  return result;
}

function markdownInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

/** Splits text into paragraph blocks, unwrapping hard-wrapped lines when the text uses blank-line paragraphs. */
export function textToBlocks(input: string, options: { markdown?: boolean } = {}): Block[] {
  let text = input.replace(/\r\n?/g, "\n");
  if (options.markdown) text = text.replace(/^```[\s\S]*?^```\s*$/gm, "");

  const lines = text.split("\n");
  const blankLines = lines.filter(line => !line.trim()).length;
  const contentLines = lines.length - blankLines;
  // Blank-line paragraphs (hard-wrapped or not) vs one paragraph per line.
  const blankSeparated = blankLines >= Math.max(1, contentLines * 0.08);

  const rawParagraphs = blankSeparated
    ? text.split(/\n\s*\n+/)
    : lines;

  const blocks: Block[] = [];
  for (const raw of rawParagraphs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (options.markdown) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
      if (heading && !trimmed.includes("\n")) {
        blocks.push({ text: collapseWhitespace(markdownInline(heading[2]!)), heading: heading[1]!.length });
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        blocks.push({ text: SCENE_BREAK, heading: 0, sceneBreak: true });
        continue;
      }
    }

    if (isSceneBreakText(trimmed)) {
      blocks.push({ text: SCENE_BREAK, heading: 0, sceneBreak: true });
      continue;
    }

    // Unwrap hard line breaks inside a paragraph.
    let paragraph = blankSeparated ? trimmed.split("\n").map(line => line.trim()).join(" ") : trimmed;
    if (options.markdown) paragraph = markdownInline(paragraph.replace(/^>\s?/gm, "").replace(/^\s*[-*+]\s+/, ""));
    paragraph = collapseWhitespace(paragraph);
    if (paragraph) blocks.push({ text: paragraph, heading: 0 });
  }
  return blocks;
}

function importText(data: Buffer, markdown: boolean, fallbackTitle: string): ImportResult {
  const warnings: string[] = [];
  const raw = decodeText(data);
  const text = stripGutenberg(raw);
  if (text.length < raw.length * 0.98 && /PROJECT GUTENBERG/i.test(raw)) warnings.push("Removed the Project Gutenberg licence header and footer.");

  const blocks = textToBlocks(text, { markdown });
  if (!blocks.length) throw new ManuscriptImportError("The file has no readable text.");

  let sections = splitBlocksOnHeadings(blocks, fallbackTitle);
  if (sections.length === 1) {
    const chunks = chunkLongSection(sections[0]!);
    if (chunks.length > 1) warnings.push("No chapter headings were found, so the text was split into parts of about 5,000 words.");
    sections = chunks;
  }
  return { format: markdown ? "markdown" : "text", chapters: finalizeSections(sections, warnings), warnings };
}

// ---------------------------------------------------------------------------
// HTML and DOCX
// ---------------------------------------------------------------------------

function importHtmlString(html: string, format: ManuscriptFormat, fallbackTitle: string, warnings: string[]): ImportResult {
  const doc = htmlToBlocks(html);
  if (!doc.blocks.length) throw new ManuscriptImportError("The document has no readable text.");
  let sections = splitBlocksOnHeadings(doc.blocks, doc.htmlTitle || fallbackTitle);
  if (sections.length === 1) {
    const chunks = chunkLongSection(sections[0]!);
    if (chunks.length > 1) warnings.push("No chapter headings were found, so the text was split into parts of about 5,000 words.");
    sections = chunks;
  }
  return { format, title: doc.htmlTitle, chapters: finalizeSections(sections, warnings), warnings };
}

async function importDocx(data: Buffer, fallbackTitle: string): Promise<ImportResult> {
  const warnings: string[] = [];
  let html: string;
  try {
    const result = await mammoth.convertToHtml({ buffer: data });
    html = result.value;
  } catch (error) {
    throw new ManuscriptImportError(`The Word document could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return importHtmlString(html, "docx", fallbackTitle, warnings);
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

type ManifestItem = { id: string; href: string; path: string; mediaType: string; properties: string };
type TocEntry = { title: string; path: string; fragment: string | null; depth: number };

class ArchiveReader {
  private readonly byLowerPath = new Map<string, string>();
  private textBytes = 0;

  constructor(private readonly zip: JSZip) {
    for (const name of Object.keys(zip.files)) this.byLowerPath.set(name.toLowerCase(), name);
  }

  resolve(filePath: string): string | null {
    if (this.zip.files[filePath]) return filePath;
    return this.byLowerPath.get(filePath.toLowerCase()) ?? null;
  }

  async text(filePath: string): Promise<string | null> {
    const resolved = this.resolve(filePath);
    if (!resolved) return null;
    const file = this.zip.file(resolved);
    if (!file) return null;
    const content = await file.async("string");
    this.textBytes += content.length;
    if (this.textBytes > MAX_ARCHIVE_TEXT_BYTES) {
      throw new ManuscriptImportError("The EPUB expands to more text than Bookx can import at once.");
    }
    return content;
  }
}

/** Resolves an href relative to the document that contains it. */
function resolveHref(baseFile: string, href: string): { path: string; fragment: string | null } {
  const [rawPath = "", fragment] = href.split("#");
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  const baseDir = path.posix.dirname(baseFile);
  const joined = decoded ? path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, decoded)) : baseFile;
  return { path: joined.replace(/^\/+/, ""), fragment: fragment ? decodeURIComponentSafe(fragment) : null };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseNavToc(xhtml: string, navPath: string): TocEntry[] {
  const root = parseHtml(xhtml);
  const navs = findAll(root, node => localName(node.name) === "nav");
  const toc = navs.find(nav => /\btoc\b/i.test(semanticsOf(nav))) ?? navs[0];
  if (!toc) return [];

  const entries: TocEntry[] = [];
  const walkList = (list: DomNode, depth: number) => {
    for (const item of list.children ?? []) {
      if (localName(item.name) !== "li") continue;
      const anchor = findFirst(item, node => localName(node.name) === "a" && Boolean(node.attribs?.href));
      const ownAnchor = anchor && !isInsideNestedList(item, anchor) ? anchor : undefined;
      if (ownAnchor?.attribs?.href) {
        const target = resolveHref(navPath, ownAnchor.attribs.href);
        entries.push({ title: collapseWhitespace(textContent(ownAnchor)), path: target.path, fragment: target.fragment, depth });
      }
      for (const child of item.children ?? []) {
        if (localName(child.name) === "ol" || localName(child.name) === "ul") walkList(child, depth + 1);
      }
    }
  };
  for (const child of findAll(toc, node => localName(node.name) === "ol" || localName(node.name) === "ul").slice(0, 1)) {
    walkList(child, 0);
  }
  return entries;
}

function isInsideNestedList(item: DomNode, target: DomNode): boolean {
  const search = (node: DomNode, insideList: boolean): boolean | null => {
    for (const child of node.children ?? []) {
      if (child === target) return insideList;
      const name = localName(child.name);
      const found = search(child, insideList || name === "ol" || name === "ul");
      if (found !== null) return found;
    }
    return null;
  };
  return search(item, false) ?? false;
}

function parseNcxToc(xml: string, ncxPath: string): TocEntry[] {
  const root = parseXml(xml);
  const navMap = findFirst(root, node => localName(node.name) === "navmap");
  if (!navMap) return [];
  const entries: TocEntry[] = [];
  const walk = (node: DomNode, depth: number) => {
    for (const child of node.children ?? []) {
      if (localName(child.name) !== "navpoint") continue;
      const label = findFirst(child, n => localName(n.name) === "text");
      const content = (child.children ?? []).find(n => localName(n.name) === "content");
      const src = content?.attribs?.src;
      if (src) {
        const target = resolveHref(ncxPath, src);
        entries.push({ title: collapseWhitespace(label ? textContent(label) : ""), path: target.path, fragment: target.fragment, depth });
      }
      walk(child, depth + 1);
    }
  };
  walk(navMap, 0);
  return entries;
}

async function importEpub(data: Buffer, fallbackTitle: string): Promise<ImportResult> {
  const warnings: string[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new ManuscriptImportError("The EPUB could not be opened. It may be damaged or not a real EPUB file.");
  }
  if (Object.keys(zip.files).length > MAX_ARCHIVE_ENTRIES) {
    throw new ManuscriptImportError("The EPUB contains too many files to import.");
  }
  const archive = new ArchiveReader(zip);

  const container = await archive.text("META-INF/container.xml");
  const containerRoot = container ? parseXml(container) : null;
  const rootfile = containerRoot ? findFirst(containerRoot, node => localName(node.name) === "rootfile" && Boolean(node.attribs?.["full-path"])) : undefined;
  let opfPath = rootfile?.attribs?.["full-path"] ?? null;
  if (!opfPath) {
    opfPath = Object.keys(zip.files).find(name => name.toLowerCase().endsWith(".opf")) ?? null;
  }
  const opf = opfPath ? await archive.text(opfPath) : null;
  if (!opf || !opfPath) throw new ManuscriptImportError("The EPUB has no package document (content.opf).");

  const opfRoot = parseXml(opf);
  const metadataText = (tag: string) => {
    const node = findFirst(opfRoot, candidate => localName(candidate.name) === tag);
    return node ? collapseWhitespace(textContent(node)) || undefined : undefined;
  };
  const title = metadataText("title");
  const author = metadataText("creator");
  const language = metadataText("language");

  const manifest = new Map<string, ManifestItem>();
  for (const item of findAll(opfRoot, node => localName(node.name) === "item")) {
    const id = item.attribs?.id;
    const href = item.attribs?.href;
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href,
      path: resolveHref(opfPath, href).path,
      mediaType: (item.attribs?.["media-type"] ?? "").toLowerCase(),
      properties: item.attribs?.properties ?? "",
    });
  }

  const spineNode = findFirst(opfRoot, node => localName(node.name) === "spine");
  const spine = findAll(spineNode ?? opfRoot, node => localName(node.name) === "itemref")
    .filter(ref => (ref.attribs?.linear ?? "yes").toLowerCase() !== "no")
    .map(ref => manifest.get(ref.attribs?.idref ?? ""))
    .filter((item): item is ManifestItem => Boolean(item) && /html|xml/.test(item!.mediaType));

  // EPUB 2 guide references and EPUB 3 landmarks, for front/back matter.
  const landmarkTypes = new Map<string, Set<string>>();
  const addLandmark = (filePath: string, type: string) => {
    const set = landmarkTypes.get(filePath) ?? new Set<string>();
    for (const value of type.toLowerCase().split(/\s+/)) if (value) set.add(value.replace(/^text$/, "bodymatter"));
    landmarkTypes.set(filePath, set);
  };
  for (const reference of findAll(opfRoot, node => localName(node.name) === "reference")) {
    if (reference.attribs?.href && reference.attribs?.type) {
      addLandmark(resolveHref(opfPath, reference.attribs.href).path, reference.attribs.type === "title-page" ? "titlepage" : reference.attribs.type === "copyright-page" ? "copyright-page" : reference.attribs.type);
    }
  }

  // Table of contents: EPUB 3 nav first, then the EPUB 2 NCX.
  let toc: TocEntry[] = [];
  const navItem = [...manifest.values()].find(item => /\bnav\b/.test(item.properties));
  if (navItem) {
    const navXhtml = await archive.text(navItem.path);
    if (navXhtml) {
      toc = parseNavToc(navXhtml, navItem.path);
      const navRoot = parseHtml(navXhtml);
      const landmarksNav = findAll(navRoot, node => localName(node.name) === "nav" && /landmarks/i.test(semanticsOf(node)))[0];
      for (const link of landmarksNav ? findAll(landmarksNav, node => localName(node.name) === "a") : []) {
        const type = link.attribs?.["epub:type"];
        if (link.attribs?.href && type) addLandmark(resolveHref(navItem.path, link.attribs.href).path, type);
      }
    }
  }
  if (!toc.length) {
    const ncxId = spineNode?.attribs?.toc;
    const ncxItem = (ncxId ? manifest.get(ncxId) : undefined) ?? [...manifest.values()].find(item => item.mediaType === "application/x-dtbncx+xml");
    if (ncxItem) {
      const ncx = await archive.text(ncxItem.path);
      if (ncx) toc = parseNcxToc(ncx, ncxItem.path);
    }
  }

  // Parse every spine document once.
  const docs: Array<{ path: string; parsed: ParsedDoc }> = [];
  for (const item of spine) {
    if (navItem && item.path === navItem.path) continue; // the nav document itself is never narrated
    const xhtml = await archive.text(item.path);
    if (xhtml === null) {
      warnings.push(`Skipped a missing file listed in the EPUB: ${item.href}`);
      continue;
    }
    const parsed = htmlToBlocks(xhtml);
    for (const value of landmarkTypes.get(item.path) ?? []) parsed.semantics.add(value);
    docs.push({ path: item.path, parsed });
  }
  if (!docs.length) throw new ManuscriptImportError("The EPUB has no readable chapters.");

  const docIndexByPath = new Map(docs.map((doc, index) => [doc.path.toLowerCase(), index]));

  // Map TOC entries to positions in the spine.
  type Position = { doc: number; block: number; title: string; depth: number };
  const positions: Position[] = [];
  for (const entry of toc) {
    const docIndex = docIndexByPath.get(entry.path.toLowerCase());
    if (docIndex === undefined) continue;
    const doc = docs[docIndex]!;
    const block = entry.fragment ? doc.parsed.anchors.get(entry.fragment) ?? 0 : 0;
    positions.push({ doc: docIndex, block, title: entry.title, depth: entry.depth });
  }
  positions.sort((left, right) => left.doc - right.doc || left.block - right.block || right.depth - left.depth);
  // Two entries at one position (a part and its first chapter): keep the deeper title.
  const unique: Position[] = [];
  for (const position of positions) {
    const previous = unique[unique.length - 1];
    if (previous && previous.doc === position.doc && previous.block === position.block) {
      if (position.depth > previous.depth) unique[unique.length - 1] = position;
      continue;
    }
    unique.push(position);
  }

  let sections: Section[];
  const tocCoversBook = unique.length >= 2 || (unique.length === 1 && docs.length === 1);

  if (tocCoversBook) {
    sections = [];
    // Anything before the first TOC entry, one section per document.
    const first = unique[0]!;
    for (let docIndex = 0; docIndex <= first.doc; docIndex++) {
      const doc = docs[docIndex]!;
      const blocks = docIndex === first.doc ? doc.parsed.blocks.slice(0, first.block) : doc.parsed.blocks;
      if (!blocks.length) continue;
      sections.push({
        title: blocks.find(block => block.heading)?.text || doc.parsed.htmlTitle || titleFromFile(doc.path),
        blocks,
        semantics: doc.parsed.semantics,
        href: doc.path,
        untitled: !blocks.some(block => block.heading),
      });
    }
    unique.forEach((position, index) => {
      const next = unique[index + 1];
      const blocks: Block[] = [];
      const semantics = new Set<string>();
      const endDoc = next ? next.doc : docs.length - 1;
      for (let docIndex = position.doc; docIndex <= endDoc; docIndex++) {
        const doc = docs[docIndex]!;
        const start = docIndex === position.doc ? position.block : 0;
        const end = next && docIndex === next.doc ? next.block : doc.parsed.blocks.length;
        if (end > start) blocks.push(...doc.parsed.blocks.slice(start, end));
        if (docIndex === position.doc) for (const value of doc.parsed.semantics) semantics.add(value);
      }
      sections.push({ title: position.title || blocks.find(block => block.heading)?.text || `Chapter ${index + 1}`, blocks, semantics, href: docs[position.doc]!.path });
    });
  } else {
    if (toc.length) warnings.push("The EPUB's table of contents did not match its files, so chapters follow the file order instead.");
    sections = [];
    for (const doc of docs) {
      const split = docs.length === 1
        ? splitBlocksOnHeadings(doc.parsed.blocks, title || fallbackTitle)
        : [{
            title: doc.parsed.blocks.find(block => block.heading)?.text || doc.parsed.htmlTitle || titleFromFile(doc.path),
            blocks: doc.parsed.blocks,
            semantics: doc.parsed.semantics,
            untitled: !doc.parsed.blocks.some(block => block.heading),
          } satisfies Section];
      for (const section of split) sections.push({ ...section, semantics: new Set([...section.semantics, ...doc.parsed.semantics]), href: doc.path });
    }
  }

  const chapters = finalizeSections(sections, warnings);
  if (!chapters.length) throw new ManuscriptImportError("The EPUB has no readable text. It may contain only images, or be protected by DRM.");
  return { format: "epub", title, author, language, chapters, warnings };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function detectFormat(filename: string, data: Buffer): ManuscriptFormat {
  const extension = path.extname(filename).toLowerCase();
  const isZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
  if (isZip) {
    // EPUB stores an uncompressed "mimetype" entry first; DOCX has [Content_Types].xml.
    const head = data.subarray(0, 200).toString("latin1");
    if (head.includes("application/epub+zip") || extension === ".epub") return "epub";
    if (extension === ".docx" || head.includes("[Content_Types].xml") || head.includes("word/")) return "docx";
    throw new ManuscriptImportError("This archive is neither an EPUB nor a Word document.");
  }
  if (extension === ".epub") throw new ManuscriptImportError("This file has an .epub name but is not a valid EPUB archive.");
  if (extension === ".docx") throw new ManuscriptImportError("This file has a .docx name but is not a valid Word document.");
  if (extension === ".doc") throw new ManuscriptImportError("Old .doc files are not supported. Save the manuscript as .docx or EPUB and try again.");
  if (extension === ".pdf" || data.subarray(0, 5).toString("latin1") === "%PDF-") {
    throw new ManuscriptImportError("PDF is not supported. Export the manuscript as EPUB, DOCX or plain text and try again.");
  }
  if (extension === ".html" || extension === ".htm" || extension === ".xhtml") return "html";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  const sniff = data.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (sniff.startsWith("<!doctype html") || sniff.startsWith("<html")) return "html";
  return "text";
}

export async function parseManuscript(input: { filename: string; data: Buffer }): Promise<ImportResult> {
  if (!input.data.length) throw new ManuscriptImportError("The file is empty.");
  if (input.data.length > MAX_MANUSCRIPT_BYTES) {
    throw new ManuscriptImportError(`The file is larger than ${Math.round(MAX_MANUSCRIPT_BYTES / (1024 * 1024))} MB.`);
  }
  const fallbackTitle = path.basename(input.filename, path.extname(input.filename)).replace(/[_-]+/g, " ").trim() || "Manuscript";
  const format = detectFormat(input.filename, input.data);

  switch (format) {
    case "epub":
      return importEpub(input.data, fallbackTitle);
    case "docx":
      return importDocx(input.data, fallbackTitle);
    case "html":
      return importHtmlString(decodeText(input.data), "html", fallbackTitle, []);
    case "markdown":
      return importText(input.data, true, fallbackTitle);
    default:
      return importText(input.data, false, fallbackTitle);
  }
}
