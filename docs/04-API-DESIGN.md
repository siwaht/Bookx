# API Design — Audiobook Maker

## Internal REST API

### Auth
```
POST /api/auth/login          { password } → { token }
GET  /api/auth/verify          → 200 | 401
```

### Books
```
GET    /api/books              → Book[]
POST   /api/books              { title, author, ... } → Book
GET    /api/books/:id          → Book (with chapters, characters)
PUT    /api/books/:id          { ...updates } → Book
DELETE /api/books/:id          → 204
POST   /api/books/:id/import   multipart(file) → { chapters[] }
```

### Chapters
```
GET    /api/books/:bookId/chapters           → Chapter[]
PUT    /api/books/:bookId/chapters/:id       { title, text, sort_order }
POST   /api/books/:bookId/chapters/reorder   { ids[] }
DELETE /api/books/:bookId/chapters/:id       → 204
```

### Characters
```
GET    /api/books/:bookId/characters         → Character[]
POST   /api/books/:bookId/characters         { name, role, voice_id, ... }
PUT    /api/books/:bookId/characters/:id     { ...updates }
DELETE /api/books/:bookId/characters/:id     → 204
```

### Segments
```
GET    /api/chapters/:chapterId/segments     → Segment[]
POST   /api/chapters/:chapterId/segments     { text, character_id, sort_order }
PUT    /api/segments/:id                     { text, character_id }
DELETE /api/segments/:id                     → 204
POST   /api/segments/:id/generate            → { audio_asset_id, duration_ms }
POST   /api/segments/:id/preview             → streaming audio
```

### Timeline
```
GET    /api/books/:bookId/tracks             → Track[] (with clips)
POST   /api/books/:bookId/tracks             { name, type }
PUT    /api/tracks/:id                       { gain, pan, muted, ... }
DELETE /api/tracks/:id                       → 204
POST   /api/tracks/:trackId/clips            { audio_asset_id, position_ms, ... }
PUT    /api/clips/:id                        { position_ms, trim_start_ms, gain, ... }
DELETE /api/clips/:id                        → 204
GET    /api/books/:bookId/chapter-markers     → ChapterMarker[]
PUT    /api/books/:bookId/chapter-markers     { markers[] }
GET    /api/tracks/:trackId/automation        → AutomationPoint[]
PUT    /api/tracks/:trackId/automation        { points[] }
```

### ElevenLabs (proxied)
```
GET    /api/elevenlabs/capabilities          → { models[], hasV3, hasSFX, hasMusic, ... }
GET    /api/elevenlabs/voices                → Voice[] (cached 5 min)
GET    /api/elevenlabs/voices/search?q=      → Voice[]
POST   /api/elevenlabs/tts                   { text, voice_id, model_id, settings } → audio_asset
POST   /api/elevenlabs/tts/stream            { text, voice_id, ... } → streaming audio
POST   /api/elevenlabs/dialogue              { text, voice_assignments } → audio_asset
POST   /api/elevenlabs/sfx                   { prompt, duration, looping } → audio_asset
POST   /api/elevenlabs/music                 { prompt, duration } → audio_asset
GET    /api/elevenlabs/usage                 → { characters_used, characters_limit, ... }
```

### Pronunciation
```
GET    /api/books/:bookId/pronunciation      → Rule[]
POST   /api/books/:bookId/pronunciation      { word, phoneme, alias, character_id }
PUT    /api/pronunciation/:id                { ...updates }
DELETE /api/pronunciation/:id                → 204
```

### Render & QC
```
POST   /api/books/:bookId/render             { type: 'full' | 'chapter', chapter_id? }
GET    /api/render-jobs/:id                  → { status, progress, qc_report }
GET    /api/render-jobs/:id/download         → file stream
```

### Export
```
POST   /api/books/:bookId/export             { target: 'acx' }
GET    /api/exports/:id                      → { status, validation_report }
GET    /api/exports/:id/download             → ZIP file stream
```

## ElevenLabs Adapter — Capability Detection Strategy

```typescript
interface ElevenLabsCapabilities {
  models: ModelInfo[];
  hasV3: boolean;
  hasDialogue: boolean;
  hasSFX: boolean;
  hasMusic: boolean;
  maxCharacters: Record<string, number>;
  concurrencyLimits: { current: number; max: number };
}

// On startup + every 30 min:
// 1. GET /v1/models → detect available models
// 2. GET /v1/user/subscription → detect tier + limits
// 3. Set capability flags
// 4. If eleven_v3 not available → fallback to eleven_multilingual_v2
// 5. If SFX/Music endpoints 404 → disable those features in UI
```

## Request Deduplication & Caching

```
hash = sha256(JSON.stringify({
  text: normalizedText,
  voice_id,
  model_id,
  voice_settings,
  seed
}))

// Before API call: check audio_assets.prompt_hash
// If match exists and file on disk → return cached asset
// Else → call API, store result, log to audit
```
