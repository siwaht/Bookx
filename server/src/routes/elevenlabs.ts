import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryOne, run } from '../db/helpers.js';
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
      const { prompt, duration_seconds, prompt_influence, book_id } = req.body;
      if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }

      const promptHash = computePromptHash({ prompt, duration_seconds, prompt_influence, type: 'sfx' });
      if (book_id) {
        const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'sfx']);
        if (cached) { res.json({ audio_asset_id: cached.id, cached: true }); return; }
      }

      const { buffer } = await generateSFX({ text: prompt, duration_seconds, prompt_influence });
      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
      fs.writeFileSync(filePath, buffer);

      if (book_id) {
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, prompt_hash, generation_params, file_size_bytes) VALUES (?, ?, 'sfx', ?, ?, ?, ?)`,
          [assetId, book_id, filePath, promptHash, JSON.stringify({ prompt, duration_seconds, prompt_influence }), buffer.length]);
      }

      res.json({ audio_asset_id: assetId, file_path: filePath, cached: false });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/music', async (req, res) => {
    try {
      const { prompt, duration_seconds, book_id } = req.body;
      if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }

      const promptHash = computePromptHash({ prompt, duration_seconds, type: 'music' });
      if (book_id) {
        const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'music']);
        if (cached) { res.json({ audio_asset_id: cached.id, cached: true }); return; }
      }

      const { buffer } = await generateMusic(prompt, duration_seconds);
      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
      fs.writeFileSync(filePath, buffer);

      if (book_id) {
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, prompt_hash, generation_params, file_size_bytes) VALUES (?, ?, 'music', ?, ?, ?, ?)`,
          [assetId, book_id, filePath, promptHash, JSON.stringify({ prompt, duration_seconds }), buffer.length]);
      }

      res.json({ audio_asset_id: assetId, file_path: filePath, cached: false });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/usage', async (_req, res) => {
    try { res.json(await getUsage()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
