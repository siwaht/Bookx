/**
 * MCP Server for Audiobook/Podcast generation.
 * Exposes tools for AI agents to create books, add chapters,
 * assign voices, generate TTS, and produce final audio.
 *
 * Usage: npx tsx server/src/mcp-server.ts
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { getDb, initializeSchema, saveDb } from './db/schema.js';
import { queryAll, queryOne, run } from './db/helpers.js';
import { getSetting } from './routes/settings.js';
import {
  generateTTS,
  getVoices,
  getCapabilities,
  getUsage,
  computePromptHash,
  generateSFX,
  generateMusic,
} from './elevenlabs/client.js';

const DATA_DIR = process.env.DATA_DIR || './data';

function log(msg: string) {
  process.stderr.write(`[MCP] ${msg}\n`);
}

function ensureDirs() {
  for (const sub of ['audio', 'renders', 'exports', 'uploads']) {
    fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  }
}

function sanitize(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function txt(data: any) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
}

// ── Server Setup ──

const server = new McpServer({
  name: 'audiobook-maker',
  version: '2.0.0',
});

let dbReady: Promise<any>;

function initDb() {
  dbReady = (async () => {
    ensureDirs();
    const db = await getDb();
    initializeSchema(db);
    const storedKey = getSetting(db, 'elevenlabs_api_key');
    if (storedKey) process.env.ELEVENLABS_API_KEY = storedKey;
    log('Database initialized');
    return db;
  })();
}

// ═══════════════════════════════════════════════════════
// PROJECT MANAGEMENT
// ═══════════════════════════════════════════════════════

server.tool('list_books', 'List all audiobook/podcast projects', {},
  async () => {
    const db = await dbReady;
    return txt(queryAll(db, 'SELECT id, title, author, narrator, project_type, format, created_at FROM books ORDER BY created_at DESC'));
  }
);

server.tool('create_book', 'Create a new audiobook or podcast project', {
  title: z.string(), author: z.string().optional(), narrator: z.string().optional(),
  project_type: z.enum(['audiobook', 'podcast']).default('podcast'),
  format: z.enum(['single_narrator', 'multi_narrator', 'full_cast']).default('multi_narrator'),
}, async ({ title, author, narrator, project_type, format }) => {
  const db = await dbReady;
  const id = uuid();
  run(db, `INSERT INTO books (id, title, author, narrator, project_type, format) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, title, author || null, narrator || null, project_type, format]);
  return txt({ id, title, project_type, format });
});

server.tool('get_project_status', 'Get detailed status of a book/podcast project including chapters, characters, and segment counts', {
  book_id: z.string(),
}, async ({ book_id }) => {
  const db = await dbReady;
  const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [book_id]);
  if (!book) return err('Book not found');
  const chapters = queryAll(db, 'SELECT id, title, sort_order FROM chapters WHERE book_id = ? ORDER BY sort_order', [book_id]);
  const characters = queryAll(db, 'SELECT id, name, role, voice_id, voice_name, model_id FROM characters WHERE book_id = ?', [book_id]);
  const chapterDetails = chapters.map((ch: any) => {
    const total = queryOne(db, 'SELECT COUNT(*) as c FROM segments WHERE chapter_id = ?', [ch.id]);
    const audio = queryOne(db, 'SELECT COUNT(*) as c FROM segments WHERE chapter_id = ? AND audio_asset_id IS NOT NULL', [ch.id]);
    return { ...ch, total_segments: total.c, audio_generated: audio.c };
  });
  return txt({ book, chapters: chapterDetails, characters });
});

server.tool('delete_book', 'Delete a book/podcast project and all its data', {
  book_id: z.string(),
}, async ({ book_id }) => {
  const db = await dbReady;
  const book = queryOne(db, 'SELECT id, title FROM books WHERE id = ?', [book_id]);
  if (!book) return err('Book not found');
  // Delete audio files from disk
  const assets = queryAll(db, 'SELECT file_path FROM audio_assets WHERE book_id = ?', [book_id]);
  for (const a of assets) { try { if (a.file_path && fs.existsSync(a.file_path)) fs.unlinkSync(a.file_path); } catch {} }
  // Cascade deletes via foreign keys
  run(db, 'DELETE FROM books WHERE id = ?', [book_id]);
  return txt({ deleted: book.title });
});

// ═══════════════════════════════════════════════════════
// CHAPTERS
// ═══════════════════════════════════════════════════════

server.tool('add_chapter', 'Add a chapter/episode to a project', {
  book_id: z.string(), title: z.string(), text: z.string().describe('Full text content'),
  sort_order: z.number().optional().describe('Sort position (auto-increments if omitted)'),
}, async ({ book_id, title, text, sort_order }) => {
  const db = await dbReady;
  if (!queryOne(db, 'SELECT id FROM books WHERE id = ?', [book_id])) return err('Book not found');
  const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as m FROM chapters WHERE book_id = ?', [book_id]);
  const order = sort_order ?? ((maxOrder?.m ?? -1) + 1);
  const id = uuid();
  run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text) VALUES (?, ?, ?, ?, ?)`, [id, book_id, title, order, text]);
  return txt({ id, title, sort_order: order });
});

server.tool('list_chapters', 'List all chapters in a book with segment counts', {
  book_id: z.string(),
}, async ({ book_id }) => {
  const db = await dbReady;
  const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [book_id]);
  return txt(chapters.map((ch: any) => {
    const segs = queryOne(db, 'SELECT COUNT(*) as c FROM segments WHERE chapter_id = ?', [ch.id]);
    return { id: ch.id, title: ch.title, sort_order: ch.sort_order, text_length: ch.raw_text?.length || 0, segments: segs.c };
  }));
});

server.tool('delete_chapter', 'Delete a chapter and its segments', {
  chapter_id: z.string(),
}, async ({ chapter_id }) => {
  const db = await dbReady;
  const ch = queryOne(db, 'SELECT id, title FROM chapters WHERE id = ?', [chapter_id]);
  if (!ch) return err('Chapter not found');
  run(db, 'DELETE FROM segments WHERE chapter_id = ?', [chapter_id]);
  run(db, 'DELETE FROM chapters WHERE id = ?', [chapter_id]);
  return txt({ deleted: ch.title });
});

server.tool('reorder_chapters', 'Reorder chapters by providing an array of chapter IDs in desired order', {
  book_id: z.string(), chapter_ids: z.array(z.string()),
}, async ({ book_id, chapter_ids }) => {
  const db = await dbReady;
  for (let i = 0; i < chapter_ids.length; i++) {
    run(db, `UPDATE chapters SET sort_order = ? WHERE id = ? AND book_id = ?`, [i, chapter_ids[i], book_id]);
  }
  return txt({ reordered: chapter_ids.length });
});

// ═══════════════════════════════════════════════════════
// CHARACTERS
// ═══════════════════════════════════════════════════════

server.tool('add_character', 'Add a character/voice to a project with an ElevenLabs voice ID', {
  book_id: z.string(), name: z.string().describe('Character name (e.g. "Alex", "Narrator")'),
  voice_id: z.string().describe('ElevenLabs voice ID'),
  role: z.enum(['narrator', 'character']).default('character'),
  model_id: z.string().default('eleven_v3'),
  stability: z.number().min(0).max(1).default(0.5),
  similarity_boost: z.number().min(0).max(1).default(0.78),
  style: z.number().min(0).max(1).default(0.15),
  speed: z.number().min(0.5).max(2.0).default(1.0).describe('Speech rate (0.5-2.0)'),
}, async ({ book_id, name, voice_id, role, model_id, stability, similarity_boost, style, speed }) => {
  const db = await dbReady;
  const id = uuid();
  run(db, `INSERT INTO characters (id, book_id, name, role, voice_id, model_id, stability, similarity_boost, style, speed, speaker_boost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [id, book_id, name, role, voice_id, model_id, stability, similarity_boost, style, speed]);
  return txt({ id, name, voice_id });
});

server.tool('update_character', 'Update a character\'s voice settings', {
  character_id: z.string(),
  voice_id: z.string().optional(), model_id: z.string().optional(),
  stability: z.number().min(0).max(1).optional(), similarity_boost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(), speed: z.number().min(0.5).max(2.0).optional(),
}, async (args) => {
  const db = await dbReady;
  const fields = ['voice_id', 'model_id', 'stability', 'similarity_boost', 'style', 'speed'] as const;
  const updates: string[] = []; const values: any[] = [];
  for (const f of fields) { if (args[f] !== undefined) { updates.push(`${f} = ?`); values.push(args[f]); } }
  if (updates.length === 0) return err('No fields to update');
  values.push(args.character_id);
  run(db, `UPDATE characters SET ${updates.join(', ')} WHERE id = ?`, values);
  return txt(queryOne(db, 'SELECT * FROM characters WHERE id = ?', [args.character_id]));
});

server.tool('list_characters', 'List all characters in a book', {
  book_id: z.string(),
}, async ({ book_id }) => {
  const db = await dbReady;
  return txt(queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [book_id]));
});

// ═══════════════════════════════════════════════════════
// SEGMENTS
// ═══════════════════════════════════════════════════════

server.tool('add_segments', 'Add dialogue/narration segments to a chapter', {
  chapter_id: z.string(),
  segments: z.array(z.object({
    character_name: z.string().describe('Character name (must match existing character)'),
    text: z.string().describe('The text this character speaks. Supports ElevenLabs v3 tags like [whisper], [laugh], [dramatic pause], [slow], [excited] etc.'),
  })),
}, async ({ chapter_id, segments: segs }) => {
  const db = await dbReady;
  const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [chapter_id]);
  if (!chapter) return err('Chapter not found');
  const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [chapter.book_id]);
  const charMap = new Map(characters.map((c: any) => [c.name.toLowerCase(), c]));
  const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as m FROM segments WHERE chapter_id = ?', [chapter_id]);
  let order = (maxOrder?.m ?? -1) + 1;
  const created: any[] = [];
  for (const seg of segs) {
    const char = charMap.get(seg.character_name.toLowerCase());
    if (!char) return err(`Character "${seg.character_name}" not found. Available: ${characters.map((c: any) => c.name).join(', ')}`);
    const id = uuid();
    run(db, `INSERT INTO segments (id, chapter_id, character_id, sort_order, text) VALUES (?, ?, ?, ?, ?)`, [id, chapter_id, char.id, order++, seg.text]);
    created.push({ id, character: seg.character_name, text: seg.text.substring(0, 60) });
  }
  return txt({ created: created.length, segments: created });
});

server.tool('list_segments', 'List all segments in a chapter with character names and audio status', {
  chapter_id: z.string(),
}, async ({ chapter_id }) => {
  const db = await dbReady;
  const segs = queryAll(db,
    `SELECT s.*, c.name as character_name, a.file_path, a.duration_ms
     FROM segments s LEFT JOIN characters c ON s.character_id = c.id
     LEFT JOIN audio_assets a ON s.audio_asset_id = a.id
     WHERE s.chapter_id = ? ORDER BY s.sort_order`, [chapter_id]);
  return txt(segs.map((s: any) => ({
    id: s.id, sort_order: s.sort_order, character: s.character_name,
    text: s.text, has_audio: !!s.audio_asset_id, duration_ms: s.duration_ms,
  })));
});

server.tool('update_segment', 'Update a segment\'s text or character assignment', {
  segment_id: z.string(), text: z.string().optional(),
  character_name: z.string().optional().describe('New character name to assign'),
}, async ({ segment_id, text, character_name }) => {
  const db = await dbReady;
  const seg = queryOne(db, 'SELECT * FROM segments WHERE id = ?', [segment_id]);
  if (!seg) return err('Segment not found');
  if (text !== undefined) run(db, `UPDATE segments SET text = ?, audio_asset_id = NULL, updated_at = datetime('now') WHERE id = ?`, [text, segment_id]);
  if (character_name) {
    const chapter = queryOne(db, 'SELECT book_id FROM chapters WHERE id = ?', [seg.chapter_id]);
    const char = queryOne(db, 'SELECT id FROM characters WHERE book_id = ? AND LOWER(name) = LOWER(?)', [chapter.book_id, character_name]);
    if (!char) return err(`Character "${character_name}" not found`);
    run(db, `UPDATE segments SET character_id = ?, updated_at = datetime('now') WHERE id = ?`, [char.id, segment_id]);
  }
  return txt(queryOne(db, 'SELECT * FROM segments WHERE id = ?', [segment_id]));
});

server.tool('delete_segments', 'Delete all segments in a chapter', {
  chapter_id: z.string(),
}, async ({ chapter_id }) => {
  const db = await dbReady;
  const count = queryOne(db, 'SELECT COUNT(*) as c FROM segments WHERE chapter_id = ?', [chapter_id]);
  run(db, 'DELETE FROM segments WHERE chapter_id = ?', [chapter_id]);
  return txt({ deleted: count.c });
});

// ═══════════════════════════════════════════════════════
// TTS GENERATION
// ═══════════════════════════════════════════════════════

server.tool('generate_chapter_audio', 'Generate TTS audio for all segments in a chapter using ElevenLabs', {
  chapter_id: z.string(),
}, async ({ chapter_id }) => {
  const db = await dbReady;
  const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [chapter_id]);
  if (!chapter) return err('Chapter not found');
  const segments = queryAll(db, 'SELECT * FROM segments WHERE chapter_id = ? ORDER BY sort_order', [chapter_id]);
  if (segments.length === 0) return err('No segments in chapter');

  // Apply pronunciation rules to segment text before generation
  const pronRules = queryAll(db, 'SELECT * FROM pronunciation_rules WHERE book_id = ? ORDER BY length(word) DESC', [chapter.book_id]);

  const results: any[] = [];
  let generated = 0, cached = 0, failed = 0;

  for (const seg of segments) {
    try {
      const char = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [seg.character_id]);
      if (!char?.voice_id) { results.push({ segment_id: seg.id, error: 'No voice assigned' }); failed++; continue; }

      // Apply pronunciation rules
      let processedText = seg.text;
      for (const rule of pronRules as any[]) {
        if (rule.character_id && rule.character_id !== seg.character_id) continue;
        const escaped = rule.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        if (rule.alias) processedText = processedText.replace(regex, rule.alias);
        else if (rule.phoneme) processedText = processedText.replace(regex, `<phoneme alphabet="ipa" ph="${rule.phoneme}">${rule.word}</phoneme>`);
      }

      const voiceSettings = { stability: char.stability, similarity_boost: char.similarity_boost, style: char.style, use_speaker_boost: !!char.speaker_boost };
      const hashParams = { text: processedText, voice_id: char.voice_id, model_id: char.model_id, voice_settings: voiceSettings };
      const promptHash = computePromptHash(hashParams);

      const cachedAsset = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ?', [promptHash]);
      if (cachedAsset && fs.existsSync(cachedAsset.file_path)) {
        run(db, `UPDATE segments SET audio_asset_id = ?, updated_at = datetime('now') WHERE id = ?`, [cachedAsset.id, seg.id]);
        results.push({ segment_id: seg.id, cached: true, asset_id: cachedAsset.id });
        cached++; continue;
      }

      const { buffer, requestId } = await generateTTS({
        voice_id: char.voice_id, text: processedText, model_id: char.model_id,
        voice_settings: voiceSettings, output_format: 'mp3_44100_192',
      });

      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
      fs.writeFileSync(filePath, buffer);
      const estimatedDurationMs = Math.round((buffer.length / 24000) * 1000);

      run(db, `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, elevenlabs_request_id, generation_params, file_size_bytes) VALUES (?, ?, 'tts', ?, ?, ?, ?, ?, ?)`,
        [assetId, chapter.book_id, filePath, estimatedDurationMs, promptHash, requestId, JSON.stringify(hashParams), buffer.length]);
      run(db, `UPDATE segments SET audio_asset_id = ?, previous_request_id = ?, updated_at = datetime('now') WHERE id = ?`, [assetId, requestId, seg.id]);

      results.push({ segment_id: seg.id, asset_id: assetId, size_kb: Math.round(buffer.length / 1024), duration_ms: estimatedDurationMs });
      generated++;
      log(`Generated segment ${seg.id}: ${(buffer.length / 1024).toFixed(1)} KB`);
    } catch (e: any) { results.push({ segment_id: seg.id, error: e.message }); failed++; }
  }
  return txt({ total: segments.length, generated, cached, failed, results });
});

server.tool('generate_single_segment', 'Generate TTS audio for a single segment', {
  segment_id: z.string(),
}, async ({ segment_id }) => {
  const db = await dbReady;
  const seg = queryOne(db, 'SELECT * FROM segments WHERE id = ?', [segment_id]);
  if (!seg) return err('Segment not found');
  const char = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [seg.character_id]);
  if (!char?.voice_id) return err('No voice assigned to character');
  const chapter = queryOne(db, 'SELECT book_id FROM chapters WHERE id = ?', [seg.chapter_id]);

  const voiceSettings = { stability: char.stability, similarity_boost: char.similarity_boost, style: char.style, use_speaker_boost: !!char.speaker_boost };
  const { buffer, requestId } = await generateTTS({
    voice_id: char.voice_id, text: seg.text, model_id: char.model_id,
    voice_settings: voiceSettings, output_format: 'mp3_44100_192',
  });

  const assetId = uuid();
  const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
  fs.writeFileSync(filePath, buffer);
  const estimatedDurationMs = Math.round((buffer.length / 24000) * 1000);
  const promptHash = computePromptHash({ text: seg.text, voice_id: char.voice_id, model_id: char.model_id, voice_settings: voiceSettings });

  run(db, `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, elevenlabs_request_id, file_size_bytes) VALUES (?, ?, 'tts', ?, ?, ?, ?, ?)`,
    [assetId, chapter.book_id, filePath, estimatedDurationMs, promptHash, requestId, buffer.length]);
  run(db, `UPDATE segments SET audio_asset_id = ?, previous_request_id = ?, updated_at = datetime('now') WHERE id = ?`, [assetId, requestId, segment_id]);

  return txt({ asset_id: assetId, size_kb: Math.round(buffer.length / 1024), duration_ms: estimatedDurationMs });
});

// ═══════════════════════════════════════════════════════
// EXPORT / CONCATENATION
// ═══════════════════════════════════════════════════════

server.tool('export_chapter_audio', 'Concatenate all segment audio in a chapter into a single MP3 file', {
  chapter_id: z.string(),
  output_filename: z.string().optional(),
  gap_between_segments_ms: z.number().default(0).describe('Silence gap between segments in milliseconds (0 = no gap, just concatenate)'),
}, async ({ chapter_id, output_filename, gap_between_segments_ms }) => {
  const db = await dbReady;
  const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ?', [chapter_id]);
  if (!chapter) return err('Chapter not found');
  const segments = queryAll(db,
    `SELECT s.*, a.file_path FROM segments s JOIN audio_assets a ON s.audio_asset_id = a.id WHERE s.chapter_id = ? ORDER BY s.sort_order`, [chapter_id]);
  if (segments.length === 0) return err('No generated audio. Run generate_chapter_audio first.');

  const buffers: Buffer[] = [];
  // Create a small silence buffer for gaps (MP3 frame of silence)
  const silenceFrame = gap_between_segments_ms > 0 ? createSilenceBuffer(gap_between_segments_ms) : null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.file_path && fs.existsSync(seg.file_path)) {
      buffers.push(fs.readFileSync(seg.file_path));
      if (silenceFrame && i < segments.length - 1) buffers.push(silenceFrame);
    }
  }

  const filename = output_filename || `${sanitize(chapter.title)}.mp3`;
  const outputPath = path.join(DATA_DIR, 'exports', filename);
  const final = Buffer.concat(buffers);
  fs.writeFileSync(outputPath, final);
  return txt({ output_path: outputPath, segments_count: segments.length, size_mb: (final.length / 1024 / 1024).toFixed(2) });
});

server.tool('export_book_audio', 'Export all chapters of a book as a single MP3 file', {
  book_id: z.string(), output_filename: z.string().optional(),
  gap_between_segments_ms: z.number().default(300).describe('Silence between segments (ms)'),
  gap_between_chapters_ms: z.number().default(2000).describe('Silence between chapters (ms)'),
}, async ({ book_id, output_filename, gap_between_segments_ms, gap_between_chapters_ms }) => {
  const db = await dbReady;
  const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [book_id]);
  if (!book) return err('Book not found');
  const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [book_id]);
  if (chapters.length === 0) return err('No chapters');

  const buffers: Buffer[] = [];
  const segSilence = gap_between_segments_ms > 0 ? createSilenceBuffer(gap_between_segments_ms) : null;
  const chSilence = gap_between_chapters_ms > 0 ? createSilenceBuffer(gap_between_chapters_ms) : null;
  let totalSegs = 0;

  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    const segs = queryAll(db,
      `SELECT s.*, a.file_path FROM segments s JOIN audio_assets a ON s.audio_asset_id = a.id WHERE s.chapter_id = ? ORDER BY s.sort_order`, [ch.id]);
    for (let si = 0; si < segs.length; si++) {
      if (segs[si].file_path && fs.existsSync(segs[si].file_path)) {
        buffers.push(fs.readFileSync(segs[si].file_path));
        totalSegs++;
        if (segSilence && si < segs.length - 1) buffers.push(segSilence);
      }
    }
    if (chSilence && ci < chapters.length - 1) buffers.push(chSilence);
  }

  if (totalSegs === 0) return err('No generated audio found. Generate chapter audio first.');
  const filename = output_filename || `${sanitize(book.title)}.mp3`;
  const outputPath = path.join(DATA_DIR, 'exports', filename);
  const final = Buffer.concat(buffers);
  fs.writeFileSync(outputPath, final);
  return txt({ output_path: outputPath, chapters: chapters.length, segments: totalSegs, size_mb: (final.length / 1024 / 1024).toFixed(2) });
});

/** Create a minimal MP3 silence buffer for the given duration */
function createSilenceBuffer(durationMs: number): Buffer {
  // MP3 frame at 192kbps, 44100Hz = ~26ms per frame, 626 bytes per frame
  const framesNeeded = Math.max(1, Math.ceil(durationMs / 26));
  const bytesPerFrame = 626;
  // Create silent MP3 frames (all zeros in audio data with valid MP3 header)
  const frame = Buffer.alloc(bytesPerFrame, 0);
  // MP3 sync word + MPEG1 Layer3 192kbps 44100Hz stereo
  frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = 0xB0; frame[3] = 0x00;
  const frames: Buffer[] = [];
  for (let i = 0; i < framesNeeded; i++) frames.push(Buffer.from(frame));
  return Buffer.concat(frames);
}

