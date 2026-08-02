import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { z } from 'zod/v4';
import { autoAssignWithMemory, findRememberedVoice, rememberCharacterVoice, normalizeName } from '../lib/voice-casting.js';

const CreateCharacterSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.enum(['narrator', 'character', 'host', 'guest']).optional(),
  voice_id: z.string().max(200).nullable().optional(),
  voice_name: z.string().max(200).nullable().optional(),
  tts_provider: z.string().max(50).optional(),
  model_id: z.string().max(100).optional(),
  stability: z.number().min(0).max(1).optional(),
  similarity_boost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  speaker_boost: z.union([z.number(), z.boolean()]).optional(),
});

const UpdateCharacterSchema = CreateCharacterSchema.partial();

export function charactersRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req: Request, res: Response) => {
    try {
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [req.params.bookId]);
      res.json(characters);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list characters' });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const parsed = CreateCharacterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }
      let { name, role, voice_id, voice_name, tts_provider, model_id,
              stability, similarity_boost, style, speed, speaker_boost } = parsed.data;

      // Multi-cast memory: if the caller didn't specify a voice, check whether this
      // book's casting / series / global memory already knows this character's voice.
      const bookIdParam = String(req.params.bookId);
      let castingMemberId: string | null = null;
      if (!voice_id) {
        const remembered = findRememberedVoice(db, name, { bookId: bookIdParam });
        if (remembered) {
          voice_id = remembered.voice_id || undefined;
          voice_name = remembered.voice_name || undefined;
          tts_provider = remembered.tts_provider as any;
          model_id = remembered.model_id;
          stability = remembered.stability;
          similarity_boost = remembered.similarity_boost;
          style = remembered.style;
          speed = remembered.speed;
          speaker_boost = !!remembered.speaker_boost;
          castingMemberId = remembered.id;
        }
      }

      const id = uuid();
      run(db,
        `INSERT INTO characters (id, book_id, name, role, voice_id, voice_name, tts_provider, model_id, stability, similarity_boost, style, speed, speaker_boost, casting_member_id, normalized_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, bookIdParam, name, role || 'character', voice_id || null, voice_name || null,
         tts_provider || 'elevenlabs', model_id || 'eleven_v3', stability ?? 0.5, similarity_boost ?? 0.75, style ?? 0.0, speed ?? 1.0, speaker_boost ?? 1,
         castingMemberId, normalizeName(name)]
      );

      // If a voice was explicitly supplied on create, remember it for next time too.
      if (voice_id && !castingMemberId) {
        rememberCharacterVoice(db, bookIdParam, { name, role, voice_id, voice_name, tts_provider, model_id, stability, similarity_boost, style, speed, speaker_boost });
      }

      const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [id]);
      res.status(201).json({ ...character, remembered: !!castingMemberId });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create character' });
    }
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const parsed = UpdateCharacterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }

      const fields = ['name', 'role', 'voice_id', 'voice_name', 'tts_provider', 'model_id', 'stability', 'similarity_boost', 'style', 'speed', 'speaker_boost'];
      const updates: string[] = [];
      const values: any[] = [];

      for (const field of fields) {
        if ((parsed.data as any)[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push((parsed.data as any)[field]);
        }
      }
      if (parsed.data.name !== undefined) {
        updates.push('normalized_name = ?');
        values.push(normalizeName(parsed.data.name));
      }

      if (updates.length > 0) {
        values.push(req.params.id, req.params.bookId);
        run(db, `UPDATE characters SET ${updates.join(', ')} WHERE id = ? AND book_id = ?`, values);
      }

      const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [req.params.id]) as any;

      // Whenever a voice gets (re)assigned, persist it into this book's casting/series
      // memory so it's remembered next time this character shows up.
      if (character?.voice_id && parsed.data.voice_id !== undefined) {
        rememberCharacterVoice(db, String(req.params.bookId), character);
      }

      res.json(character);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update character' });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      run(db, 'DELETE FROM characters WHERE id = ? AND book_id = ?', [req.params.id, req.params.bookId]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete character' });
    }
  });

  // Auto-assign voices to characters that don't have one yet
  // Uses available voices from configured TTS providers and distributes them
  // so each character gets a unique voice. Supports optional hints for smarter matching.
  router.post('/auto-assign-voices', async (req: Request, res: Response) => {
    try {
      const bookId = String(req.params.bookId);
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);
      if (characters.length === 0) {
        res.json({ assigned: 0, message: 'No characters found' });
        return;
      }

      const unassigned = characters.filter((c: any) => !c.voice_id);
      if (unassigned.length === 0) {
        res.json({ assigned: 0, message: 'All characters already have voices', assignments: [] });
        return;
      }

      // Gather available voices from the request body or fetch from providers
      let availableVoices: Array<{ voiceId: string; name: string; provider: string; gender?: string; category?: string; labels?: Record<string, string> }> = [];

      if (req.body.voices && Array.isArray(req.body.voices)) {
        // Client sent a pre-fetched voice list
        availableVoices = req.body.voices;
      } else {
        // Fetch from all configured providers via the registry
        const { listAllVoices } = await import('../tts/registry.js');
        availableVoices = await listAllVoices();
      }

      // Multi-cast assignment: recall a remembered voice for each character from this
      // book's casting / series / global memory first, and only pick a fresh voice
      // when there's no memory hit. Every assignment (remembered or fresh) is written
      // back into the casting so it's remembered for the next book/volume/episode.
      //
      // Note we deliberately do NOT bail out when the provider catalog is empty:
      // recall works purely off the database, so an unconfigured or rate-limited
      // provider must not cost us the voices we already remember. We only report
      // the "no voices available" error if nothing at all could be assigned.
      const assignments = autoAssignWithMemory(db, bookId, characters, availableVoices);
      const rememberedCount = assignments.filter((a) => a.source === 'memory').length;

      if (assignments.length === 0 && availableVoices.length === 0) {
        res.status(400).json({ error: 'No voices available from any configured provider, and none of these characters have a remembered voice yet. Add a TTS API key in Settings.' });
        return;
      }

      res.json({
        assigned: assignments.length,
        total_characters: characters.length,
        unassigned_remaining: unassigned.length - assignments.length,
        remembered_from_casting: rememberedCount,
        assignments,
      });
    } catch (err: any) {
      console.error('Auto-assign voices error:', err);
      res.status(500).json({ error: err.message || 'Failed to auto-assign voices' });
    }
  });

  // Auto-assign segments to characters by matching speaker names in text
  router.post('/auto-assign-by-name', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);
      if (characters.length === 0) { res.json({ assigned: 0, message: 'No characters found' }); return; }

      const chapters = queryAll(db, 'SELECT id FROM chapters WHERE book_id = ?', [bookId]);
      const chapterIds = chapters.map((c: any) => c.id);
      if (chapterIds.length === 0) { res.json({ assigned: 0, message: 'No chapters found' }); return; }

      const placeholders = chapterIds.map(() => '?').join(',');
      const allSegments = queryAll(db, `SELECT * FROM segments WHERE chapter_id IN (${placeholders})`, chapterIds);

      const nameMap = new Map<string, any>();
      for (const char of characters) {
        nameMap.set((char as any).name.toLowerCase(), char);
      }

      let assigned = 0;
      const matches: { segment_id: string; character_name: string }[] = [];

      for (const seg of allSegments) {
        const text = ((seg as any).text || '').trim();
        const match = text.match(/^([A-Za-z][A-Za-z0-9_ ]*?)(?:\s*[\[\(][^\]\)]*[\]\)])?\s*:/);
        if (!match) continue;

        const speakerName = match[1].trim().toLowerCase();
        const character = nameMap.get(speakerName);
        if (!character) continue;

        if (!(seg as any).character_id) {
          run(db, `UPDATE segments SET character_id = ?, updated_at = datetime('now') WHERE id = ?`,
            [(character as any).id, (seg as any).id]);
          assigned++;
          matches.push({ segment_id: (seg as any).id, character_name: (character as any).name });
        }
      }

      res.json({ assigned, total_segments: allSegments.length, matches });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
