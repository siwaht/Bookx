# System Design — Audiobook Maker

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Browser (React SPA)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │Manuscript │ │  Voices  │ │ Timeline │ │ Export │ │
│  │  Editor   │ │  Panel   │ │  (Canvas │ │  & QC  │ │
│  │          │ │          │ │ +WebAudio)│ │        │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│                    ↕ REST API                        │
└─────────────────────────────────────────────────────┘
                         │
┌─────────────────────────────────────────────────────┐
│              Node.js / Express Backend               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │  Project  │ │ElevenLabs│ │  Render  │ │  Auth  │ │
│  │  CRUD     │ │ Adapter  │ │  Engine  │ │(simple)│ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│       ↕              ↕            ↕                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │  SQLite   │ │ElevenLabs│ │  FFmpeg  │            │
│  │  (better- │ │   API    │ │  (child  │            │
│  │  sqlite3) │ │          │ │  process)│            │
│  └──────────┘ └──────────┘ └──────────┘            │
│       ↕                          ↕                   │
│  ┌──────────────────────────────────────┐           │
│  │     Local Disk (Replit persistent)    │           │
│  │  /data/audio/  /data/exports/         │           │
│  └──────────────────────────────────────┘           │
└─────────────────────────────────────────────────────┘
```

## Components

### Frontend (React + TypeScript)
- **Project Dashboard**: list/create/open books
- **Manuscript Editor**: chapter list, text editor, character tagging
- **Voice Manager**: browse ElevenLabs voices, assign to characters, configure settings
- **Timeline Editor**: Canvas-based waveform rendering, WebAudio playback, drag/drop clips
- **QC & Export**: render controls, QC report viewer, export wizard

### Backend (Node.js + Express + TypeScript)
- **Auth Middleware**: simple password check via env var
- **Project API**: CRUD for books, chapters, characters, clips, timeline state
- **ElevenLabs Adapter**: unified wrapper with capability detection, retry/backoff, rate limiting, caching
- **Render Engine**: FFmpeg-based offline render with loudness normalization
- **Export Engine**: ACX package builder with validation

### ElevenLabs Adapter Layer
- Runtime model detection via `GET /v1/models`
- Capability flags: `hasV3`, `hasDialogue`, `hasSFX`, `hasMusic`
- Automatic fallback: v3 → multilingual_v2 → flash_v2_5
- Request deduplication by hash(text + voice_id + model + settings)
- Cost estimation before generation (character count × model rate)
- Rate limit tracking via response headers
- Retry with exponential backoff (429, 500, 503)

### Render Pipeline
1. Collect timeline state (clips, positions, gains, fades, automation)
2. For each chapter marker range, build FFmpeg filter graph
3. Apply: gain, fade, pan, ducking (sidechain-style via compand)
4. Normalize to ACX loudness targets
5. Output per-chapter WAV masters → encode to MP3 192kbps CBR 44.1kHz
6. Run QC analysis pass
7. Package for export

## Data Flow
```
Import DOCX → Parse chapters → Store in DB
                    ↓
Assign voices → Configure settings per character
                    ↓
Generate TTS → ElevenLabs API → Cache audio files on disk
                    ↓
Arrange on timeline → Edit clips (non-destructive)
                    ↓
Render → FFmpeg → WAV masters → MP3 deliverables
                    ↓
QC Analysis → Report → Fix issues → Re-render if needed
                    ↓
Export ACX package → Validate → Download ZIP
```
