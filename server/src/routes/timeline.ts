import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

export function timelineRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.get('/tracks', (req: Request, res: Response) => {
    const tracks = queryAll(db, 'SELECT * FROM tracks WHERE book_id = ? ORDER BY sort_order', [req.params.bookId]);
    const tracksWithClips = tracks.map((track: any) => {
      const clips = queryAll(db, 'SELECT * FROM clips WHERE track_id = ? ORDER BY position_ms', [track.id]);
      return { ...track, clips };
    });
    res.json(tracksWithClips);
  });

  router.post('/tracks', (req: Request, res: Response) => {
    const id = uuid();
    const { name, type, color } = req.body;
    const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as max_order FROM tracks WHERE book_id = ?', [req.params.bookId]);
    run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.params.bookId, name, type, (maxOrder?.max_order ?? -1) + 1, color || '#4A90D9']);
    const track = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [id]);
    res.status(201).json(track);
  });

  router.put('/tracks/:trackId', (req: Request, res: Response) => {
    const fields = ['name', 'gain', 'pan', 'muted', 'solo', 'locked', 'color', 'sort_order'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) { updates.push(`${field} = ?`); values.push(req.body[field]); }
    }
    if (updates.length > 0) {
      values.push(req.params.trackId);
      run(db, `UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    const track = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [req.params.trackId]);
    res.json(track);
  });

  router.delete('/tracks/:trackId', (req: Request, res: Response) => {
    run(db, 'DELETE FROM tracks WHERE id = ?', [req.params.trackId]);
    res.status(204).send();
  });

  router.post('/tracks/:trackId/clips', (req: Request, res: Response) => {
    const id = uuid();
    const { audio_asset_id, segment_id, position_ms, trim_start_ms, trim_end_ms, gain, fade_in_ms, fade_out_ms, notes } = req.body;
    run(db,
      `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms, trim_start_ms, trim_end_ms, gain, fade_in_ms, fade_out_ms, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.trackId, audio_asset_id, segment_id || null, position_ms ?? 0, trim_start_ms ?? 0, trim_end_ms ?? 0, gain ?? 0.0, fade_in_ms ?? 0, fade_out_ms ?? 0, notes || null]);
    const clip = queryOne(db, 'SELECT * FROM clips WHERE id = ?', [id]);
    res.status(201).json(clip);
  });

  router.put('/clips/:clipId', (req: Request, res: Response) => {
    const fields = ['position_ms', 'trim_start_ms', 'trim_end_ms', 'gain', 'fade_in_ms', 'fade_out_ms', 'notes', 'audio_asset_id'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) { updates.push(`${field} = ?`); values.push(req.body[field]); }
    }
    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(req.params.clipId);
      run(db, `UPDATE clips SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    const clip = queryOne(db, 'SELECT * FROM clips WHERE id = ?', [req.params.clipId]);
    res.json(clip);
  });

  router.delete('/clips/:clipId', (req: Request, res: Response) => {
    run(db, 'DELETE FROM clips WHERE id = ?', [req.params.clipId]);
    res.status(204).send();
  });

  router.get('/chapter-markers', (req: Request, res: Response) => {
    const markers = queryAll(db, 'SELECT * FROM chapter_markers WHERE book_id = ? ORDER BY position_ms', [req.params.bookId]);
    res.json(markers);
  });

  router.put('/chapter-markers', (req: Request, res: Response) => {
    const { markers } = req.body;
    run(db, 'DELETE FROM chapter_markers WHERE book_id = ?', [req.params.bookId]);
    for (const m of markers) {
      run(db, 'INSERT INTO chapter_markers (id, book_id, chapter_id, position_ms, label) VALUES (?, ?, ?, ?, ?)',
        [uuid(), req.params.bookId, m.chapter_id || null, m.position_ms, m.label]);
    }
    res.json({ ok: true });
  });

  // Auto-populate timeline from generated segments
  router.post('/populate', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { chapter_ids } = req.body; // optional: specific chapters, or all if omitted

      // Get chapters
      let chapters;
      if (chapter_ids?.length) {
        const placeholders = chapter_ids.map(() => '?').join(',');
        chapters = queryAll(db, `SELECT * FROM chapters WHERE book_id = ? AND id IN (${placeholders}) ORDER BY sort_order`, [bookId, ...chapter_ids]);
      } else {
        chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
      }

      // Ensure a narration track exists
      let narrationTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'narration' LIMIT 1", [bookId]);
      if (!narrationTrack) {
        const trackId = uuid();
        run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, 'Narration', 'narration', 0, '#4A90D9')`, [trackId, bookId]);
        narrationTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [trackId]);
      }

      let currentPositionMs = 0;
      const gapBetweenSegmentsMs = 300; // 300ms gap between segments
      const gapBetweenChaptersMs = 2000; // 2s gap between chapters
      const clipsCreated: any[] = [];
      const markersCreated: any[] = [];

      // Clear existing chapter markers for this book if repopulating
      run(db, 'DELETE FROM chapter_markers WHERE book_id = ?', [bookId]);

      for (const chapter of chapters) {
        // Create chapter marker at current position
        const markerId = uuid();
        run(db, 'INSERT INTO chapter_markers (id, book_id, chapter_id, position_ms, label) VALUES (?, ?, ?, ?, ?)',
          [markerId, bookId, chapter.id, currentPositionMs, chapter.title]);
        markersCreated.push({ id: markerId, chapter_id: chapter.id, position_ms: currentPositionMs, label: chapter.title });

        // Get segments with audio for this chapter
        const segments = queryAll(db,
          `SELECT s.*, a.duration_ms, a.file_path FROM segments s
           JOIN audio_assets a ON s.audio_asset_id = a.id
           WHERE s.chapter_id = ? ORDER BY s.sort_order`,
          [chapter.id]);

        for (const seg of segments) {
          // Check if clip already exists for this segment on this track
          const existing = queryOne(db, 'SELECT * FROM clips WHERE segment_id = ? AND track_id = ?', [seg.id, narrationTrack.id]);
          if (existing) {
            currentPositionMs = existing.position_ms + (seg.duration_ms || 3000) + gapBetweenSegmentsMs;
            continue;
          }

          const clipId = uuid();
          const durationMs = seg.duration_ms || 3000;
          run(db,
            `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms) VALUES (?, ?, ?, ?, ?)`,
            [clipId, narrationTrack.id, seg.audio_asset_id, seg.id, currentPositionMs]);
          clipsCreated.push({ id: clipId, segment_id: seg.id, position_ms: currentPositionMs, duration_ms: durationMs });
          currentPositionMs += durationMs + gapBetweenSegmentsMs;
        }

        currentPositionMs += gapBetweenChaptersMs - gapBetweenSegmentsMs;
      }

      // Return full track state
      const tracks = queryAll(db, 'SELECT * FROM tracks WHERE book_id = ? ORDER BY sort_order', [bookId]);
      const tracksWithClips = tracks.map((track: any) => {
        const clips = queryAll(db, 'SELECT * FROM clips WHERE track_id = ? ORDER BY position_ms', [track.id]);
        return { ...track, clips };
      });

      res.json({
        tracks: tracksWithClips,
        clips_created: clipsCreated.length,
        markers_created: markersCreated.length,
        total_duration_ms: currentPositionMs,
      });
    } catch (err: any) {
      console.error('[Populate Timeline Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tracks/:trackId/automation', (req: Request, res: Response) => {
    const points = queryAll(db, 'SELECT * FROM automation_points WHERE track_id = ? ORDER BY time_ms', [req.params.trackId]);
    res.json(points);
  });

  router.put('/tracks/:trackId/automation', (req: Request, res: Response) => {
    const { points } = req.body;
    run(db, 'DELETE FROM automation_points WHERE track_id = ?', [req.params.trackId]);
    for (const p of points) {
      run(db, 'INSERT INTO automation_points (id, track_id, time_ms, value, curve) VALUES (?, ?, ?, ?, ?)',
        [uuid(), req.params.trackId, p.time_ms, p.value, p.curve || 'linear']);
    }
    res.json({ ok: true });
  });

  return router;
}
