# Implementation Plan — Audiobook Maker

## Milestone 1: Foundation (Week 1-2)
- Project scaffolding (monorepo: client + server)
- SQLite schema + migrations
- Auth middleware (password gate)
- Book CRUD API + UI dashboard
- Manuscript import (DOCX via mammoth, TXT, Markdown)
- Chapter parsing + text editor

**Risk**: DOCX parsing edge cases → Mitigation: start with TXT/MD, DOCX as best-effort

## Milestone 2: ElevenLabs Integration (Week 3-4)
- ElevenLabs adapter with capability detection
- Voice browser + search UI
- Character/role system with voice assignment
- TTS generation (v3 + fallback)
- Text-to-Dialogue for multi-speaker scenes
- Segment-level generate/preview/regenerate
- Request caching + dedup
- Cost estimation + audit logging

**Risk**: API rate limits during bulk generation → Mitigation: queue with concurrency control, backoff

## Milestone 3: Timeline Editor (Week 5-7)
- Canvas-based timeline renderer
- WebAudio playback engine
- Track management (add/remove/reorder)
- Clip placement, drag, trim, split
- Fade in/out handles
- Gain/pan per clip and per track
- Mute/solo/lock
- Chapter markers
- Volume automation lanes
- Auto-ducking (music under narration)

**Risk**: Canvas performance with many clips → Mitigation: virtual rendering (only visible clips), waveform pre-computation

## Milestone 4: SFX & Music (Week 8)
- SFX generation UI (prompt, duration, looping)
- Music generation UI (prompt, duration)
- Asset library panel (browse generated/imported assets)
- Drag from library to timeline
- Import external audio files

**Risk**: Music API availability → Mitigation: graceful disable if not available on user's tier

## Milestone 5: Render & QC (Week 9-10)
- FFmpeg render pipeline (server-side)
- Per-chapter + full-book render
- Loudness normalization (ACX targets)
- QC analysis (RMS, true peak, LUFS, noise floor, clipping)
- QC report UI with pass/fail
- Re-render workflow

**Risk**: FFmpeg not available on Replit → Mitigation: use fluent-ffmpeg with static binary, or fallback to WebAudio offline rendering

## Milestone 6: Export & Polish (Week 11-12)
- ACX export package builder
- File naming convention
- ID3 tag embedding
- Cover art embedding
- Opening/closing credits generation
- Validation checks
- ZIP download
- End-to-end testing
- Bug fixes + UX polish

**Risk**: ACX spec changes → Mitigation: config-driven spec presets, easy to update
