import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { ManuscriptImportError, SCENE_BREAK, countWords, detectFormat, htmlToBlocks, isSceneBreakText, parseManuscript, textToBlocks, tidyTitle } from "./manuscriptImport";

const xhtml = (title: string, body: string, bodyAttrs = "") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title><style>p { margin: 0 }</style></head>
<body ${bodyAttrs}>${body}</body></html>`;

const longParagraph = (seed: string, words = 60) => Array.from({ length: words }, (_, index) => `${seed}${index % 7}`).join(" ") + ".";

async function buildEpub(options: { withNav?: boolean; withNcx?: boolean } = { withNav: true, withNcx: true }) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Quiet Current</dc:title>
    <dc:creator>Mira Ellis</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${options.withNav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ""}
    ${options.withNcx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ""}
    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="copyright" href="Text/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="about" href="Text/about.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="Images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine ${options.withNcx ? 'toc="ncx"' : ""}>
    <itemref idref="cover"/>
    <itemref idref="copyright"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="notes" linear="no"/>
    <itemref idref="about"/>
  </spine>
</package>`);
  if (options.withNav) {
    zip.file("OEBPS/nav.xhtml", xhtml("Contents", `<nav epub:type="toc"><h1>Contents</h1><ol>
      <li><a href="Text/chapter%201.xhtml">Chapter One: The Storm</a></li>
      <li><a href="Text/ch2.xhtml#start">Chapter Two</a>
        <ol><li><a href="Text/ch2.xhtml#part-b">The Harbour</a></li></ol>
      </li>
      <li><a href="Text/about.xhtml">About the Author</a></li>
    </ol></nav>`));
  }
  if (options.withNcx) {
    zip.file("OEBPS/toc.ncx", `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint id="n1"><navLabel><text>Chapter One: The Storm</text></navLabel><content src="Text/chapter%201.xhtml"/></navPoint>
      <navPoint id="n2"><navLabel><text>Chapter Two</text></navLabel><content src="Text/ch2.xhtml#start"/>
        <navPoint id="n3"><navLabel><text>The Harbour</text></navLabel><content src="Text/ch2.xhtml#part-b"/></navPoint>
      </navPoint>
      <navPoint id="n4"><navLabel><text>About the Author</text></navLabel><content src="Text/about.xhtml"/></navPoint>
    </navMap></ncx>`);
  }
  zip.file("OEBPS/Text/cover.xhtml", xhtml("Cover", `<div><img src="../Images/cover.jpg" alt="Cover"/></div><p>The Quiet Current</p>`, 'epub:type="cover"'));
  zip.file("OEBPS/Text/copyright.xhtml", xhtml("Copyright", `<p>Copyright &copy; 2026 Mira Ellis. All rights reserved.</p><p>ISBN 978-0-00-000000-0</p>`));
  zip.file("OEBPS/Text/chapter 1.xhtml", xhtml("Chapter One", `<h1>Chapter One: The Storm</h1>
    <p>The rain had not stopped for three days&nbsp;and the river rose.<sup><a epub:type="noteref" href="notes.xhtml#n1">1</a></sup></p>
    <p>&ldquo;Are you coming?&rdquo; Mara asked. Elias shook his head&mdash;slowly.</p>
    <p class="break">* * *</p>
    <p>${longParagraph("storm")}</p>
    <aside epub:type="footnote" id="n1"><p>This note should never be narrated.</p></aside>`));
  zip.file("OEBPS/Text/ch2.xhtml", xhtml("Chapter Two", `<section id="start"><h2>Chapter Two</h2><p>${longParagraph("dawn")}</p></section>
    <section id="part-b"><h3>The Harbour</h3><p>${longParagraph("harbour")}</p></section>`));
  zip.file("OEBPS/Text/notes.xhtml", xhtml("Notes", `<p id="n1">A linear="no" note document.</p>`));
  zip.file("OEBPS/Text/about.xhtml", xhtml("About the Author", `<h1>About the Author</h1><p>Mira Ellis lives by the sea.</p>`));
  zip.file("OEBPS/Images/cover.jpg", Buffer.from([0xff, 0xd8, 0xff]));
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