// ═══════════════════════════════════════════════════════
// QUICK PODCAST (one-shot, no DB)
// ═══════════════════════════════════════════════════════

server.tool('quick_podcast', 'One-shot podcast generation: provide transcript with speaker labels and voice IDs, get a single MP3. No project setup needed.', {
  title: z.string(),
  voices: z.record(z.string(), z.string()).describe('Map of speaker name to ElevenLabs voice ID'),
  segments: z.array(z.object({ speaker: z.string(), text: z.string() })),
  model_id: z.string().default('eleven_v3'),
  stability: z.number().default(0.5), similarity_boost: z.number().default(0.78), style: z.number().default(0.15),
  output_filename: z.string().optional(),
}, async ({ title, voices, segments: segs, model_id, stability, similarity_boost, style, output_filename }) => {
  const audioChunks: Buffer[] = [];
  const results: any[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const voiceId = voices[seg.speaker];
    if (!voiceId) return err(`No voice ID for speaker "${seg.speaker}". Available: ${Object.keys(voices).join(', ')}`);
    try {
      log(`[${i + 1}/${segs.length}] Generating: "${seg.text.substring(0, 50)}..."`);
      const { buffer } = await generateTTS({
        voice_id: voiceId, text: seg.text, model_id,
        voice_settings: { stability, similarity_boost, style, use_speaker_boost: true },
        output_format: 'mp3_44100_192',
      });
      audioChunks.push(buffer);
      results.push({ index: i, speaker: seg.speaker, size_kb: Math.round(buffer.length / 1024) });
      if (i < segs.length - 1) await new Promise(r => setTimeout(r, 300));
    } catch (e: any) { return err(`Segment ${i + 1} (${seg.speaker}): ${e.message}`); }
  }
  const final = Buffer.concat(audioChunks);
  const filename = output_filename || `${sanitize(title)}.mp3`;
  const outputPath = path.join(DATA_DIR, 'exports', filename);
  fs.writeFileSync(outputPath, final);
  return txt({ output_path: outputPath, total_segments: segs.length, size_mb: (final.length / 1024 / 1024).toFixed(2), results });
});

