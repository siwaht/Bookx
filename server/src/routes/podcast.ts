import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run, withTransaction } from '../db/helpers.js';
import { detectAvailableProvider, getLLMApiKey, callLLM, buildSystemPrompt } from './ai-parse.js';
import { autoAssignWithMemory, applyCastingToBook, syncCastingFromBook, normalizeName } from '../lib/voice-casting.js';
import { listAllVoices } from '../tts/registry.js';

/**
 * Podcast section: paste a script, get speakers auto-detected and cast with
 * voices automatically, then optionally save that cast under a name so the
 * next episode can reuse it with one click. Mounted at /api/podcast.
 *
 * Casting CRUD/listing/reuse lives in castings.ts (GET /api/castings?project_type=podcast,
 * POST /api/castings/:id/apply-to-book/:bookId) — this file only owns the
 * "paste script -> detect speakers -> build an episode" pipeline.
 */

interface ParsedSegment {
  speaker: string;
  text: string;
}

// Matches lines like "HOST: text", "Alice (excited): text", "Dr. Smith [narrator]: text"
const SPEAKER_LINE_RE = /^\s*([A-Z][A-Za-z0-9'._-]{0,30}(?:\s[A-Z][A-Za-z0-9'._-]{0,30}){0,2})\s*(?:[\[(][^\])]{0,40}[\])])?\s*:\s*(.+)$/;

function looksLikeSpeakerName(name: string): boolean {
  // Title Case ("Alice", "Dr Smith") or ALL CAPS ("HOST", "GUEST 1")
  return /^[A-Z][a-z0-9'.]*(\s[A-Z][a-z0-9'.]*){0,2}$/.test(name) || /^[A-Z][A-Z0-9 ]{0,20}$/.test(name);
}

/**
 * Deterministic, zero-cost speaker detection for scripts already written with
 * a "Speaker: line" convention (the vast majority of podcast scripts). Only
 * falls through to the LLM when this heuristic can't confidently tag the text.
 */
function parseScriptBySpeakerTags(text: string): { speakers: string[]; segments: ParsedSegment[] } | null {
  const lines = text.split(/\r?\n/);
  const segments: ParsedSegment[] = [];
  let currentSpeaker: string | null = null;
  let currentText: string[] = [];
  let taggedLines = 0;
  let nonEmptyLines = 0;

  const flush = () => {
    if (currentSpeaker && currentText.length) {
      const t = currentText.join(' ').trim();
      if (t) segments.push({ speaker: currentSpeaker, text: t });
    }
    currentText = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    nonEmptyLines++;
    const m = line.match(SPEAKER_LINE_RE);
    if (m && looksLikeSpeakerName(m[1].trim())) {
      taggedLines++;
      flush();
      currentSpeaker = m[1].trim();
      currentText = [m[2].trim()];
    } else if (currentSpeaker) {
      currentText.push(line);
    }
  }
  flush();

  const speakerSet = new Set(segments.map((s) => s.speaker));
  if (speakerSet.size < 2) return null;
  if (nonEmptyLines === 0 || taggedLines / nonEmptyLines < 0.5) return null;

  return { speakers: Array.from(speakerSet), segments };
}

async function detectSpeakersWithLLM(db: SqlJsDatabase, scriptText: string): Promise<{ speakers: string[]; segments: ParsedSegment[]; provider: string }> {
  const provider = detectAvailableProvider(db);
  if (!provider) {
    throw new Error('Could not auto-detect speakers from formatting (expected lines like "Host: ..." or "HOST: ..."), and no LLM API key is configured for AI-based detection. Add an OpenAI, Claude, Mistral, or Gemini key in Settings, or format the script with one "Speaker: line" per line.');
  }
  const apiKey = getLLMApiKey(db, provider);
  if (!apiKey) throw new Error(`No API key found for ${provider}. Add it in Settings.`);

  const systemPrompt = buildSystemPrompt('podcast', 'multi_character');
  const userPrompt = `Here is the podcast script to analyze:\n\n${scriptText.slice(0, 24000)}`;
  const raw = await callLLM(provider, apiKey, systemPrompt, userPrompt);

  let parsed: any;
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : raw);
  } catch {
    throw new Error('AI returned an invalid response while parsing the script. Try again, or format it with "Speaker: line" per line.');
  }

  const speakers: string[] = (parsed.characters || []).map((c: any) => c.name);
  const segments: ParsedSegment[] = [];
  for (const ch of parsed.chapters || []) {
    for (const seg of ch.segments || []) {
      segments.push({ speaker: seg.speaker || 'Narrator', text: seg.text });
    }
  }
  return { speakers, segments, provider };
}

