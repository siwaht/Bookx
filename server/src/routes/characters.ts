import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

export function charactersRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req: Request, res: Response) => {
    const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [req.params.bookId]);
    res.json(characters);
  });

  router.post('/', (req: Request, res: Response) => {
    const id = uuid();
    const { name, role, voice_id, voice_name, model_id, stability, similarity_boost, style, speed, speaker_boost } = req.body;

    run(db,
      `INSERT INTO characters (id, book_id, name, role, voice_id, voice_name, model_id, stability, similarity_boost, style, speed, speaker_boost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.bookId, name, role || 'character', voice_id || null, voice_name || null,
       model_id || 'eleven_v3', stability ?? 0.5, similarity_boost ?? 0.75, style ?? 0.0, speed ?? 1.0, speaker_boost ?? 1]
    );

    const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [id]);
    res.status(201).json(character);
  });

  router.put('/:id', (req: Request, res: Response) => {
    const fields = ['name', 'role', 'voice_id', 'voice_name', 'model_id', 'stability', 'similarity_boost', 'style', 'speed', 'speaker_boost'];
    const updates: string[] = [];
    const values: any[] = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length > 0) {
      values.push(req.params.id, req.params.bookId);
      run(db, `UPDATE characters SET ${updates.join(', ')} WHERE id = ? AND book_id = ?`, values);
    }

    const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [req.params.id]);
    res.json(character);
  });

  router.delete('/:id', (req: Request, res: Response) => {
    run(db, 'DELETE FROM characters WHERE id = ? AND book_id = ?', [req.params.id, req.params.bookId]);
    res.status(204).send();
  });

  // Auto-assign segments to characters by matching speaker names in text
  // Matches patterns like "KAI:", "Sam:", "SAM [excited]:", "narrator:" at the start of segment text
  router.post('/auto-assign-by-name', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);
      if (characters.length === 0) { res.json({ assigned: 0, message: 'No characters found' }); return; }

      // Get all chapters for this book, then all segments
      const chapters = queryAll(db, 'SELECT id FROM chapters WHERE book_id = ?', [bookId]);
      const chapterIds = chapters.map((c: any) => c.id);
      if (chapterIds.length === 0) { res.json({ assigned: 0, message: 'No chapters found' }); return; }

      const placeholders = chapterIds.map(() => '?').join(',');
      const allSegments = queryAll(db, `SELECT * FROM segments WHERE chapter_id IN (${placeholders})`, chapterIds);

      // Build name→character map (case-insensitive)
      const nameMap = new Map<string, any>();
      for (const char of characters) {
        nameMap.set((char as any).name.toLowerCase(), char);
      }

      let assigned = 0;
      const matches: { segment_id: string; character_name: string }[] = [];

      for (const seg of allSegments) {
        const text = ((seg as any).text || '').trim();
        // Match: NAME: or NAME [tag]: or NAME(tag): at start of text
        const match = text.match(/^([A-Za-z][A-Za-z0-9_ ]*?)(?:\s*[\[\(][^\]\)]*[\]\)])?\s*:/);
        if (!match) continue;

        const speakerName = match[1].trim().toLowerCase();
        const character = nameMap.get(speakerName);
        if (!character) continue;

        // Only assign if not already assigned (or force re-assign unassigned)
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