// ═══════════════════════════════════════════════════════
// PRONUNCIATION RULES
// ═══════════════════════════════════════════════════════

server.tool('add_pronunciation_rule', 'Add a pronunciation rule for a word (phoneme IPA or alias replacement). Applied during TTS generation.', {
  book_id: z.string(), word: z.string().describe('The word to customize pronunciation for'),
  phoneme: z.string().optional().describe('IPA phoneme string (e.g. "ˈkɪroʊ")'),
  alias: z.string().optional().describe('Simple text replacement (e.g. "Kiro" -> "Keero")'),
  character_id: z.string().optional().describe('Apply only to a specific character (omit for global)'),
}, async ({ book_id, word, phoneme, alias, character_id }) => {
  const db = await dbReady;
  if (!phoneme && !alias) return err('Either phoneme or alias is required');
  const id = uuid();
  run(db, 'INSERT INTO pronunciation_rules (id, book_id, character_id, word, phoneme, alias) VALUES (?, ?, ?, ?, ?, ?)',
    [id, book_id, character_id || null, word, phoneme || null, alias || null]);
  return txt({ id, word, phoneme, alias });
});

server.tool('list_pronunciation_rules', 'List all pronunciation rules for a book', {
  book_id: z.string(),
}, async ({ book_id }) => {
  const db = await dbReady;
  return txt(queryAll(db,
    'SELECT p.*, c.name as character_name FROM pronunciation_rules p LEFT JOIN characters c ON p.character_id = c.id WHERE p.book_id = ? ORDER BY p.word',
    [book_id]));
});

