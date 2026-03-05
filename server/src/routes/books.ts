import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { z } from 'zod/v4';

const CreateBookSchema = z.object({
  title: z.string().min(1).max(500),
  author: z.string().max(500).optional(),
  narrator: z.string().max(500).optional(),
  isbn: z.string().max(50).optional(),
  default_model: z.string().max(100).optional(),
  project_type: z.enum(['audiobook', 'podcast']).optional(),
  format: z.string().max(100).optional(),
  default_gap_ms: z.number().int().min(0).max(30000).optional(),
  chapter_gap_ms: z.number().int().min(0).max(60000).optional(),
  default_speed: z.number().min(0.25).max(4.0).optional(),
});

const UpdateBookSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  author: z.string().max(500).nullable().optional(),
  narrator: z.string().max(500).nullable().optional(),
  isbn: z.string().max(50).nullable().optional(),
  cover_art_path: z.string().max(1000).nullable().optional(),
  default_model: z.string().max(100).optional(),
  project_type: z.enum(['audiobook', 'podcast']).optional(),
  format: z.string().max(100).optional(),
  default_gap_ms: z.number().int().min(0).max(30000).optional(),
  chapter_gap_ms: z.number().int().min(0).max(60000).optional(),
  default_speed: z.number().min(0.25).max(4.0).optional(),
  intro_asset_id: z.string().max(100).nullable().optional(),
  outro_asset_id: z.string().max(100).nullable().optional(),
});

export function booksRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      const books = queryAll(db, 'SELECT * FROM books ORDER BY updated_at DESC');
      res.json(books);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list books' });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    try {
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [req.params.id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [req.params.id]);
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [req.params.id]);

      res.json({ ...book, chapters, characters });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get book' });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const parsed = CreateBookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }
      const { title, author, narrator, isbn, default_model, project_type, format,
              default_gap_ms, chapter_gap_ms, default_speed } = parsed.data;

      const id = uuid();
      run(db,
        `INSERT INTO books (id, title, author, narrator, isbn, default_model, project_type, format, default_gap_ms, chapter_gap_ms, default_speed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, author || null, narrator || null, isbn || null, default_model || 'eleven_v3',
         project_type || 'audiobook', format || 'single_narrator',
         default_gap_ms ?? 300, chapter_gap_ms ?? 2000, default_speed ?? 1.0]
      );

      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [id]);
      res.status(201).json(book);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create book' });
    }
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const parsed = UpdateBookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }
      const { title, author, narrator, isbn, cover_art_path, default_model, project_type, format,
              default_gap_ms, chapter_gap_ms, default_speed, intro_asset_id, outro_asset_id } = parsed.data;

      run(db,
        `UPDATE books SET title = COALESCE(?, title), author = COALESCE(?, author),
         narrator = COALESCE(?, narrator), isbn = COALESCE(?, isbn),
         cover_art_path = COALESCE(?, cover_art_path), default_model = COALESCE(?, default_model),
         project_type = COALESCE(?, project_type), format = COALESCE(?, format),
         default_gap_ms = COALESCE(?, default_gap_ms), chapter_gap_ms = COALESCE(?, chapter_gap_ms),
         default_speed = COALESCE(?, default_speed), intro_asset_id = COALESCE(?, intro_asset_id),
         outro_asset_id = COALESCE(?, outro_asset_id),
         updated_at = datetime('now') WHERE id = ?`,
        [title, author, narrator, isbn, cover_art_path, default_model, project_type, format,
         default_gap_ms, chapter_gap_ms, default_speed, intro_asset_id, outro_asset_id, req.params.id]
      );

      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [req.params.id]);
      res.json(book);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update book' });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [req.params.id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }
      run(db, 'DELETE FROM books WHERE id = ?', [req.params.id]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete book' });
    }
  });

  return router;
}
