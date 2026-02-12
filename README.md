# 🎧 Audiobook Maker

A professional audiobook production tool powered by ElevenLabs API. Import manuscripts, assign voices, generate audio, edit on a multi-track timeline, and export ACX/Audible-ready packages.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env and set your ElevenLabs API key + password
cp .env.example .env
# Edit .env with your ELEVENLABS_API_KEY and APP_PASSWORD

# 3. Start development
npm run dev
```

The app runs at `http://localhost:5173` (frontend) proxying to `http://localhost:3001` (backend).

## Workflow

1. **Create a book** on the Dashboard
2. **Import a manuscript** (DOCX, TXT, or Markdown) — auto-splits into chapters
3. **Create characters** on the Voices page, assign ElevenLabs voices with tuned settings
4. **Split chapters into segments** on the Manuscript page, assign characters to each segment
5. **Generate audio** per-segment or batch-generate an entire chapter
6. **Send to Timeline** to auto-populate tracks with clips and chapter markers
7. **Preview playback** with WebAudio directly in the browser
8. **Render** the full book with FFmpeg loudness normalization to ACX specs
9. **Review QC report** (RMS, peak, LUFS, noise floor per chapter)
10. **Export** an ACX-compliant ZIP package

## Features

- **Manuscript Import**: DOCX, TXT, Markdown with auto chapter splitting
- **Voice Management**: Browse ElevenLabs voices, assign to characters, preview with sample text
- **TTS Generation**: v3 (preferred), multilingual v2, flash v2.5 with automatic fallback
- **Batch Generation**: Generate all segments in a chapter with one click
- **Sound Effects**: Generate SFX from text prompts
- **Music Generation**: Create music beds from text prompts
- **Timeline Editor**: Multi-track canvas-based editor with WebAudio playback
- **Auto-Populate**: One-click timeline population from generated segments
- **Render Pipeline**: FFmpeg-based with loudness normalization to ACX specs
- **QC Analysis**: RMS, true peak, LUFS, noise floor, clipping detection
- **ACX Export**: Publisher-ready ZIP with proper naming, metadata CSV, and validation

## Tech Stack

- Frontend: React + TypeScript + Vite + Zustand + TanStack Query
- Backend: Node.js + Express + TypeScript
- Database: SQLite (sql.js — no native deps)
- Audio: FFmpeg (rendering), WebAudio API (browser playback)
- API: ElevenLabs (TTS, SFX, Music)

## Requirements

- Node.js 18+
- FFmpeg (for rendering — optional for development)
- ElevenLabs API key (paid tier recommended)