server.tool('delete_pronunciation_rule', 'Delete a pronunciation rule', {
  rule_id: z.string(),
}, async ({ rule_id }) => {
  const db = await dbReady;
  run(db, 'DELETE FROM pronunciation_rules WHERE id = ?', [rule_id]);
  return txt({ deleted: rule_id });
});

// ═══════════════════════════════════════════════════════
// TIMELINE / COMPOSITION
// ═══════════════════════════════════════════════════════

server.tool('populate_timeline', 'Auto-populate timeline from generated segments. Creates tracks, clips, and chapter markers with configurable gaps.', {
  book_id: z.string(),
  chapter_ids: z.array(z.string()).optional().describe('Specific chapters (omit for all)'),
  gap_between_segments_ms: z.number().default(300).describe('Gap between segments in ms'),
  gap_between_chapters_ms: z.number().default(2000).describe('Gap between chapters in ms'),
}, async ({ book_id, chapter_ids, gap_between_segments_ms, gap_between_chapters_ms }) => {
  const db = await dbReady;
  let chapters;
  if (chapter_ids?.length) {
    const ph = chapter_ids.map(() => '?').join(',');
    chapters = queryAll(db, `SELECT * FROM chapters WHERE book_id = ? AND id IN (${ph}) ORDER BY sort_order`, [book_id, ...chapter_ids]);
  } else {
    chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [book_id]);
  }

  let narrationTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'narration' LIMIT 1", [book_id]);
  if (!narrationTrack) {
    const trackId = uuid();
    run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, 'Narration', 'narration', 0, '#4A90D9')`, [trackId, book_id]);
    narrationTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [trackId]);
  }

  let currentMs = 0; let clipsCreated = 0; let markersCreated = 0;
  run(db, 'DELETE FROM chapter_markers WHERE book_id = ?', [book_id]);

  for (const ch of chapters) {
    const markerId = uuid();
    run(db, 'INSERT INTO chapter_markers (id, book_id, chapter_id, position_ms, label) VALUES (?, ?, ?, ?, ?)',
      [markerId, book_id, ch.id, currentMs, ch.title]);
    markersCreated++;

    const segs = queryAll(db,
      `SELECT s.*, a.duration_ms FROM segments s JOIN audio_assets a ON s.audio_asset_id = a.id WHERE s.chapter_id = ? ORDER BY s.sort_order`, [ch.id]);
    for (const seg of segs) {
      const existing = queryOne(db, 'SELECT * FROM clips WHERE segment_id = ? AND track_id = ?', [seg.id, narrationTrack.id]);
      if (existing) { currentMs = existing.position_ms + (seg.duration_ms || 3000) + gap_between_segments_ms; continue; }
      const clipId = uuid();
      const dur = seg.duration_ms || 3000;
      run(db, `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms) VALUES (?, ?, ?, ?, ?)`,
        [clipId, narrationTrack.id, seg.audio_asset_id, seg.id, currentMs]);
      clipsCreated++;
      currentMs += dur + gap_between_segments_ms;
    }
    currentMs += gap_between_chapters_ms - gap_between_segments_ms;
  }
  return txt({ clips_created: clipsCreated, markers_created: markersCreated, total_duration_ms: currentMs });
});

server.tool('create_track', 'Create a new audio track on the timeline', {
  book_id: z.string(), name: z.string(),
  type: z.enum(['narration', 'dialogue', 'sfx', 'music', 'imported']),
  color: z.string().default('#4A90D9'),
}, async ({ book_id, name, type, color }) => {
  const db = await dbReady;
  const id = uuid();
  const maxOrder = queryOne(db, 'SELECT MAX(sort_order) as m FROM tracks WHERE book_id = ?', [book_id]);
  run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, book_id, name, type, (maxOrder?.m ?? -1) + 1, color]);
  return txt(queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [id]));
});

server.tool('list_tracks', 'List all tracks and their clips for a book', {
  book_id: z.string(),
}, async ({ book_id }) => {
  const db = await dbReady;
  const tracks = queryAll(db, 'SELECT * FROM tracks WHERE book_id = ? ORDER BY sort_order', [book_id]);
  return txt(tracks.map((t: any) => {
    const clips = queryAll(db, 'SELECT * FROM clips WHERE track_id = ? ORDER BY position_ms', [t.id]);
    return { ...t, clips };
  }));
});

server.tool('add_clip', 'Add an audio clip to a track at a specific position', {
  track_id: z.string(), audio_asset_id: z.string(), position_ms: z.number().default(0),
  segment_id: z.string().optional(),
  trim_start_ms: z.number().default(0), trim_end_ms: z.number().default(0),
  gain: z.number().default(0), speed: z.number().default(1.0),
  fade_in_ms: z.number().default(0), fade_out_ms: z.number().default(0),
}, async (args) => {
  const db = await dbReady;
  const id = uuid();
  run(db, `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms, trim_start_ms, trim_end_ms, gain, speed, fade_in_ms, fade_out_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, args.track_id, args.audio_asset_id, args.segment_id || null, args.position_ms, args.trim_start_ms, args.trim_end_ms, args.gain, args.speed, args.fade_in_ms, args.fade_out_ms]);
  return txt(queryOne(db, 'SELECT * FROM clips WHERE id = ?', [id]));
});

