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

  return router;
}
