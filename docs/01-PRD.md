# Audiobook Maker — Product Requirements Document

## Vision
A single-user web app for producing publisher-ready audiobooks using ElevenLabs' full API surface (TTS v3, Text-to-Dialogue, Sound Effects, Music). Hosted on Replit, optimized for one author/producer workflow.

## User Stories (MVP)

### Manuscript Management
- As a producer, I can create a Book project with metadata (title, author, narrator, ISBN, cover art)
- I can import DOCX/TXT/Markdown manuscripts and have them auto-split into chapters
- I can manually edit chapter boundaries and clean up text (smart quotes, scene breaks)
- I can define a pronunciation lexicon (global + per-voice word overrides)

### Character & Voice System
- I can create character roles (Narrator, Character A, Character B, etc.)
- I can assign ElevenLabs voices to each role with default performance settings
- I can browse/search the ElevenLabs voice library from within the app
- I can configure per-role: model, stability, similarity, style, speed, speaker boost

### TTS Generation
- I can generate audio for any text segment using ElevenLabs TTS (v3 preferred, fallback to multilingual_v2)
- I can use Text-to-Dialogue API for multi-speaker scenes
- I can insert emotion/audio tags ([sad], [whispering], [laughing]) in v3 mode
- I can preview audio via streaming before committing a full render
- I can regenerate any segment without losing timeline edits
- Previous/next text stitching is used automatically for continuity

### Sound Effects & Music
- I can generate SFX from text prompts with duration/looping controls
- I can generate music beds from text prompts (up to 5 min)
- Generated assets are cached by prompt+settings hash to avoid duplicate API spend

### Timeline Editor
- I see a multi-track DAW-like timeline with waveform display
- Track types: Narration, Dialogue, SFX, Music, Imported Audio
- I can trim, split, move, fade in/out clips
- I can adjust per-clip gain and pan
- I can mute/solo/lock tracks
- I can set chapter markers on the timeline
- Music auto-ducks under narration with configurable attack/release
- Volume automation lanes per track
- All edits are non-destructive (metadata until render)

### Rendering & QC
- I can render per-chapter or full-book audio offline via FFmpeg
- Render applies loudness normalization to ACX specs (RMS -23 to -18 dB, peak ≤ -3 dB, noise floor ≤ -60 dB)
- A QC report is generated: RMS, true peak, LUFS, noise floor, clipping detection per chapter
- I can review and fix issues before export

### Export (ACX/Audible)
- I can export an ACX-compliant package: per-chapter MP3 files (192kbps CBR, 44.1kHz, mono or stereo)
- Files are named per ACX convention
- Opening/closing credits files are generated
- Metadata is embedded (ID3 tags, cover art)
- Validation checks run before export with clear pass/fail + suggested fixes

## MVP Scope
- Single user, password-gated
- One publisher target: ACX/Audible
- Browser-based timeline (WebAudio)
- SQLite + local disk storage (Replit-friendly)
- ElevenLabs API: TTS, Text-to-Dialogue, Sound Effects, Music

## Explicit Non-Goals (v1)
- Multi-user / team collaboration
- Findaway, Apple Books, Google Play exports (future)
- Real-time collaborative editing
- Mobile-optimized UI
- Voice cloning workflow (can use pre-cloned voices, but no cloning UI)
- Paid SFX/music licensing tracking
- Offline/desktop mode
