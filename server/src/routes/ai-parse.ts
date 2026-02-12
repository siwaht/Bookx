import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { getSetting } from './settings.js';

export function aiParseRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  // POST /api/books/:bookId/ai-parse
  // Takes the book's chapters and uses an LLM to:
  // 1. Identify characters/speakers
  // 2. Assign each paragraph/line to a speaker
  // 3. Suggest SFX and background music cues
  router.post('/', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId as string;
      const { chapter_ids } = req.body; // optional subset

      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [bookId]) as any;
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      // Get chapters
      let chapters;
      if (chapter_ids?.length) {
        const ph = chapter_ids.map(() => '?').join(',');
        chapters = queryAll(db, `SELECT * FROM chapters WHERE book_id = ? AND id IN (${ph}) ORDER BY sort_order`, [bookId, ...chapter_ids]);
      } else {
        chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
      }

      if (!chapters.length) {
        res.status(400).json({ error: 'No chapters found. Import a manuscript first.' });
        return;
      }

      // Determine LLM provider
      const provider = getSetting(db, 'default_llm_provider') || detectAvailableProvider(db);
      if (!provider) {
        res.status(400).json({
          error: 'No LLM API key configured. Go to Settings and add an OpenAI, Mistral, or Gemini API key.',
        });
        return;
      }

      const apiKey = getSetting(db, `${provider}_api_key`);
      if (!apiKey) {
        res.status(400).json({ error: `No API key found for ${provider}. Configure it in Settings.` });
        return;
      }

      const format = book.format || 'single_narrator';
      const projectType = book.project_type || 'audiobook';

      // Build the prompt
      const chapterTexts = (chapters as any[]).map((ch) =>
        `--- ${ch.title} ---\n${(ch.cleaned_text || ch.raw_text).slice(0, 6000)}`
      ).join('\n\n');

      const systemPrompt = buildSystemPrompt(projectType, format);
      const userPrompt = `Here is the text to analyze:\n\n${chapterTexts.slice(0, 24000)}`;

      // Call LLM
      const result = await callLLM(provider, apiKey, systemPrompt, userPrompt);

      // Parse the JSON response
      let parsed;
      try {
        const jsonMatch = result.match(/```json\s*([\s\S]*?)```/) || result.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : result;
        parsed = JSON.parse(jsonStr);
      } catch {
        res.status(500).json({ error: 'LLM returned invalid JSON. Try again.', raw: result.slice(0, 2000) });
        return;
      }

      // Apply the parsed result to the database
      const applied = await applyParsedResult(db, bookId, chapters as any[], parsed);

      res.json({
        ...applied,
        provider,
        format,
        project_type: projectType,
      });
    } catch (err: any) {
      console.error('[AI Parse Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/books/:bookId/ai-parse/v3-tags
  // Uses LLM to suggest V3 audio tags for a given text
  router.post('/v3-tags', async (req: Request, res: Response) => {
    try {
      const { text, context } = req.body; // text = segment or chapter text, context = optional surrounding context
      if (!text?.trim()) { res.status(400).json({ error: 'No text provided' }); return; }

      const provider = getSetting(db, 'default_llm_provider') || detectAvailableProvider(db);
      if (!provider) {
        res.status(400).json({ error: 'No LLM API key configured. Go to Settings and add an API key.' });
        return;
      }
      const apiKey = getSetting(db, `${provider}_api_key`);
      if (!apiKey) {
        res.status(400).json({ error: `No API key found for ${provider}.` });
        return;
      }

      const systemPrompt = `You are an expert audio production assistant specializing in ElevenLabs v3 audio tags.

Given text from an audiobook or podcast, insert appropriate v3 audio tags to make the narration more expressive and engaging.

Available tags (wrap in square brackets):
- Emotions: [happy], [sad], [angry], [fearful], [excited], [melancholic], [romantic], [mysterious], [anxious], [confident], [nostalgic], [playful], [serious], [tender], [dramatic]
- Vocal Effects: [whisper], [shout], [gasp], [sigh], [laugh], [sob], [yawn], [cough], [chuckle], [giggle], [growl], [murmur], [panting], [clears throat]
- Styles: [conversational], [formal], [theatrical], [monotone], [breathy], [crisp], [commanding], [gentle], [intimate], [distant], [warm], [cold]
- Narrative: [storytelling tone], [voice-over style], [documentary style], [bedtime story], [dramatic pause], [suspense build-up], [inner monologue], [flashback tone]
- Rhythm: [slow], [fast], [dramatic pause], [pauses for effect], [staccato], [measured], [rushed], [languid], [building tension]

Rules:
- Insert tags naturally before the text they should affect
- Don't over-tag — use 2-5 tags per paragraph max
- Place tags where they create the most impact
- Keep the original text exactly as-is, only add tags
- Return ONLY a JSON object with "tagged_text" (the text with tags inserted) and "tags_used" (array of tag names used)`;

      const result = await callLLM(provider, apiKey, systemPrompt, text.slice(0, 4000));

      let parsed;
      try {
        const jsonMatch = result.match(/```json\s*([\s\S]*?)```/) || result.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : result;
        parsed = JSON.parse(jsonStr);
      } catch {
        res.status(500).json({ error: 'LLM returned invalid response. Try again.', raw: result.slice(0, 1000) });
        return;
      }

      res.json({ tagged_text: parsed.tagged_text || text, tags_used: parsed.tags_used || [], provider });
    } catch (err: any) {
      console.error('[AI V3 Tags Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function detectAvailableProvider(db: SqlJsDatabase): string | null {
  for (const p of ['openai', 'mistral', 'gemini']) {
    const key = getSetting(db, `${p}_api_key`);
    if (key) return p;
  }
  return null;
}

function buildSystemPrompt(projectType: string, format: string): string {
  const formatDesc: Record<string, string> = {
    single_narrator: 'A single narrator reads everything.',
    two_person_conversation: 'Two people having a conversation (Speaker A and Speaker B).',
    conversation_with_narrator: 'Two or more people conversing, plus a narrator who sets scenes and provides context.',
    narrator_and_guest: 'A host/narrator interviews or converses with one or more guests.',
    multi_character: 'Multiple distinct characters with a narrator. Like a radio drama or full-cast audiobook.',
    interview: 'An interviewer and one or more interviewees.',
  };

  const typeDesc = projectType === 'podcast' ? 'podcast episode' : 'audiobook';
  const fmtDesc = formatDesc[format] || formatDesc.single_narrator;

  return `You are an expert audio production assistant. You analyze text for a ${typeDesc} project.

Format: ${fmtDesc}

Your job:
1. Identify all distinct speakers/characters in the text. For each, provide a name and a brief voice description (gender, age, tone).
2. Break the text into segments, assigning each segment to the correct speaker.
3. Suggest sound effects (SFX) cues where appropriate — describe the sound briefly.
4. Suggest background music cues — describe mood/genre briefly.

Respond with ONLY a JSON object (no markdown, no explanation) in this exact structure:
{
  "characters": [
    { "name": "Narrator", "role": "narrator", "voice_description": "warm male voice, 40s, authoritative" },
    { "name": "Alice", "role": "character", "voice_description": "young female, 20s, energetic" }
  ],
  "chapters": [
    {
      "title": "Chapter title",
      "segments": [
        { "speaker": "Narrator", "text": "The segment text...", "type": "narration" },
        { "speaker": "Alice", "text": "Her dialogue...", "type": "dialogue" }
      ],
      "sfx_cues": [
        { "after_segment": 2, "description": "door creaking open" }
      ],
      "music_cues": [
        { "at_start": true, "description": "soft ambient piano, reflective mood" }
      ]
    }
  ]
}

Rules:
- Keep segment text faithful to the original — don't rewrite it.
- For narration/description paragraphs, assign to "Narrator".
- For dialogue, identify the speaker from context clues (dialogue tags, names, etc).
- If you can't determine the speaker, use "Narrator".
- SFX cues should be specific and producible (sounds, not abstract concepts).
- Music cues should describe mood and instruments.
- Limit to the most impactful SFX/music suggestions (don't over-annotate).`;
}

async function callLLM(provider: string, apiKey: string, system: string, user: string): Promise<string> {
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.3,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return data.choices[0].message.content;
  }

  if (provider === 'mistral') {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.3,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`Mistral API error ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return data.choices[0].message.content;
  }

  if (provider === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: system + '\n\n' + user }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 8000, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return data.candidates[0].content.parts[0].text;
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

async function applyParsedResult(
  db: SqlJsDatabase,
  bookId: string,
  existingChapters: any[],
  parsed: any
): Promise<{ characters_created: number; segments_created: number; sfx_cues: number; music_cues: number }> {
  let charactersCreated = 0;
  let segmentsCreated = 0;
  let sfxCues = 0;
  let musicCues = 0;

  // 1. Create characters
  const charMap = new Map<string, string>(); // name -> id
  if (parsed.characters?.length) {
    // Clear existing characters for this book
    run(db, 'DELETE FROM characters WHERE book_id = ?', [bookId]);

    for (const ch of parsed.characters) {
      const id = uuid();
      run(db,
        `INSERT INTO characters (id, book_id, name, role) VALUES (?, ?, ?, ?)`,
        [id, bookId, ch.name, ch.role || 'character']
      );
      charMap.set(ch.name, id);
      charactersCreated++;
    }
  }

  // 2. Create segments for each chapter
  if (parsed.chapters?.length) {
    for (let i = 0; i < parsed.chapters.length && i < existingChapters.length; i++) {
      const parsedCh = parsed.chapters[i];
      const dbChapter = existingChapters[i];

      // Clear existing segments
      run(db, 'DELETE FROM segments WHERE chapter_id = ?', [dbChapter.id]);

      if (parsedCh.segments?.length) {
        for (let j = 0; j < parsedCh.segments.length; j++) {
          const seg = parsedCh.segments[j];
          const characterId = charMap.get(seg.speaker) || null;
          run(db,
            `INSERT INTO segments (id, chapter_id, character_id, sort_order, text) VALUES (?, ?, ?, ?, ?)`,
            [uuid(), dbChapter.id, characterId, j, seg.text]
          );
          segmentsCreated++;
        }
      }

      if (parsedCh.sfx_cues?.length) sfxCues += parsedCh.sfx_cues.length;
      if (parsedCh.music_cues?.length) musicCues += parsedCh.music_cues.length;
    }
  }

  return { characters_created: charactersCreated, segments_created: segmentsCreated, sfx_cues: sfxCues, music_cues: musicCues };
}