describe("manuscript import: EPUB", () => {
  it("splits an EPUB 3 book on its nav table of contents and excludes front and back matter", async () => {
    const result = await parseManuscript({ filename: "quiet-current.epub", data: await buildEpub() });

    expect(result.format).toBe("epub");
    expect(result.title).toBe("The Quiet Current");
    expect(result.author).toBe("Mira Ellis");
    expect(result.language).toBe("en");

    const titles = result.chapters.map(chapter => chapter.title);
    expect(titles).toEqual(["Cover", "Copyright", "Chapter One: The Storm", "Chapter Two", "The Harbour", "About the Author"]);

    const byTitle = Object.fromEntries(result.chapters.map(chapter => [chapter.title, chapter]));
    expect(byTitle["Cover"]).toMatchObject({ kind: "front-matter", included: false });
    expect(byTitle["Copyright"]).toMatchObject({ kind: "front-matter", included: false });
    expect(byTitle["About the Author"]).toMatchObject({ kind: "back-matter", included: false });
    expect(byTitle["Chapter One: The Storm"]).toMatchObject({ kind: "chapter", included: true });
    expect(byTitle["The Harbour"]).toMatchObject({ kind: "chapter", included: true });

    const storm = byTitle["Chapter One: The Storm"]!.body;
    // Entities decoded. The heading is no longer repeated at the top of the body:
    // it is the chapter's name, and the narration reads it from there.
    expect(storm.startsWith("Chapter One: The Storm")).toBe(false);
    expect(storm).toContain("“Are you coming?” Mara asked. Elias shook his head—slowly.");
    expect(storm).toContain("three days and the river rose.");
    // Footnote markers and footnote bodies are not narrated.
    expect(storm).not.toContain("never be narrated");
    expect(storm).not.toMatch(/rose\.1/);
    // The scene-break ornament becomes the canonical marker paragraph.
    expect(storm.split("\n\n")).toContain(SCENE_BREAK);
    // The linear="no" notes file is not a chapter.
    expect(titles).not.toContain("Notes");
  });

  it("falls back to the EPUB 2 NCX when there is no nav document", async () => {
    const result = await parseManuscript({ filename: "book.epub", data: await buildEpub({ withNav: false, withNcx: true }) });
    expect(result.chapters.filter(chapter => chapter.included).map(chapter => chapter.title)).toEqual([
      "Chapter One: The Storm",
      "Chapter Two",
      "The Harbour",
    ]);
  });

  it("uses the file order when the EPUB has no table of contents", async () => {
    const result = await parseManuscript({ filename: "book.epub", data: await buildEpub({ withNav: false, withNcx: false }) });
    const included = result.chapters.filter(chapter => chapter.included).map(chapter => chapter.title);
    expect(included).toEqual(["Chapter One: The Storm", "Chapter Two"]);
    expect(result.chapters.find(chapter => chapter.title === "Chapter Two")!.body).toContain("The Harbour");
  });

  it("rejects files that only pretend to be EPUBs", async () => {
    await expect(parseManuscript({ filename: "fake.epub", data: Buffer.from("not a zip") })).rejects.toBeInstanceOf(ManuscriptImportError);
  });
});