server.tool('update_track', 'Update track properties (gain, pan, mute, solo, etc.)', {
  track_id: z.string(), name: z.string().optional(),
  gain: z.number().optional(), pan: z.number().optional(),
  muted: z.boolean().optional(), solo: z.boolean().optional(), locked: z.boolean().optional(),
}, async (args) => {
  const db = await dbReady;
  const updates: string[] = []; const values: any[] = [];
  if (args.name !== undefined) { updates.push('name = ?'); values.push(args.name); }
  if (args.gain !== undefined) { updates.push('gain = ?'); values.push(args.gain); }
  if (args.pan !== undefined) { updates.push('pan = ?'); values.push(args.pan); }
  if (args.muted !== undefined) { updates.push('muted = ?'); values.push(args.muted ? 1 : 0); }
  if (args.solo !== undefined) { updates.push('solo = ?'); values.push(args.solo ? 1 : 0); }
  if (args.locked !== undefined) { updates.push('locked = ?'); values.push(args.locked ? 1 : 0); }
  if (updates.length === 0) return err('No fields to update');
  values.push(args.track_id);
  run(db, `UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`, values);
  return txt(queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [args.track_id]));
});

// ═══════════════════════════════════════════════════════
// ELEVENLABS: VOICES, SFX, MUSIC, USAGE
// ═══════════════════════════════════════════════════════

server.tool('list_voices', 'List available ElevenLabs voices from your account', {
  search: z.string().optional().describe('Filter by name/category/label'),
}, async ({ search }) => {
  const allVoices = await getVoices();
  let filtered = allVoices;
  if (search) {
    const q = search.toLowerCase();
    filtered = allVoices.filter((v: any) =>
      v.name.toLowerCase().includes(q) || v.category?.toLowerCase().includes(q) ||
      Object.values(v.labels || {}).some((l: any) => String(l).toLowerCase().includes(q)));
  }
  return txt(filtered.map((v: any) => ({ voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels })));
});

server.tool('get_capabilities', 'Get ElevenLabs account capabilities: available models, features, character limits', {},
  async () => txt(await getCapabilities())
);

server.tool('get_usage', 'Get ElevenLabs account usage: character count, limits, subscription tier', {},
  async () => txt(await getUsage())
);

server.tool('generate_sfx', 'Generate a sound effect using ElevenLabs', {
  prompt: z.string().describe('Description of the sound (e.g. "airplane cabin ding bell")'),
  duration_seconds: z.number().optional(),
  book_id: z.string().optional().describe('Associate with a book project'),
  output_filename: z.string().optional(),
}, async ({ prompt, duration_seconds, book_id, output_filename }) => {
  try {
    const db = await dbReady;
    const { buffer } = await generateSFX({ text: prompt, duration_seconds });
    const assetId = uuid();
    const filename = output_filename || `sfx_${sanitize(prompt).substring(0, 40)}.mp3`;
    const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
    fs.writeFileSync(filePath, buffer);
    const estimatedDurationMs = Math.round((buffer.length / 16000) * 1000);

    if (book_id) {
      const promptHash = computePromptHash({ prompt, duration_seconds, type: 'sfx' });
      run(db, `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name) VALUES (?, ?, 'sfx', ?, ?, ?, ?, ?, ?)`,
        [assetId, book_id, filePath, estimatedDurationMs, promptHash, JSON.stringify({ prompt, duration_seconds }), buffer.length, prompt.slice(0, 100)]);
    }
    return txt({ asset_id: assetId, output_path: filePath, size_kb: Math.round(buffer.length / 1024), duration_ms: estimatedDurationMs });
  } catch (e: any) { return err(e.message); }
});

server.tool('generate_music', 'Generate background music using ElevenLabs', {
  prompt: z.string().describe('Description of the music (e.g. "soft ambient piano, reflective mood")'),
  duration_seconds: z.number().optional().describe('Duration in seconds'),
  force_instrumental: z.boolean().default(true),
  book_id: z.string().optional().describe('Associate with a book project'),
  output_filename: z.string().optional(),
}, async ({ prompt, duration_seconds, force_instrumental, book_id, output_filename }) => {
  try {
    const db = await dbReady;
    const lengthMs = duration_seconds ? duration_seconds * 1000 : undefined;
    const { buffer } = await generateMusic(prompt, lengthMs, force_instrumental);
    const assetId = uuid();
    const filename = output_filename || `music_${sanitize(prompt).substring(0, 40)}.mp3`;
    const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
    fs.writeFileSync(filePath, buffer);
    const estimatedDurationMs = Math.round((buffer.length / 24000) * 1000);

    if (book_id) {
      const promptHash = computePromptHash({ prompt, music_length_ms: lengthMs, force_instrumental, type: 'music' });
      run(db, `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, generation_params, file_size_bytes, name) VALUES (?, ?, 'music', ?, ?, ?, ?, ?, ?)`,
        [assetId, book_id, filePath, estimatedDurationMs, promptHash, JSON.stringify({ prompt, duration_seconds, force_instrumental }), buffer.length, prompt.slice(0, 100)]);
    }
    return txt({ asset_id: assetId, output_path: filePath, size_kb: Math.round(buffer.length / 1024), duration_ms: estimatedDurationMs });
  } catch (e: any) { return err(e.message); }
});

// ═══════════════════════════════════════════════════════
// AUDIO LIBRARY
// ═══════════════════════════════════════════════════════

