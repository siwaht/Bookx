/**
 * Shared "multi-cast" voice memory logic.
 *
 * A character's voice assignment can be remembered and reused via a
 * `voice_castings` record (a named, reusable cast of characters -> voices).
 * A casting can either:
 *   - stand alone (e.g. a podcast's recurring hosts/guests), or
 *   - be the default casting for a `series` (a group of book volumes), so
 *     every volume in the series automatically reuses the same character
 *     voices, and any newly-discovered character gets remembered for the
 *     next volume too.
 *
 * This module centralizes: name normalization, voice-picking heuristics,
 * and the "look up a remembered voice, else assign a fresh one and
 * remember it" flow used by characters.ts, ai-parse.ts, series.ts, and
 * the podcast casting routes.
 */

import type { Database as SqlJsDatabase } from 'sql.js';
import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, run } from '../db/helpers.js';

export function normalizeName(name: string): string {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface CandidateVoice {
  voiceId: string;
  name: string;
  provider: string;
  gender?: string;
  category?: string;
  labels?: Record<string, string>;
}

export interface CastingMemberRow {
  id: string;
  casting_id: string;
  character_name: string;
  normalized_name: string;
  role: string;
  voice_id: string | null;
  voice_name: string | null;
  tts_provider: string;
  model_id: string;
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  speaker_boost: number;
}

/** Score a voice for a character based on role/name heuristics (moved here from characters.ts so
 * every entry point — manual auto-assign, AI parse, podcast casting — scores voices the same way). */
export function findBestVoice(
  character: { name?: string; role?: string },
  voices: CandidateVoice[],
  alreadyAssigned: Set<string>
): CandidateVoice | null {
  const available = voices.filter((v) => !alreadyAssigned.has(v.voiceId));
  if (available.length === 0) return null;

  const role = (character.role || '').toLowerCase();
  const charName = (character.name || '').toLowerCase();

  const scored = available.map((voice) => {
    let score = 0;
    const vName = (voice.name || '').toLowerCase();
    const vCategory = (voice.category || '').toLowerCase();
    const labels = voice.labels || {};
    const labelValues = Object.values(labels).map((l) => l.toLowerCase());
    const labelKeys = Object.keys(labels).map((k) => k.toLowerCase());

    if (role === 'narrator') {
      if (vName.includes('narrator') || vName.includes('storytell')) score += 10;
      if (vCategory === 'professional' || vCategory === 'narration') score += 5;
      if (labelValues.some((l) => l.includes('narrat') || l.includes('storytell') || l.includes('audiobook'))) score += 8;
      if (labelKeys.includes('use case') && labelValues.some((l) => l.includes('narrat'))) score += 6;
    }

    if (role === 'character' || role === 'guest' || role === 'host') {
      if (vCategory === 'conversational' || vCategory === 'characters') score += 3;
      if (labelValues.some((l) => l.includes('character') || l.includes('conversational'))) score += 4;
    }

    if (vName.includes(charName) || charName.includes(vName)) score += 15;
    score += Math.random() * 2;

    return { voice, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.voice || null;
}

/** Get (or lazily create) the default casting linked to a series. */
export function getOrCreateSeriesCasting(db: SqlJsDatabase, seriesId: string): CastingMemberRow['casting_id'] {
  const existing = queryOne(db, 'SELECT id FROM voice_castings WHERE series_id = ? AND is_series_default = 1', [seriesId]) as any;
  if (existing) return existing.id;

  const series = queryOne(db, 'SELECT * FROM series WHERE id = ?', [seriesId]) as any;
  const id = uuid();
  run(db,
    `INSERT INTO voice_castings (id, name, description, project_type, series_id, is_series_default) VALUES (?, ?, ?, 'any', ?, 1)`,
    [id, `${series?.name || 'Series'} — Cast`, 'Auto-managed voice memory for this series', seriesId]);
  return id;
}

/** Insert or update a casting member by (casting_id, normalized_name). */
export function upsertCastingMember(
  db: SqlJsDatabase,
  castingId: string,
  member: {
    character_name: string;
    role?: string;
    voice_id?: string | null;
    voice_name?: string | null;
    tts_provider?: string;
    model_id?: string;
    stability?: number;
    similarity_boost?: number;
    style?: number;
    speed?: number;
    speaker_boost?: number | boolean;
  }
): string {
  const norm = normalizeName(member.character_name);
  const existing = queryOne(db, 'SELECT id FROM voice_casting_members WHERE casting_id = ? AND normalized_name = ?', [castingId, norm]) as any;

  if (existing) {
    run(db,
      `UPDATE voice_casting_members SET character_name = ?, role = ?, voice_id = ?, voice_name = ?, tts_provider = ?, model_id = ?,
        stability = ?, similarity_boost = ?, style = ?, speed = ?, speaker_boost = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        member.character_name, member.role || 'character', member.voice_id ?? null, member.voice_name ?? null,
        member.tts_provider || 'elevenlabs', member.model_id || 'eleven_v3',
        member.stability ?? 0.5, member.similarity_boost ?? 0.75, member.style ?? 0.0,
        member.speed ?? 1.0, member.speaker_boost ? 1 : 0, existing.id,
      ]);
    return existing.id;
  }

  const id = uuid();
  run(db,
    `INSERT INTO voice_casting_members
      (id, casting_id, character_name, normalized_name, role, voice_id, voice_name, tts_provider, model_id, stability, similarity_boost, style, speed, speaker_boost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, castingId, member.character_name, norm, member.role || 'character',
      member.voice_id ?? null, member.voice_name ?? null, member.tts_provider || 'elevenlabs', member.model_id || 'eleven_v3',
      member.stability ?? 0.5, member.similarity_boost ?? 0.75, member.style ?? 0.0, member.speed ?? 1.0, member.speaker_boost ? 1 : 0,
    ]);
  return id;
}

/**
 * Look up a remembered voice for a character name, in priority order:
 *  1. The book's own explicit casting (`books.casting_id`), if set.
 *  2. The book's series default casting, if the book belongs to a series.
 *  3. Any casting at all with a member of that name (global memory) —
 *     lets a recurring podcast guest or crossover character get recognized
 *     even outside a formal series.
 */
export function findRememberedVoice(
  db: SqlJsDatabase,
  characterName: string,
  opts: { bookId?: string; excludeCastingIds?: string[] } = {}
): (CastingMemberRow & { casting_name: string }) | null {
  const norm = normalizeName(characterName);
  if (!norm) return null;
  const exclude = new Set(opts.excludeCastingIds || []);

  let book: any = null;
  if (opts.bookId) {
    book = queryOne(db, 'SELECT casting_id, series_id FROM books WHERE id = ?', [opts.bookId]);
  }

  const tryCasting = (castingId: string | null | undefined): (CastingMemberRow & { casting_name: string }) | null => {
    if (!castingId || exclude.has(castingId)) return null;
    const row = queryOne(db,
      `SELECT m.*, c.name as casting_name FROM voice_casting_members m
       JOIN voice_castings c ON c.id = m.casting_id
       WHERE m.casting_id = ? AND m.normalized_name = ? AND m.voice_id IS NOT NULL`,
      [castingId, norm]) as any;
    return row || null;
  };

  // 1. Explicit book casting
  const explicit = tryCasting(book?.casting_id);
  if (explicit) return explicit;

  // 2. Series default casting
  if (book?.series_id) {
    const seriesCastingId = getOrCreateSeriesCasting(db, book.series_id);
    const fromSeries = tryCasting(seriesCastingId);
    if (fromSeries) return fromSeries;
  }

  // 3. Global fallback — most recently updated match across any casting
  const globalMatch = queryOne(db,
    `SELECT m.*, c.name as casting_name FROM voice_casting_members m
     JOIN voice_castings c ON c.id = m.casting_id
     WHERE m.normalized_name = ? AND m.voice_id IS NOT NULL
     ORDER BY m.updated_at DESC LIMIT 1`,
    [norm]) as any;
  return globalMatch || null;
}

/** Remember a character's voice assignment: write it into the book's explicit casting
 * (if any) and/or its series default casting, so future books/volumes can reuse it. */
export function rememberCharacterVoice(
  db: SqlJsDatabase,
  bookId: string,
  character: { name?: string; character_name?: string; role?: string; voice_id?: string | null; voice_name?: string | null; tts_provider?: string; model_id?: string; stability?: number; similarity_boost?: number; style?: number; speed?: number; speaker_boost?: number | boolean }
): void {
  if (!character.voice_id) return;
  const member = characterRowToMember(character);
  if (!member.character_name) return;

  const book = queryOne(db, 'SELECT casting_id, series_id FROM books WHERE id = ?', [bookId]) as any;
  if (!book) return;

  if (book.casting_id) {
    upsertCastingMember(db, book.casting_id, member);
  }
  if (book.series_id) {
    const seriesCastingId = getOrCreateSeriesCasting(db, book.series_id);
    upsertCastingMember(db, seriesCastingId, member);
  }
}

/**
 * Voice IDs already claimed by *other* characters that share this book's
 * casting/series memory. Used so a newly-cast character in Volume 2 doesn't
 * get handed the voice that already belongs to someone in Volume 1 — the
 * "every character has its own unique voice" guarantee has to hold across
 * the whole series, not just within a single book.
 */
export function getClaimedVoiceIds(db: SqlJsDatabase, bookId: string, excludeNormalizedName?: string): Set<string> {
  const claimed = new Set<string>();
  const book = queryOne(db, 'SELECT casting_id, series_id FROM books WHERE id = ?', [bookId]) as any;
  if (!book) return claimed;

  const castingIds: string[] = [];
  if (book.casting_id) castingIds.push(book.casting_id);
  if (book.series_id) castingIds.push(getOrCreateSeriesCasting(db, book.series_id));
  if (castingIds.length === 0) return claimed;

  const placeholders = castingIds.map(() => '?').join(',');
  const rows = queryAll(db,
    `SELECT normalized_name, voice_id FROM voice_casting_members WHERE casting_id IN (${placeholders}) AND voice_id IS NOT NULL`,
    castingIds) as any[];
  for (const r of rows) {
    if (excludeNormalizedName && r.normalized_name === excludeNormalizedName) continue;
    claimed.add(r.voice_id);
  }
  return claimed;
}

export interface AutoAssignResult {
  character_id: string;
  character_name: string;
  voice_id: string;
  voice_name: string;
  provider: string;
  source: 'memory' | 'fresh';
  casting_name?: string;
}

/**
 * The core "multi-cast" routine: for a book's unassigned characters, first
 * try to recall a previously-used voice (from this book's casting, its
 * series, or any casting globally); otherwise pick a fresh, unique voice
 * from the given candidate pool. Every assignment is written back onto the
 * character AND remembered for next time.
 */
export function autoAssignWithMemory(
  db: SqlJsDatabase,
  bookId: string,
  characters: any[],
  availableVoices: CandidateVoice[],
  opts: { onlyCharacterIds?: string[] } = {}
): AutoAssignResult[] {
  const results: AutoAssignResult[] = [];
  // Voices taken by characters already voiced in THIS book...
  const usedVoiceIds = new Set(characters.filter((c) => c.voice_id).map((c) => c.voice_id));
  // ...plus voices already owned by other characters anywhere in this book's
  // casting/series memory, so Volume 2's new characters don't collide with
  // voices that already belong to Volume 1's cast.
  for (const claimed of getClaimedVoiceIds(db, bookId)) usedVoiceIds.add(claimed);
  const assignedInThisRound = new Set<string>();

  // `onlyCharacterIds` narrows *which* characters get cast (used by the UI's
  // per-character "auto-pick"), but the full `characters` list is still used
  // above for uniqueness, so a one-off pick can't steal a voice that's already
  // in use elsewhere in the book.
  const limitTo = opts.onlyCharacterIds?.length ? new Set(opts.onlyCharacterIds) : null;
  const unassigned = characters.filter((c) => !c.voice_id && (!limitTo || limitTo.has(c.id)));
  // Narrators first so they get first pick of "narrator-labeled" voices.
  const sorted = [...unassigned].sort((a, b) => {
    if (a.role === 'narrator' && b.role !== 'narrator') return -1;
    if (a.role !== 'narrator' && b.role === 'narrator') return 1;
    return 0;
  });

  for (const char of sorted) {
    const remembered = findRememberedVoice(db, char.name, { bookId });
    if (remembered) {
      run(db,
        `UPDATE characters SET voice_id = ?, voice_name = ?, tts_provider = ?, model_id = ?, stability = ?, similarity_boost = ?, style = ?, speed = ?, speaker_boost = ?, casting_member_id = ?, normalized_name = ? WHERE id = ?`,
        [
          remembered.voice_id, remembered.voice_name, remembered.tts_provider, remembered.model_id,
          remembered.stability, remembered.similarity_boost, remembered.style, remembered.speed, remembered.speaker_boost,
          remembered.id, normalizeName(char.name), char.id,
        ]);
      usedVoiceIds.add(remembered.voice_id!);
      results.push({
        character_id: char.id, character_name: char.name,
        voice_id: remembered.voice_id!, voice_name: remembered.voice_name || remembered.voice_id!,
        provider: remembered.tts_provider, source: 'memory', casting_name: remembered.casting_name,
      });
      rememberCharacterVoice(db, bookId, { ...char, voice_id: remembered.voice_id, voice_name: remembered.voice_name, tts_provider: remembered.tts_provider });
      continue;
    }

    // No memory hit — assign a fresh, unique voice from the candidate pool.
    let candidatePool = availableVoices.filter((v) => !usedVoiceIds.has(v.voiceId));
    if (candidatePool.length === 0) candidatePool = availableVoices;

    let bestVoice = findBestVoice(char, candidatePool, assignedInThisRound);
    if (!bestVoice && assignedInThisRound.size > 0) {
      bestVoice = findBestVoice(char, candidatePool, new Set());
    }
    if (!bestVoice) continue;

    run(db,
      `UPDATE characters SET voice_id = ?, voice_name = ?, tts_provider = ?, normalized_name = ? WHERE id = ?`,
      [bestVoice.voiceId, bestVoice.name, bestVoice.provider, normalizeName(char.name), char.id]);

    assignedInThisRound.add(bestVoice.voiceId);
    usedVoiceIds.add(bestVoice.voiceId);
    results.push({
      character_id: char.id, character_name: char.name,
      voice_id: bestVoice.voiceId, voice_name: bestVoice.name, provider: bestVoice.provider, source: 'fresh',
    });

    rememberCharacterVoice(db, bookId, { name: char.name, role: char.role, voice_id: bestVoice.voiceId, voice_name: bestVoice.name, tts_provider: bestVoice.provider });
  }

  return results;
}

/** Convert a `characters` table row into the shape upsertCastingMember expects.
 * The two tables name this column differently (`characters.name` vs
 * `voice_casting_members.character_name`), so every caller must map it. */
function characterRowToMember(character: any) {
  return {
    character_name: character.character_name ?? character.name,
    role: character.role,
    voice_id: character.voice_id,
    voice_name: character.voice_name,
    tts_provider: character.tts_provider,
    model_id: character.model_id,
    stability: character.stability,
    similarity_boost: character.similarity_boost,
    style: character.style,
    speed: character.speed,
    speaker_boost: character.speaker_boost,
  };
}

/** Snapshot a book's current characters into a casting (creating it if `castingId` is omitted). */
export function syncCastingFromBook(
  db: SqlJsDatabase,
  bookId: string,
  opts: { castingId?: string; name?: string; description?: string; projectType?: string }
): string {
  const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [bookId]) as any;
  const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);

  let castingId = opts.castingId;
  if (!castingId) {
    castingId = uuid();
    run(db,
      `INSERT INTO voice_castings (id, name, description, project_type) VALUES (?, ?, ?, ?)`,
      [castingId, opts.name || `${book?.title || 'Untitled'} Cast`, opts.description || null, opts.projectType || book?.project_type || 'any']);
  } else if (opts.name) {
    run(db, `UPDATE voice_castings SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?`,
      [opts.name, opts.description || null, castingId]);
  }

  for (const c of characters as any[]) {
    if (!c.voice_id) continue;
    upsertCastingMember(db, castingId, characterRowToMember(c));
  }

  run(db, 'UPDATE books SET casting_id = ? WHERE id = ?', [castingId, bookId]);
  return castingId;
}

/** Apply a saved casting onto a book: update matching characters by name, create any that don't exist yet. */
export function applyCastingToBook(db: SqlJsDatabase, bookId: string, castingId: string): { updated: number; created: number } {
  const members = queryAll(db, 'SELECT * FROM voice_casting_members WHERE casting_id = ?', [castingId]) as any[];
  const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]) as any[];
  const byNorm = new Map(characters.map((c) => [normalizeName(c.name), c]));

  let updated = 0;
  let created = 0;
  for (const m of members) {
    if (!m.voice_id) continue;
    const existing = byNorm.get(m.normalized_name);
    if (existing) {
      run(db,
        `UPDATE characters SET voice_id = ?, voice_name = ?, tts_provider = ?, model_id = ?, stability = ?, similarity_boost = ?, style = ?, speed = ?, speaker_boost = ?, casting_member_id = ? WHERE id = ?`,
        [m.voice_id, m.voice_name, m.tts_provider, m.model_id, m.stability, m.similarity_boost, m.style, m.speed, m.speaker_boost, m.id, existing.id]);
      updated++;
    } else {
      const id = uuid();
      run(db,
        `INSERT INTO characters (id, book_id, name, role, voice_id, voice_name, tts_provider, model_id, stability, similarity_boost, style, speed, speaker_boost, casting_member_id, normalized_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, bookId, m.character_name, m.role, m.voice_id, m.voice_name, m.tts_provider, m.model_id, m.stability, m.similarity_boost, m.style, m.speed, m.speaker_boost, m.id, m.normalized_name]);
      created++;
    }
  }
  run(db, 'UPDATE books SET casting_id = ? WHERE id = ?', [castingId, bookId]);
  return { updated, created };
}
