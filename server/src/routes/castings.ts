import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { saveDb } from '../db/schema.js';
import { z } from 'zod/v4';
import { syncCastingFromBook, applyCastingToBook, upsertCastingMember, normalizeName } from '../lib/voice-casting.js';

/**
 * Voice Castings = named, reusable "cast" of character -> voice assignments.
 * Mounted at /api/castings. This is the persistence layer behind:
 *   - "remember this book's voices for next time" (sync from a book)
 *   - "reuse a saved cast" (apply to a book/podcast episode)
 *   - the Podcast section's save/reuse-casting workflow.
 *
 * Series-managed castings (voice_castings.is_series_default = 1) are also
 * visible here (read-only name/description edits are fine, but they can't be
 * deleted directly — delete the series instead).
 */

const CreateCastingSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  project_type: z.enum(['audiobook', 'podcast', 'any']).optional(),
});

const MemberSchema = z.object({
  character_name: z.string().min(1).max(200),
  role: z.enum(['narrator', 'character', 'host', 'guest']).optional(),
  voice_id: z.string().max(200).nullable().optional(),
  voice_name: z.string().max(200).nullable().optional(),
  tts_provider: z.string().max(50).optional(),
  model_id: z.string().max(100).optional(),
  stability: z.number().min(0).max(1).optional(),
  similarity_boost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  speaker_boost: z.union([z.number(), z.boolean()]).optional(),
});

export function castingsRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    try {
      const projectType = req.query.project_type as string | undefined;
      let castings: any[];
      if (projectType && projectType !== 'any') {
        castings = queryAll(db, `SELECT * FROM voice_castings WHERE project_type = ? OR project_type = 'any' ORDER BY updated_at DESC`, [projectType]);
      } else {
        castings = queryAll(db, 'SELECT * FROM voice_castings ORDER BY updated_at DESC');
      }
      const withCounts = castings.map((c: any) => {
        const memberCount = queryOne(db, 'SELECT COUNT(*) as n FROM voice_casting_members WHERE casting_id = ?', [c.id]) as any;
        const voicedCount = queryOne(db, 'SELECT COUNT(*) as n FROM voice_casting_members WHERE casting_id = ? AND voice_id IS NOT NULL', [c.id]) as any;
        return { ...c, member_count: memberCount?.n || 0, voiced_count: voicedCount?.n || 0 };
      });
      res.json(withCounts);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list castings' });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    try {
      const casting = queryOne(db, 'SELECT * FROM voice_castings WHERE id = ?', [req.params.id]);
      if (!casting) { res.status(404).json({ error: 'Casting not found' }); return; }
      const members = queryAll(db, 'SELECT * FROM voice_casting_members WHERE casting_id = ? ORDER BY character_name', [req.params.id]);
      const books = queryAll(db, 'SELECT id, title, project_type FROM books WHERE casting_id = ?', [req.params.id]);
      res.json({ ...casting, members, books });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get casting' });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const parsed = CreateCastingSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); return; }
      const id = uuid();
      run(db, `INSERT INTO voice_castings (id, name, description, project_type) VALUES (?, ?, ?, ?)`,
        [id, parsed.data.name, parsed.data.description || null, parsed.data.project_type || 'any']);
      const casting = queryOne(db, 'SELECT * FROM voice_castings WHERE id = ?', [id]);
      res.status(201).json(casting);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create casting' });
    }
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const parsed = CreateCastingSchema.partial().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); return; }
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of ['name', 'description', 'project_type'] as const) {
        if (parsed.data[field] !== undefined) { updates.push(`${field} = ?`); values.push(parsed.data[field]); }
      }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(req.params.id);
        run(db, `UPDATE voice_castings SET ${updates.join(', ')} WHERE id = ?`, values);
      }
      const casting = queryOne(db, 'SELECT * FROM voice_castings WHERE id = ?', [req.params.id]);
      res.json(casting);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update casting' });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const casting = queryOne(db, 'SELECT * FROM voice_castings WHERE id = ?', [req.params.id]) as any;
      if (!casting) { res.status(404).json({ error: 'Casting not found' }); return; }
      if (casting.is_series_default) {
        res.status(400).json({ error: 'This casting is managed by a series. Delete the series instead.' });
        return;
      }
      run(db, 'UPDATE books SET casting_id = NULL WHERE casting_id = ?', [req.params.id]);
      run(db, 'DELETE FROM voice_castings WHERE id = ?', [req.params.id]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete casting' });
    }
  });

  // ── Members ──

  router.post('/:id/members', (req: Request, res: Response) => {
    try {
      const parsed = MemberSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); return; }
      const memberId = upsertCastingMember(db, String(req.params.id), parsed.data);
      run(db, `UPDATE voice_castings SET updated_at = datetime('now') WHERE id = ?`, [req.params.id]);
      const member = queryOne(db, 'SELECT * FROM voice_casting_members WHERE id = ?', [memberId]);
      res.status(201).json(member);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to add casting member' });
    }
  });

  router.put('/:id/members/:memberId', (req: Request, res: Response) => {
    try {
      const parsed = MemberSchema.partial().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); return; }
      const fields = ['character_name', 'role', 'voice_id', 'voice_name', 'tts_provider', 'model_id', 'stability', 'similarity_boost', 'style', 'speed', 'speaker_boost'];
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of fields) {
        if ((parsed.data as any)[field] !== undefined) { updates.push(`${field} = ?`); values.push((parsed.data as any)[field]); }
      }
      if (parsed.data.character_name !== undefined) {
        updates.push('normalized_name = ?');
        values.push(normalizeName(parsed.data.character_name));
      }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(req.params.memberId);
        run(db, `UPDATE voice_casting_members SET ${updates.join(', ')} WHERE id = ?`, values);
      }
      const member = queryOne(db, 'SELECT * FROM voice_casting_members WHERE id = ?', [req.params.memberId]);
      res.json(member);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update casting member' });
    }
  });

  router.delete('/:id/members/:memberId', (req: Request, res: Response) => {
    try {
      run(db, 'DELETE FROM voice_casting_members WHERE id = ? AND casting_id = ?', [req.params.memberId, req.params.id]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete casting member' });
    }
  });

  // ── Sync / Apply ──

  // Snapshot a book's current characters+voices into this casting (or a brand new one).
  router.post('/sync-from-book', (req: Request, res: Response) => {
    try {
      const { book_id, casting_id, name, description, project_type } = req.body;
      if (!book_id) { res.status(400).json({ error: 'book_id is required' }); return; }
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [book_id]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }
      const id = syncCastingFromBook(db, book_id, { castingId: casting_id, name, description, projectType: project_type });
      const casting = queryOne(db, 'SELECT * FROM voice_castings WHERE id = ?', [id]);
      const members = queryAll(db, 'SELECT * FROM voice_casting_members WHERE casting_id = ? ORDER BY character_name', [id]);
      saveDb(); // a saved cast is meant to survive restarts — flush now
      res.json({ ...casting, members });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to sync casting from book' });
    }
  });

  // Apply a saved casting's voices onto a book's characters (creating missing characters).
  router.post('/:id/apply-to-book/:bookId', (req: Request, res: Response) => {
    try {
      const casting = queryOne(db, 'SELECT * FROM voice_castings WHERE id = ?', [req.params.id]);
      if (!casting) { res.status(404).json({ error: 'Casting not found' }); return; }
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [req.params.bookId]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }
      const result = applyCastingToBook(db, String(req.params.bookId), String(req.params.id));
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [req.params.bookId]);
      saveDb();
      res.json({ ...result, characters });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to apply casting to book' });
    }
  });

  return router;
}
