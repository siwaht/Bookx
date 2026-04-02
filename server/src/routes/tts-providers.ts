import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryOne, run } from '../db/helpers.js';
import { getAllProviders, getProvider, listAllVoices, generateWithProvider } from '../tts/registry.js';
import { computePromptHash } from '../elevenlabs/client.js';
import type { TTSProviderName } from '../tts/provider.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export function ttsProvidersRouter(db: SqlJsDatabase): Router {
  const router = Router();

  // List all providers and their status
  router.get('/providers', (_req: Request, res: Response) => {
    const providers = getAllProviders().map((p) => ({
      name: p.name,
      displayName: p.displayName,
      configured: p.isConfigured(),
    }));
    res.json(providers);
  });

  // Test a specific provider's connection
  router.get('/providers/:name/test', async (req: Request, res: Response) => {
    try {
      const provider = getProvider(req.params.name as TTSProviderName);
      const result = await provider.testConnection();
      res.json(result);
    } catch (err: any) {
      res.json({ connected: false, error: err.message });
    }
  });

  // List voices for a specific provider
  router.get('/providers/:name/voices', async (req: Request, res: Response) => {
    try {
      const provider = getProvider(req.params.name as TTSProviderName);
      const voices = await provider.listVoices();
      res.json(voices);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all voices across all configured providers
  router.get('/voices', async (_req: Request, res: Response) => {
    try {
      const voices = await listAllVoices();
      res.json(voices);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Generate TTS with a specific provider
  router.post('/generate', async (req: Request, res: Response) => {
    try {
      const { provider, text, voice_id, model_id, speed, stability,
        similarity_boost, style, speaker_boost, book_id, seed } = req.body;

      if (!provider || !text || !voice_id) {
        res.status(400).json({ error: 'provider, text, and voice_id are required' });
        return;
      }

      // Check cache first to avoid regenerating identical audio
      const promptHash = computePromptHash({ provider, text, voice_id, model_id, speed, stability, similarity_boost, style, speaker_boost, seed });
      if (book_id) {
        const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'tts']);
        if (cached && fs.existsSync(cached.file_path)) {
          res.json({
            audio_asset_id: cached.id,
            provider,
            request_id: cached.elevenlabs_request_id,
            duration_ms: cached.duration_ms,
            cached: true,
          });
          return;
        }
      }

      const result = await generateWithProvider(provider as TTSProviderName, {
        text, voiceId: voice_id, modelId: model_id, speed,
        stability, similarityBoost: similarity_boost, style,
        speakerBoost: speaker_boost, seed,
      });

      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
      fs.writeFileSync(filePath, result.buffer);

      if (book_id) {
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, elevenlabs_request_id, generation_params, file_size_bytes)
           VALUES (?, ?, 'tts', ?, ?, ?, ?, ?, ?)`,
          [assetId, book_id, filePath, result.durationMs || null, promptHash,
           result.requestId, JSON.stringify({ provider, ...req.body }), result.buffer.length]);
      }

      res.json({
        audio_asset_id: assetId,
        provider: result.provider,
        request_id: result.requestId,
        duration_ms: result.durationMs,
        cached: false,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
