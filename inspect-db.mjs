// Read-only inspection of both candidate SQLite files, to find which database
// holds the podcast project shown in the bug report and what state it is in.
import fs from 'fs';
import initSqlJs from 'sql.js';

const candidates = ['data/db.sqlite', 'server/data/db.sqlite'];
const SQL = await initSqlJs();

for (const file of candidates) {
  console.log('='.repeat(70));
  console.log('FILE:', file, fs.existsSync(file) ? `(${fs.statSync(file).size} bytes)` : '(missing)');
  if (!fs.existsSync(file)) continue;

  const db = new SQL.Database(fs.readFileSync(file));
  const q = (sql, params = []) => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };

  try {
    const books = q('SELECT id, title, project_type FROM books ORDER BY created_at');
    console.log(`books: ${books.length}`);
    for (const b of books) {
      const chars = q('SELECT name, role, voice_id, voice_name FROM characters WHERE book_id = ?', [b.id]);
      const voiced = chars.filter((c) => c.voice_id).length;
      const segs = q(
        `SELECT COUNT(*) n,
                SUM(CASE WHEN s.character_id IS NULL THEN 1 ELSE 0 END) no_char,
                SUM(CASE WHEN s.audio_asset_id IS NULL THEN 1 ELSE 0 END) no_audio
           FROM segments s JOIN chapters ch ON ch.id = s.chapter_id
          WHERE ch.book_id = ?`,
        [b.id]
      )[0];
      console.log(
        `  - "${b.title}" [${b.project_type}] chars=${chars.length} voiced=${voiced} ` +
          `segments=${segs.n} segsWithoutCharacter=${segs.no_char ?? 0} segsWithoutAudio=${segs.no_audio ?? 0}`
      );
      if (chars.length && voiced < chars.length) {
        for (const c of chars) {
          console.log(`      ${c.voice_id ? 'OK  ' : 'MISSING'} ${c.name} [${c.role}] ${c.voice_name || ''}`);
        }
      }
    }
  } catch (err) {
    console.log('  error reading:', err.message);
  }
  db.close();
}
