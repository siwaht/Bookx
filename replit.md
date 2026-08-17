# Audiobook Maker

## Overview
A professional audiobook production tool powered by ElevenLabs API. Users can import manuscripts, assign voices, generate audio, edit on a multi-track timeline, and export ACX/Audible-ready packages.

## Recent Changes
- 2026-08-05: Re-imported from GitHub and set up again: bumped `concurrently` to ^9.2.1 (old lockfile pinned `shell-quote@1.8.3`, blocked by npm security policy), created `.env` from `.env.example` (APP_PASSWORD set to a random value in the untracked `.env`; TTS/LLM keys left empty, set them in the app's Settings page or `.env`).
- 2026-05-03: Major timeline redesign in `client/src/pages/TimelinePage.tsx`:
  - Visual polish: refined playhead, vertical grid lines, top-accent stripes on clips, hover lift, gradient ruler, marker pins.
  - New features: track lock (with hatched lane pattern, blocked drag/trim and mutation guards across delete/split/duplicate/cut/paste/inspector/crossfade/batch ops), loop region (Shift+drag on ruler, wrap-around in both togglePlay and seekTo ticks).
  - Better waveform/playback: per-clip canvas waveform from cached AudioBuffer with in-flight load dedupe; drag-to-scrub on ruler.
  - Layout: docked clip inspector as flex sibling instead of floating overlay.
  - Perf: load dedupe map prevents redundant fetch/decode for shared audio assets.
- 2026-02-12: Initial Replit setup - configured Vite on port 5000 with proxy to backend on 3001, installed ffmpeg

## Project Architecture
- **Monorepo** with npm workspaces: `client/` and `server/`
- **Frontend**: React + TypeScript + Vite + Zustand + TanStack Query (port 5000 in dev)
- **Backend**: Express + TypeScript (port 3001), uses sql.js (SQLite in-memory/file)
- **Database**: SQLite via sql.js, stored in `data/` directory
- **External API**: ElevenLabs for TTS, SFX, and music generation
- **Auth**: Simple password gate via APP_PASSWORD env var

## Key Files
- `client/vite.config.ts` - Frontend dev server config (port 5000, proxy to backend)
- `server/src/index.ts` - Backend entry point
- `server/src/db/schema.ts` - Database schema and initialization
- `server/src/middleware/auth.ts` - Authentication middleware

## Environment Variables
- `PORT` - Backend port (default: 3001)
- `DATA_DIR` - Data storage directory (default: ./data)
- `NODE_ENV` - Environment mode
- `APP_PASSWORD` (secret) - Password for app login
- `ELEVENLABS_API_KEY` (secret) - ElevenLabs API key for TTS

## Development
- Workflow runs both frontend and backend via `concurrently`
- Frontend proxies `/api` requests to backend at localhost:3001

## Deployment
- Build: `npm run build` (compiles client + server)
- Run: `npm run start` (serves built client from server)
- Target: VM (stateful, SQLite database)
