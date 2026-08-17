import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne } from '../db/helpers.js';

/**
 * Apply pronunciation rules from the book to the given text.
 * Character-specific rules take priority, then global rules.
 * Longer words are replaced first to avoid partial matches.
 */
export function applyPronunciationRules(db: SqlJsDatabase, text: string, chapterId: string, characterId: string | null): string {
  const chapter = queryOne(db, 'SELECT book_id FROM chapters WHERE id = ?', [chapterId]);
  if (!chapter) return text;

  let rules;
  if (characterId) {
    rules = queryAll(db,
      'SELECT * FROM pronunciation_rules WHERE book_id = ? AND (character_id = ? OR character_id IS NULL) ORDER BY length(word) DESC',
      [chapter.book_id, characterId]);
  } else {
    rules = queryAll(db,
      'SELECT * FROM pronunciation_rules WHERE book_id = ? AND character_id IS NULL ORDER BY length(word) DESC',
      [chapter.book_id]);
  }

  if (!rules || rules.length === 0) return text;

  let result = text;
  for (const rule of rules as any[]) {
    const escaped = rule.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (rule.alias) {
      result = result.replace(regex, rule.alias);
    } else if (rule.phoneme) {
      result = result.replace(regex, `<phoneme alphabet="ipa" ph="${rule.phoneme}">${rule.word}</phoneme>`);
    }
  }

  return result;
}
