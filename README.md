# 🎧 Audiobook Maker

A professional audiobook and podcast production tool powered by ElevenLabs API. Import manuscripts, assign AI voices, generate audio with v3 tags, edit on a multi-track timeline, and export ACX/Audible-ready packages.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env and configure
cp .env.example .env
# Edit .env: set APP_PASSWORD, optionally set API keys (or use Settings page)

# 3. Build and start
npm run build
npm start
```

The app runs at `http://localhost:3001`. In development, use `npm run dev` for hot-reload (frontend on port 5000, backend on 3001).

## API Keys

Configure via the Settings page in the app, or set in `.env`:

- **ElevenLabs** (required): TTS, SFX, and music generation
- **OpenAI / Mistral / Gemini** (one required): AI auto-assign (character detection, segment assignment, SFX/music suggestions)

## Workflow

1. **Create a project** (audiobook or podcast) on the Dashboard
2. **Import a manuscript** (EPUB, DOCX, TXT, MD, HTML) — auto-splits into chapters
3. **AI Auto-Assign** — detects characters, assigns segments, suggests SFX & music
4. **Create characters** on the Voices page, assign ElevenLabs voices
5. **Generate audio** per-segment or batch-generate entire chapters
6. **Audio Studio** — generate SFX and music, use v3 audio tags
7. **Send to Timeline** — auto-populate tracks with clips and chapter markers
8. **Render** with FFmpeg loudness normalization to ACX specs
9. **QC report** — RMS, peak, LUFS, noise floor per chapter
10. **Export** ACX-compliant ZIP package

## Features

- **Manuscript Import**: EPUB, DOCX, TXT, Markdown, HTML with auto chapter splitting
- **AI Script Parsing**: Auto-detect characters, assign segments, suggest SFX & music cues
- **Voice Management**: Browse/search ElevenLabs voices, add by voice ID, preview, fine-tune
- **TTS Generation**: v3 with audio tags, multilingual v2, flash v2.5
- **V3 Audio Tags**: Emotion, vocal effects, style, narrative, and rhythm tags
- **Sound Effects**: Generate SFX from text prompts with duration/loop controls
- **Music Generation**: Create music beds with instrumental/vocal options
- **Timeline Editor**: Multi-track canvas editor with drag, trim, split, keyboard shortcuts
- **Render Pipeline**: FFmpeg-based with loudness normalization to ACX specs
- **QC Analysis**: RMS, true peak, LUFS, noise floor, clipping detection
- **ACX Export**: Publisher-ready ZIP with proper naming and metadata
- **Podcast Support**: Multi-speaker formats, interview, panel, conversation

## Tech Stack

- Frontend: React 18 + TypeScript + Vite + Zustand + TanStack Query
- Backend: Node.js + Express + TypeScript
- Database: SQLite (sql.js — no native deps, Replit-compatible)
- Audio: FFmpeg (rendering), WebAudio API (browser playback)
- APIs: ElevenLabs (TTS/SFX/Music), OpenAI/Mistral/Gemini (AI parsing)

## Requirements

- Node.js 18+
- FFmpeg (for rendering — optional for development)
- ElevenLabs API key (paid tier recommended)
- At least one LLM API key for AI features (OpenAI, Mistral, or Gemini)
