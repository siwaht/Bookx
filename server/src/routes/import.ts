import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, run } from '../db/helpers.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

const SUPPORTED_FORMATS = ['.txt', '.md', '.docx', '.epub', '.html', '.htm'];

export function importRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  // Return supported formats
  router.get('/formats', (_req: Request, res: Response) => {
    res.json({
      supported: SUPPORTED_FORMATS,
      description: {
        '.txt': 'Plain text',
        '.md': 'Markdown',
        '.docx': 'Microsoft Word',
        '.epub': 'EPUB ebook',
        '.html': 'HTML document',
        '.htm': 'HTML document',
      },
    });
  });

  router.post('/', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const bookId = req.params.bookId;
      const ext = path.extname(req.file.originalname).toLowerCase();
      let chapters: Array<{ title: string; text: string }> = [];

      if (ext === '.txt' || ext === '.md') {
        const text = fs.readFileSync(req.file.path, 'utf-8');
        chapters = splitIntoChapters(text);
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: req.file.path });
        chapters = splitIntoChapters(result.value);
      } else if (ext === '.epub') {
        chapters = await parseEpub(req.file.path);
      } else if (ext === '.html' || ext === '.htm') {
        const html = fs.readFileSync(req.file.path, 'utf-8');
        const text = stripHtml(html);
        chapters = splitIntoChapters(text);
      } else {
        res.status(400).json({
          error: `Unsupported format: ${ext}`,
          supported: SUPPORTED_FORMATS,
          hint: 'Try converting your file to EPUB, DOCX, TXT, or Markdown first.',
        });
        return;
      }

      // Clean up uploaded file
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }

      if (chapters.length === 0) {
        res.status(400).json({ error: 'No content found in the file. The file may be empty or in an unsupported encoding.' });
        return;
      }

      // Replace existing chapters
      run(db, 'DELETE FROM segments WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id = ?)', [bookId]);
      run(db, 'DELETE FROM chapters WHERE book_id = ?', [bookId]);

      chapters.forEach((ch, index) => {
        run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text, cleaned_text) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), bookId, ch.title, index, ch.text, cleanText(ch.text)]);
      });

      const inserted = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
      res.json({
        chapters: inserted,
        count: inserted.length,
        source_format: ext,
      });
    } catch (err: any) {
      console.error('[Import Error]', err);
      // Clean up uploaded file on error
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      res.status(500).json({ error: `Import failed: ${err.message}` });
    }
  });

  return router;
}

// ── EPUB Parser ──

async function parseEpub(filePath: string): Promise<Array<{ title: string; text: string }>> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // 1. Find the OPF file (package document) via container.xml
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  let opfPath = 'content.opf';
  if (containerXml) {
    const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
    if (rootfileMatch) opfPath = rootfileMatch[1];
  }

  // 2. Parse the OPF to get the spine order
  const opfContent = await zip.file(opfPath)?.async('string');
  if (!opfContent) {
    // Fallback: just find all HTML files in the zip
    return await extractAllHtmlFromZip(zip);
  }

  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // Parse manifest: id -> href mapping
  const manifest = new Map<string, string>();
  const manifestRegex = /<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = manifestRegex.exec(opfContent)) !== null) {
    manifest.set(match[1], match[2]);
  }
  // Also handle href before id
  const manifestRegex2 = /<item\s+[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*>/gi;
  while ((match = manifestRegex2.exec(opfContent)) !== null) {
    manifest.set(match[2], match[1]);
  }

  // Parse spine: ordered list of itemrefs
  const spineItems: string[] = [];
  const spineRegex = /<itemref\s+[^>]*idref="([^"]+)"[^>]*>/gi;
  while ((match = spineRegex.exec(opfContent)) !== null) {
    spineItems.push(match[1]);
  }

  // Parse TOC for chapter titles (from NCX or nav)
  const tocTitles = await extractTocTitles(zip, opfContent, opfDir);

  // 3. Read each spine item in order
  const chapters: Array<{ title: string; text: string }> = [];

  for (let i = 0; i < spineItems.length; i++) {
    const href = manifest.get(spineItems[i]);
    if (!href) continue;

    const fullPath = opfDir + decodeURIComponent(href);
    const file = zip.file(fullPath);
    if (!file) continue;

    const html = await file.async('string');
    const text = stripHtml(html).trim();

    if (!text || text.length < 10) continue; // Skip empty/boilerplate pages

    // Try to get title from TOC, or extract from HTML <title> or first heading
    let title = tocTitles.get(href) || extractTitleFromHtml(html) || `Chapter ${chapters.length + 1}`;

    chapters.push({ title, text });
  }

  // If we got no chapters from spine, fallback
  if (chapters.length === 0) {
    return await extractAllHtmlFromZip(zip);
  }

  return chapters;
}

