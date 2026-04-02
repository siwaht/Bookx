import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { getSetting } from './settings.js';
import { generateSFX, generateMusic, computePromptHash } from '../elevenlabs/client.js';

const DATA_DIR = process.env.DATA_DIR || './data';

// ── LLM helpers (reused from ai-parse pattern) ──

function detectProvider(db: SqlJsDatabase): string | null {
  for (const p of ['openai', 'claude', 'mistral', 'gemini']) {
    const key = getSetting(db, `${p}_api_key`);
    if (key) return p;
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.MISTRAL_API_KEY) return 'mistral';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

const FALLBACK_MODELS: Record<string, { id: string; label: string }[]> = {
  openai: [
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { id: 'o3-mini', label: 'o3-mini' },
  ],
  claude: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  ],
  mistral: [
    { id: 'mistral-large-latest', label: 'Mistral Large' },
    { id: 'mistral-small-latest', label: 'Mistral Small' },
    { id: 'mistral-medium-latest', label: 'Mistral Medium' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
};

// Cache fetched models for 10 minutes to avoid hammering APIs
const modelsCache: Record<string, { models: { id: string; label: string }[]; fetchedAt: number }> = {};
const CACHE_TTL = 10 * 60 * 1000;

async function fetchProviderModels(provider: string, apiKey: string): Promise<{ id: string; label: string }[]> {
  const cached = modelsCache[provider];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.models;

  try {
    let models: { id: string; label: string }[] = [];

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}`);
      const data = await res.json() as any;
      const chatModels = (data.data as any[])
        .filter((m: any) => /^(gpt-|o[1-9]|chatgpt-)/.test(m.id) && !/instruct|realtime|audio|search|tts|dall|whisper|embed|moderation/i.test(m.id))
        .sort((a: any, b: any) => (b.created || 0) - (a.created || 0));
      models = chatModels.map((m: any) => ({ id: m.id, label: m.id }));
    }

    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=50', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Error(`Claude ${res.status}`);
      const data = await res.json() as any;
      models = (data.data as any[]).map((m: any) => ({
        id: m.id,
        label: m.display_name || m.id,
      }));
    }

    if (provider === 'mistral') {
      const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`Mistral ${res.status}`);
      const data = await res.json() as any;
      const chatModels = (data.data as any[])
        .filter((m: any) => !/embed|moderation/i.test(m.id))
        .sort((a: any, b: any) => (b.created || 0) - (a.created || 0));
      models = chatModels.map((m: any) => ({ id: m.id, label: m.id }));
    }

    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = await res.json() as any;
      const genModels = (data.models as any[])
        .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
        .sort((a: any, b: any) => (b.name || '').localeCompare(a.name || ''));
      models = genModels.map((m: any) => ({
        id: m.name.replace('models/', ''),
        label: m.displayName || m.name.replace('models/', ''),
      }));
    }

    if (models.length > 0) {
      modelsCache[provider] = { models, fetchedAt: Date.now() };
      return models;
    }
  } catch (err) {
    console.warn(`[Background Boost] Failed to fetch ${provider} models, using fallback:`, (err as Error).message);
  }

  return FALLBACK_MODELS[provider] || [];
}

function getDefaultModel(provider: string): string {
  const models = FALLBACK_MODELS[provider];
  return models?.[0]?.id || 'gpt-4o-mini';
}

function getApiKeyForProvider(db: SqlJsDatabase, provider: string): string | null {
  if (provider === 'claude') {
    return getSetting(db, 'claude_api_key') || process.env.ANTHROPIC_API_KEY || null;
  }
  return getSetting(db, `${provider}_api_key`) || process.env[`${provider.toUpperCase()}_API_KEY`] || null;
}

async function callLLM(provider: string, apiKey: string, system: string, user: string, model?: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'gpt-4.1-mini',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.4, max_tokens: 16000,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => '')}`);
      const data = await res.json() as any;
      return data.choices[0].message.content;
    }
    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: 16000,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text().catch(() => '')}`);
      const data = await res.json() as any;
      return data.content[0].text;
    }
    if (provider === 'mistral') {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'mistral-small-latest',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.4, max_tokens: 16000,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Mistral ${res.status}: ${await res.text().catch(() => '')}`);
      const data = await res.json() as any;
      return data.choices[0].message.content;
    }
    if (provider === 'gemini') {
      const modelId = model || 'gemini-2.5-flash';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: system + '\n\n' + user }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 16000, responseMimeType: 'application/json' },
          }),
          signal: controller.signal,
        }
      );
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text().catch(() => '')}`);
      const data = await res.json() as any;
      return data.candidates[0].content.parts[0].text;
    }
    throw new Error(`Unsupported provider: ${provider}`);
  } finally { clearTimeout(timeout); }
}

const SCENE_ANALYSIS_PROMPT = `You are an elite cinematic sound designer, foley artist, and film composer creating a FULL immersive audio experience — like a Hollywood movie, anime, or AAA video game. You must treat every paragraph as if you're designing the soundtrack for a film adaptation.

Your job: read the text segment by segment and identify EVERY sound that would exist in that world.

## WHAT YOU MUST DETECT

