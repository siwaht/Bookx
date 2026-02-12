import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import {
  getCapabilities, getVoices, searchVoices,
  generateTTS, streamTTS, generateSFX, generateMusic,
  getUsage, computePromptHash, invalidateVoiceCache,
} from '../elevenlabs/client.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export function elevenlabsRouter(db: SqlJsDatabase): Router {
  const router = Router();

  // ── Connection Test ──
  router.get('/test-connection', async (_req, res) => {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        res.json({ connected: false, error: 'No API key configured. Go to Settings and add your ElevenLabs API key.' });
        return;
      }
      // Direct lightweight call to check the key works
      const testRes = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': apiKey },
      });
      if (testRes.ok) {
        const data = await testRes.json() as any;
        res.json({
          connected: true,
          tier: data.tier || 'unknown',
          character_count: data.character_count || 0,
          character_limit: data.character_limit || 0,
          can_use_instant_voice_cloning: data.can_use_instant_voice_cloning || false,
          key_last4: '••••' + apiKey.slice(-4),
        });
      } else {
        const errText = await testRes.text().catch(() => 'Unknown error');
        res.json({ connected: false, error: `API returned ${testRes.status}: ${errText}`, key_last4: '••••' + apiKey.slice(-4) });
      }
    } catch (err: any) {
      res.json({ connected: false, error: err.message });
    }
  });

  router.get('/capabilities', async (_req, res) => {
    try { res.json(await getCapabilities()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/voices', async (_req, res) => {
    try { res.json(await getVoices()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/voices/search', async (req, res) => {
    try { res.json(await searchVoices((req.query.q as string) || '')); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Search the full ElevenLabs shared voice library
  router.get('/voices/library', async (req, res) => {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) { res.status(400).json({ error: 'ELEVENLABS_API_KEY not set' }); return; }
      const q = (req.query.q as string) || '';
      const pageSize = parseInt((req.query.page_size as string) || '20', 10);
      const gender = (req.query.gender as string) || '';
      const language = (req.query.language as string) || '';
      const useCase = (req.query.use_case as string) || '';

      const params = new URLSearchParams();
      params.set('page_size', String(Math.min(pageSize, 100)));
      if (q) params.set('search', q);
      if (gender) params.set('gender', gender);
      if (language) params.set('language', language);
      if (useCase) params.set('use_case', useCase);

      const apiRes = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => 'Unknown error');
        res.status(apiRes.status).json({ error: `ElevenLabs library search failed: ${errText}` });
        return;
      }
      const data = await apiRes.json() as any;
      const voices = (data.voices || []).map((v: any) => ({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category || 'shared',
        labels: v.labels || {},
        preview_url: v.preview_url || null,
        description: v.description || null,
        use_case: v.use_case || null,
        language: v.language || null,
        public_owner_id: v.public_owner_id || null,
        sharing: true,
      }));
      res.json({ voices, has_more: data.has_more || false, last_sort_id: data.last_sort_id || null });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Add a shared voice to the user's ElevenLabs library
  // This is REQUIRED before a shared/community voice can be used for TTS
  router.post('/voices/add-shared', async (req, res) => {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) { res.status(400).json({ error: 'ELEVENLABS_API_KEY not set' }); return; }

      const { public_owner_id, voice_id, name } = req.body;
      if (!public_owner_id || !voice_id) {
        res.status(400).json({ error: 'public_owner_id and voice_id are required' });
        return;
      }

      const apiRes = await fetch(`https://api.elevenlabs.io/v1/voices/add/${public_owner_id}/${voice_id}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: name || 'Shared Voice' }),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => 'Unknown error');
        res.status(apiRes.status).json({ error: `Failed to add shared voice: ${errText}` });
        return;
      }

      const data = await apiRes.json() as any;
      // The API returns a NEW voice_id that works for TTS
      // Invalidate voice cache so the new voice shows up
      invalidateVoiceCache();

      res.json({ voice_id: data.voice_id, name: name || 'Shared Voice', added: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Look up a specific voice by ID from ElevenLabs API
  router.get('/voices/:voiceId', async (req, res) => {
    try {
      const voiceId = req.params.voiceId;
      // First check local cache
      const voices = await getVoices();
      const local = voices.find((v: any) => v.voice_id === voiceId);
      if (local) { res.json(local); return; }
      // Fetch directly from ElevenLabs (own voices)
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) { res.status(400).json({ error: 'ELEVENLABS_API_KEY not set' }); return; }
      const apiRes = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (apiRes.ok) {
        const voice = await apiRes.json();
        res.json(voice);
        return;
      }
      // Try the shared voice library as fallback
      const libraryRes = await fetch(`https://api.elevenlabs.io/v1/shared-voices?voice_id=${voiceId}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (libraryRes.ok) {
        const libData = await libraryRes.json() as any;
        if (libData.voices?.length > 0) {
          const sv = libData.voices[0];
          res.json({
            voice_id: sv.voice_id || voiceId,
            name: sv.name || 'Shared Voice',
            category: sv.category || 'shared',
            labels: sv.labels || {},
            preview_url: sv.preview_url || null,
            description: sv.description || null,
            public_owner_id: sv.public_owner_id || null,
            sharing: true,
          });
          return;
        }
      }
      res.status(404).json({ error: `Voice ID "${voiceId}" not found. Check the ID is correct, or add it to your ElevenLabs voice library first.` });
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

      // Estimate duration from MP3 file size (128kbps = 16000 bytes/sec for SFX)
      const estimatedDurationMs = Math.round((buffer.length / 16000) * 1000);

      if (book_id) {
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name) VALUES (?, ?, 'sfx', ?, ?, ?, ?, ?, ?)`,
          [assetId, book_id, filePath, estimatedDurationMs, promptHash, JSON.stringify({ prompt, duration_seconds, prompt_influence, loop, model_id }), buffer.length, prompt.slice(0, 100)]);
      }

      res.json({ audio_asset_id: assetId, file_path: filePath, cached: false, duration_ms: estimatedDurationMs });
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

      // Estimate duration from MP3 file size (192kbps = 24000 bytes/sec)
      const estimatedDurationMs = Math.round((buffer.length / 24000) * 1000);

      if (book_id) {
        run(db,
          `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name) VALUES (?, ?, 'music', ?, ?, ?, ?, ?, ?)`,
          [assetId, book_id, filePath, estimatedDurationMs, promptHash, JSON.stringify({ prompt, music_length_ms: lengthMs, force_instrumental, model_id }), buffer.length, prompt.slice(0, 100)]);
      }

      res.json({ audio_asset_id: assetId, file_path: filePath, cached: false, duration_ms: estimatedDurationMs });
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
