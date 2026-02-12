import { Router, Request, Response } from 'express';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

export function chaptersRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req: Request, res: Response) => {
    const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [req.params.bookId]);
    res.json(chapters);
  });

  router.put('/:id', (req: Request, res: Response) => {
    const { title, raw_text, cleaned_text, sort_order } = req.body;
    run(db,
      `UPDATE chapters SET title = COALESCE(?, title), raw_text = COALESCE(?, raw_text),
       cleaned_text = COALESCE(?, cleaned_text), sort_order = COALESCE(?, sort_order),
       updated_at = datetime('now') WHERE id = ? AND book_id = ?`,
      [title, raw_text, cleaned_text, sort_order, req.params.id, req.params.bookId]
    );
    const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [req.params.id]);
    res.json(chapter);
  });

  router.post('/reorder', (req: Request, res: Response) => {
    const { ids } = req.body as { ids: string[] };
    ids.forEach((id, index) => {
      run(db, 'UPDATE chapters SET sort_order = ? WHERE id = ? AND book_id = ?', [index, id, req.params.bookId]);
    });
    res.json({ ok: true });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    run(db, 'DELETE FROM chapters WHERE id = ? AND book_id = ?', [req.params.id, req.params.bookId]);
    res.status(204).send();
  });

  return router;
}