server.tool('list_audio_assets', 'List all audio assets for a book (TTS, SFX, music, imported)', {
  book_id: z.string(),
  type: z.enum(['tts', 'sfx', 'music', 'imported', 'all']).default('all'),
}, async ({ book_id, type }) => {
  const db = await dbReady;
  const sql = type === 'all'
    ? 'SELECT * FROM audio_assets WHERE book_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM audio_assets WHERE book_id = ? AND type = ? ORDER BY created_at DESC';
  const params = type === 'all' ? [book_id] : [book_id, type];
  return txt(queryAll(db, sql, params));
});

server.tool('delete_audio_asset', 'Delete an audio asset and its file from disk', {
  asset_id: z.string(),
}, async ({ asset_id }) => {
  const db = await dbReady;
  const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [asset_id]);
  if (!asset) return err('Audio asset not found');
  if (asset.file_path && fs.existsSync(asset.file_path)) try { fs.unlinkSync(asset.file_path); } catch {}
  run(db, 'DELETE FROM clips WHERE audio_asset_id = ?', [asset_id]);
  run(db, 'UPDATE segments SET audio_asset_id = NULL WHERE audio_asset_id = ?', [asset_id]);
  run(db, 'DELETE FROM audio_assets WHERE id = ?', [asset_id]);
  return txt({ deleted: asset_id });
});

// ═══════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════

server.tool('get_settings', 'Get current app settings (API keys are masked)', {},
  async () => {
    const db = await dbReady;
    const rows = queryAll(db, 'SELECT key, value, updated_at FROM settings');
    const settings: any = {};
    for (const row of rows as any[]) {
      const isSecret = row.key.endsWith('_api_key');
      settings[row.key] = { masked: isSecret && row.value ? '••••' + row.value.slice(-4) : row.value, updated_at: row.updated_at };
    }
    return txt(settings);
  }
);

server.tool('update_setting', 'Update an app setting (e.g. API keys, default LLM provider)', {
  key: z.enum(['elevenlabs_api_key', 'openai_api_key', 'mistral_api_key', 'gemini_api_key', 'default_llm_provider']),
  value: z.string(),
}, async ({ key, value }) => {
  const db = await dbReady;
  const existing = queryOne(db, 'SELECT key FROM settings WHERE key = ?', [key]);
  if (existing) run(db, "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [value, key]);
  else run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
  // Sync to env
  if (key === 'elevenlabs_api_key') process.env.ELEVENLABS_API_KEY = value;
  if (key === 'openai_api_key') process.env.OPENAI_API_KEY = value;
  if (key === 'mistral_api_key') process.env.MISTRAL_API_KEY = value;
  if (key === 'gemini_api_key') process.env.GEMINI_API_KEY = value;
  return txt({ updated: key });
});

// ═══════════════════════════════════════════════════════
// VOICE LIBRARY SEARCH (shared/community voices)
// ═══════════════════════════════════════════════════════

server.tool('search_voice_library', 'Search the ElevenLabs shared voice library (community voices) by name, gender, language, or use case', {
  query: z.string().optional().describe('Search query'),
  gender: z.string().optional().describe('Filter by gender (e.g. "male", "female")'),
  language: z.string().optional().describe('Filter by language (e.g. "en", "es")'),
  use_case: z.string().optional().describe('Filter by use case (e.g. "narration", "conversational")'),
  page_size: z.number().default(20).describe('Results per page (max 100)'),
}, async ({ query, gender, language, use_case, page_size }) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return err('ELEVENLABS_API_KEY not set');
  const params = new URLSearchParams();
  params.set('page_size', String(Math.min(page_size, 100)));
  if (query) params.set('search', query);
  if (gender) params.set('gender', gender);
  if (language) params.set('language', language);
  if (use_case) params.set('use_case', use_case);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`, {
      headers: { 'xi-api-key': apiKey },
    });
    if (!res.ok) return err(`ElevenLabs API ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    const voices = (data.voices || []).map((v: any) => ({
      voice_id: v.voice_id, name: v.name, category: v.category || 'shared',
      labels: v.labels || {}, preview_url: v.preview_url, description: v.description,
      use_case: v.use_case, language: v.language, public_owner_id: v.public_owner_id,
    }));
    return txt({ voices, has_more: data.has_more || false });
  } catch (e: any) { return err(e.message); }
});

server.tool('add_shared_voice', 'Add a shared/community voice to your ElevenLabs library so it can be used for TTS', {
  public_owner_id: z.string(), voice_id: z.string(), name: z.string().optional(),
}, async ({ public_owner_id, voice_id, name }) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return err('ELEVENLABS_API_KEY not set');
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/voices/add/${public_owner_id}/${voice_id}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: name || 'Shared Voice' }),
    });
    if (!res.ok) return err(`Failed: ${await res.text()}`);
    const data = await res.json() as any;
    return txt({ voice_id: data.voice_id, name: name || 'Shared Voice', added: true });
  } catch (e: any) { return err(e.message); }
});

// ═══════════════════════════════════════════════════════
// AI PARSE (auto-detect characters, assign segments)
// ═══════════════════════════════════════════════════════

server.tool('ai_parse_chapters', 'Use an LLM to auto-detect characters, assign dialogue segments, and suggest SFX/music cues from raw chapter text. Requires an LLM API key in settings.', {
  book_id: z.string(),
  chapter_ids: z.array(z.string()).optional().describe('Specific chapters to parse (omit for all)'),
}, async ({ book_id, chapter_ids }) => {
  const db = await dbReady;
  const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [book_id]);
  if (!book) return err('Book not found');

  let chapters;
  if (chapter_ids?.length) {
    const ph = chapter_ids.map(() => '?').join(',');
    chapters = queryAll(db, `SELECT * FROM chapters WHERE book_id = ? AND id IN (${ph}) ORDER BY sort_order`, [book_id, ...chapter_ids]);
  } else {
    chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [book_id]);
  }
  if (!chapters.length) return err('No chapters found. Add chapters first.');

  const provider = detectProvider(db);
  if (!provider) return err('No LLM API key configured. Use update_setting to add an openai_api_key, mistral_api_key, or gemini_api_key.');
  const apiKey = getSetting(db, `${provider}_api_key`) || process.env[`${provider.toUpperCase()}_API_KEY`];
  if (!apiKey) return err(`No API key for ${provider}`);

  const format = book.format || 'single_narrator';
  const projectType = book.project_type || 'audiobook';

  const chapterTexts = (chapters as any[]).map((ch: any) =>
    `--- ${ch.title} ---\n${(ch.cleaned_text || ch.raw_text).slice(0, 6000)}`
  ).join('\n\n');

  const systemPrompt = buildParseSystemPrompt(projectType, format);
  const userPrompt = `Here is the text to analyze:\n\n${chapterTexts.slice(0, 24000)}`;

  log(`AI parsing ${chapters.length} chapters with ${provider}...`);
  const result = await callLLM(provider, apiKey, systemPrompt, userPrompt);

  let parsed;
  try {
    const jsonMatch = result.match(/```json\s*([\s\S]*?)```/) || result.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : result);
  } catch { return err('LLM returned invalid JSON. Try again.'); }

  // Apply: create characters and segments
  let charactersCreated = 0, segmentsCreated = 0;
  const charMap = new Map<string, string>();

  if (parsed.characters?.length) {
    run(db, 'DELETE FROM characters WHERE book_id = ?', [book_id]);
    for (const ch of parsed.characters) {
      const id = uuid();
      run(db, `INSERT INTO characters (id, book_id, name, role) VALUES (?, ?, ?, ?)`, [id, book_id, ch.name, ch.role || 'character']);
      charMap.set(ch.name, id);
      charactersCreated++;
    }
  }

  if (parsed.chapters?.length) {
    for (let i = 0; i < parsed.chapters.length && i < chapters.length; i++) {
      const parsedCh = parsed.chapters[i];
      const dbCh = chapters[i];
      run(db, 'DELETE FROM segments WHERE chapter_id = ?', [dbCh.id]);
      if (parsedCh.segments?.length) {
        for (let j = 0; j < parsedCh.segments.length; j++) {
          const seg = parsedCh.segments[j];
          run(db, `INSERT INTO segments (id, chapter_id, character_id, sort_order, text) VALUES (?, ?, ?, ?, ?)`,
            [uuid(), dbCh.id, charMap.get(seg.speaker) || null, j, seg.text]);
          segmentsCreated++;
        }
      }
    }
  }

  return txt({ characters_created: charactersCreated, segments_created: segmentsCreated, provider, sfx_cues: parsed.chapters?.reduce((n: number, c: any) => n + (c.sfx_cues?.length || 0), 0) || 0 });
});

