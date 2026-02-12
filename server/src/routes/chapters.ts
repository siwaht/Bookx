import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

export function chaptersRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  // List chapters with progress stats
  router.get('/', (req: Request, res: Response) => {
    const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [req.params.bookId]);
    const enriched = chapters.map((ch: any) => {
      const segs = queryAll(db, 'SELECT id, character_id, audio_asset_id FROM segments WHERE chapter_id = ?', [ch.id]);
      const totalSegs = segs.length;
      const assigned = segs.filter((s: any) => s.character_id).length;
      const withAudio = segs.filter((s: any) => s.audio_asset_id).length;
      // Check if any clips exist for segments in this chapter
      const onTimeline = totalSegs > 0 ? queryOne(db,
        `SELECT COUNT(*) as cnt FROM clips WHERE segment_id IN (SELECT id FROM segments WHERE chapter_id = ?)`, [ch.id])?.cnt || 0 : 0;
      return { ...ch, stats: { total_segments: totalSegs, assigned, with_audio: withAudio, on_timeline: onTimeline } };
    });
    res.json(enriched);
  });

  // Create a new chapter
  router.post('/', (req: Request, res: Response) => {
    const { title, raw_text } = req.body;
    const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as mx FROM chapters WHERE book_id = ?', [req.params.bookId]);
    const sortOrder = (maxOrder?.mx ?? -1) + 1;
    const id = uuid();
    run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text) VALUES (?, ?, ?, ?, ?)`,
      [id, req.params.bookId, title || `Chapter ${sortOrder + 1}`, sortOrder, raw_text || '']);
    const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [id]);
    res.status(201).json(chapter);
  });

  router.put('/:id', (req: Request, res: Response) => {
    const { title, raw_text, cleaned_text, sort_order } = req.body;
    // Handle cleaned_text specially: allow explicit null to clear it
    const cleanedTextVal = req.body.hasOwnProperty('cleaned_text') ? cleaned_text : undefined;
    const updates: string[] = [];
    const values: any[] = [];
    if (title !== undefined) { updates.push('title = ?'); values.push(title); }
    if (raw_text !== undefined) { updates.push('raw_text = ?'); values.push(raw_text); }
    if (req.body.hasOwnProperty('cleaned_text')) { updates.push('cleaned_text = ?'); values.push(cleanedTextVal); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(req.params.id, req.params.bookId);
      run(db, `UPDATE chapters SET ${updates.join(', ')} WHERE id = ? AND book_id = ?`, values);
    }
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

  // Split a chapter at a given character position
  router.post('/:id/split', (req: Request, res: Response) => {
    try {
      const { split_at, new_title } = req.body; // split_at = character index in raw_text
      const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ? AND book_id = ?', [req.params.id, req.params.bookId]) as any;
      if (!chapter) { res.status(404).json({ error: 'Chapter not found' }); return; }

      const text = chapter.cleaned_text || chapter.raw_text;
      if (split_at < 1 || split_at >= text.length) {
        res.status(400).json({ error: 'Invalid split position' }); return;
      }

      const textBefore = text.slice(0, split_at).trimEnd();
      const textAfter = text.slice(split_at).trimStart();

      // Update original chapter with first half
      run(db, `UPDATE chapters SET raw_text = ?, cleaned_text = NULL, updated_at = datetime('now') WHERE id = ?`,
        [textBefore, chapter.id]);

      // Shift sort_order of subsequent chapters
      run(db, `UPDATE chapters SET sort_order = sort_order + 1 WHERE book_id = ? AND sort_order > ?`,
        [req.params.bookId, chapter.sort_order]);

      // Create new chapter with second half
      const newId = uuid();
      run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text) VALUES (?, ?, ?, ?, ?)`,
        [newId, req.params.bookId, new_title || `${chapter.title} (cont.)`, chapter.sort_order + 1, textAfter]);

      // Clear segments from original chapter (text changed)
      run(db, 'DELETE FROM segments WHERE chapter_id = ?', [chapter.id]);

      const original = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [chapter.id]);
      const newChapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [newId]);
      res.json({ original, new_chapter: newChapter });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Duplicate a chapter
  router.post('/:id/duplicate', (req: Request, res: Response) => {
    try {
      const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ? AND book_id = ?', [req.params.id, req.params.bookId]) as any;
      if (!chapter) { res.status(404).json({ error: 'Chapter not found' }); return; }

      run(db, `UPDATE chapters SET sort_order = sort_order + 1 WHERE book_id = ? AND sort_order > ?`,
        [req.params.bookId, chapter.sort_order]);

      const newId = uuid();
      run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text, cleaned_text) VALUES (?, ?, ?, ?, ?, ?)`,
        [newId, req.params.bookId, `${chapter.title} (copy)`, chapter.sort_order + 1, chapter.raw_text, chapter.cleaned_text]);

      const newChapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [newId]);
      res.status(201).json(newChapter);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    run(db, 'DELETE FROM chapters WHERE id = ? AND book_id = ?', [req.params.id, req.params.bookId]);
    res.status(204).send();
  });

  return router;
}