export function podcastRouter(db: SqlJsDatabase): Router {
  const router = Router();

  // ── Preview: detect speakers + segments without creating anything ──
  // Lets the UI show "Detected: Host, Guest" and a segment preview before
  // the user commits to creating the episode (and picks/saves a casting).
  router.post('/parse-script', async (req: Request, res: Response) => {
    try {
      const scriptText = String(req.body.script_text || '').trim();
      if (!scriptText) { res.status(400).json({ error: 'script_text is required' }); return; }
      if (scriptText.length > 200000) {
        res.status(400).json({ error: 'Script is too long (max 200,000 characters). Split it into multiple episodes.' });
        return;
      }

      const tagResult = parseScriptBySpeakerTags(scriptText);
      if (tagResult) {
        res.json({ method: 'tags', speakers: tagResult.speakers, segments: tagResult.segments });
        return;
      }

      const llmResult = await detectSpeakersWithLLM(db, scriptText);
      res.json({ method: 'llm', ...llmResult });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Create a podcast episode from a script, with auto-cast (memory-aware) or a saved casting ──
  router.post('/episodes', async (req: Request, res: Response) => {
    try {
      const { title, author, script_text, casting_id, save_as_casting_name } = req.body;
      let segments: ParsedSegment[] | undefined = req.body.segments;
      let speakerNames: string[] | undefined = req.body.speakers;

      if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }
      if (!script_text?.trim() && !(segments && segments.length)) {
        res.status(400).json({ error: 'script_text (or pre-parsed segments) is required' });
        return;
      }

      if (!segments || segments.length === 0) {
        const scriptText = String(script_text).trim();
        const tagResult = parseScriptBySpeakerTags(scriptText);
        if (tagResult) {
          segments = tagResult.segments;
          speakerNames = tagResult.speakers;
        } else {
          const llmResult = await detectSpeakersWithLLM(db, scriptText);
          segments = llmResult.segments;
          speakerNames = llmResult.speakers;
        }
      }

      if (!segments.length) { res.status(400).json({ error: 'No dialogue segments could be extracted from the script.' }); return; }
      if (!speakerNames || speakerNames.length === 0) {
        speakerNames = Array.from(new Set(segments.map((s) => s.speaker)));
      }

      const bookId = uuid();
      const chapterId = uuid();
      const fallbackRawText = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n\n');

      withTransaction(db, () => {
        run(db, `INSERT INTO books (id, title, author, project_type, format) VALUES (?, ?, ?, 'podcast', 'multi_character')`,
          [bookId, title.trim(), author || null]);
        run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text) VALUES (?, ?, 'Episode', 0, ?)`,
          [chapterId, bookId, script_text?.trim() || fallbackRawText]);

        const charIdByName = new Map<string, string>();
        for (const name of speakerNames!) {
          const id = uuid();
          const role = /host/i.test(name) ? 'host' : /guest/i.test(name) ? 'guest' : /narrat/i.test(name) ? 'narrator' : 'character';
          run(db, `INSERT INTO characters (id, book_id, name, role, normalized_name) VALUES (?, ?, ?, ?, ?)`,
            [id, bookId, name, role, normalizeName(name)]);
          charIdByName.set(name, id);
        }

        segments!.forEach((seg, i) => {
          let charId = charIdByName.get(seg.speaker);
          if (!charId) {
            // A segment referenced a speaker outside our detected list — create it on the fly.
            charId = uuid();
            run(db, `INSERT INTO characters (id, book_id, name, role, normalized_name) VALUES (?, ?, ?, 'character', ?)`,
              [charId, bookId, seg.speaker, normalizeName(seg.speaker)]);
            charIdByName.set(seg.speaker, charId);
          }
          run(db, `INSERT INTO segments (id, chapter_id, character_id, sort_order, text) VALUES (?, ?, ?, ?, ?)`,
            [uuid(), chapterId, charId, i, seg.text]);
        });
      });

      // Voice casting: apply a saved cast if one was chosen, then auto-assign
      // (memory-aware) anything still unvoiced, so recurring hosts/guests keep
      // the same voice automatically even without picking a casting explicitly.
      let castingApplied: { updated: number; created: number } | null = null;
      if (casting_id) {
        castingApplied = applyCastingToBook(db, bookId, casting_id);
      }

      let assignments: any[] = [];
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);
      const stillUnassigned = characters.filter((c: any) => !c.voice_id);
      if (stillUnassigned.length > 0) {
        try {
          const availableVoices = await listAllVoices();
          if (availableVoices.length > 0) {
            assignments = autoAssignWithMemory(db, bookId, characters, availableVoices);
          }
        } catch (err) {
          console.warn('[Podcast] Voice auto-assign skipped:', (err as Error).message);
        }
      }

      let savedCastingId: string | undefined;
      if (save_as_casting_name?.trim()) {
        savedCastingId = syncCastingFromBook(db, bookId, { name: save_as_casting_name.trim(), projectType: 'podcast' });
      }

      const finalCharacters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [bookId]);

      res.status(201).json({
        book,
        chapter_id: chapterId,
        characters: finalCharacters,
        segments_created: segments.length,
        speakers_detected: speakerNames,
        casting_applied: castingApplied,
        voice_assignments: assignments,
        saved_casting_id: savedCastingId,
      });
    } catch (err: any) {
      console.error('[Podcast Episode Create Error]', err);
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
