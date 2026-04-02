import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { generateTTS, computePromptHash } from '../elevenlabs/client.js';
import { generateWithProvider } from '../tts/registry.js';
import type { TTSProviderName } from '../tts/provider.js';

const DATA_DIR = process.env.DATA_DIR || './data';

// In-memory map of running jobs so we can cancel them
const runningJobs = new Map<string, { cancelled: boolean }>();

export function generationRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  // ── Get generation status overview for a book ──
  router.get('/status', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;

      // Per-chapter stats
      const chapters = queryAll(db,
        'SELECT id, title, sort_order FROM chapters WHERE book_id = ? ORDER BY sort_order',
        [bookId]) as any[];

      const chapterStats = chapters.map((ch: any) => {
        const total = queryOne(db,
          'SELECT COUNT(*) as count FROM segments WHERE chapter_id = ?', [ch.id]) as any;
        const withAudio = queryOne(db,
          `SELECT COUNT(*) as count FROM segments s
           WHERE s.chapter_id = ? AND s.audio_asset_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM audio_assets a WHERE a.id = s.audio_asset_id)`,
          [ch.id]) as any;
        const withCharacter = queryOne(db,
          `SELECT COUNT(*) as count FROM segments s
           WHERE s.chapter_id = ? AND s.character_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM characters c WHERE c.id = s.character_id AND c.voice_id IS NOT NULL)`,
          [ch.id]) as any;

        return {
          chapter_id: ch.id,
          title: ch.title,
          sort_order: ch.sort_order,
          total_segments: total.count,
          with_audio: withAudio.count,
          ready_to_generate: withCharacter.count,
          missing_audio: total.count - withAudio.count,
        };
      });

      const totals = chapterStats.reduce((acc, ch) => ({
        total_segments: acc.total_segments + ch.total_segments,
        with_audio: acc.with_audio + ch.with_audio,
        ready_to_generate: acc.ready_to_generate + ch.ready_to_generate,
        missing_audio: acc.missing_audio + ch.missing_audio,
      }), { total_segments: 0, with_audio: 0, ready_to_generate: 0, missing_audio: 0 });

      // Active/recent jobs
      const jobs = queryAll(db,
        `SELECT * FROM generation_jobs WHERE book_id = ? ORDER BY created_at DESC LIMIT 10`,
        [bookId]);

      res.json({ chapters: chapterStats, totals, jobs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Start a generation job ──
  router.post('/start', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { scope, scope_ids, regenerate } = req.body;
      // scope: 'book' | 'chapter' | 'segment'
      // scope_ids: string[] (chapter IDs or segment IDs depending on scope)
      // regenerate: boolean - if true, regenerate even if audio exists

      const jobId = uuid();
      const jobScope = scope || 'book';

      // Check for already-running job on this book
      const existing = queryOne(db,
        "SELECT id FROM generation_jobs WHERE book_id = ? AND status = 'running'",
        [bookId]) as any;
      if (existing) {
        res.status(409).json({ error: 'A generation job is already running for this book', job_id: existing.id });
        return;
      }

      // Gather segments to generate
      let segments: any[] = [];
      if (jobScope === 'segment' && scope_ids?.length) {
        const placeholders = scope_ids.map(() => '?').join(',');
        segments = queryAll(db,
          `SELECT s.*, ch.book_id, ch.title as chapter_title FROM segments s
           JOIN chapters ch ON s.chapter_id = ch.id
           WHERE s.id IN (${placeholders}) AND ch.book_id = ?
           ORDER BY ch.sort_order, s.sort_order`,
          [...scope_ids, bookId]);
      } else if (jobScope === 'chapter' && scope_ids?.length) {
        const placeholders = scope_ids.map(() => '?').join(',');
        segments = queryAll(db,
          `SELECT s.*, ch.book_id, ch.title as chapter_title FROM segments s
           JOIN chapters ch ON s.chapter_id = ch.id
           WHERE ch.id IN (${placeholders}) AND ch.book_id = ?
           ORDER BY ch.sort_order, s.sort_order`,
          [...scope_ids, bookId]);
      } else {
        // Whole book
        segments = queryAll(db,
          `SELECT s.*, ch.book_id, ch.title as chapter_title FROM segments s
           JOIN chapters ch ON s.chapter_id = ch.id
           WHERE ch.book_id = ?
           ORDER BY ch.sort_order, s.sort_order`,
          [bookId]);
      }

      if (segments.length === 0) {
        res.status(400).json({ error: 'No segments found for the given scope' });
        return;
      }

      // Create job record
      run(db,
        `INSERT INTO generation_jobs (id, book_id, scope, scope_ids, status, total_segments, started_at)
         VALUES (?, ?, ?, ?, 'running', ?, datetime('now'))`,
        [jobId, bookId, jobScope, scope_ids ? JSON.stringify(scope_ids) : null, segments.length]);

      // Return immediately, process in background
      res.json({ job_id: jobId, total_segments: segments.length });

      // Background processing
      const jobControl = { cancelled: false };
      runningJobs.set(jobId, jobControl);

      processGeneration(db, jobId, segments, !!regenerate, jobControl).catch((err) => {
        console.error('[Generation Job Error]', err);
        run(db,
          `UPDATE generation_jobs SET status = 'failed', errors = ?, completed_at = datetime('now') WHERE id = ?`,
          [JSON.stringify([err.message]), jobId]);
        runningJobs.delete(jobId);
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Get job progress ──
  router.get('/jobs/:jobId', (req: Request, res: Response) => {
    try {
      const job = queryOne(db, 'SELECT * FROM generation_jobs WHERE id = ?', [req.params.jobId]);
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
      const parsed = { ...job, errors: JSON.parse(job.errors || '[]'), scope_ids: job.scope_ids ? JSON.parse(job.scope_ids) : null };
      res.json(parsed);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cancel a running job ──
  router.post('/cancel/:jobId', (req: Request, res: Response) => {
    try {
      const job = queryOne(db, 'SELECT * FROM generation_jobs WHERE id = ?', [req.params.jobId]) as any;
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
      if (job.status !== 'running') { res.status(400).json({ error: 'Job is not running' }); return; }

      const control = runningJobs.get(req.params.jobId as string);
      if (control) control.cancelled = true;

      run(db,
        `UPDATE generation_jobs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?`,
        [req.params.jobId]);

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}


// ── Background generation processor ──
async function processGeneration(
  db: SqlJsDatabase,
  jobId: string,
  segments: any[],
  regenerate: boolean,
  control: { cancelled: boolean },
) {
  let completed = 0;
  let cached = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const segment of segments) {
    if (control.cancelled) break;

    // Skip segments without a voice-assigned character
    if (!segment.character_id) {
      skipped++;
      updateJobProgress(db, jobId, completed, cached, failed, skipped, errors, segment.chapter_title, segment.text?.slice(0, 50));
      continue;
    }

    const char = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [segment.character_id]) as any;
    if (!char?.voice_id) {
      skipped++;
      updateJobProgress(db, jobId, completed, cached, failed, skipped, errors, segment.chapter_title, segment.text?.slice(0, 50));
      continue;
    }

    // Skip if already has audio and not regenerating
    if (!regenerate && segment.audio_asset_id) {
      const existing = queryOne(db, 'SELECT id FROM audio_assets WHERE id = ?', [segment.audio_asset_id]);
      if (existing) {
        skipped++;
        updateJobProgress(db, jobId, completed, cached, failed, skipped, errors, segment.chapter_title, segment.text?.slice(0, 50));
        continue;
      }
    }

    try {
      const result = await generateSegmentAudioInternal(db, segment, char);
      if (result.cached) cached++;
      else completed++;
    } catch (err: any) {
      failed++;
      errors.push(`Ch "${segment.chapter_title}" seg ${segment.sort_order}: ${err.message}`);
      if (errors.length > 50) errors.splice(0, errors.length - 50); // keep last 50
    }

    updateJobProgress(db, jobId, completed, cached, failed, skipped, errors, segment.chapter_title, segment.text?.slice(0, 50));
  }

  const finalStatus = control.cancelled ? 'cancelled' : (failed > 0 && completed === 0 && cached === 0 ? 'failed' : 'completed');
  run(db,
    `UPDATE generation_jobs SET status = ?, completed_segments = ?, cached_segments = ?, failed_segments = ?, skipped_segments = ?, errors = ?, completed_at = datetime('now'), current_chapter = NULL, current_segment = NULL WHERE id = ?`,
    [finalStatus, completed, cached, failed, skipped, JSON.stringify(errors), jobId]);

  runningJobs.delete(jobId);
}

function updateJobProgress(
  db: SqlJsDatabase, jobId: string,
  completed: number, cached: number, failed: number, skipped: number,
  errors: string[], currentChapter: string, currentSegment: string,
) {
  run(db,
    `UPDATE generation_jobs SET completed_segments = ?, cached_segments = ?, failed_segments = ?, skipped_segments = ?, errors = ?, current_chapter = ?, current_segment = ? WHERE id = ?`,
    [completed, cached, failed, skipped, JSON.stringify(errors), currentChapter, currentSegment, jobId]);
}

function applyPronunciationRules(db: SqlJsDatabase, text: string, chapterId: string, characterId: string | null): string {
  const chapter = queryOne(db, 'SELECT book_id FROM chapters WHERE id = ?', [chapterId]);
  if (!chapter) return text;

  let rules;
  if (characterId) {
    rules = queryAll(db,
      'SELECT * FROM pronunciation_rules WHERE book_id = ? AND (character_id = ? OR character_id IS NULL) ORDER BY length(word) DESC',
      [chapter.book_id, characterId]);
  } else {
    rules = queryAll(db,
      'SELECT * FROM pronunciation_rules WHERE book_id = ? AND character_id IS NULL ORDER BY length(word) DESC',
      [chapter.book_id]);
  }

  if (!rules || rules.length === 0) return text;

  let result = text;
  for (const rule of rules as any[]) {
    const escaped = rule.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (rule.alias) {
      result = result.replace(regex, rule.alias);
    } else if (rule.phoneme) {
      result = result.replace(regex, `<phoneme alphabet="ipa" ph="${rule.phoneme}">${rule.word}</phoneme>`);
    }
  }
  return result;
}

async function generateSegmentAudioInternal(
  db: SqlJsDatabase,
  segment: any,
  char: any,
): Promise<{ audio_asset_id: string; cached: boolean; duration_ms?: number }> {
  const voiceId = char.voice_id;
  const modelId = char.model_id || 'eleven_v3';
  const ttsProvider: TTSProviderName = char.tts_provider || 'elevenlabs';
  const speed = char.speed || 1.0;
  const voiceSettings = {
    stability: char.stability ?? 0.5,
    similarity_boost: char.similarity_boost ?? 0.75,
    style: char.style ?? 0.0,
    use_speaker_boost: !!char.speaker_boost,
  };

  const processedText = applyPronunciationRules(db, segment.text, segment.chapter_id, segment.character_id);
  const hashParams = { provider: ttsProvider, text: processedText, voice_id: voiceId, model_id: modelId, voice_settings: voiceSettings };
  const promptHash = computePromptHash(hashParams);

  // Check cache
  const cachedAsset = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ?', [promptHash]) as any;
  if (cachedAsset && fs.existsSync(cachedAsset.file_path)) {
    run(db, `UPDATE segments SET audio_asset_id = ?, updated_at = datetime('now') WHERE id = ?`, [cachedAsset.id, segment.id]);
    return { audio_asset_id: cachedAsset.id, duration_ms: cachedAsset.duration_ms, cached: true };
  }

  const chapter = queryOne(db, 'SELECT book_id FROM chapters WHERE id = ?', [segment.chapter_id]) as any;

  let buffer: Buffer;
  let requestId: string | null = null;
  let durationMs: number;

  if (ttsProvider === 'elevenlabs') {
    const prevSegment = queryOne(db,
      'SELECT previous_request_id FROM segments WHERE chapter_id = ? AND sort_order < ? AND previous_request_id IS NOT NULL ORDER BY sort_order DESC LIMIT 1',
      [segment.chapter_id, segment.sort_order]) as any;

    const result = await generateTTS({
      text: processedText,
      voice_id: voiceId,
      model_id: modelId,
      voice_settings: voiceSettings,
      previous_request_ids: prevSegment?.previous_request_id ? [prevSegment.previous_request_id] : undefined,
      output_format: 'mp3_44100_192',
    });
    buffer = result.buffer;
    requestId = result.requestId;
    durationMs = Math.round((buffer.length / 24000) * 1000);
  } else {
    const result = await generateWithProvider(ttsProvider, {
      text: processedText,
      voiceId,
      modelId,
      speed,
      stability: voiceSettings.stability,
      similarityBoost: voiceSettings.similarity_boost,
      style: voiceSettings.style,
      speakerBoost: voiceSettings.use_speaker_boost,
    });
    buffer = result.buffer;
    requestId = result.requestId;
    durationMs = result.durationMs || Math.round((buffer.length / 24000) * 1000);
  }

  const assetId = uuid();
  const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
  fs.writeFileSync(filePath, buffer);

  run(db,
    `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, elevenlabs_request_id, generation_params, file_size_bytes)
     VALUES (?, ?, 'tts', ?, ?, ?, ?, ?, ?)`,
    [assetId, chapter.book_id, filePath, durationMs, promptHash, requestId, JSON.stringify({ ...hashParams, provider: ttsProvider }), buffer.length]);

  run(db, `UPDATE segments SET audio_asset_id = ?, previous_request_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [assetId, requestId, segment.id]);

  run(db, `INSERT INTO audit_log (book_id, action, details, elevenlabs_request_id, characters_used) VALUES (?, 'tts_generate', ?, ?, ?)`,
    [chapter.book_id, JSON.stringify({ segment_id: segment.id, model: modelId, provider: ttsProvider }), requestId, segment.text.length]);

  return { audio_asset_id: assetId, cached: false, duration_ms: durationMs };
}
