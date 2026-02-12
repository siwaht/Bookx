import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { generateTTS, computePromptHash } from '../elevenlabs/client.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export function segmentsRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req: Request, res: Response) => {
    const segments = queryAll(db, 'SELECT * FROM segments WHERE chapter_id = ? ORDER BY sort_order', [req.params.chapterId]);
    res.json(segments);
  });

  router.post('/', (req: Request, res: Response) => {
    const id = uuid();
    const { text, character_id, sort_order } = req.body;
    run(db, `INSERT INTO segments (id, chapter_id, character_id, sort_order, text) VALUES (?, ?, ?, ?, ?)`,
      [id, req.params.chapterId, character_id || null, sort_order ?? 0, text]);
    const segment = queryOne(db, 'SELECT * FROM segments WHERE id = ?', [id]);
    res.status(201).json(segment);
  });

  router.put('/:id', (req: Request, res: Response) => {
    const fields = ['text', 'character_id', 'sort_order'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }
    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(req.params.id);
      run(db, `UPDATE segments SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    const segment = queryOne(db, 'SELECT * FROM segments WHERE id = ?', [req.params.id]);
    res.json(segment);
  });

  router.delete('/:id', (req: Request, res: Response) => {
    run(db, 'DELETE FROM segments WHERE id = ?', [req.params.id]);
    res.status(204).send();
  });

  // Generate TTS for a single segment
  router.post('/:id/generate', async (req: Request, res: Response) => {
    try {
      const segment = queryOne(db, 'SELECT * FROM segments WHERE id = ?', [req.params.id]);
      if (!segment) { res.status(404).json({ error: 'Segment not found' }); return; }

      const result = await generateSegmentAudio(db, segment);
      res.json(result);
    } catch (err: any) {
      console.error('[Segment Generate Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Batch generate TTS for all segments in a chapter
  router.post('/batch-generate', async (req: Request, res: Response) => {
    try {
      const chapterId = req.params.chapterId;
      const segments = queryAll(db, 'SELECT * FROM segments WHERE chapter_id = ? ORDER BY sort_order', [chapterId]);

      if (segments.length === 0) {
        res.status(400).json({ error: 'No segments in this chapter' });
        return;
      }

      const results: any[] = [];
      let generated = 0;
      let cached = 0;
      let failed = 0;

      for (const segment of segments) {
        try {
          const result = await generateSegmentAudio(db, segment);
          results.push({ segment_id: segment.id, ...result });
          if (result.cached) cached++; else generated++;
        } catch (err: any) {
          results.push({ segment_id: segment.id, error: err.message });
          failed++;
        }
      }

      res.json({ results, summary: { total: segments.length, generated, cached, failed } });
    } catch (err: any) {
      console.error('[Batch Generate Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}


// Shared generation logic
async function generateSegmentAudio(
  db: SqlJsDatabase,
  segment: any
): Promise<{ audio_asset_id: string; request_id?: string | null; cached: boolean; duration_ms?: number }> {
  let voiceId = 'default';
  let voiceSettings = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };
  let modelId = 'eleven_v3';

  if (segment.character_id) {
    const char = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [segment.character_id]);
    if (char?.voice_id) {
      voiceId = char.voice_id;
      modelId = char.model_id;
      voiceSettings = {
        stability: char.stability,
        similarity_boost: char.similarity_boost,
        style: char.style,
        use_speaker_boost: !!char.speaker_boost,
      };
    }
  }

  if (voiceId === 'default') {
    throw new Error('No voice assigned to character. Assign a voice first.');
  }

  const hashParams = { text: segment.text, voice_id: voiceId, model_id: modelId, voice_settings: voiceSettings };
  const promptHash = computePromptHash(hashParams);

  // Check cache
  const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ?', [promptHash]);
  if (cached && fs.existsSync(cached.file_path)) {
    run(db, `UPDATE segments SET audio_asset_id = ?, updated_at = datetime('now') WHERE id = ?`, [cached.id, segment.id]);
    return { audio_asset_id: cached.id, duration_ms: cached.duration_ms, cached: true };
  }

  const chapter = queryOne(db, 'SELECT book_id FROM chapters WHERE id = ?', [segment.chapter_id]);

  // Get previous segment's request ID for continuity stitching
  const prevSegment = queryOne(db,
    'SELECT previous_request_id FROM segments WHERE chapter_id = ? AND sort_order < ? AND previous_request_id IS NOT NULL ORDER BY sort_order DESC LIMIT 1',
    [segment.chapter_id, segment.sort_order]);

  const { buffer, requestId } = await generateTTS({
    text: segment.text,
    voice_id: voiceId,
    model_id: modelId,
    voice_settings: voiceSettings,
    previous_request_ids: prevSegment?.previous_request_id ? [prevSegment.previous_request_id] : undefined,
    output_format: 'mp3_44100_192',
  });

  const assetId = uuid();
  const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
  fs.writeFileSync(filePath, buffer);

  // Estimate duration from MP3 file size (192kbps = 24000 bytes/sec)
  const estimatedDurationMs = Math.round((buffer.length / 24000) * 1000);

  run(db,
    `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, elevenlabs_request_id, generation_params, file_size_bytes)
     VALUES (?, ?, 'tts', ?, ?, ?, ?, ?, ?)`,
    [assetId, chapter.book_id, filePath, estimatedDurationMs, promptHash, requestId, JSON.stringify(hashParams), buffer.length]);

  run(db, `UPDATE segments SET audio_asset_id = ?, previous_request_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [assetId, requestId, segment.id]);

  run(db, `INSERT INTO audit_log (book_id, action, details, elevenlabs_request_id, characters_used) VALUES (?, 'tts_generate', ?, ?, ?)`,
    [chapter.book_id, JSON.stringify({ segment_id: segment.id, model: modelId }), requestId, segment.text.length]);

  return { audio_asset_id: assetId, request_id: requestId, cached: false, duration_ms: estimatedDurationMs };
}
