import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import mammoth from 'mammoth';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, run } from '../db/helpers.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

export function importRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.post('/', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

      const bookId = req.params.bookId;
      const ext = path.extname(req.file.originalname).toLowerCase();
      let text = '';

      if (ext === '.txt' || ext === '.md') {
        text = fs.readFileSync(req.file.path, 'utf-8');
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: req.file.path });
        text = result.value;
      } else {
        res.status(400).json({ error: `Unsupported format: ${ext}. Use .txt, .md, or .docx` });
        return;
      }

      fs.unlinkSync(req.file.path);

      const chapters = splitIntoChapters(text);

      run(db, 'DELETE FROM chapters WHERE book_id = ?', [bookId]);
      chapters.forEach((ch, index) => {
        run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text, cleaned_text) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), bookId, ch.title, index, ch.text, cleanText(ch.text)]);
      });

      const inserted = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
      res.json({ chapters: inserted, count: inserted.length });
    } catch (err: any) {
      console.error('[Import Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function splitIntoChapters(text: string): Array<{ title: string; text: string }> {
  const chapterPatterns = [
    /^(Chapter\s+\d+[.:]\s*.*)$/gim,
    /^(CHAPTER\s+\d+[.:]\s*.*)$/gm,
    /^(Chapter\s+[IVXLCDM]+[.:]\s*.*)$/gim,
    /^(Part\s+\d+[.:]\s*.*)$/gim,
    /^(#{1,3}\s+.+)$/gm,
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

  return [{ title: 'Chapter 1', text: text.trim() }];
}

function cleanText(text: string): string {
  return text
    .replace(/\u201C/g, '\u201C').replace(/\u201D/g, '\u201D')
    .replace(/\r\n/g, '\n').replace(/\t/g, '  ')
    .replace(/\n{3,}/g, '\n\n').trim();
}
