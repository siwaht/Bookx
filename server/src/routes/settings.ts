import { Router, Request, Response } from 'express';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

// Keys that are allowed to be stored
const ALLOWED_KEYS = [
  'elevenlabs_api_key',
  'deepgram_api_key',
  'openai_api_key',
  'mistral_api_key',
  'gemini_api_key',
  'google_tts_api_key',
  'aws_access_key',
  'aws_secret_access_key',
  'aws_region',
  'default_llm_provider',
  'default_tts_provider',
];

const MAX_VALUE_LENGTH = 500;

export function settingsRouter(db: SqlJsDatabase): Router {
  const router = Router();

  // GET all settings (masks secret values)
  router.get('/', (_req: Request, res: Response) => {
    try {
      const rows = queryAll(db, 'SELECT key, value, updated_at FROM settings');
      const settings: Record<string, { value: string; masked: string; updated_at: string }> = {};
      for (const row of rows as any[]) {
        const isSecret = row.key.endsWith('_api_key');
        settings[row.key] = {
          value: isSecret ? '' : row.value, // never send raw keys to client
          masked: isSecret && row.value ? '••••' + row.value.slice(-4) : row.value,
          updated_at: row.updated_at,
        };
      }
      res.json(settings);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  // PUT a single setting
  router.put('/:key', (req: Request, res: Response) => {
    try {
      const key = req.params.key as string;
      const { value } = req.body;

      if (!ALLOWED_KEYS.includes(key)) {
        res.status(400).json({ error: `Unknown setting: ${key}` });
        return;
      }

      if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
        res.status(400).json({ error: `Value must be a string under ${MAX_VALUE_LENGTH} characters` });
        return;
      }

      const existing = queryOne(db, 'SELECT key FROM settings WHERE key = ?', [key]);
      if (existing) {
        run(db, "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [value, key]);
      } else {
        run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
      }

      // Sync keys to env vars for immediate availability
      if (key === 'elevenlabs_api_key' && value) process.env.ELEVENLABS_API_KEY = value;
      if (key === 'openai_api_key' && value) process.env.OPENAI_API_KEY = value;
      if (key === 'mistral_api_key' && value) process.env.MISTRAL_API_KEY = value;
      if (key === 'gemini_api_key' && value) process.env.GEMINI_API_KEY = value;
      if (key === 'google_tts_api_key' && value) process.env.GOOGLE_TTS_API_KEY = value;
      if (key === 'aws_access_key' && value) process.env.AWS_ACCESS_KEY_ID = value;
      if (key === 'aws_secret_access_key' && value) process.env.AWS_SECRET_ACCESS_KEY = value;
      if (key === 'aws_region' && value) process.env.AWS_REGION = value;

      res.json({ ok: true, key });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update setting' });
    }
  });

  // DELETE a setting
  router.delete('/:key', (req: Request, res: Response) => {
    try {
      const key = req.params.key as string;
      if (!ALLOWED_KEYS.includes(key)) {
        res.status(400).json({ error: `Unknown setting: ${key}` });
        return;
      }
      run(db, 'DELETE FROM settings WHERE key = ?', [key]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete setting' });
    }
  });

  // Helper: get a raw setting value (for server-side use)
  return router;
}

// Utility to read a setting from DB (used by other server modules)
export function getSetting(db: SqlJsDatabase, key: string): string | null {
  const row = queryOne(db, 'SELECT value FROM settings WHERE key = ?', [key]) as any;
  return row?.value || null;
}
