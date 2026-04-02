import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { z } from 'zod/v4';

// Helper: score a voice for a character based on role/name heuristics
function findBestVoice(
  character: any,
  voices: Array<{ voiceId: string; name: string; provider: string; gender?: string; category?: string; labels?: Record<string, string> }>,
  alreadyAssigned: Set<string>
): typeof voices[0] | null {
  const available = voices.filter((v) => !alreadyAssigned.has(v.voiceId));
  if (available.length === 0) return null;

  const role = (character.role || '').toLowerCase();
  const charName = (character.name || '').toLowerCase();

  // Score each voice
  const scored = available.map((voice) => {
    let score = 0;
    const vName = (voice.name || '').toLowerCase();
    const vCategory = (voice.category || '').toLowerCase();
    const labels = voice.labels || {};
    const labelValues = Object.values(labels).map((l) => l.toLowerCase());
    const labelKeys = Object.keys(labels).map((k) => k.toLowerCase());

    // Narrator role prefers voices with narrator/storyteller labels
    if (role === 'narrator') {
      if (vName.includes('narrator') || vName.includes('storytell')) score += 10;
      if (vCategory === 'professional' || vCategory === 'narration') score += 5;
      if (labelValues.some((l) => l.includes('narrat') || l.includes('storytell') || l.includes('audiobook'))) score += 8;
      if (labelKeys.includes('use case') && labelValues.some((l) => l.includes('narrat'))) score += 6;
    }

    // Character role prefers expressive/conversational voices
    if (role === 'character') {
      if (vCategory === 'conversational' || vCategory === 'characters') score += 3;
      if (labelValues.some((l) => l.includes('character') || l.includes('conversational'))) score += 4;
    }

    // Bonus for name similarity (e.g., character "Alice" matching voice "Alice")
    if (vName.includes(charName) || charName.includes(vName)) score += 15;

    // Slight randomization to distribute voices more naturally
    score += Math.random() * 2;

    return { voice, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.voice || null;
}

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
      const { name, role, voice_id, voice_name, tts_provider, model_id,
              stability, similarity_boost, style, speed, speaker_boost } = parsed.data;

      const id = uuid();
      run(db,
        `INSERT INTO characters (id, book_id, name, role, voice_id, voice_name, tts_provider, model_id, stability, similarity_boost, style, speed, speaker_boost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.params.bookId, name, role || 'character', voice_id || null, voice_name || null,
         tts_provider || 'elevenlabs', model_id || 'eleven_v3', stability ?? 0.5, similarity_boost ?? 0.75, style ?? 0.0, speed ?? 1.0, speaker_boost ?? 1]
      );

      const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [id]);
      res.status(201).json(character);
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

      if (updates.length > 0) {
        values.push(req.params.id, req.params.bookId);
        run(db, `UPDATE characters SET ${updates.join(', ')} WHERE id = ? AND book_id = ?`, values);
      }

      const character = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [req.params.id]);
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
      const bookId = req.params.bookId;
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

      if (availableVoices.length === 0) {
        res.status(400).json({ error: 'No voices available from any configured provider. Check your API keys in Settings.' });
        return;
      }

      // Build a set of already-used voice IDs in this book to avoid duplicates
      const usedVoiceIds = new Set(
        characters.filter((c: any) => c.voice_id).map((c: any) => c.voice_id)
      );

      // Filter out already-used voices
      let candidateVoices = availableVoices.filter((v) => !usedVoiceIds.has(v.voiceId));
      if (candidateVoices.length === 0) {
        // If all voices are used, allow reuse but still try to distribute
        candidateVoices = [...availableVoices];
      }

      // Smart assignment: try to match narrator roles to voices labeled as "narrator" or "storyteller"
      // and distribute character voices to be distinct
      const assignments: Array<{ character_id: string; character_name: string; voice_id: string; voice_name: string; provider: string }> = [];
      const assignedInThisRound = new Set<string>();

      // Sort: narrators first, then characters
      const sortedUnassigned = [...unassigned].sort((a: any, b: any) => {
        if (a.role === 'narrator' && b.role !== 'narrator') return -1;
        if (a.role !== 'narrator' && b.role === 'narrator') return 1;
        return 0;
      });

      for (const char of sortedUnassigned) {
        const c = char as any;
        // Find best matching voice
        let bestVoice = findBestVoice(c, candidateVoices, assignedInThisRound);
        if (!bestVoice && assignedInThisRound.size > 0) {
          // Relax: allow reuse if we ran out
          bestVoice = findBestVoice(c, candidateVoices, new Set());
        }
        if (!bestVoice) continue;

        // Update the character in DB
        run(db,
          `UPDATE characters SET voice_id = ?, voice_name = ?, tts_provider = ? WHERE id = ? AND book_id = ?`,
          [bestVoice.voiceId, bestVoice.name, bestVoice.provider, c.id, bookId]
        );

        assignedInThisRound.add(bestVoice.voiceId);
        assignments.push({
          character_id: c.id,
          character_name: c.name,
          voice_id: bestVoice.voiceId,
          voice_name: bestVoice.name,
          provider: bestVoice.provider,
        });
      }

      res.json({
        assigned: assignments.length,
        total_characters: characters.length,
        unassigned_remaining: unassigned.length - assignments.length,
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