### Physical Actions → SFX (one-shot sounds)
Every physical action described or implied MUST get a sound effect:
- Walking/running → footsteps (on gravel, wood, stone, grass, snow, marble, etc.)
- Doors → opening, closing, slamming, creaking, locking
- Eating/drinking → chewing, sipping, pouring, clinking glasses, setting down cups
- Fighting → punches landing, kicks, grunts, bodies hitting ground, armor clanking
- Weapons → sword drawing, sword clashing, arrow release, gun cocking, gun firing, reloading
- Objects → picking up items, dropping things, paper rustling, book pages turning, keys jingling
- Body sounds → breathing heavily, heartbeat (tension), gasping, sighing, crying, laughing
- Impacts → glass breaking, wood splintering, stone crumbling, metal bending
- Vehicles → horse hooves, carriage wheels, car engine, ship creaking
- Magic/supernatural → energy crackling, whooshing, ethereal hum, explosion

### Environment → Ambience (continuous loops)
Every location described needs its ambient soundscape:
- Forest → birds chirping, leaves rustling, twigs snapping, insects buzzing, wind through trees
- City/town → crowd murmur, distant traffic, street vendors, church bells, dogs barking
- Indoor → clock ticking, fireplace crackling, floorboards creaking, muffled voices
- Rain/storm → rain on roof/ground/windows, thunder (distant or close), wind howling
- Ocean/water → waves crashing, seagulls, ship creaking, water lapping
- Night → crickets, owls, distant wolves, wind, silence with occasional sounds
- Cave/dungeon → dripping water, echoes, distant rumbling, chains rattling
- Battlefield → distant explosions, shouting, metal clashing, horses
- Kitchen → sizzling, boiling water, chopping, pots clanking
- Tavern/bar → crowd chatter, glasses clinking, music, laughter

### Mood → Background Music (scored per scene)
Music MUST match the emotional arc precisely:
- Romantic/intimate → soft piano, gentle strings, warm pads, slow tempo (60-80 BPM)
- Tension/suspense → low drones, dissonant strings, sparse percussion, building intensity
- Action/battle → aggressive drums, fast tempo (140-180 BPM), brass hits, distorted guitars
- Mystery/exploration → plucked strings, ethereal pads, unusual instruments, moderate tempo
- Sadness/loss → solo cello or violin, minor key, minimal arrangement, very slow
- Joy/celebration → upbeat tempo, major key, full orchestra or folk instruments
- Horror/dread → atonal strings, reversed sounds, deep bass rumbles, silence with stingers
- Epic/triumphant → full orchestra crescendo, choir, timpani, brass fanfare
- Peaceful/nature → acoustic guitar, flute, light percussion, nature-inspired
- Chase/urgency → fast ostinato strings, driving percussion, rising pitch

### Transitions Between Scenes
When mood changes between consecutive scenes:
- Gradual shift → long crossfade (3-5 seconds), music morphs
- Sudden shift (e.g., peace → attack) → hard cut or dramatic sting
- Emotional climax → music swells then drops to silence
- Scene ending → fade out with reverb tail

## OUTPUT FORMAT

Respond with ONLY a JSON object:
{
  "scenes": [
    {
      "scene_index": 0,
      "title": "Brief vivid description of what happens",
      "mood": "romantic|action|suspense|horror|peaceful|melancholic|epic|comedic|mysterious|dramatic|tense|joyful|chase|battle|exploration",
      "intensity": 0.0-1.0,
      "segment_start": 0,
      "segment_end": 5,
      "music": {
        "prompt": "VERY detailed music prompt. Include: genre, instruments, tempo BPM, key (major/minor), dynamics, reference style. Example: 'Dark orchestral suspense score, low cello drones in D minor, sparse pizzicato violins, deep timpani rolls building slowly, 70 BPM, Hans Zimmer style tension, gradually intensifying'",
        "volume": 0.15-0.30,
        "fade_in_ms": 1000-5000,
        "fade_out_ms": 1000-5000,
        "duration_hint_seconds": 10-120,
        "loop": true
      },
      "ambience": [
        {
          "prompt": "SPECIFIC ambient sound. Example: 'Dense forest ambience with birds singing, gentle wind through oak leaves, distant stream flowing over rocks, occasional woodpecker tapping'",
          "volume": 0.15-0.35,
          "fade_in_ms": 500-2000,
          "fade_out_ms": 500-2000,
          "loop": true,
          "duration_hint_seconds": 10-22
        }
      ],
      "sfx": [
        {
          "prompt": "PRECISE sound effect. Example: 'Heavy leather boots walking slowly on wet cobblestone, 4 deliberate steps'",
          "at_segment": 2,
          "position": "start|middle|end",
          "offset_hint_ms": 0-5000,
          "volume": 0.3-0.8,
          "duration_hint_seconds": 1-10
        }
      ],
      "voice_mood": "How narration should sound — whispered, urgent, trembling, warm, cold, shouting, breathless, etc."
    }
  ]
}

## CRITICAL RULES

