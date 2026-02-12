import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

export function pronunciationRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  // GET all rules for a book
  router.get('/', (req: Request, res: Response) => {
    const rules = queryAll(db,
      'SELECT p.*, c.name as character_name FROM pronunciation_rules p LEFT JOIN characters c ON p.character_id = c.id WHERE p.book_id = ? ORDER BY p.word',
      [req.params.bookId]);
    res.json(rules);
  });

  // POST create a rule
  router.post('/', (req: Request, res: Response) => {
    const { word, phoneme, alias, character_id } = req.body;
    if (!word?.trim()) { res.status(400).json({ error: 'word is required' }); return; }
    if (!phoneme?.trim() && !alias?.trim()) { res.status(400).json({ error: 'phoneme or alias is required' }); return; }

    const id = uuid();
    run(db, 'INSERT INTO pronunciation_rules (id, book_id, character_id, word, phoneme, alias) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.params.bookId, character_id || null, word.trim(), phoneme?.trim() || null, alias?.trim() || null]);
    const rule = queryOne(db, 'SELECT * FROM pronunciation_rules WHERE id = ?', [id]);
    res.status(201).json(rule);
  });

  // PUT update a rule
  router.put('/:ruleId', (req: Request, res: Response) => {
    const { word, phoneme, alias, character_id } = req.body;
    const updates: string[] = [];
    const values: any[] = [];
    if (word !== undefined) { updates.push('word = ?'); values.push(word.trim()); }
    if (phoneme !== undefined) { updates.push('phoneme = ?'); values.push(phoneme?.trim() || null); }
    if (alias !== undefined) { updates.push('alias = ?'); values.push(alias?.trim() || null); }
    if (character_id !== undefined) { updates.push('character_id = ?'); values.push(character_id || null); }

    if (updates.length > 0) {
      values.push(req.params.ruleId);
      run(db, `UPDATE pronunciation_rules SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    const rule = queryOne(db, 'SELECT * FROM pronunciation_rules WHERE id = ?', [req.params.ruleId]);
    res.json(rule);
  });

  // DELETE a rule
  router.delete('/:ruleId', (req: Request, res: Response) => {
    run(db, 'DELETE FROM pronunciation_rules WHERE id = ?', [req.params.ruleId]);
    res.status(204).send();
  });

  // POST apply rules to text — replaces words with ElevenLabs pronunciation XML
  router.post('/apply', (req: Request, res: Response) => {
    const { text, character_id } = req.body;
    if (!text) { res.status(400).json({ error: 'text required' }); return; }

    // Get rules: character-specific first, then global
    let rules;
    if (character_id) {
      rules = queryAll(db,
        'SELECT * FROM pronunciation_rules WHERE book_id = ? AND (character_id = ? OR character_id IS NULL) ORDER BY length(word) DESC',
        [req.params.bookId, character_id]);
    } else {
      rules = queryAll(db,
        'SELECT * FROM pronunciation_rules WHERE book_id = ? ORDER BY length(word) DESC',
        [req.params.bookId]);
    }

    let result = text;
    for (const rule of rules as any[]) {
      const escaped = rule.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      if (rule.alias) {
        // Simple alias replacement
        result = result.replace(regex, rule.alias);
      } else if (rule.phoneme) {
        // ElevenLabs SSML-style phoneme (works with v3)
        result = result.replace(regex, `<phoneme alphabet="ipa" ph="${rule.phoneme}">${rule.word}</phoneme>`);
      }
    }

    res.json({ original: text, processed: result, rules_applied: (rules as any[]).length });
  });

  return router;
}
