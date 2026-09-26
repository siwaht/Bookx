import JSZip from "jszip";

/**
 * A small sample EPUB for trying Bookx end to end: a public-domain opening
 * (Pride and Prejudice, chapter 1, abridged) plus an original stormy chapter
 * with a sword fight and a quiet romantic ending, which exercises dialogue
 * attribution and scene sound cues.
 */

const pride = [
  "Chapter 1",
  "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
  "However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.",
  "“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”",
  "Mr. Bennet replied that he had not.",
  "“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”",
  "Mr. Bennet made no answer.",
  "“Do you not want to know who has taken it?” cried his wife impatiently.",
  "“You want to tell me, and I have no objection to hearing it.”",
  "This was invitation enough.",
  "“Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England.”",
  "“What is his name?”",
  "“Bingley.”",
  "“Is he married or single?”",
  "“Oh! Single, my dear, to be sure! A single man of large fortune; four or five thousand a year. What a fine thing for our girls!”",
  "“How so? How can it affect them?”",
  "“My dear Mr. Bennet,” replied his wife, “how can you be so tiresome! You must know that I am thinking of his marrying one of them.”",
];

const storm = [
  "Chapter 2: The Storm at Harrow Pass",
  "The rain came in hard over the ridge, and somewhere beyond the pines the thunder rolled like a cart on cobbles. Captain Aldric Vane pulled his cloak tighter and watched the road.",
  "“They will come tonight,” said Mira Solen, crouching beside him. “No one travels this pass in a storm unless they have to.”",
  "“Then we make sure they regret it,” Aldric answered.",
  "* * *",
  "The raiders broke from the trees an hour later. Steel rang against steel as Aldric met the first of them on the bridge, and the swords clashed again and again until the man fell back into the dark water.",
  "Mira fought at his shoulder, quick and silent, her blade flashing in the lightning.",
  "“Behind you!” she shouted.",
  "He turned in time. When it was over, the only sound left was the rain.",
  "* * *",
  "Later, by the small fire in the ruined chapel, Mira took his hand. Neither of them spoke for a long while.",
  "“I thought I had lost you on that bridge,” she whispered.",
  "Aldric smiled for the first time in days. “You will not lose me so easily.”",
];

const xhtml = (title: string, paragraphs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title></head>
<body>${paragraphs.map((paragraph, index) => (index === 0 ? `<h1>${paragraph}</h1>` : paragraph === "* * *" ? '<p class="break">* * *</p>' : `<p>${paragraph}</p>`)).join("\n")}</body></html>`;

export async function buildSampleEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Bookx Sampler</dc:title><dc:creator>Various</dc:creator><dc:language>en</dc:language></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="copyright" href="copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="copyright"/><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`);
  zip.file("OEBPS/nav.xhtml", xhtml("Contents", ["Contents"]).replace("</body>", `<nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter 1</a></li><li><a href="c2.xhtml">Chapter 2: The Storm at Harrow Pass</a></li></ol></nav></body>`));
  zip.file("OEBPS/cover.xhtml", xhtml("Cover", ["Bookx Sampler"]).replace("<body>", '<body epub:type="cover">'));
  zip.file("OEBPS/copyright.xhtml", xhtml("Copyright", ["Copyright", "Chapter 2 copyright © 2026 Bookx. Chapter 1 is in the public domain. All rights reserved."]));
  zip.file("OEBPS/c1.xhtml", xhtml("Chapter 1", pride));
  zip.file("OEBPS/c2.xhtml", xhtml("Chapter 2", storm));
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}