async function extractTocTitles(zip: JSZip, opfContent: string, opfDir: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();

  // Try NCX file first
  const ncxMatch = opfContent.match(/<item[^>]*media-type="application\/x-dtbncx\+xml"[^>]*href="([^"]+)"/i);
  if (ncxMatch) {
    const ncxPath = opfDir + ncxMatch[1];
    const ncxContent = await zip.file(ncxPath)?.async('string');
    if (ncxContent) {
      // Parse navPoints: <navPoint> ... <text>Title</text> ... <content src="file.xhtml"/> ...
      const navPointRegex = /<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content\s+src="([^"]+)"[\s\S]*?<\/navPoint>/gi;
      let m;
      while ((m = navPointRegex.exec(ncxContent)) !== null) {
        const src = m[2].split('#')[0]; // Remove fragment
        titles.set(src, m[1].trim());
      }
    }
  }

  return titles;
}

async function extractAllHtmlFromZip(zip: JSZip): Promise<Array<{ title: string; text: string }>> {
  const chapters: Array<{ title: string; text: string }> = [];
  const htmlFiles = Object.keys(zip.files)
    .filter((f) => /\.(x?html?|xml)$/i.test(f) && !f.includes('META-INF') && !f.endsWith('.opf') && !f.endsWith('.ncx'))
    .sort();

  for (const filePath of htmlFiles) {
    const html = await zip.file(filePath)!.async('string');
    const text = stripHtml(html).trim();
    if (!text || text.length < 10) continue;

    const title = extractTitleFromHtml(html) || `Chapter ${chapters.length + 1}`;
    chapters.push({ title, text });
  }

  return chapters;
}

// ── HTML Stripping ──

function stripHtml(html: string): string {
  return html
    // Remove head section entirely
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert <br>, <p>, <div>, headings to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitleFromHtml(html: string): string | null {
  // Try <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].trim();
    if (t && t.length < 200) return t;
  }
  // Try first <h1>, <h2>, or <h3>
  const headingMatch = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i);
  if (headingMatch) {
    const t = headingMatch[1].trim();
    if (t && t.length < 200) return t;
  }
  return null;
}

// ── Chapter Splitting ──

function splitIntoChapters(text: string): Array<{ title: string; text: string }> {
  // Try various chapter heading patterns
  const chapterPatterns = [
    /^(Chapter\s+\d+[.:\s].*)$/gim,
    /^(CHAPTER\s+\d+[.:\s].*)$/gm,
    /^(Chapter\s+[IVXLCDM]+[.:\s].*)$/gim,
    /^(Part\s+\d+[.:\s].*)$/gim,
    /^(#{1,3}\s+.+)$/gm,
    // Also match "Chapter 1" without colon/period
    /^(Chapter\s+\d+)$/gim,
    /^(CHAPTER\s+[IVXLCDM]+)$/gm,
  ];

  for (const pattern of chapterPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      const chapters: Array<{ title: string; text: string }> = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index!;
        const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
        const chapterText = text.slice(start, end).trim();
        const title = matches[i][1].replace(/^#+\s*/, '').trim();
        chapters.push({ title, text: chapterText });
      }
      return chapters;
    }
  }

  // Fallback: split long texts into ~8000 char chunks at paragraph boundaries
  if (text.length > 10000) {
    const paragraphs = text.split(/\n\s*\n/);
    const chapters: Array<{ title: string; text: string }> = [];
    let current = '';
    let chapterNum = 1;
    for (const para of paragraphs) {
      if (current.length + para.length > 8000 && current.length > 0) {
        chapters.push({ title: `Chapter ${chapterNum}`, text: current.trim() });
        chapterNum++;
        current = '';
      }
      current += para + '\n\n';
    }
    if (current.trim()) chapters.push({ title: `Chapter ${chapterNum}`, text: current.trim() });
    return chapters;
  }

  // Single chapter for short texts
  return [{ title: 'Chapter 1', text: text.trim() }];
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