describe("manuscript import: text and markdown", () => {
  const gutenberg = [
    "The Project Gutenberg eBook of A Small Tale",
    "",
    "*** START OF THE PROJECT GUTENBERG EBOOK A SMALL TALE ***",
    "",
    "A SMALL TALE",
    "",
    "CONTENTS",
    "",
    "CHAPTER I. The Door",
    "",
    "CHAPTER II. The Key",
    "",
    "CHAPTER III. The Hall",
    "",
    "CHAPTER I. The Door",
    "",
    "The door had been painted green once, long ago, and the",
    "paint had since come away in long curling strips.",
    "",
    `${longParagraph("door", 40)}`,
    "",
    "CHAPTER II. The Key",
    "",
    `${longParagraph("key", 40)}`,
    "",
    "CHAPTER III. The Hall",
    "",
    `${longParagraph("hall", 40)}`,
    "",
    "*** END OF THE PROJECT GUTENBERG EBOOK A SMALL TALE ***",
    "Licence text that must not be narrated.",
  ].join("\r\n");

  it("strips the Gutenberg licence, unwraps hard-wrapped lines and ignores the contents list", async () => {
    const result = await parseManuscript({ filename: "small-tale.txt", data: Buffer.from(gutenberg, "utf8") });
    const included = result.chapters.filter(chapter => chapter.included);
    expect(included.map(chapter => chapter.title)).toEqual(["Chapter I. The Door", "Chapter II. The Key", "Chapter III. The Hall"]);
    expect(included[0]!.body).toContain("The door had been painted green once, long ago, and the paint had since come away in long curling strips.");
    expect(result.chapters.map(chapter => chapter.body).join(" ")).not.toContain("Licence text");
    const contents = result.chapters.find(chapter => chapter.title === "Contents");
    expect(contents?.included).toBe(false);
  });

  it("does not repeat a chapter heading as the chapter's first paragraph", async () => {
    const text = [
      "PROLOGUE",
      "",
      "Nine hundred years before the inn at Korash, there was only the stone.",
      "",
      "CHAPTER 1 — The Scribe",
      "",
      "The ink was wrong, and the scribe knew it before anyone else did.",
    ].join("\n");
    const result = await parseManuscript({ filename: "book.txt", data: Buffer.from(text, "utf8") });
    expect(result.chapters.map(chapter => chapter.body)).toEqual([
      "Nine hundred years before the inn at Korash, there was only the stone.",
      "The ink was wrong, and the scribe knew it before anyone else did.",
    ]);
    for (const chapter of result.chapters) {
      expect(chapter.body.toLowerCase().startsWith(chapter.title.toLowerCase().slice(0, 12))).toBe(false);
    }
  });

  it("splits Markdown on headings and strips inline markup", async () => {
    const markdown = "# Chapter 1\n\nShe said *hello* to [the man](http://x.test).\n\n---\n\nAfter the break.\n\n# Chapter 2\n\nThe end.";
    const result = await parseManuscript({ filename: "notes.md", data: Buffer.from(markdown) });
    expect(result.chapters.map(chapter => chapter.title)).toEqual(["Chapter 1", "Chapter 2"]);
    // The heading names the chapter; it is not also its first paragraph.
    expect(result.chapters[0]!.body).toBe(`She said hello to the man.\n\n${SCENE_BREAK}\n\nAfter the break.`);
  });

  it("treats each line as a paragraph when the text has no blank lines", () => {
    const blocks = textToBlocks("First paragraph.\nSecond paragraph.\nThird paragraph.");
    expect(blocks.map(block => block.text)).toEqual(["First paragraph.", "Second paragraph.", "Third paragraph."]);
  });

  it("decodes Windows-1252 text that is not valid UTF-8", async () => {
    const latin = Buffer.from([0x93, 0x48, 0x69, 0x94, 0x20, 0x73, 0x68, 0x65, 0x20, 0x73, 0x61, 0x69, 0x64, 0x2e]);
    const result = await parseManuscript({ filename: "old.txt", data: latin });
    expect(result.chapters[0]!.body).toBe("“Hi” she said.");
  });
});

describe("manuscript import helpers", () => {
  it("recognises scene-break ornaments but not ordinary short lines", () => {
    for (const ornament of ["* * *", "***", "#", "~~~", "⁂", "• • •", "-----"]) expect(isSceneBreakText(ornament)).toBe(true);
    for (const text of ["...", "1.", "Yes.", "—Oh!", "A"]) expect(isSceneBreakText(text)).toBe(false);
  });

  it("tidies all-caps titles without mangling ordinary words", () => {
    expect(tidyTitle("CHAPTER IV: THE MIX")).toBe("Chapter IV: The Mix");
    expect(tidyTitle("  The   Harbour ")).toBe("The Harbour");
    expect(tidyTitle("Room 101")).toBe("Room 101");
    expect(tidyTitle("Chapter 3 ........ 45")).toBe("Chapter 3");
  });

  it("detects formats from content, not only the extension", () => {
    expect(detectFormat("book.txt", Buffer.from("<!DOCTYPE html><html></html>"))).toBe("html");
    expect(() => detectFormat("book.pdf", Buffer.from("%PDF-1.7"))).toThrow(/PDF is not supported/);
    expect(() => detectFormat("book.doc", Buffer.from("x"))).toThrow(/\.docx/);
  });

  it("records anchors against block positions that survive scene-break cleanup", () => {
    const doc = htmlToBlocks("<body><p>* * *</p><p>One.</p><hr/><hr/><p id='a'>Two.</p></body>");
    expect(doc.blocks.map(block => block.text)).toEqual(["One.", SCENE_BREAK, "Two."]);
    expect(doc.anchors.get("a")).toBe(2);
  });

  it("counts words across punctuation and unicode", () => {
    expect(countWords("“Don’t go,” she said — twice.")).toBe(5);
  });
});
