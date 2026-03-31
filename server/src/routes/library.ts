import { Router } from 'express';
import { Database as SqlJsDatabase } from 'sql.js';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { queryAll, queryOne } from '../db/helpers.js';
import { saveDb } from '../db/schema.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const LIBRARY_DIR = path.join(DATA_DIR, 'library');

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(LIBRARY_DIR, { recursive: true });
      cb(null, LIBRARY_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.epub', '.docx', '.doc', '.mobi', '.azw', '.azw3', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const coverUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const coverDir = path.join(LIBRARY_DIR, 'covers');
      fs.mkdirSync(coverDir, { recursive: true });
      cb(null, coverDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.tiff'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

function detectFormat(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'pdf', '.epub': 'epub', '.docx': 'docx', '.doc': 'docx',
    '.mobi': 'mobi', '.azw': 'kindle', '.azw3': 'kindle', '.txt': 'txt',
  };
  return map[ext] || 'unknown';
}

export function libraryRouter(db: SqlJsDatabase): Router {
  const router = Router();

  // List all library books
  router.get('/', (_req, res) => {
    try {
      const books = queryAll(db, 'SELECT * FROM library_books ORDER BY updated_at DESC');
      // Attach formats
      for (const book of books as any[]) {
        book.formats = queryAll(db, 'SELECT * FROM library_book_formats WHERE library_book_id = ?', [book.id]);
      }
      res.json(books);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download all library books as ZIP (must be before /:id routes)
  router.get('/download-all', async (_req, res) => {
    try {
      const allBooks = queryAll(db, 'SELECT * FROM library_books ORDER BY title') as any[];
      if (allBooks.length === 0) { res.status(404).json({ error: 'No books in library' }); return; }

      const archiver = (await import('archiver')).default;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="library_export.zip"');

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err: any) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      archive.pipe(res);

      for (const book of allBooks) {
        const safeName = (book.title || 'untitled').replace(/[^a-zA-Z0-9_\- ]/g, '_');
        if (book.file_path && fs.existsSync(book.file_path)) {
          const ext = path.extname(book.file_path);
          archive.file(book.file_path, { name: `${safeName}/${safeName}${ext}` });
        }
        if (book.cover_path && fs.existsSync(book.cover_path)) {
          const coverExt = path.extname(book.cover_path);
          archive.file(book.cover_path, { name: `${safeName}/cover${coverExt}` });
        }
        const formats = queryAll(db, 'SELECT * FROM library_book_formats WHERE library_book_id = ?', [book.id]) as any[];
        for (const fmt of formats) {
          if (fmt.file_path && fs.existsSync(fmt.file_path) && fmt.file_path !== book.file_path) {
            const fmtExt = path.extname(fmt.file_path);
            archive.file(fmt.file_path, { name: `${safeName}/${safeName}_${fmt.format}${fmtExt}` });
          }
        }
      }

      await archive.finalize();
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // Get single library book
  router.get('/:id', (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }
      (book as any).formats = queryAll(db, 'SELECT * FROM library_book_formats WHERE library_book_id = ?', [req.params.id]);
      res.json(book);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload a book file
  router.post('/', upload.single('file'), (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
      const id = uuid();
      const format = detectFormat(req.file.originalname);
      const title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, '');
      const author = req.body.author || null;
      const description = req.body.description || null;
      const isbn = req.body.isbn || null;
      const tags = req.body.tags || null;

      db.run(
        `INSERT INTO library_books (id, title, author, description, isbn, original_format, file_path, file_size_bytes, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, author, description, isbn, format, req.file.path, req.file.size, tags]
      );

      // Also store as a format entry
      const fmtId = uuid();
      db.run(
        `INSERT INTO library_book_formats (id, library_book_id, format, file_path, file_size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
        [fmtId, id, format, req.file.path, req.file.size]
      );

      saveDb();
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [id]);
      (book as any).formats = queryAll(db, 'SELECT * FROM library_book_formats WHERE library_book_id = ?', [id]);
      res.status(201).json(book);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update book metadata
  router.put('/:id', (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      const fields = ['title', 'author', 'description', 'isbn', 'tags', 'audiobook_ready', 'kindle_ready', 'page_count'];
      const updates: string[] = [];
      const values: any[] = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          updates.push(`${f} = ?`);
          values.push(req.body[f]);
        }
      }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(req.params.id);
        db.run(`UPDATE library_books SET ${updates.join(', ')} WHERE id = ?`, values);
        saveDb();
      }

      const updated = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]);
      (updated as any).formats = queryAll(db, 'SELECT * FROM library_book_formats WHERE library_book_id = ?', [req.params.id]);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload/replace cover art
  router.post('/:id/cover', coverUpload.single('cover'), (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ error: 'No cover image uploaded' }); return; }
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]) as any;
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      // Delete old cover if exists
      if (book.cover_path && fs.existsSync(book.cover_path)) {
        fs.unlinkSync(book.cover_path);
      }

      const bookId = req.params.id as string;
      db.run("UPDATE library_books SET cover_path = ?, updated_at = datetime('now') WHERE id = ?",
        [req.file.path, bookId]);
      saveDb();
      res.json({ cover_path: req.file.path });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get cover image
  router.get('/:id/cover', (req, res) => {
    const book = queryOne(db, 'SELECT cover_path FROM library_books WHERE id = ?', [req.params.id]) as any;
    if (!book?.cover_path || !fs.existsSync(book.cover_path)) {
      res.status(404).json({ error: 'No cover found' }); return;
    }
    res.sendFile(path.resolve(book.cover_path));
  });

  // Upload additional format
  router.post('/:id/formats', upload.single('file'), (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      const format = req.body.format || detectFormat(req.file.originalname);
      const fmtId = uuid();
      const fmtBookId = req.params.id as string;
      db.run(
        `INSERT INTO library_book_formats (id, library_book_id, format, file_path, file_size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
        [fmtId, fmtBookId, format, req.file.path, req.file.size]
      );
      db.run("UPDATE library_books SET updated_at = datetime('now') WHERE id = ?", [fmtBookId]);
      saveDb();

      res.status(201).json({ id: fmtId, format, file_path: req.file.path, file_size_bytes: req.file.size });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download a format file
  router.get('/:id/formats/:formatId/download', (req, res) => {
    try {
      const fmt = queryOne(db,
        'SELECT lbf.*, lb.title FROM library_book_formats lbf JOIN library_books lb ON lb.id = lbf.library_book_id WHERE lbf.id = ? AND lbf.library_book_id = ?',
        [req.params.formatId, req.params.id]) as any;
      if (!fmt || !fs.existsSync(fmt.file_path)) {
        res.status(404).json({ error: 'File not found' }); return;
      }
      const ext = path.extname(fmt.file_path);
      const safeName = fmt.title.replace(/[^a-zA-Z0-9_\- ]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${fmt.format}${ext.includes(fmt.format) ? '' : ext}"`);
      res.sendFile(path.resolve(fmt.file_path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download original file
  router.get('/:id/download', (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]) as any;
      if (!book || !fs.existsSync(book.file_path)) {
        res.status(404).json({ error: 'File not found' }); return;
      }
      const ext = path.extname(book.file_path);
      const safeName = book.title.replace(/[^a-zA-Z0-9_\- ]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}${ext}"`);
      res.sendFile(path.resolve(book.file_path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark as audiobook-ready (strip TOC, index, etc.)
  router.post('/:id/prepare-audiobook', (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      db.run("UPDATE library_books SET audiobook_ready = 1, updated_at = datetime('now') WHERE id = ?", [req.params.id]);
      saveDb();
      res.json({ ok: true, message: 'Book marked as audiobook-ready. TOC and index references flagged for removal during audio generation.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark as Kindle-ready (paperback/hardcover compatible)
  router.post('/:id/prepare-kindle', (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      db.run("UPDATE library_books SET kindle_ready = 1, updated_at = datetime('now') WHERE id = ?", [req.params.id]);
      saveDb();
      res.json({ ok: true, message: 'Book marked as Kindle-ready for paperback/hardcover publishing.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a format
  router.delete('/:id/formats/:formatId', (req, res) => {
    try {
      const fmt = queryOne(db, 'SELECT * FROM library_book_formats WHERE id = ? AND library_book_id = ?',
        [req.params.formatId, req.params.id]) as any;
      if (!fmt) { res.status(404).json({ error: 'Format not found' }); return; }
      if (fs.existsSync(fmt.file_path)) fs.unlinkSync(fmt.file_path);
      db.run('DELETE FROM library_book_formats WHERE id = ?', [req.params.formatId]);
      saveDb();
      res.status(204).end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a library book
  router.delete('/:id', (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]) as any;
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      // Delete all format files
      const formats = queryAll(db, 'SELECT * FROM library_book_formats WHERE library_book_id = ?', [req.params.id]) as any[];
      for (const fmt of formats) {
        if (fs.existsSync(fmt.file_path)) fs.unlinkSync(fmt.file_path);
      }
      // Delete original file
      if (book.file_path && fs.existsSync(book.file_path)) fs.unlinkSync(book.file_path);
      // Delete cover
      if (book.cover_path && fs.existsSync(book.cover_path)) fs.unlinkSync(book.cover_path);

      db.run('DELETE FROM library_book_formats WHERE library_book_id = ?', [req.params.id]);
      db.run('DELETE FROM library_books WHERE id = ?', [req.params.id]);
      saveDb();
      res.status(204).end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve file for in-browser reading (PDF, EPUB viewer)
  router.get('/:id/read', (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]) as any;
      if (!book || !fs.existsSync(book.file_path)) {
        res.status(404).json({ error: 'File not found' }); return;
      }
      const ext = path.extname(book.file_path).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.epub': 'application/epub+zip',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword',
        '.txt': 'text/plain',
      };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', 'inline');
      res.sendFile(path.resolve(book.file_path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve a specific format for reading
  router.get('/:id/formats/:formatId/read', (req, res) => {
    try {
      const fmt = queryOne(db,
        'SELECT * FROM library_book_formats WHERE id = ? AND library_book_id = ?',
        [req.params.formatId, req.params.id]) as any;
      if (!fmt || !fs.existsSync(fmt.file_path)) {
        res.status(404).json({ error: 'File not found' }); return;
      }
      const ext = path.extname(fmt.file_path).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.epub': 'application/epub+zip',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.txt': 'text/plain',
      };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', 'inline');
      res.sendFile(path.resolve(fmt.file_path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Convert library book to audiobook project (with full EPUB/DOCX/TXT import)
  router.post('/:id/convert-to-audiobook', async (req, res) => {
    try {
      const libBook = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]) as any;
      if (!libBook) { res.status(404).json({ error: 'Book not found' }); return; }
      if (!fs.existsSync(libBook.file_path)) { res.status(404).json({ error: 'Source file not found on disk' }); return; }

      const bookId = uuid();
      db.run(
        `INSERT INTO books (id, title, author, isbn, cover_art_path, project_type, format, library_book_id)
         VALUES (?, ?, ?, ?, ?, 'audiobook', 'single_narrator', ?)`,
        [bookId, libBook.title, libBook.author, libBook.isbn, libBook.cover_path, libBook.id]
      );

      // Parse the file based on format
      const ext = path.extname(libBook.file_path).toLowerCase();
      let chapters: Array<{ title: string; text: string }> = [];

      if (ext === '.txt') {
        const text = fs.readFileSync(libBook.file_path, 'utf-8');
        chapters = splitTextIntoChapters(text);
      } else if (ext === '.docx' || ext === '.doc') {
        const mammoth = (await import('mammoth')).default;
        const result = await mammoth.extractRawText({ path: libBook.file_path });
        chapters = splitTextIntoChapters(result.value);
      } else if (ext === '.epub') {
        const JSZip = (await import('jszip')).default;
        const data = fs.readFileSync(libBook.file_path);
        const zip = await JSZip.loadAsync(data);
        chapters = await parseEpubToChapters(zip);
      }

      // Insert chapters (skip front/back matter for audiobook)
      const skipPatterns = /^(table of contents|contents|copyright|dedication|acknowledgments?|about the author|index|bibliography|appendix|foreword|preface|prologue|epilogue|glossary|also by|other books|title page|half title)/i;
      const filtered = chapters.filter(ch => !skipPatterns.test(ch.title.trim()));
      const finalChapters = filtered.length > 0 ? filtered : chapters;

      for (let i = 0; i < finalChapters.length; i++) {
        const chId = uuid();
        const cleaned = finalChapters[i].text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        db.run(
          `INSERT INTO chapters (id, book_id, title, sort_order, raw_text, cleaned_text) VALUES (?, ?, ?, ?, ?, ?)`,
          [chId, bookId, finalChapters[i].title, i, finalChapters[i].text, cleaned]
        );
      }

      const skippedCount = chapters.length - finalChapters.length;

      db.run("UPDATE library_books SET audiobook_ready = 1, updated_at = datetime('now') WHERE id = ?", [req.params.id]);
      saveDb();

      res.status(201).json({
        ok: true,
        book_id: bookId,
        title: libBook.title,
        chapters_created: finalChapters.length,
        chapters_skipped: skippedCount,
        message: finalChapters.length > 0
          ? `Audiobook project created with ${finalChapters.length} chapter(s) from ${ext.replace('.', '').toUpperCase()}.${skippedCount > 0 ? ` Skipped ${skippedCount} non-audio sections (TOC, copyright, etc.).` : ''}`
          : 'Audiobook project created. Import your manuscript in the Manuscript page to add chapters.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read DOCX as HTML (for in-browser viewing)
  router.get('/:id/read-html', async (req, res) => {
    try {
      const book = queryOne(db, 'SELECT * FROM library_books WHERE id = ?', [req.params.id]) as any;
      if (!book || !fs.existsSync(book.file_path)) { res.status(404).json({ error: 'File not found' }); return; }
      const ext = path.extname(book.file_path).toLowerCase();
      if (ext === '.docx' || ext === '.doc') {
        const mammoth = (await import('mammoth')).default;
        const result = await mammoth.convertToHtml({ path: book.file_path });
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.8;color:#222}img{max-width:100%}</style></head><body>${result.value}</body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } else if (ext === '.txt') {
        const text = fs.readFileSync(book.file_path, 'utf-8');
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.8;color:#222;white-space:pre-wrap}</style></head><body>${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } else {
        res.status(400).json({ error: 'HTML conversion only supported for DOCX and TXT files' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ── Helper: split text into chapters ──
function splitTextIntoChapters(text: string): Array<{ title: string; text: string }> {
  const patterns = [
    /^(Chapter\s+\d+[.:\s].*)$/gim,
    /^(CHAPTER\s+\d+[.:\s].*)$/gm,
    /^(Chapter\s+[IVXLCDM]+[.:\s].*)$/gim,
    /^(Part\s+\d+[.:\s].*)$/gim,
    /^(#{1,3}\s+.+)$/gm,
    /^(Chapter\s+\d+)$/gim,
  ];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      const chapters: Array<{ title: string; text: string }> = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index!;
        const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
        chapters.push({ title: matches[i][1].replace(/^#+\s*/, '').trim(), text: text.slice(start, end).trim() });
      }
      return chapters;
    }
  }
  if (text.length > 10000) {
    const paras = text.split(/\n\s*\n/);
    const chapters: Array<{ title: string; text: string }> = [];
    let cur = '', num = 1;
    for (const p of paras) {
      if (cur.length + p.length > 8000 && cur.length > 0) { chapters.push({ title: `Chapter ${num}`, text: cur.trim() }); num++; cur = ''; }
      cur += p + '\n\n';
    }
    if (cur.trim()) chapters.push({ title: `Chapter ${num}`, text: cur.trim() });
    return chapters;
  }
  return [{ title: 'Chapter 1', text: text.trim() }];
}

// ── Helper: parse EPUB into chapters ──
async function parseEpubToChapters(zip: any): Promise<Array<{ title: string; text: string }>> {
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  let opfPath = 'content.opf';
  if (containerXml) {
    const m = containerXml.match(/full-path="([^"]+)"/);
    if (m) opfPath = m[1];
  }
  const opfContent = await zip.file(opfPath)?.async('string');
  if (!opfContent) return fallbackHtmlExtract(zip);

  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map<string, string>();
  let match;
  const r1 = /<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/gi;
  while ((match = r1.exec(opfContent)) !== null) manifest.set(match[1], match[2]);
  const r2 = /<item\s+[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*>/gi;
  while ((match = r2.exec(opfContent)) !== null) manifest.set(match[2], match[1]);

  const spineItems: string[] = [];
  const r3 = /<itemref\s+[^>]*idref="([^"]+)"[^>]*>/gi;
  while ((match = r3.exec(opfContent)) !== null) spineItems.push(match[1]);

  const chapters: Array<{ title: string; text: string }> = [];
  for (let i = 0; i < spineItems.length; i++) {
    const href = manifest.get(spineItems[i]);
    if (!href) continue;
    const file = zip.file(opfDir + decodeURIComponent(href));
    if (!file) continue;
    const html = await file.async('string');
    const text = stripHtmlTags(html).trim();
    if (!text || text.length < 10) continue;
    const hm = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i);
    const title = hm ? hm[1].trim() : `Chapter ${chapters.length + 1}`;
    chapters.push({ title, text });
  }
  return chapters.length > 0 ? chapters : fallbackHtmlExtract(zip);
}

async function fallbackHtmlExtract(zip: any): Promise<Array<{ title: string; text: string }>> {
  const chapters: Array<{ title: string; text: string }> = [];
  const files = Object.keys(zip.files).filter((f: string) => /\.(x?html?)$/i.test(f) && !f.includes('META-INF')).sort();
  for (const fp of files) {
    const html = await zip.file(fp)!.async('string');
    const text = stripHtmlTags(html).trim();
    if (!text || text.length < 10) continue;
    const hm = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i);
    chapters.push({ title: hm ? hm[1].trim() : `Chapter ${chapters.length + 1}`, text });
  }
  return chapters;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