server.tool('ai_suggest_v3_tags', 'Use an LLM to suggest ElevenLabs v3 audio tags for expressive narration on a given text', {
  text: z.string().describe('The text to add v3 tags to'),
}, async ({ text }) => {
  const db = await dbReady;
  const provider = detectProvider(db);
  if (!provider) return err('No LLM API key configured.');
  const apiKey = getSetting(db, `${provider}_api_key`) || process.env[`${provider.toUpperCase()}_API_KEY`];
  if (!apiKey) return err(`No API key for ${provider}`);

  const systemPrompt = `You are an expert audio production assistant specializing in ElevenLabs v3 audio tags.
Given text from an audiobook or podcast, insert appropriate v3 audio tags to make the narration more expressive.

Available tags (wrap in square brackets):
- Emotions: [happy], [sad], [angry], [fearful], [excited], [melancholic], [romantic], [mysterious], [anxious], [confident], [nostalgic], [playful], [serious], [tender], [dramatic]
- Vocal Effects: [whisper], [shout], [gasp], [sigh], [laugh], [sob], [yawn], [cough], [chuckle], [giggle], [growl], [murmur], [panting], [clears throat]
- Styles: [conversational], [formal], [theatrical], [monotone], [breathy], [crisp], [commanding], [gentle], [intimate], [distant], [warm], [cold]
- Narrative: [storytelling tone], [voice-over style], [documentary style], [bedtime story], [dramatic pause], [suspense build-up], [inner monologue], [flashback tone]
- Rhythm: [slow], [fast], [dramatic pause], [pauses for effect], [staccato], [measured], [rushed], [languid], [building tension]

Rules: Insert tags naturally, 2-5 per paragraph max. Keep original text exactly as-is. Return ONLY JSON: {"tagged_text": "...", "tags_used": ["..."]}`;

  const result = await callLLM(provider, apiKey, systemPrompt, text.slice(0, 4000));
  try {
    const jsonMatch = result.match(/```json\s*([\s\S]*?)```/) || result.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : result);
    return txt({ tagged_text: parsed.tagged_text || text, tags_used: parsed.tags_used || [], provider });
  } catch { return err('LLM returned invalid response. Try again.'); }
});

// ═══════════════════════════════════════════════════════
// IMPORT MANUSCRIPT
// ═══════════════════════════════════════════════════════

