import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

export function booksRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const books = queryAll(db, 'SELECT * FROM books ORDER BY updated_at DESC');
    res.json(books);
  });

  router.get('/:id', (req: Request, res: Response) => {
    const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

    const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [req.params.id]);
    const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [req.params.id]);

    res.json({ ...book, chapters, characters });
  });

  router.post('/', (req: Request, res: Response) => {
    const id = uuid();
    const { title, author, narrator, isbn, default_model } = req.body;

    run(db,
      `INSERT INTO books (id, title, author, narrator, isbn, default_model) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, title, author || null, narrator || null, isbn || null, default_model || 'eleven_v3']
    );

    const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [id]);
    res.status(201).json(book);
  });

  router.put('/:id', (req: Request, res: Response) => {
    const { title, author, narrator, isbn, cover_art_path, default_model } = req.body;

    run(db,
      `UPDATE books SET title = COALESCE(?, title), author = COALESCE(?, author),
       narrator = COALESCE(?, narrator), isbn = COALESCE(?, isbn),
       cover_art_path = COALESCE(?, cover_art_path), default_model = COALESCE(?, default_model),
       updated_at = datetime('now') WHERE id = ?`,
      [title, author, narrator, isbn, cover_art_path, default_model, req.params.id]
    );

    const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [req.params.id]);
    res.json(book);
  });

  router.delete('/:id', (req: Request, res: Response) => {
    run(db, 'DELETE FROM books WHERE id = ?', [req.params.id]);
    res.status(204).send();
  });

  return router;
}
