import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { z } from 'zod/v4';

const CreateCharacterSchema = z.object({
  name: z.string().min(1).max(200),
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

const UpdateCharacterSchema = CreateCharacterSchema.partial();

export function charactersRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req: Request, res: Response) => {
    try {
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [req.params.bookId]);
      res.json(characters);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list characters' });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const parsed = CreateCharacterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }
      const { name, role, voice_id, voice_name, tts_provider, model_id,
              stability, similarity_boost, style, speed, speaker_boost } = parsed.data;

      const id = uuid();
      run(db,
        `INSERT INTO characters (id, book_id, name, role, voice_id, voice_name, tts_provider, model_id, stability, similarity_boost, style, speed, speaker_boost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.params.bookId, name, role || 'character', voice_id || null, voice_name || null,
         tts_provider || 'elevenlabs', model_id || 'eleven_v3', stability ?? 0.5, similarity_boost ?? 0.75, style ?? 0.0, speed ?? 1.0, speaker_boost ?? 1]
      );

      const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [id]);
      res.status(201).json(character);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create character' });
    }
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const parsed = UpdateCharacterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }

      const fields = ['name', 'role', 'voice_id', 'voice_name', 'tts_provider', 'model_id', 'stability', 'similarity_boost', 'style', 'speed', 'speaker_boost'];
      const updates: string[] = [];
      const values: any[] = [];

      for (const field of fields) {
        if ((parsed.data as any)[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push((parsed.data as any)[field]);
        }
      }

      if (updates.length > 0) {
        values.push(req.params.id, req.params.bookId);
        run(db, `UPDATE characters SET ${updates.join(', ')} WHERE id = ? AND book_id = ?`, values);
      }

      const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [req.params.id]);
      res.json(character);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update character' });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      run(db, 'DELETE FROM characters WHERE id = ? AND book_id = ?', [req.params.id, req.params.bookId]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete character' });
    }
  });

  // Auto-assign segments to characters by matching speaker names in text
  router.post('/auto-assign-by-name', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);
      if (characters.length === 0) { res.json({ assigned: 0, message: 'No characters found' }); return; }

      const chapters = queryAll(db, 'SELECT id FROM chapters WHERE book_id = ?', [bookId]);
      const chapterIds = chapters.map((c: any) => c.id);
      if (chapterIds.length === 0) { res.json({ assigned: 0, message: 'No chapters found' }); return; }

      const placeholders = chapterIds.map(() => '?').join(',');
      const allSegments = queryAll(db, `SELECT * FROM segments WHERE chapter_id IN (${placeholders})`, chapterIds);

      const nameMap = new Map<string, any>();
      for (const char of characters) {
        nameMap.set((char as any).name.toLowerCase(), char);
      }

      let assigned = 0;
      const matches: { segment_id: string; character_name: string }[] = [];

      for (const seg of allSegments) {
        const text = ((seg as any).text || '').trim();
        const match = text.match(/^([A-Za-z][A-Za-z0-9_ ]*?)(?:\s*[\[\(][^\]\)]*[\]\)])?\s*:/);
        if (!match) continue;

        const speakerName = match[1].trim().toLowerCase();
        const character = nameMap.get(speakerName);
        if (!character) continue;

        if (!(seg as any).character_id) {
          run(db, `UPDATE segments SET character_id = ?, updated_at = datetime('now') WHERE id = ?`,
            [(character as any).id, (seg as any).id]);
          assigned++;
          matches.push({ segment_id: (seg as any).id, character_name: (character as any).name });
        }
      }

      res.json({ assigned, total_segments: allSegments.length, matches });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
