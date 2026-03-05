# 🎧 Audio Producer

A professional audiobook and podcast production tool with multi-provider TTS support. Import manuscripts, assign AI voices from ElevenLabs, OpenAI, Google Cloud TTS, or Amazon Polly, generate audio, edit on a multi-track timeline, and export ACX/Audible-ready packages.

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

## TTS Providers

Configure via the Settings page or `.env`:

| Provider | Voices | Best For |
|----------|--------|----------|
| ElevenLabs | 100s of voices, voice cloning, v3 tags | Highest quality, SFX, music |
| OpenAI TTS | 10 voices (alloy, echo, fable, nova, etc.) | Fast, affordable, good quality |
| Google Cloud TTS | Journey, Studio, Neural2 voices | Multi-language, natural voices |
| Amazon Polly | Neural voices (Matthew, Joanna, etc.) | AWS integration, SSML support |

## API Keys

- **ElevenLabs**: TTS, SFX, and music generation (primary provider)
- **OpenAI**: GPT models for AI parsing + OpenAI TTS voices
- **Google Cloud TTS**: Google Text-to-Speech voices
- **AWS Access Key + Secret**: Amazon Polly voices
- **Mistral / Gemini**: Alternative LLM providers for AI parsing

## Workflow

1. **Create a project** (audiobook or podcast) on the Dashboard
2. **Import a manuscript** (EPUB, DOCX, TXT, MD, HTML) — auto-splits into chapters
3. **AI Auto-Assign** — detects characters, assigns segments, suggests SFX & music
4. **Create characters** on the Voices page, assign voices from any provider
5. **Generate audio** per-segment or batch-generate entire chapters
6. **Audio Studio** — generate SFX and music with ElevenLabs
7. **Send to Timeline** — auto-populate tracks with clips and chapter markers
8. **Render** with FFmpeg loudness normalization to ACX specs
9. **QC report** — RMS, peak, LUFS, noise floor per chapter
10. **Export** ACX-compliant ZIP package

## Features

- **Multi-Provider TTS**: ElevenLabs, OpenAI, Google Cloud TTS, Amazon Polly
- **Manuscript Import**: EPUB, DOCX, TXT, Markdown, HTML with auto chapter splitting
- **AI Script Parsing**: Auto-detect characters, assign segments, suggest SFX & music
- **Voice Management**: Browse voices per provider, preview, fine-tune settings
- **ElevenLabs v3 Tags**: Emotion, vocal effects, style, narrative, rhythm tags
- **Sound Effects & Music**: Generate SFX and music beds from text prompts
- **Timeline Editor**: Multi-track canvas with drag, trim, split, keyboard shortcuts
- **Render Pipeline**: FFmpeg-based with loudness normalization to ACX specs
- **QC Analysis**: RMS, true peak, LUFS, noise floor, clipping detection
- **ACX Export**: Publisher-ready ZIP with proper naming and metadata
- **Podcast Support**: Multi-speaker formats, interview, panel, conversation

## Tech Stack

- Frontend: React 18 + TypeScript + Vite + Zustand + TanStack Query
- Backend: Node.js + Express + TypeScript
- Database: SQLite (sql.js — no native deps, Replit-compatible)
- Audio: FFmpeg (rendering), WebAudio API (browser playback)
- TTS: ElevenLabs, OpenAI, Google Cloud TTS, Amazon Polly
- AI: OpenAI/Mistral/Gemini (script parsing)

## Requirements

- Node.js 18+
- FFmpeg (for rendering — optional for development)
- At least one TTS API key (ElevenLabs recommended for full features)
- At least one LLM API key for AI features (OpenAI, Mistral, or Gemini)