server.tool('import_text', 'Import raw text as chapters into a book. Auto-splits into chapters by detecting headings.', {
  book_id: z.string(),
  text: z.string().describe('The full manuscript text. Chapter headings like "Chapter 1: Title" will be auto-detected.'),
  replace_existing: z.boolean().default(true).describe('Replace existing chapters or append'),
}, async ({ book_id, text, replace_existing }) => {
  const db = await dbReady;
  if (!queryOne(db, 'SELECT id FROM books WHERE id = ?', [book_id])) return err('Book not found');

  const chapters = splitIntoChapters(text);
  if (chapters.length === 0) return err('No content found in text');

  if (replace_existing) {
    const existing = queryAll(db, 'SELECT id FROM chapters WHERE book_id = ?', [book_id]);
    for (const ch of existing) run(db, 'DELETE FROM segments WHERE chapter_id = ?', [ch.id]);
    run(db, 'DELETE FROM chapters WHERE book_id = ?', [book_id]);
  }

  const startOrder = replace_existing ? 0 : ((queryOne(db, 'SELECT MAX(sort_order) as m FROM chapters WHERE book_id = ?', [book_id])?.m ?? -1) + 1);

  const created: any[] = [];
  chapters.forEach((ch, i) => {
    const id = uuid();
    run(db, `INSERT INTO chapters (id, book_id, title, sort_order, raw_text, cleaned_text) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, book_id, ch.title, startOrder + i, ch.text, ch.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()]);
    created.push({ id, title: ch.title, text_length: ch.text.length });
  });

  return txt({ chapters_created: created.length, chapters: created });
});

// ═══════════════════════════════════════════════════════
// GENERATE + POPULATE TIMELINE (combo)
// ═══════════════════════════════════════════════════════

server.tool('generate_and_populate', 'Generate TTS for all segments then auto-populate the timeline in one step', {
  book_id: z.string(),
  chapter_ids: z.array(z.string()).optional(),
  gap_between_segments_ms: z.number().default(300),
  gap_between_chapters_ms: z.number().default(2000),
}, async ({ book_id, chapter_ids, gap_between_segments_ms, gap_between_chapters_ms }) => {
  const db = await dbReady;
  let chapters;
  if (chapter_ids?.length) {
    const ph = chapter_ids.map(() => '?').join(',');
    chapters = queryAll(db, `SELECT * FROM chapters WHERE book_id = ? AND id IN (${ph}) ORDER BY sort_order`, [book_id, ...chapter_ids]);
  } else {
    chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [book_id]);
  }
  if (!chapters.length) return err('No chapters found');

  // Apply pronunciation rules
  const pronRules = queryAll(db, 'SELECT * FROM pronunciation_rules WHERE book_id = ? ORDER BY length(word) DESC', [book_id]);

  // 1. Generate TTS
  let ttsGenerated = 0, ttsCached = 0, ttsFailed = 0, ttsSkipped = 0;
  const errors: string[] = [];

  for (const ch of chapters) {
    const segs = queryAll(db, 'SELECT * FROM segments WHERE chapter_id = ? ORDER BY sort_order', [ch.id]);
    for (const seg of segs) {
      if (seg.audio_asset_id && queryOne(db, 'SELECT id FROM audio_assets WHERE id = ?', [seg.audio_asset_id])) { ttsSkipped++; continue; }
      const char = queryOne(db, 'SELECT * FROM characters WHERE id = ?', [seg.character_id]);
      if (!char?.voice_id) { ttsFailed++; errors.push(`Seg ${seg.id}: no voice`); continue; }

      let processedText = seg.text;
      for (const rule of pronRules as any[]) {
        if (rule.character_id && rule.character_id !== seg.character_id) continue;
        const escaped = rule.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        if (rule.alias) processedText = processedText.replace(regex, rule.alias);
        else if (rule.phoneme) processedText = processedText.replace(regex, `<phoneme alphabet="ipa" ph="${rule.phoneme}">${rule.word}</phoneme>`);
      }

      const voiceSettings = { stability: char.stability, similarity_boost: char.similarity_boost, style: char.style, use_speaker_boost: !!char.speaker_boost };
      const hashParams = { text: processedText, voice_id: char.voice_id, model_id: char.model_id, voice_settings: voiceSettings };
      const promptHash = computePromptHash(hashParams);

      const cached = queryOne(db, 'SELECT * FROM audio_assets WHERE prompt_hash = ?', [promptHash]);
      if (cached && fs.existsSync(cached.file_path)) {
        run(db, `UPDATE segments SET audio_asset_id = ?, updated_at = datetime('now') WHERE id = ?`, [cached.id, seg.id]);
        ttsCached++; continue;
      }

      try {
        const { buffer, requestId } = await generateTTS({
          voice_id: char.voice_id, text: processedText, model_id: char.model_id,
          voice_settings: voiceSettings, output_format: 'mp3_44100_192',
        });
        const assetId = uuid();
        const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);
        fs.writeFileSync(filePath, buffer);
        const dur = Math.round((buffer.length / 24000) * 1000);
        run(db, `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, prompt_hash, elevenlabs_request_id, generation_params, file_size_bytes) VALUES (?, ?, 'tts', ?, ?, ?, ?, ?, ?)`,
          [assetId, book_id, filePath, dur, promptHash, requestId, JSON.stringify(hashParams), buffer.length]);
        run(db, `UPDATE segments SET audio_asset_id = ?, previous_request_id = ?, updated_at = datetime('now') WHERE id = ?`, [assetId, requestId, seg.id]);
        ttsGenerated++;
        log(`Generated: ${(buffer.length / 1024).toFixed(1)} KB`);
      } catch (e: any) { ttsFailed++; errors.push(`Seg ${seg.id}: ${e.message}`); }
    }
  }

  // 2. Populate timeline
  let narrationTrack = queryOne(db, "SELECT * FROM tracks WHERE book_id = ? AND type = 'narration' LIMIT 1", [book_id]);
  if (!narrationTrack) {
    const trackId = uuid();
    run(db, `INSERT INTO tracks (id, book_id, name, type, sort_order, color) VALUES (?, ?, 'Narration', 'narration', 0, '#4A90D9')`, [trackId, book_id]);
    narrationTrack = queryOne(db, 'SELECT * FROM tracks WHERE id = ?', [trackId]);
  }

  let currentMs = 0, clipsCreated = 0, markersCreated = 0;
  run(db, 'DELETE FROM chapter_markers WHERE book_id = ?', [book_id]);

  for (const ch of chapters) {
    run(db, 'INSERT INTO chapter_markers (id, book_id, chapter_id, position_ms, label) VALUES (?, ?, ?, ?, ?)',
      [uuid(), book_id, ch.id, currentMs, ch.title]);
    markersCreated++;
    const segs = queryAll(db,
      `SELECT s.*, a.duration_ms FROM segments s JOIN audio_assets a ON s.audio_asset_id = a.id WHERE s.chapter_id = ? ORDER BY s.sort_order`, [ch.id]);
    for (const seg of segs) {
      const existing = queryOne(db, 'SELECT * FROM clips WHERE segment_id = ? AND track_id = ?', [seg.id, narrationTrack.id]);
      if (existing) { currentMs = existing.position_ms + (seg.duration_ms || 3000) + gap_between_segments_ms; continue; }
      const clipId = uuid();
      run(db, `INSERT INTO clips (id, track_id, audio_asset_id, segment_id, position_ms) VALUES (?, ?, ?, ?, ?)`,
        [clipId, narrationTrack.id, seg.audio_asset_id, seg.id, currentMs]);
      clipsCreated++;
      currentMs += (seg.duration_ms || 3000) + gap_between_segments_ms;
    }
    currentMs += gap_between_chapters_ms - gap_between_segments_ms;
  }

  return txt({
    tts: { generated: ttsGenerated, cached: ttsCached, skipped: ttsSkipped, failed: ttsFailed, errors: errors.slice(0, 10) },
    timeline: { clips_created: clipsCreated, markers_created: markersCreated, total_duration_ms: currentMs },
  });
});

// ═══════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════

function detectProvider(db: any): string | null {
  for (const p of ['openai', 'mistral', 'gemini']) {
    if (getSetting(db, `${p}_api_key`)) return p;
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.MISTRAL_API_KEY) return 'mistral';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

async function callLLM(provider: string, apiKey: string, system: string, user: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3, max_tokens: 8000, response_format: { type: 'json_object' } }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      return ((await res.json()) as any).choices[0].message.content;
    }
    if (provider === 'mistral') {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3, max_tokens: 8000, response_format: { type: 'json_object' } }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Mistral ${res.status}: ${await res.text()}`);
      return ((await res.json()) as any).choices[0].message.content;
    }
    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: system + '\n\n' + user }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 8000, responseMimeType: 'application/json' } }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      return ((await res.json()) as any).candidates[0].content.parts[0].text;
    }
    throw new Error(`Unsupported provider: ${provider}`);
  } finally { clearTimeout(timeout); }
}

function buildParseSystemPrompt(projectType: string, format: string): string {
  const typeDesc = projectType === 'podcast' ? 'podcast episode' : 'audiobook';
  return `You are an expert audio production assistant. Analyze text for a ${typeDesc} (format: ${format}).

Your job:
1. Identify all distinct speakers/characters. For each, provide name, role (narrator/character), and voice description.
2. Break text into segments, assigning each to the correct speaker.
3. Suggest SFX cues where appropriate.
4. Suggest background music cues.

Respond with ONLY JSON:
{
  "characters": [{"name": "Narrator", "role": "narrator", "voice_description": "warm male, 40s"}],
  "chapters": [{
    "title": "Chapter title",
    "segments": [{"speaker": "Narrator", "text": "...", "type": "narration"}],
    "sfx_cues": [{"after_segment": 2, "description": "door creaking"}],
    "music_cues": [{"at_start": true, "description": "soft piano"}]
  }]
}

Rules: Keep text faithful to original. Use "Narrator" for description paragraphs. Be specific with SFX. Don't over-annotate.`;
}

function splitIntoChapters(text: string): Array<{ title: string; text: string }> {
  const patterns = [
    /^(Chapter\s+\d+[.:\s].*)$/gim, /^(CHAPTER\s+\d+[.:\s].*)$/gm,
    /^(Chapter\s+[IVXLCDM]+[.:\s].*)$/gim, /^(Part\s+\d+[.:\s].*)$/gim,
    /^(#{1,3}\s+.+)$/gm, /^(Chapter\s+\d+)$/gim, /^(CHAPTER\s+[IVXLCDM]+)$/gm,
  ];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      const chapters: Array<{ title: string; text: string }> = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index!;
        const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
        chapters.push({ title: matches[i][1].replace(/^#+\s*/, '').trim(), text: text.slice(start, end).trim() });
      }
      return chapters;
    }
  }
  if (text.length > 10000) {
    const paragraphs = text.split(/\n\s*\n/);
    const chapters: Array<{ title: string; text: string }> = [];
    let current = ''; let num = 1;
    for (const para of paragraphs) {
      if (current.length + para.length > 8000 && current.length > 0) {
        chapters.push({ title: `Chapter ${num}`, text: current.trim() }); num++; current = '';
      }
      current += para + '\n\n';
    }
    if (current.trim()) chapters.push({ title: `Chapter ${num}`, text: current.trim() });
    return chapters;
  }
  return [{ title: 'Chapter 1', text: text.trim() }];
}

// ── Start ──

async function main() {
  initDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Audiobook Maker MCP Server v2.0 running on stdio');
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(1);
});
