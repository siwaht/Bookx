import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import {
  getCapabilities, getVoices, searchVoices,
  generateTTS, streamTTS, generateSFX, generateMusic,
  getUsage, computePromptHash,
} from '../elevenlabs/client.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export function elevenlabsRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/capabilities', async (_req, res) => {
    try { res.json(await getCapabilities()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/voices', async (_req, res) => {
    try { res.json(await getVoices()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/voices/search', async (req, res) => {
    try { res.json(await searchVoices((req.query.q as string) || '')); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Look up a specific voice by ID from ElevenLabs API
  router.get('/voices/:voiceId', async (req, res) => {
    try {
      const voiceId = req.params.voiceId;
      // First check local cache
      const voices = await getVoices();
      const local = voices.find((v: any) => v.voice_id === voiceId);
      if (local) { res.json(local); return; }
      // Fetch directly from ElevenLabs
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) { res.status(400).json({ error: 'ELEVENLABS_API_KEY not set' }); return; }
      const apiRes = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => 'Unknown error');
        res.status(apiRes.status).json({ error: `Voice not found: ${errText}` });
        return;
      }
      const voice = await apiRes.json();
      res.json(voice);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/tts', async (req, res) => {
    try {
      const { text, voice_id, model_id, voice_settings, seed, book_id } = req.body;
      if (!text || !voice_id) { res.status(400).json({ error: 'text and voice_id required' }); return; }

      const { buffer, requestId } = await generateTTS({ text, voice_id, model_id, voice_settings, seed, output_format: 'mp3_44100_192' });
      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
      fs.writeFileSync(filePath, buffer);

      if (book_id) {
        const promptHash = computePromptHash({ text, voice_id, model_id, voice_settings, seed });
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, prompt_hash, elevenlabs_request_id, generation_params, file_size_bytes)
           VALUES (?, ?, 'tts', ?, ?, ?, ?, ?)`,
          [assetId, book_id, filePath, promptHash, requestId, JSON.stringify(req.body), buffer.length]);
      }

      res.json({ audio_asset_id: assetId, file_path: filePath, request_id: requestId });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/tts/stream', async (req, res) => {
    try {
      const { text, voice_id, model_id, voice_settings } = req.body;
      if (!text || !voice_id) { res.status(400).json({ error: 'text and voice_id required' }); return; }

      const { stream } = await streamTTS({ text, voice_id, model_id, voice_settings, output_format: 'mp3_44100_128' });
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Transfer-Encoding', 'chunked');

      const reader = (stream as any).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/sfx', async (req, res) => {
    try {
      const { prompt, duration_seconds, prompt_influence, loop, model_id, book_id } = req.body;
      if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }

      const promptHash = computePromptHash({ prompt, duration_seconds, prompt_influence, loop, model_id, type: 'sfx' });
      if (book_id) {
        const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'sfx']);
        if (cached) { res.json({ audio_asset_id: cached.id, cached: true }); return; }
      }

      const { buffer } = await generateSFX({ text: prompt, duration_seconds, prompt_influence, loop, model_id });
      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
      fs.writeFileSync(filePath, buffer);

      if (book_id) {
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, prompt_hash, generation_params, file_size_bytes) VALUES (?, ?, 'sfx', ?, ?, ?, ?)`,
          [assetId, book_id, filePath, promptHash, JSON.stringify({ prompt, duration_seconds, prompt_influence, loop, model_id }), buffer.length]);
      }

      res.json({ audio_asset_id: assetId, file_path: filePath, cached: false });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/music', async (req, res) => {
    try {
      const { prompt, duration_seconds, music_length_ms, force_instrumental, model_id, book_id } = req.body;
      if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }

      // Support both duration_seconds (legacy) and music_length_ms (new API)
      const lengthMs = music_length_ms || (duration_seconds ? duration_seconds * 1000 : undefined);

      const promptHash = computePromptHash({ prompt, music_length_ms: lengthMs, force_instrumental, model_id, type: 'music' });
      if (book_id) {
        const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'music']);
        if (cached) { res.json({ audio_asset_id: cached.id, cached: true }); return; }
      }

      const { buffer } = await generateMusic(prompt, lengthMs, force_instrumental);
      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
      fs.writeFileSync(filePath, buffer);

      if (book_id) {
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, prompt_hash, generation_params, file_size_bytes) VALUES (?, ?, 'music', ?, ?, ?, ?)`,
          [assetId, book_id, filePath, promptHash, JSON.stringify({ prompt, music_length_ms: lengthMs, force_instrumental, model_id }), buffer.length]);
      }

      res.json({ audio_asset_id: assetId, file_path: filePath, cached: false });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/usage', async (_req, res) => {
    try { res.json(await getUsage()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Local usage stats from audit_log
  router.get('/usage/local', (_req, res) => {
    try {
      const totalChars = queryOne(db, 'SELECT COALESCE(SUM(characters_used), 0) as total FROM audit_log') as any;
      const totalGenerations = queryOne(db, 'SELECT COUNT(*) as count FROM audit_log WHERE action = ?', ['tts_generate']) as any;
      const totalAssets = queryOne(db, 'SELECT COUNT(*) as count FROM audio_assets') as any;
      const totalSizeBytes = queryOne(db, 'SELECT COALESCE(SUM(file_size_bytes), 0) as total FROM audio_assets') as any;

      // Per-book breakdown
      const perBook = queryAll(db,
        `SELECT b.id, b.title, 
          COALESCE(SUM(a.characters_used), 0) as characters_used,
          COUNT(a.id) as generations,
          (SELECT COUNT(*) FROM audio_assets aa WHERE aa.book_id = b.id) as assets,
          (SELECT COALESCE(SUM(aa.file_size_bytes), 0) FROM audio_assets aa WHERE aa.book_id = b.id) as size_bytes
         FROM books b LEFT JOIN audit_log a ON a.book_id = b.id
         GROUP BY b.id ORDER BY b.title`,
        []);

      // Recent activity (last 20)
      const recent = queryAll(db,
        `SELECT action, details, characters_used, created_at FROM audit_log ORDER BY created_at DESC LIMIT 20`,
        []);

      res.json({
        total_characters_used: totalChars.total,
        total_generations: totalGenerations.count,
        total_assets: totalAssets.count,
        total_size_bytes: totalSizeBytes.total,
        per_book: perBook,
        recent_activity: recent,
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
