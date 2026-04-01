import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { generateTTS, computePromptHash } from '../elevenlabs/client.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export function timelineRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.get('/tracks', (req: Request, res: Response) => {
    try {
      const tracks = queryAll(db, 'SELECT * FROM tracks WHERE book_id = ? ORDER BY sort_order', [req.params.bookId]);
      const tracksWithClips = tracks.map((track: any) => {
        const clips = queryAll(db,
          `SELECT c.*, s.text as segment_text, ch.name as character_name, a.duration_ms as asset_duration_ms
           FROM clips c
           LEFT JOIN segments s ON c.segment_id = s.id
           LEFT JOIN characters ch ON s.character_id = ch.id
           LEFT JOIN audio_assets a ON c.audio_asset_id = a.id
           WHERE c.track_id = ? ORDER BY c.position_ms`,
          [track.id]);
        return { ...track, clips };
      });
      res.json(tracksWithClips);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list tracks' });
    }
  });

  router.post('/tracks', (req: Request, res: Response) => {
    try {
      const id = uuid();
      const { name, type, color } = req.body;
      if (!name || typeof name !== 'string') { res.status(400).json({ error: 'name is required' }); return; }
      const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as max_order FROM tracks WHERE book_id = ?', [req.params.bookId]);
      run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, req.params.bookId, name, type, (maxOrder?.max_order ?? -1) + 1, color || '#4A90D9']);
      const track = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [id]);
      res.status(201).json(track);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create track' });
    }
  });

  router.put('/tracks/:trackId', (req: Request, res: Response) => {
    try {
      const fields = ['name', 'gain', 'pan', 'muted', 'solo', 'locked', 'color', 'sort_order',
                      'duck_amount_db', 'duck_attack_ms', 'duck_release_ms', 'ducking_enabled'];
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
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update track' });
    }
  });

  router.delete('/tracks/:trackId', (req: Request, res: Response) => {
    try {
      run(db, 'DELETE FROM tracks WHERE id = ?', [req.params.trackId]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete track' });
    }
  });

  router.post('/tracks/:trackId/clips', (req: Request, res: Response) => {
    try {
      const id = uuid();
      const { audio_asset_id, segment_id, position_ms, trim_start_ms, trim_end_ms, gain, speed, fade_in_ms, fade_out_ms, notes } = req.body;
      if (!audio_asset_id) { res.status(400).json({ error: 'audio_asset_id is required' }); return; }
      run(db,
        `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms, trim_start_ms, trim_end_ms, gain, speed, fade_in_ms, fade_out_ms, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.params.trackId, audio_asset_id, segment_id || null, position_ms ?? 0, trim_start_ms ?? 0, trim_end_ms ?? 0, gain ?? 0.0, speed ?? 1.0, fade_in_ms ?? 0, fade_out_ms ?? 0, notes || null]);
      const clip = queryOne(db, 'SELECT * FROM clips WHERE id = ?', [id]);
      res.status(201).json(clip);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create clip' });
    }
  });

  router.put('/clips/:clipId', (req: Request, res: Response) => {
    try {
      const fields = ['position_ms', 'trim_start_ms', 'trim_end_ms', 'gain', 'speed', 'fade_in_ms', 'fade_out_ms', 'notes', 'audio_asset_id'];
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
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update clip' });
    }
  });

  router.delete('/clips/:clipId', (req: Request, res: Response) => {
    try {
      run(db, 'DELETE FROM clips WHERE id = ?', [req.params.clipId]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete clip' });
    }
  });

  router.get('/chapter-markers', (req: Request, res: Response) => {
    try {
      const markers = queryAll(db, 'SELECT * FROM chapter_markers WHERE book_id = ? ORDER BY position_ms', [req.params.bookId]);
      res.json(markers);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list chapter markers' });
    }
  });

  router.put('/chapter-markers', (req: Request, res: Response) => {
    try {
      const { markers } = req.body;
      if (!Array.isArray(markers)) { res.status(400).json({ error: 'markers must be an array' }); return; }
      run(db, 'DELETE FROM chapter_markers WHERE book_id = ?', [req.params.bookId]);
      for (const m of markers) {
        run(db, 'INSERT INTO chapter_markers (id, book_id, chapter_id, position_ms, label) VALUES (?, ?, ?, ?, ?)',
          [uuid(), req.params.bookId, m.chapter_id || null, m.position_ms, m.label]);
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update chapter markers' });
    }
  });

  // Auto-populate timeline from generated segments
  router.post('/populate', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { chapter_ids, gap_ms, chapter_gap_ms: reqChapterGapMs } = req.body;

      // Get book-level pacing defaults
      const book = queryOne(db, 'SELECT default_gap_ms, chapter_gap_ms, default_speed FROM books WHERE id = ?', [bookId]);
      const gapBetweenSegmentsMs = gap_ms ?? book?.default_gap_ms ?? 300;
      const gapBetweenChaptersMs = reqChapterGapMs ?? book?.chapter_gap_ms ?? 2000;

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
    try {
      const points = queryAll(db, 'SELECT * FROM automation_points WHERE track_id = ? ORDER BY time_ms', [req.params.trackId]);
      res.json(points);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list automation points' });
    }
  });

  router.put('/tracks/:trackId/automation', (req: Request, res: Response) => {
    try {
      const { points } = req.body;
      if (!Array.isArray(points)) { res.status(400).json({ error: 'points must be an array' }); return; }
      run(db, 'DELETE FROM automation_points WHERE track_id = ?', [req.params.trackId]);
      for (const p of points) {
        run(db, 'INSERT INTO automation_points (id, track_id, time_ms, value, curve) VALUES (?, ?, ?, ?, ?)',
          [uuid(), req.params.trackId, p.time_ms, p.value, p.curve || 'linear']);
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update automation points' });
    }
  });

  // ── Generate TTS + Populate Timeline (combined two-step) ──
  router.post('/generate-and-populate', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { chapter_ids, gap_ms, chapter_gap_ms: reqChapterGapMs } = req.body;

      // Get book-level pacing defaults
      const book = queryOne(db, 'SELECT default_gap_ms, chapter_gap_ms, default_speed FROM books WHERE id = ?', [bookId]);
      const gapBetweenSegmentsMs = gap_ms ?? book?.default_gap_ms ?? 300;
      const gapBetweenChaptersMs = reqChapterGapMs ?? book?.chapter_gap_ms ?? 2000;

      // 1. Get chapters
      let chapters;
      if (chapter_ids?.length) {
        const placeholders = chapter_ids.map(() => '?').join(',');
        chapters = queryAll(db, `SELECT * FROM chapters WHERE book_id = ? AND id IN (${placeholders}) ORDER BY sort_order`, [bookId, ...chapter_ids]);
      } else {
        chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
      }

      // 2. Generate TTS for all segments missing audio
      let ttsGenerated = 0;
      let ttsCached = 0;
      let ttsFailed = 0;
      let ttsSkipped = 0;
      const errors: string[] = [];

      for (const chapter of chapters) {
        const segments = queryAll(db, 'SELECT * FROM segments WHERE chapter_id = ? ORDER BY sort_order', [chapter.id]);
        for (const seg of segments) {
          // Skip if already has audio
          if (seg.audio_asset_id) {
            const existing = queryOne(db, 'SELECT id FROM audio_assets WHERE id = ?', [seg.audio_asset_id]);
            if (existing) { ttsSkipped++; continue; }
          }

          try {
            const result = await generateSegmentAudioForTimeline(db, seg);
            if (result.cached) ttsCached++; else ttsGenerated++;
          } catch (err: any) {
            ttsFailed++;
            errors.push(`Seg ${seg.id}: ${err.message}`);
          }
        }
      }

      // 3. Now populate timeline (same logic as /populate)
      let narrationTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'narration' LIMIT 1", [bookId]);
      if (!narrationTrack) {
        const trackId = uuid();
        run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, 'Narration', 'narration', 0, '#4A90D9')`, [trackId, bookId]);
        narrationTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [trackId]);
      }

      let currentPositionMs = 0;
      let clipsCreated = 0;
      let markersCreated = 0;

      run(db, 'DELETE FROM chapter_markers WHERE book_id = ?', [bookId]);

      for (const chapter of chapters) {
        const markerId = uuid();
        run(db, 'INSERT INTO chapter_markers (id, book_id, chapter_id, position_ms, label) VALUES (?, ?, ?, ?, ?)',
          [markerId, bookId, chapter.id, currentPositionMs, chapter.title]);
        markersCreated++;

        const segments = queryAll(db,
          `SELECT s.*, a.duration_ms FROM segments s
           JOIN audio_assets a ON s.audio_asset_id = a.id
           WHERE s.chapter_id = ? ORDER BY s.sort_order`,
          [chapter.id]);

        for (const seg of segments) {
          const existing = queryOne(db, 'SELECT * FROM clips WHERE segment_id = ? AND track_id = ?', [seg.id, narrationTrack.id]);
          if (existing) {
            currentPositionMs = existing.position_ms + (seg.duration_ms || 3000) + gapBetweenSegmentsMs;
            continue;
          }

          const clipId = uuid();
          const durationMs = seg.duration_ms || 3000;
          run(db, `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms) VALUES (?, ?, ?, ?, ?)`,
            [clipId, narrationTrack.id, seg.audio_asset_id, seg.id, currentPositionMs]);
          clipsCreated++;
          currentPositionMs += durationMs + gapBetweenSegmentsMs;
        }

        currentPositionMs += gapBetweenChaptersMs - gapBetweenSegmentsMs;
      }

      res.json({
        tts: { generated: ttsGenerated, cached: ttsCached, skipped: ttsSkipped, failed: ttsFailed, errors },
        timeline: { clips_created: clipsCreated, markers_created: markersCreated, total_duration_ms: currentPositionMs },
      });
    } catch (err: any) {
      console.error('[Generate+Populate Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Batch update multiple clips ──
  router.post('/clips/batch-update', (req: Request, res: Response) => {
    try {
      const { clip_ids, updates } = req.body;
      if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
        res.status(400).json({ error: 'clip_ids array required' }); return;
      }
      const fields = ['position_ms', 'trim_start_ms', 'trim_end_ms', 'gain', 'speed', 'fade_in_ms', 'fade_out_ms'];
      const setClauses: string[] = [];
      const setValues: any[] = [];
      for (const f of fields) {
        if (updates[f] !== undefined) { setClauses.push(`${f} = ?`); setValues.push(updates[f]); }
      }
      // Support relative adjustments (delta_gain, delta_speed, delta_position_ms)
      if (updates.delta_gain !== undefined) {
        setClauses.push('gain = gain + ?'); setValues.push(updates.delta_gain);
      }
      if (updates.delta_speed !== undefined) {
        setClauses.push('speed = MAX(0.25, MIN(2.0, speed + ?))'); setValues.push(updates.delta_speed);
      }
      if (updates.delta_position_ms !== undefined) {
        setClauses.push('position_ms = MAX(0, position_ms + ?)'); setValues.push(updates.delta_position_ms);
      }
      if (setClauses.length === 0) { res.status(400).json({ error: 'No valid updates' }); return; }
      setClauses.push("updated_at = datetime('now')");
      const placeholders = clip_ids.map(() => '?').join(',');
      run(db, `UPDATE clips SET ${setClauses.join(', ')} WHERE id IN (${placeholders})`, [...setValues, ...clip_ids]);
      res.json({ ok: true, updated: clip_ids.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Batch delete multiple clips ──
  router.post('/clips/batch-delete', (req: Request, res: Response) => {
    try {
      const { clip_ids } = req.body;
      if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
        res.status(400).json({ error: 'clip_ids array required' }); return;
      }
      const placeholders = clip_ids.map(() => '?').join(',');
      run(db, `DELETE FROM clips WHERE id IN (${placeholders})`, clip_ids);
      res.json({ ok: true, deleted: clip_ids.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Normalize volume across all clips on a track ──
  router.post('/tracks/:trackId/normalize', (req: Request, res: Response) => {
    try {
      const { target_db } = req.body;
      const targetDb = target_db ?? -3; // default target peak
      const clips = queryAll(db,
        `SELECT c.id, c.gain, a.duration_ms, a.file_size_bytes
         FROM clips c JOIN audio_assets a ON c.audio_asset_id = a.id
         WHERE c.track_id = ?`, [req.params.trackId]);
      if (clips.length === 0) { res.json({ ok: true, normalized: 0 }); return; }
      // Simple normalization: set all clips to the same gain level
      // More sophisticated would analyze actual audio levels, but this gives consistent output
      for (const clip of clips) {
        run(db, 'UPDATE clips SET gain = ? WHERE id = ?', [targetDb, (clip as any).id]);
      }
      res.json({ ok: true, normalized: clips.length, target_db: targetDb });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Ripple edit: shift all clips after a position ──
  router.post('/tracks/:trackId/ripple', (req: Request, res: Response) => {
    try {
      const { after_ms, delta_ms } = req.body;
      if (after_ms === undefined || delta_ms === undefined) {
        res.status(400).json({ error: 'after_ms and delta_ms required' }); return;
      }
      run(db,
        `UPDATE clips SET position_ms = MAX(0, position_ms + ?) WHERE track_id = ? AND position_ms > ?`,
        [delta_ms, req.params.trackId, after_ms]);
      // Also shift chapter markers
      const bookId = req.params.bookId;
      run(db,
        `UPDATE chapter_markers SET position_ms = MAX(0, position_ms + ?) WHERE book_id = ? AND position_ms > ?`,
        [delta_ms, bookId, after_ms]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Crossfade between two adjacent clips ──
  router.post('/clips/crossfade', (req: Request, res: Response) => {
    try {
      const { clip_a_id, clip_b_id, crossfade_ms } = req.body;
      if (!clip_a_id || !clip_b_id) { res.status(400).json({ error: 'clip_a_id and clip_b_id required' }); return; }
      const fadeMs = crossfade_ms ?? 500;
      const clipA = queryOne(db,
        `SELECT c.*, a.duration_ms as asset_duration_ms FROM clips c
         LEFT JOIN audio_assets a ON c.audio_asset_id = a.id WHERE c.id = ?`, [clip_a_id]) as any;
      const clipB = queryOne(db,
        `SELECT c.*, a.duration_ms as asset_duration_ms FROM clips c
         LEFT JOIN audio_assets a ON c.audio_asset_id = a.id WHERE c.id = ?`, [clip_b_id]) as any;
      if (!clipA || !clipB) { res.status(404).json({ error: 'Clip not found' }); return; }
      // Calculate clip A's end position
      const aDur = clipA.asset_duration_ms
        ? clipA.asset_duration_ms - (clipA.trim_start_ms || 0) - (clipA.trim_end_ms || 0)
        : 3000;
      const aEnd = clipA.position_ms + aDur;
      // Move clip B to overlap by crossfade_ms
      const newBPos = Math.max(0, aEnd - fadeMs);
      run(db, 'UPDATE clips SET fade_out_ms = ? WHERE id = ?', [fadeMs, clip_a_id]);
      run(db, 'UPDATE clips SET position_ms = ?, fade_in_ms = ? WHERE id = ?', [newBPos, fadeMs, clip_b_id]);
      res.json({ ok: true, clip_a_fade_out: fadeMs, clip_b_position: newBPos, clip_b_fade_in: fadeMs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Close gaps: remove silence between clips on a track ──
  router.post('/tracks/:trackId/close-gaps', (req: Request, res: Response) => {
    try {
      const { gap_ms } = req.body;
      const targetGap = gap_ms ?? 0;
      const clips = queryAll(db,
        `SELECT c.*, a.duration_ms as asset_duration_ms FROM clips c
         LEFT JOIN audio_assets a ON c.audio_asset_id = a.id
         WHERE c.track_id = ? ORDER BY c.position_ms`, [req.params.trackId]) as any[];
      if (clips.length <= 1) { res.json({ ok: true, adjusted: 0 }); return; }
      let currentPos = clips[0].position_ms;
      let adjusted = 0;
      for (let i = 0; i < clips.length; i++) {
        if (i === 0) {
          currentPos += (clips[i].asset_duration_ms
            ? clips[i].asset_duration_ms - (clips[i].trim_start_ms || 0) - (clips[i].trim_end_ms || 0)
            : 3000) + targetGap;
          continue;
        }
        if (clips[i].position_ms !== currentPos) {
          run(db, 'UPDATE clips SET position_ms = ? WHERE id = ?', [currentPos, clips[i].id]);
          adjusted++;
        }
        const dur = clips[i].asset_duration_ms
          ? clips[i].asset_duration_ms - (clips[i].trim_start_ms || 0) - (clips[i].trim_end_ms || 0)
          : 3000;
        currentPos += dur + targetGap;
      }
      res.json({ ok: true, adjusted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Send a single segment (with audio) to the timeline ──
  router.post('/send-segment-to-timeline', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { segment_id } = req.body;
      if (!segment_id) { res.status(400).json({ error: 'segment_id required' }); return; }

      const seg = queryOne(db, 'SELECT * FROM segments WHERE id = ?', [segment_id]) as any;
      if (!seg) { res.status(404).json({ error: 'Segment not found' }); return; }
      if (!seg.audio_asset_id) { res.status(400).json({ error: 'Segment has no audio. Generate audio first.' }); return; }

      const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [seg.audio_asset_id]) as any;
      if (!asset) { res.status(400).json({ error: 'Audio asset not found' }); return; }

      // Ensure narration track exists
      let narrationTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'narration' LIMIT 1", [bookId]) as any;
      if (!narrationTrack) {
        const trackId = uuid();
        run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, 'Narration', 'narration', 0, '#4A90D9')`, [trackId, bookId]);
        narrationTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [trackId]) as any;
      }

      // Check if clip already exists for this segment
      const existing = queryOne(db, 'SELECT * FROM clips WHERE segment_id = ? AND track_id = ?', [segment_id, narrationTrack.id]) as any;
      if (existing) {
        // Update the existing clip's audio asset (in case user regenerated)
        run(db, `UPDATE clips SET audio_asset_id = ? WHERE id = ?`, [seg.audio_asset_id, existing.id]);
        res.json({ clip_id: existing.id, position_ms: existing.position_ms, updated: true });
        return;
      }

      // Find the end position of the last clip on this track
      const lastClip = queryOne(db,
        `SELECT c.position_ms, a.duration_ms FROM clips c
         LEFT JOIN audio_assets a ON c.audio_asset_id = a.id
         WHERE c.track_id = ? ORDER BY c.position_ms DESC LIMIT 1`,
        [narrationTrack.id]) as any;
      const positionMs = lastClip ? (lastClip.position_ms + (lastClip.duration_ms || 3000) + 300) : 0;

      const clipId = uuid();
      const clipDurationMs = asset.duration_ms || 3000;
      run(db, `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms) VALUES (?, ?, ?, ?, ?)`,
        [clipId, narrationTrack.id, seg.audio_asset_id, segment_id, positionMs]);

      res.json({ clip_id: clipId, position_ms: positionMs, duration_ms: asset.duration_ms, updated: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
async function generateSegmentAudioForTimeline(
  db: SqlJsDatabase,
  segment: any
): Promise<{ audio_asset_id: string; cached: boolean }> {
  let voiceId = 'default';
  let voiceSettings = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };
  let modelId = 'eleven_v3';

  if (segment.character_id) {
    const char = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [segment.character_id]);
    if (char?.voice_id) {
      voiceId = char.voice_id;
      modelId = char.model_id || 'eleven_v3';
      voiceSettings = {
        stability: char.stability ?? 0.5,
        similarity_boost: char.similarity_boost ?? 0.75,
        style: char.style ?? 0.0,
        use_speaker_boost: !!char.speaker_boost,
      };
    }
  }

  if (voiceId === 'default') {
    throw new Error('No voice assigned. Assign a character with a voice first.');
  }

  const hashParams = { text: segment.text, voice_id: voiceId, model_id: modelId, voice_settings: voiceSettings };
  const promptHash = computePromptHash(hashParams);

  // Check cache
  const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ?', [promptHash]);
  if (cached && fs.existsSync(cached.file_path)) {
    run(db, `UPDATE segments SET audio_asset_id = ?, updated_at = datetime('now') WHERE id = ?`, [cached.id, segment.id]);
    return { audio_asset_id: cached.id, cached: true };
  }

  const chapter = queryOne(db, 'SELECT book_id FROM chapters WHERE id = ?', [segment.chapter_id]);

  const { buffer, requestId } = await generateTTS({
    text: segment.text,
    voice_id: voiceId,
    model_id: modelId,
    voice_settings: voiceSettings,
    output_format: 'mp3_44100_192',
  });

  const assetId = uuid();
  const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
  fs.writeFileSync(filePath, buffer);

  const estimatedDurationMs = Math.round((buffer.length / 24000) * 1000);

  run(db,
    `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, elevenlabs_request_id, generation_params, file_size_bytes)
     VALUES (?, ?, 'tts', ?, ?, ?, ?, ?, ?)`,
    [assetId, chapter.book_id, filePath, estimatedDurationMs, promptHash, requestId, JSON.stringify(hashParams), buffer.length]);

  run(db, `UPDATE segments SET audio_asset_id = ?, previous_request_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [assetId, requestId, segment.id]);

  return { audio_asset_id: assetId, cached: false };
}
