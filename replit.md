# Audiobook Maker

## Overview
A professional audiobook production tool powered by ElevenLabs API. Users can import manuscripts, assign voices, generate audio, edit on a multi-track timeline, and export ACX/Audible-ready packages.

## Recent Changes
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
