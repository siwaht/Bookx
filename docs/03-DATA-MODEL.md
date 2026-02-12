# Data Model — Audiobook Maker

## SQLite Schema

```sql
-- Projects / Books
CREATE TABLE books (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  author TEXT,
  narrator TEXT,
  isbn TEXT,
  cover_art_path TEXT,
  default_model TEXT DEFAULT 'eleven_v3',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Chapters (ordered segments of a book)
CREATE TABLE chapters (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  cleaned_text TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Characters / Roles
CREATE TABLE characters (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'character', -- 'narrator' | 'character'
  voice_id TEXT, -- ElevenLabs voice ID
  voice_name TEXT,
  model_id TEXT DEFAULT 'eleven_v3',
  stability REAL DEFAULT 0.5,
  similarity_boost REAL DEFAULT 0.75,
  style REAL DEFAULT 0.0,
  speed REAL DEFAULT 1.0,
  speaker_boost INTEGER DEFAULT 1, -- boolean
  created_at TEXT DEFAULT (datetime('now'))
);

-- Text Segments (chunks of chapter text assigned to a character)
CREATE TABLE segments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id),
  sort_order INTEGER NOT NULL,
  text TEXT NOT NULL,
  audio_asset_id TEXT REFERENCES audio_assets(id),
  generation_seed INTEGER,
  previous_request_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Audio Assets (generated or imported audio files)
CREATE TABLE audio_assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'tts' | 'dialogue' | 'sfx' | 'music' | 'imported'
  file_path TEXT NOT NULL,
  duration_ms INTEGER,
  sample_rate INTEGER,
  channels INTEGER DEFAULT 1,
  prompt_hash TEXT, -- for dedup/caching
  elevenlabs_request_id TEXT,
  generation_params TEXT, -- JSON blob of all params used
  file_size_bytes INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Timeline Tracks
CREATE TABLE tracks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'narration' | 'dialogue' | 'sfx' | 'music' | 'imported'
  sort_order INTEGER NOT NULL,
  gain REAL DEFAULT 0.0, -- dB
  pan REAL DEFAULT 0.0, -- -1 to 1
  muted INTEGER DEFAULT 0,
  solo INTEGER DEFAULT 0,
  locked INTEGER DEFAULT 0,
  color TEXT DEFAULT '#4A90D9',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Timeline Clips (audio placed on tracks)
CREATE TABLE clips (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  audio_asset_id TEXT NOT NULL REFERENCES audio_assets(id),
  segment_id TEXT REFERENCES segments(id),
  position_ms INTEGER NOT NULL DEFAULT 0, -- start position on timeline
  trim_start_ms INTEGER DEFAULT 0, -- trim from beginning of source
  trim_end_ms INTEGER DEFAULT 0, -- trim from end of source
  gain REAL DEFAULT 0.0, -- clip-level gain dB
  fade_in_ms INTEGER DEFAULT 0,
  fade_out_ms INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Chapter Markers (on the timeline)
CREATE TABLE chapter_markers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES chapters(id),
  position_ms INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Volume Automation Points
CREATE TABLE automation_points (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  time_ms INTEGER NOT NULL,
  value REAL NOT NULL, -- 0.0 to 1.0 (gain multiplier)
  curve TEXT DEFAULT 'linear', -- 'linear' | 'exponential'
  created_at TEXT DEFAULT (datetime('now'))
);

-- Pronunciation Lexicon
CREATE TABLE pronunciation_rules (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id), -- NULL = global
  word TEXT NOT NULL,
  phoneme TEXT, -- IPA or custom
  alias TEXT, -- replacement text
  created_at TEXT DEFAULT (datetime('now'))
);

-- Render Jobs
CREATE TABLE render_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending', -- 'pending' | 'running' | 'completed' | 'failed'
  type TEXT DEFAULT 'full', -- 'full' | 'chapter' | 'preview'
  chapter_id TEXT REFERENCES chapters(id),
  output_path TEXT,
  progress REAL DEFAULT 0.0,
  error_message TEXT,
  qc_report TEXT, -- JSON
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Export Packages
CREATE TABLE exports (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  target TEXT DEFAULT 'acx', -- 'acx' | future targets
  status TEXT DEFAULT 'pending',
  output_path TEXT,
  validation_report TEXT, -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);

-- Audit Log
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT REFERENCES books(id),
  action TEXT NOT NULL,
  details TEXT, -- JSON
  elevenlabs_request_id TEXT,
  characters_used INTEGER,
  cost_estimate REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_chapters_book ON chapters(book_id, sort_order);
CREATE INDEX idx_segments_chapter ON segments(chapter_id, sort_order);
CREATE INDEX idx_clips_track ON clips(track_id, position_ms);
CREATE INDEX idx_audio_assets_hash ON audio_assets(prompt_hash);
CREATE INDEX idx_automation_track ON automation_points(track_id, time_ms);
CREATE INDEX idx_audit_book ON audit_log(book_id, created_at);
```
