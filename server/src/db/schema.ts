import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { queryAll } from './helpers.js';

const DATA_DIR = process.env.DATA_DIR || './data';

let db: SqlJsDatabase | null = null;
let dbPath: string;

export async function getDb(): Promise<SqlJsDatabase> {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'exports'), { recursive: true });

  dbPath = path.join(DATA_DIR, 'db.sqlite');

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  return db;
}

export function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Auto-save every 5 seconds
setInterval(() => saveDb(), 5000);

export function initializeSchema(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      narrator TEXT,
      isbn TEXT,
      cover_art_path TEXT,
      default_model TEXT DEFAULT 'eleven_v3',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      raw_text TEXT NOT NULL,
      cleaned_text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'character',
      voice_id TEXT,
      voice_name TEXT,
      model_id TEXT DEFAULT 'eleven_v3',
      stability REAL DEFAULT 0.5,
      similarity_boost REAL DEFAULT 0.75,
      style REAL DEFAULT 0.0,
      speed REAL DEFAULT 1.0,
      speaker_boost INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS audio_assets (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      duration_ms INTEGER,
      sample_rate INTEGER,
      channels INTEGER DEFAULT 1,
      prompt_hash TEXT,
      elevenlabs_request_id TEXT,
      generation_params TEXT,
      file_size_bytes INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      character_id TEXT REFERENCES characters(id),
      sort_order INTEGER NOT NULL,
      text TEXT NOT NULL,
      audio_asset_id TEXT REFERENCES audio_assets(id),
      generation_seed INTEGER,
      previous_request_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      gain REAL DEFAULT 0.0,
      pan REAL DEFAULT 0.0,
      muted INTEGER DEFAULT 0,
      solo INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0,
      color TEXT DEFAULT '#4A90D9',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      audio_asset_id TEXT NOT NULL REFERENCES audio_assets(id),
      segment_id TEXT REFERENCES segments(id),
      position_ms INTEGER NOT NULL DEFAULT 0,
      trim_start_ms INTEGER DEFAULT 0,
      trim_end_ms INTEGER DEFAULT 0,
      gain REAL DEFAULT 0.0,
      fade_in_ms INTEGER DEFAULT 0,
      fade_out_ms INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS chapter_markers (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT REFERENCES chapters(id),
      position_ms INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS automation_points (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      time_ms INTEGER NOT NULL,
      value REAL NOT NULL,
      curve TEXT DEFAULT 'linear',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS pronunciation_rules (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      character_id TEXT REFERENCES characters(id),
      word TEXT NOT NULL,
      phoneme TEXT,
      alias TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS render_jobs (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      type TEXT DEFAULT 'full',
      chapter_id TEXT REFERENCES chapters(id),
      output_path TEXT,
      progress REAL DEFAULT 0.0,
      error_message TEXT,
      qc_report TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      target TEXT DEFAULT 'acx',
      status TEXT DEFAULT 'pending',
      output_path TEXT,
      validation_report TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT REFERENCES books(id),
      action TEXT NOT NULL,
      details TEXT,
      elevenlabs_request_id TEXT,
      characters_used INTEGER,
      cost_estimate REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // API keys / settings store
  database.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Indexes
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_segments_chapter ON segments(chapter_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_clips_track ON clips(track_id, position_ms)',
    'CREATE INDEX IF NOT EXISTS idx_audio_assets_hash ON audio_assets(prompt_hash)',
    'CREATE INDEX IF NOT EXISTS idx_automation_track ON automation_points(track_id, time_ms)',
    'CREATE INDEX IF NOT EXISTS idx_audit_book ON audit_log(book_id, created_at)',
  ];
  for (const idx of indexes) {
    database.run(idx);
  }

  // Migrations: add columns if missing
  const bookCols = queryAll(database, "PRAGMA table_info(books)").map((c: any) => c.name);
  if (!bookCols.includes('project_type')) {
    database.run("ALTER TABLE books ADD COLUMN project_type TEXT DEFAULT 'audiobook'");
  }
  if (!bookCols.includes('format')) {
    database.run("ALTER TABLE books ADD COLUMN format TEXT DEFAULT 'single_narrator'");
  }

  saveDb();
}
