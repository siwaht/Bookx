import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { z } from 'zod/v4';
import { getOrCreateSeriesCasting } from '../lib/voice-casting.js';

/**
 * Series = a group of book volumes that should share character voice memory.
 * Mounted at /api/series.
 */

const CreateSeriesSchema = z.object({
  name: z.string().min(1).max(300),
  author: z.string().max(300).optional(),
  description: z.string().max(2000).optional(),
});

const UpdateSeriesSchema = CreateSeriesSchema.partial();

export function seriesRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      const series = queryAll(db, 'SELECT * FROM series ORDER BY updated_at DESC');
      const withCounts = series.map((s: any) => {
        const bookCount = queryOne(db, 'SELECT COUNT(*) as c FROM books WHERE series_id = ?', [s.id]) as any;
        return { ...s, book_count: bookCount?.c || 0 };
      });
      res.json(withCounts);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list series' });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    try {
      const series = queryOne(db, 'SELECT * FROM series WHERE id = ?', [req.params.id]);
      if (!series) { res.status(404).json({ error: 'Series not found' }); return; }
      const books = queryAll(db, 'SELECT * FROM books WHERE series_id = ? ORDER BY series_volume, created_at', [req.params.id]);
      const castingId = getOrCreateSeriesCasting(db, String(req.params.id));
      const castingMembers = queryAll(db, 'SELECT * FROM voice_casting_members WHERE casting_id = ? ORDER BY character_name', [castingId]);
      res.json({ ...series, books, casting_id: castingId, cast: castingMembers });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get series' });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const parsed = CreateSeriesSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); return; }
      const id = uuid();
      run(db, `INSERT INTO series (id, name, author, description) VALUES (?, ?, ?, ?)`,
        [id, parsed.data.name, parsed.data.author || null, parsed.data.description || null]);
      // Eagerly create the default casting so the UI has something to show immediately.
      getOrCreateSeriesCasting(db, id);
      const series = queryOne(db, 'SELECT * FROM series WHERE id = ?', [id]);
      res.status(201).json(series);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create series' });
    }
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const parsed = UpdateSeriesSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); return; }
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of ['name', 'author', 'description'] as const) {
        if (parsed.data[field] !== undefined) { updates.push(`${field} = ?`); values.push(parsed.data[field]); }
      }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(req.params.id);
        run(db, `UPDATE series SET ${updates.join(', ')} WHERE id = ?`, values);
      }
      const series = queryOne(db, 'SELECT * FROM series WHERE id = ?', [req.params.id]);
      res.json(series);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update series' });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      // Detach books rather than deleting them; only the series + its auto-casting go away.
      run(db, 'UPDATE books SET series_id = NULL, series_volume = NULL WHERE series_id = ?', [req.params.id]);
      run(db, 'DELETE FROM voice_castings WHERE series_id = ?', [req.params.id]);
      run(db, 'DELETE FROM series WHERE id = ?', [req.params.id]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete series' });
    }
  });

  // Attach/detach a book to this series, with an optional volume number for ordering.
  router.post('/:id/books/:bookId', (req: Request, res: Response) => {
    try {
      const series = queryOne(db, 'SELECT * FROM series WHERE id = ?', [req.params.id]);
      if (!series) { res.status(404).json({ error: 'Series not found' }); return; }
      const volume = req.body.volume != null ? parseInt(req.body.volume, 10) : null;
      run(db, 'UPDATE books SET series_id = ?, series_volume = ? WHERE id = ?', [req.params.id, volume, req.params.bookId]);
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [req.params.bookId]);
      res.json(book);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to attach book to series' });
    }
  });

  router.delete('/:id/books/:bookId', (req: Request, res: Response) => {
    try {
      run(db, 'UPDATE books SET series_id = NULL, series_volume = NULL WHERE id = ? AND series_id = ?', [req.params.bookId, req.params.id]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to detach book from series' });
    }
  });

  return router;
}
