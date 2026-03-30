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

  return router;
}