1. **EVERY physical action gets an SFX** — if someone walks, you hear footsteps. If someone drinks, you hear sipping. If a door opens, you hear it. NO exceptions.
2. **SFX prompts must be hyper-specific** — not "footsteps" but "soft leather shoes on creaky wooden floorboards, slow pace". The generation model needs detail.
3. **Multiple SFX per segment is normal** — a character walking to a table, pulling out a chair, and sitting down = 3 separate SFX entries.
4. **Ambience changes with location** — if characters move from indoors to outdoors, the ambient sound MUST change.
5. **Music follows emotional arc** — if a scene starts calm and builds to tension, describe that progression in the music prompt.
6. **Volume hierarchy**: Narration is king. Music 0.15-0.25, Ambience 0.15-0.30, SFX 0.35-0.70. SFX can spike briefly.
7. **Don't skip quiet moments** — silence or near-silence IS a sound design choice. A ticking clock in a quiet room is powerful.
8. **Layer sounds realistically** — a tavern scene needs: crowd chatter (ambience) + fireplace (ambience) + background music + specific SFX (glass clink, chair scrape, etc.)
9. **Break scenes at mood/location changes** — don't group a peaceful walk and a sudden ambush into one scene.
10. **Be generous with SFX** — more is better. 3-8 SFX per scene is typical. A fight scene might have 10+.
11. **offset_hint_ms** tells where within the segment's duration the SFX should play. 0 = start, higher values = later. Use this for precise timing.
12. **Keep scenes granular** — prefer more smaller scenes (3-8 segments each) over fewer large ones. Each mood shift = new scene.`;


export function backgroundBoostRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  // GET /api/books/:bookId/background-boost/models
  // Returns available LLM providers and their models (fetched live from each API)
  router.get('/models', async (req: Request, res: Response) => {
    try {
      // If ?refresh=true, clear the cache to force re-fetch
      if (req.query.refresh === 'true') {
        for (const key of Object.keys(modelsCache)) delete modelsCache[key];
      }

      const currentProvider = getSetting(db, 'default_llm_provider') || detectProvider(db);
      const currentModel = getSetting(db, 'default_llm_model');
      const providers = ['openai', 'claude', 'mistral', 'gemini'];
      const available: Record<string, { models: { id: string; label: string }[]; hasKey: boolean }> = {};

      // Fetch models in parallel for all providers that have keys
      const fetches = providers.map(async (prov) => {
        const apiKey = getApiKeyForProvider(db, prov);
        const hasKey = !!apiKey;
        const models = hasKey ? await fetchProviderModels(prov, apiKey!) : FALLBACK_MODELS[prov] || [];
        available[prov] = { models, hasKey };
      });
      await Promise.all(fetches);

      res.json({ providers: available, currentProvider, currentModel });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/books/:bookId/background-boost/analyze
  // Analyzes chapter text and returns scene-by-scene audio suggestions
  router.post('/analyze', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { chapter_ids, provider: reqProvider, model: reqModel } = req.body;

      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [bookId]) as any;
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      const provider = reqProvider || getSetting(db, 'default_llm_provider') || detectProvider(db);
      if (!provider) {
        res.status(400).json({ error: 'No LLM API key configured. Go to Settings and add an OpenAI, Claude, Mistral, or Gemini API key.' });
        return;
      }
      const apiKey = getApiKeyForProvider(db, provider);
      if (!apiKey) {
        res.status(400).json({ error: `No API key for ${provider}. Add it in Settings.` });
        return;
      }
      const model = reqModel || getSetting(db, 'default_llm_model') || getDefaultModel(provider);

      // Get chapters
      let chapterList: any[];
      if (chapter_ids?.length) {
        const ph = chapter_ids.map(() => '?').join(',');
        chapterList = queryAll(db, `SELECT * FROM chapters WHERE book_id = ? AND id IN (${ph}) ORDER BY sort_order`, [bookId, ...chapter_ids]);
      } else {
        chapterList = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
      }
      if (!chapterList.length) {
        res.status(400).json({ error: 'No chapters found. Import a manuscript first.' });
        return;
      }

      // Get segments for each chapter to provide context
      const chaptersWithSegments = chapterList.map((ch: any) => {
        const segs = queryAll(db, 'SELECT s.*, c.name as character_name FROM segments s LEFT JOIN characters c ON s.character_id = c.id WHERE s.chapter_id = ? ORDER BY s.sort_order', [ch.id]);
        return { ...ch, segments: segs };
      });

      // Build text for analysis — include character names for context
      const analysisText = chaptersWithSegments.map((ch: any) => {
        const segTexts = ch.segments.map((s: any, i: number) => {
          const speaker = s.character_name ? `[${s.character_name}]` : '';
          return `[Segment ${i}] ${speaker} ${s.text}`;
        }).join('\n');
        return `=== ${ch.title} ===\n${segTexts || (ch.cleaned_text || ch.raw_text).slice(0, 6000)}`;
      }).join('\n\n');

      const totalSegments = chaptersWithSegments.reduce((sum: number, ch: any) => sum + ch.segments.length, 0);
      const contextHeader = `Total segments: ${totalSegments}. Analyze EVERY segment for sounds. Be thorough — every action, every environment change, every mood shift.\n\n`;
      const result = await callLLM(provider, apiKey, SCENE_ANALYSIS_PROMPT, contextHeader + analysisText.slice(0, 48000), model);

      let parsed;
      try {
        const jsonMatch = result.match(/```json\s*([\s\S]*?)```/) || result.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : result;
        parsed = JSON.parse(jsonStr);
      } catch {
        res.status(500).json({ error: 'LLM returned invalid JSON. Try again.', raw: result.slice(0, 2000) });
        return;
      }

      // Store analysis in DB — only delete scenes for analyzed chapters (not all)
      if (chapter_ids?.length) {
        const ph = chapter_ids.map(() => '?').join(',');
        run(db, `DELETE FROM background_boost_scenes WHERE book_id = ? AND chapter_id IN (${ph})`, [bookId, ...chapter_ids]);
      } else {
        run(db, 'DELETE FROM background_boost_scenes WHERE book_id = ?', [bookId]);
      }
      const scenes = parsed.scenes || [];
      // Map scene segment ranges to chapters so we can tag each scene with its chapter_id
      const chapterSegRanges = chaptersWithSegments.map((ch: any) => ({
        id: ch.id,
        segCount: ch.segments.length,
      }));
      let segOffset = 0;
      const chapterRanges = chapterSegRanges.map((ch: any) => {
        const start = segOffset;
        segOffset += ch.segCount;
        return { id: ch.id, start, end: segOffset - 1 };
      });

      for (const scene of scenes) {
        const id = uuid();
        // Find which chapter this scene belongs to based on segment_start
        const matchedChapter = chapterRanges.find((cr: any) => (scene.segment_start ?? 0) >= cr.start && (scene.segment_start ?? 0) <= cr.end);
        const chapterId = matchedChapter?.id || (chapterList.length === 1 ? chapterList[0].id : null);
        run(db,
          `INSERT INTO background_boost_scenes (id, book_id, chapter_id, scene_index, title, mood, intensity, segment_start, segment_end, music_prompt, music_volume, music_fade_in_ms, music_fade_out_ms, music_duration_hint, music_loop, ambience_json, sfx_json, voice_mood, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [
            id, bookId, chapterId, scene.scene_index, scene.title, scene.mood, scene.intensity,
            scene.segment_start ?? 0, scene.segment_end ?? 0,
            scene.music?.prompt || null, scene.music?.volume ?? 0.2,
            scene.music?.fade_in_ms ?? 2000, scene.music?.fade_out_ms ?? 3000,
            scene.music?.duration_hint_seconds ?? 30, scene.music?.loop ? 1 : 0,
            JSON.stringify(scene.ambience || []),
            JSON.stringify(scene.sfx || []),
            scene.voice_mood || null,
          ]
        );
      }

      res.json({
        scenes,
        total_scenes: scenes.length,
        provider,
        model,
        chapters_analyzed: chapterList.length,
      });
    } catch (err: any) {
      console.error('[Background Boost Analyze Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/books/:bookId/background-boost/scenes
  router.get('/scenes', (req: Request, res: Response) => {
    try {
      const scenes = queryAll(db,
        'SELECT * FROM background_boost_scenes WHERE book_id = ? ORDER BY scene_index',
        [req.params.bookId]
      );
      // Parse JSON fields
      const parsed = scenes.map((s: any) => ({
        ...s,
        ambience: JSON.parse(s.ambience_json || '[]'),
        sfx: JSON.parse(s.sfx_json || '[]'),
        music_loop: !!s.music_loop,
      }));
      res.json(parsed);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/books/:bookId/background-boost/scenes/:sceneId
  // Update a scene's settings (volume, prompts, etc.)
  router.put('/scenes/:sceneId', (req: Request, res: Response) => {
    try {
      const fields: Record<string, string> = {
        title: 'title', mood: 'mood', intensity: 'intensity',
        music_prompt: 'music_prompt', music_volume: 'music_volume',
        music_fade_in_ms: 'music_fade_in_ms', music_fade_out_ms: 'music_fade_out_ms',
        music_duration_hint: 'music_duration_hint', music_loop: 'music_loop',
        voice_mood: 'voice_mood', status: 'status',
      };
      const updates: string[] = [];
      const values: any[] = [];
      for (const [bodyKey, dbCol] of Object.entries(fields)) {
        if (req.body[bodyKey] !== undefined) {
          updates.push(`${dbCol} = ?`);
          values.push(req.body[bodyKey]);
        }
      }
      if (req.body.ambience !== undefined) {
        updates.push('ambience_json = ?');
        values.push(JSON.stringify(req.body.ambience));
      }
      if (req.body.sfx !== undefined) {
        updates.push('sfx_json = ?');
        values.push(JSON.stringify(req.body.sfx));
      }
      if (updates.length > 0) {
        values.push(req.params.sceneId);
        run(db, `UPDATE background_boost_scenes SET ${updates.join(', ')} WHERE id = ?`, values);
      }
      const scene = queryOne(db, 'SELECT * FROM background_boost_scenes WHERE id = ?', [req.params.sceneId]) as any;
      res.json({
        ...scene,
        ambience: JSON.parse(scene?.ambience_json || '[]'),
        sfx: JSON.parse(scene?.sfx_json || '[]'),
        music_loop: !!scene?.music_loop,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/books/:bookId/background-boost/scenes/:sceneId
  router.delete('/scenes/:sceneId', (req: Request, res: Response) => {
    try {
      run(db, 'DELETE FROM background_boost_scenes WHERE id = ?', [req.params.sceneId]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/books/:bookId/background-boost/generate
  // Generate audio for one or all scenes and place on timeline
  // If scenes were previously generated, old boost clips are removed first
  router.post('/generate', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { scene_ids, generate_music, generate_ambience, generate_sfx, force_regenerate } = req.body;
      const doMusic = generate_music !== false;
      const doAmbience = generate_ambience !== false;
      const doSfx = generate_sfx !== false;

      // Get scenes to generate
      let scenes: any[];
      if (scene_ids?.length) {
        const ph = scene_ids.map(() => '?').join(',');
        scenes = queryAll(db, `SELECT * FROM background_boost_scenes WHERE book_id = ? AND id IN (${ph}) ORDER BY scene_index`, [bookId, ...scene_ids]);
      } else {
        scenes = queryAll(db, 'SELECT * FROM background_boost_scenes WHERE book_id = ? ORDER BY scene_index', [bookId]);
      }

      if (!scenes.length) {
        res.status(400).json({ error: 'No scenes found. Run analysis first.' });
        return;
      }

      // If force_regenerate or re-generating specific scenes, clean up old boost clips first
      const boostTrackIds: string[] = [];
      const boostTracks = queryAll(db, "SELECT id FROM tracks WHERE book_id = ? AND (name LIKE '%Boost%' OR name LIKE '%Ambience%')", [bookId]);
      for (const t of boostTracks) boostTrackIds.push((t as any).id);

      if (boostTrackIds.length > 0 && (force_regenerate || scene_ids?.length)) {
        // Remove clips on boost tracks that match the scenes being regenerated
        for (const scene of scenes) {
          const notePattern = `Boost: ${scene.title}`;
          for (const trackId of boostTrackIds) {
            run(db, "DELETE FROM clips WHERE track_id = ? AND notes LIKE ?", [trackId, `%${scene.title.slice(0, 40)}%`]);
          }
        }
      } else if (boostTrackIds.length > 0 && !scene_ids?.length) {
        // Full regeneration — clear all boost clips
        for (const trackId of boostTrackIds) {
          run(db, 'DELETE FROM clips WHERE track_id = ?', [trackId]);
        }
      }

      // Get existing timeline to calculate positions
      const narrationTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'narration' LIMIT 1", [bookId]) as any;
      const narrationClips = narrationTrack
        ? queryAll(db, `SELECT c.*, a.duration_ms as asset_duration_ms FROM clips c LEFT JOIN audio_assets a ON c.audio_asset_id = a.id WHERE c.track_id = ? ORDER BY c.position_ms`, [narrationTrack.id])
        : [];

      // Ensure SFX and Music tracks exist
      let sfxTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'sfx' AND name LIKE '%Boost%' LIMIT 1", [bookId]) as any;
      if (!sfxTrack) {
        const id = uuid();
        const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as m FROM tracks WHERE book_id = ?', [bookId]) as any;
        run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color, gain) VALUES (?, ?, '🔊 Boost SFX', 'sfx', ?, '#F59E0B', -6.0)`,
          [id, bookId, (maxOrder?.m ?? 0) + 1]);
        sfxTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [id]);
      }

      let musicTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'music' AND name LIKE '%Boost%' LIMIT 1", [bookId]) as any;
      if (!musicTrack) {
        const id = uuid();
        const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as m FROM tracks WHERE book_id = ?', [bookId]) as any;
        run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color, gain) VALUES (?, ?, '🎵 Boost Music', 'music', ?, '#8B5CF6', -10.0)`,
          [id, bookId, (maxOrder?.m ?? 0) + 1]);
        musicTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [id]);
      }

      let ambienceTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'sfx' AND name LIKE '%Ambience%' LIMIT 1", [bookId]) as any;
      if (!ambienceTrack) {
        const id = uuid();
        const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as m FROM tracks WHERE book_id = ?', [bookId]) as any;
        run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color, gain) VALUES (?, ?, '🌿 Boost Ambience', 'sfx', ?, '#10B981', -8.0)`,
          [id, bookId, (maxOrder?.m ?? 0) + 1]);
        ambienceTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [id]);
      }

      const results = {
        music_generated: 0, ambience_generated: 0, sfx_generated: 0,
        clips_created: 0, errors: [] as string[],
      };

      // Helper: find narration clip position for a segment index
      function getSegmentPositionMs(segIndex: number): number {
        if (segIndex < narrationClips.length) {
          return (narrationClips[segIndex] as any).position_ms;
        }
        // Estimate from last clip
        if (narrationClips.length > 0) {
          const last = narrationClips[narrationClips.length - 1] as any;
          return last.position_ms + (last.asset_duration_ms || 3000) + 300;
        }
        return segIndex * 5000; // fallback
      }

      for (const scene of scenes) {
        const sceneStartMs = getSegmentPositionMs(scene.segment_start);
        const sceneEndMs = getSegmentPositionMs(scene.segment_end);
        const sceneDurationMs = Math.max(sceneEndMs - sceneStartMs, 5000);

        // Generate music
        if (doMusic && scene.music_prompt) {
          try {
            const durationSec = scene.music_duration_hint || Math.ceil(sceneDurationMs / 1000);
            const lengthMs = Math.min(durationSec * 1000, 300000); // max 5 min

            const promptHash = computePromptHash({ prompt: scene.music_prompt, music_length_ms: lengthMs, type: 'boost_music' });
            let assetId: string;
            const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'music']);
            if (cached && fs.existsSync(cached.file_path)) {
              assetId = cached.id;
            } else {
              const { buffer } = await generateMusic(scene.music_prompt, lengthMs, true);
              assetId = uuid();
              const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
              fs.writeFileSync(filePath, buffer);
              const estDuration = Math.round((buffer.length / 24000) * 1000);
              run(db,
                `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name)
                 VALUES (?, ?, 'music', ?, ?, ?, ?, ?, ?)`,
                [assetId, bookId, filePath, estDuration, promptHash,
                 JSON.stringify({ prompt: scene.music_prompt, music_length_ms: lengthMs, source: 'background_boost' }),
                 buffer.length, `🎵 ${scene.title}`]);
            }

            // Place clip on music track
            const clipId = uuid();
            run(db,
              `INSERT INTO clips (id, track_id, audio_asset_id, position_ms, gain, fade_in_ms, fade_out_ms, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [clipId, musicTrack.id, assetId, sceneStartMs,
               volumeToDb(scene.music_volume ?? 0.2),
               scene.music_fade_in_ms ?? 2000, scene.music_fade_out_ms ?? 3000,
               `Boost: ${scene.title}`]);
            results.music_generated++;
            results.clips_created++;
          } catch (err: any) {
            results.errors.push(`Music for "${scene.title}": ${err.message}`);
          }
        }

        // Generate ambience
        if (doAmbience) {
          const ambienceList = JSON.parse(scene.ambience_json || '[]');
          for (const amb of ambienceList) {
            try {
              const durSec = amb.duration_hint_seconds || Math.ceil(sceneDurationMs / 1000);
              const promptHash = computePromptHash({ prompt: amb.prompt, duration_seconds: durSec, type: 'boost_ambience' });
              let assetId: string;
              const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'sfx']);
              if (cached && fs.existsSync(cached.file_path)) {
                assetId = cached.id;
              } else {
                const { buffer } = await generateSFX({ text: amb.prompt, duration_seconds: Math.min(durSec, 22), loop: amb.loop });
                assetId = uuid();
                const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
                fs.writeFileSync(filePath, buffer);
                const estDuration = Math.round((buffer.length / 16000) * 1000);
                run(db,
                  `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name)
                   VALUES (?, ?, 'sfx', ?, ?, ?, ?, ?, ?)`,
                  [assetId, bookId, filePath, estDuration, promptHash,
                   JSON.stringify({ prompt: amb.prompt, duration_seconds: durSec, source: 'background_boost' }),
                   buffer.length, `🌿 ${amb.prompt.slice(0, 60)}`]);
              }

              const clipId = uuid();
              run(db,
                `INSERT INTO clips (id, track_id, audio_asset_id, position_ms, gain, fade_in_ms, fade_out_ms, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [clipId, ambienceTrack.id, assetId, sceneStartMs,
                 volumeToDb(amb.volume ?? 0.25),
                 amb.fade_in_ms ?? 1000, amb.fade_out_ms ?? 1500,
                 `Ambience: ${amb.prompt.slice(0, 50)}`]);
              results.ambience_generated++;
              results.clips_created++;
            } catch (err: any) {
              results.errors.push(`Ambience "${amb.prompt?.slice(0, 30)}": ${err.message}`);
            }
          }
        }

        // Generate SFX
        if (doSfx) {
          const sfxList = JSON.parse(scene.sfx_json || '[]');
          for (const sfx of sfxList) {
            try {
              const durSec = sfx.duration_hint_seconds || 3;
              const promptHash = computePromptHash({ prompt: sfx.prompt, duration_seconds: durSec, type: 'boost_sfx' });
              let assetId: string;
              const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ? AND type = ?', [promptHash, 'sfx']);
              if (cached && fs.existsSync(cached.file_path)) {
                assetId = cached.id;
              } else {
                const { buffer } = await generateSFX({ text: sfx.prompt, duration_seconds: Math.min(durSec, 22) });
                assetId = uuid();
                const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
                fs.writeFileSync(filePath, buffer);
                const estDuration = Math.round((buffer.length / 16000) * 1000);
                run(db,
                  `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name)
                   VALUES (?, ?, 'sfx', ?, ?, ?, ?, ?, ?)`,
                  [assetId, bookId, filePath, estDuration, promptHash,
                   JSON.stringify({ prompt: sfx.prompt, duration_seconds: durSec, source: 'background_boost' }),
                   buffer.length, `🔊 ${sfx.prompt.slice(0, 60)}`]);
              }

              // Position SFX at the specific segment with offset for precise timing
              let sfxPositionMs = sceneStartMs;
              if (sfx.at_segment !== undefined) {
                sfxPositionMs = getSegmentPositionMs(sfx.at_segment);
              }
              // Apply position-based offset within the segment
              if (sfx.at_segment !== undefined && sfx.at_segment < narrationClips.length) {
                const segClip = narrationClips[sfx.at_segment] as any;
                const segDuration = segClip?.asset_duration_ms || 3000;
                if (sfx.offset_hint_ms) {
                  sfxPositionMs += Math.min(sfx.offset_hint_ms, segDuration);
                } else if (sfx.position === 'middle') {
                  sfxPositionMs += Math.round(segDuration * 0.4);
                } else if (sfx.position === 'end') {
                  sfxPositionMs += Math.max(segDuration - (durSec * 1000) - 200, 0);
                }
                // 'start' keeps sfxPositionMs as-is
              }

              const clipId = uuid();
              run(db,
                `INSERT INTO clips (id, track_id, audio_asset_id, position_ms, gain, notes)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [clipId, sfxTrack.id, assetId, sfxPositionMs,
                 volumeToDb(sfx.volume ?? 0.6),
                 `SFX: ${sfx.prompt.slice(0, 50)}`]);
              results.sfx_generated++;
              results.clips_created++;
            } catch (err: any) {
              results.errors.push(`SFX "${sfx.prompt?.slice(0, 30)}": ${err.message}`);
            }
          }
        }

        // Mark scene as generated
        run(db, "UPDATE background_boost_scenes SET status = 'generated' WHERE id = ?", [scene.id]);
      }

      // Reset status to pending for scenes that had errors
      for (const scene of scenes) {
        const hasErrors = results.errors.some(e => e.includes(scene.title));
        if (hasErrors) {
          run(db, "UPDATE background_boost_scenes SET status = 'partial' WHERE id = ?", [scene.id]);
        }
      }

      // Return updated tracks
      const tracks = queryAll(db, 'SELECT * FROM tracks WHERE book_id = ? ORDER BY sort_order', [bookId]);
      const tracksWithClips = tracks.map((track: any) => {
        const clips = queryAll(db, 'SELECT * FROM clips WHERE track_id = ? ORDER BY position_ms', [track.id]);
        return { ...track, clips };
      });

      res.json({ ...results, tracks: tracksWithClips });
    } catch (err: any) {
      console.error('[Background Boost Generate Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/books/:bookId/background-boost/scenes/:sceneId/regenerate
  // Re-generate audio for a single scene (clears old clips for this scene first)
  router.post('/scenes/:sceneId/regenerate', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const sceneId = req.params.sceneId;
      const { layer } = req.body; // optional: 'music' | 'ambience' | 'sfx' | undefined (all)

      const scene = queryOne(db, 'SELECT * FROM background_boost_scenes WHERE id = ? AND book_id = ?', [sceneId, bookId]) as any;
      if (!scene) { res.status(404).json({ error: 'Scene not found' }); return; }

      // Reset scene status
      run(db, "UPDATE background_boost_scenes SET status = 'pending' WHERE id = ?", [sceneId]);

      // Generate via the main generate endpoint logic
      // Forward to generate with just this scene
      req.body.scene_ids = [sceneId];
      req.body.force_regenerate = true;
      if (layer === 'music') {
        req.body.generate_music = true;
        req.body.generate_ambience = false;
        req.body.generate_sfx = false;
      } else if (layer === 'ambience') {
        req.body.generate_music = false;
        req.body.generate_ambience = true;
        req.body.generate_sfx = false;
      } else if (layer === 'sfx') {
        req.body.generate_music = false;
        req.body.generate_ambience = false;
        req.body.generate_sfx = true;
      }

      // Delegate to the generate handler by calling it internally
      // We'll just inline the logic for a single scene
      const narrationTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'narration' LIMIT 1", [bookId]) as any;
      const narrationClips = narrationTrack
        ? queryAll(db, `SELECT c.*, a.duration_ms as asset_duration_ms FROM clips c LEFT JOIN audio_assets a ON c.audio_asset_id = a.id WHERE c.track_id = ? ORDER BY c.position_ms`, [narrationTrack.id])
        : [];

      function getSegPos(segIndex: number): number {
        if (segIndex < narrationClips.length) return (narrationClips[segIndex] as any).position_ms;
        if (narrationClips.length > 0) {
          const last = narrationClips[narrationClips.length - 1] as any;
          return last.position_ms + (last.asset_duration_ms || 3000) + 300;
        }
        return segIndex * 5000;
      }

      const sceneStartMs = getSegPos(scene.segment_start);
      const sceneEndMs = getSegPos(scene.segment_end);
      const sceneDurationMs = Math.max(sceneEndMs - sceneStartMs, 5000);

      // Clean old clips for this scene on boost tracks
      const boostTracks = queryAll(db, "SELECT id, name FROM tracks WHERE book_id = ? AND (name LIKE '%Boost%' OR name LIKE '%Ambience%')", [bookId]);
      for (const t of boostTracks as any[]) {
        if (layer === 'music' && !t.name.includes('Music')) continue;
        if (layer === 'ambience' && !t.name.includes('Ambience')) continue;
        if (layer === 'sfx' && !t.name.includes('SFX')) continue;
        run(db, "DELETE FROM clips WHERE track_id = ? AND notes LIKE ?", [t.id, `%${scene.title.slice(0, 40)}%`]);
      }

      const results = { music_generated: 0, ambience_generated: 0, sfx_generated: 0, clips_created: 0, errors: [] as string[] };

      // Ensure tracks exist
      const ensureTrack = (type: string, name: string, color: string, gain: number) => {
        let track = queryOne(db, `SELECT * FROM tracks WHERE book_id = ? AND name = ? LIMIT 1`, [bookId, name]) as any;
        if (!track) {
          const id = uuid();
          const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as m FROM tracks WHERE book_id = ?', [bookId]) as any;
          run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color, gain) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, bookId, name, type, (maxOrder?.m ?? 0) + 1, color, gain]);
          track = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [id]);
        }
        return track;
      };

      // Music
      if (layer !== 'ambience' && layer !== 'sfx' && scene.music_prompt) {
        const musicTrack = ensureTrack('music', '🎵 Boost Music', '#8B5CF6', -10.0);
        try {
          const durationSec = scene.music_duration_hint || Math.ceil(sceneDurationMs / 1000);
          const lengthMs = Math.min(durationSec * 1000, 300000);
          // Force new generation by appending timestamp to bust cache
          const promptForGen = scene.music_prompt;
          const { buffer } = await generateMusic(promptForGen, lengthMs, true);
          const assetId = uuid();
          const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
          fs.writeFileSync(filePath, buffer);
          const estDuration = Math.round((buffer.length / 24000) * 1000);
          const promptHash = computePromptHash({ prompt: promptForGen, music_length_ms: lengthMs, type: 'boost_music', ts: Date.now() });
          run(db,
            `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name)
             VALUES (?, ?, 'music', ?, ?, ?, ?, ?, ?)`,
            [assetId, bookId, filePath, estDuration, promptHash,
             JSON.stringify({ prompt: promptForGen, music_length_ms: lengthMs, source: 'background_boost_regen' }),
             buffer.length, `🎵 ${scene.title}`]);
          const clipId = uuid();
          run(db,
            `INSERT INTO clips (id, track_id, audio_asset_id, position_ms, gain, fade_in_ms, fade_out_ms, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [clipId, musicTrack.id, assetId, sceneStartMs,
             volumeToDb(scene.music_volume ?? 0.2),
             scene.music_fade_in_ms ?? 2000, scene.music_fade_out_ms ?? 3000,
             `Boost: ${scene.title}`]);
          results.music_generated++;
          results.clips_created++;
        } catch (err: any) {
          results.errors.push(`Music: ${err.message}`);
        }
      }

      // Ambience
      if (layer !== 'music' && layer !== 'sfx') {
        const ambienceTrack = ensureTrack('sfx', '🌿 Boost Ambience', '#10B981', -8.0);
        const ambienceList = JSON.parse(scene.ambience_json || '[]');
        for (const amb of ambienceList) {
          try {
            const durSec = amb.duration_hint_seconds || Math.ceil(sceneDurationMs / 1000);
            const { buffer } = await generateSFX({ text: amb.prompt, duration_seconds: Math.min(durSec, 22), loop: amb.loop });
            const assetId = uuid();
            const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
            fs.writeFileSync(filePath, buffer);
            const estDuration = Math.round((buffer.length / 16000) * 1000);
            const promptHash = computePromptHash({ prompt: amb.prompt, duration_seconds: durSec, type: 'boost_ambience', ts: Date.now() });
            run(db,
              `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name)
               VALUES (?, ?, 'sfx', ?, ?, ?, ?, ?, ?)`,
              [assetId, bookId, filePath, estDuration, promptHash,
               JSON.stringify({ prompt: amb.prompt, duration_seconds: durSec, source: 'background_boost_regen' }),
               buffer.length, `🌿 ${amb.prompt.slice(0, 60)}`]);
            const clipId = uuid();
            run(db,
              `INSERT INTO clips (id, track_id, audio_asset_id, position_ms, gain, fade_in_ms, fade_out_ms, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [clipId, ambienceTrack.id, assetId, sceneStartMs,
               volumeToDb(amb.volume ?? 0.25),
               amb.fade_in_ms ?? 1000, amb.fade_out_ms ?? 1500,
               `Ambience: ${amb.prompt.slice(0, 50)}`]);
            results.ambience_generated++;
            results.clips_created++;
          } catch (err: any) {
            results.errors.push(`Ambience: ${err.message}`);
          }
        }
      }

      // SFX
      if (layer !== 'music' && layer !== 'ambience') {
        const sfxTrack = ensureTrack('sfx', '🔊 Boost SFX', '#F59E0B', -6.0);
        const sfxList = JSON.parse(scene.sfx_json || '[]');
        for (const sfx of sfxList) {
          try {
            const durSec = sfx.duration_hint_seconds || 3;
            const { buffer } = await generateSFX({ text: sfx.prompt, duration_seconds: Math.min(durSec, 22) });
            const assetId = uuid();
            const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
            fs.writeFileSync(filePath, buffer);
            const estDuration = Math.round((buffer.length / 16000) * 1000);
            const promptHash = computePromptHash({ prompt: sfx.prompt, duration_seconds: durSec, type: 'boost_sfx', ts: Date.now() });
            run(db,
              `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name)
               VALUES (?, ?, 'sfx', ?, ?, ?, ?, ?, ?)`,
              [assetId, bookId, filePath, estDuration, promptHash,
               JSON.stringify({ prompt: sfx.prompt, duration_seconds: durSec, source: 'background_boost_regen' }),
               buffer.length, `🔊 ${sfx.prompt.slice(0, 60)}`]);
            let sfxPositionMs = sceneStartMs;
            if (sfx.at_segment !== undefined) sfxPositionMs = getSegPos(sfx.at_segment);
            const clipId = uuid();
            run(db,
              `INSERT INTO clips (id, track_id, audio_asset_id, position_ms, gain, notes)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [clipId, sfxTrack.id, assetId, sfxPositionMs,
               volumeToDb(sfx.volume ?? 0.6),
               `SFX: ${sfx.prompt.slice(0, 50)}`]);
            results.sfx_generated++;
            results.clips_created++;
          } catch (err: any) {
            results.errors.push(`SFX: ${err.message}`);
          }
        }
      }

      run(db, `UPDATE background_boost_scenes SET status = ? WHERE id = ?`,
        [results.errors.length > 0 ? 'partial' : 'generated', sceneId]);

      const updatedScene = queryOne(db, 'SELECT * FROM background_boost_scenes WHERE id = ?', [sceneId]) as any;
      res.json({
        ...results,
        scene: {
          ...updatedScene,
          ambience: JSON.parse(updatedScene?.ambience_json || '[]'),
          sfx: JSON.parse(updatedScene?.sfx_json || '[]'),
          music_loop: !!updatedScene?.music_loop,
        },
      });
    } catch (err: any) {
      console.error('[Background Boost Regenerate Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/books/:bookId/background-boost/clear
  // Remove all boost-generated clips and tracks
  router.post('/clear', (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      // Delete clips on boost tracks
      const boostTracks = queryAll(db, "SELECT id FROM tracks WHERE book_id = ? AND name LIKE '%Boost%'", [bookId]);
      for (const t of boostTracks) {
        run(db, 'DELETE FROM clips WHERE track_id = ?', [(t as any).id]);
      }
      // Optionally delete the tracks too
      if (req.body.delete_tracks) {
        run(db, "DELETE FROM tracks WHERE book_id = ? AND name LIKE '%Boost%'", [bookId]);
      }
      // Clear scene analysis
      run(db, 'DELETE FROM background_boost_scenes WHERE book_id = ?', [bookId]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// Convert 0.0-1.0 volume to dB (for clip gain)
function volumeToDb(volume: number): number {
  if (volume <= 0) return -60;
  return Math.round(20 * Math.log10(volume) * 10) / 10;
}
