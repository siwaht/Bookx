# Audiobook Maker MCP Server

An MCP server that exposes audiobook and podcast generation as tools for AI agents. Uses ElevenLabs for TTS, SFX, and music generation.

## Quick Start

```json
{
  "mcpServers": {
    "audiobook-maker": {
      "command": "npx",
      "args": ["tsx", "server/src/mcp-server.ts"],
      "env": { "DATA_DIR": "./data" }
    }
  }
}
```

## Typical Workflow

1. `create_book` → Create a project
2. `add_chapter` or `import_text` → Add content
3. `add_character` → Assign ElevenLabs voices (use `list_voices` or `search_voice_library` to find voice IDs)
4. `add_segments` → Break chapters into dialogue segments per character
5. `generate_chapter_audio` → Generate TTS for all segments
6. `export_chapter_audio` or `export_book_audio` → Get final MP3

**Shortcut:** Use `quick_podcast` for one-shot generation without any DB setup.

**AI-assisted:** Use `ai_parse_chapters` to auto-detect characters and assign segments from raw text (requires an LLM API key).

**Combo:** Use `generate_and_populate` to generate TTS + build timeline in one call.

## Tools (40)

### Project Management
- `list_books` — List all projects
- `create_book` — Create audiobook/podcast project
- `get_project_status` — Chapters, characters, segment counts
- `delete_book` — Delete project and all data

### Chapters
- `add_chapter` — Add chapter with text
- `list_chapters` — List chapters with segment counts
- `delete_chapter` — Remove chapter
- `reorder_chapters` — Reorder by ID array
- `import_text` — Import raw text, auto-split into chapters

### Characters
- `add_character` — Add character with ElevenLabs voice
- `update_character` — Update voice settings
- `list_characters` — List all characters

### Segments
- `add_segments` — Add dialogue segments (supports v3 tags like `[whisper]`, `[dramatic pause]`)
- `list_segments` — List segments with audio status
- `update_segment` — Edit text or reassign character
- `delete_segments` — Clear all segments in a chapter

### TTS Generation
- `generate_chapter_audio` — Batch generate with caching + pronunciation rules
- `generate_single_segment` — Generate one segment
- `generate_and_populate` — Generate TTS + populate timeline in one step

### Export
- `export_chapter_audio` — Concatenate chapter to MP3 (configurable silence gaps)
- `export_book_audio` — Export full book as MP3
- `quick_podcast` — One-shot: transcript + voice IDs → MP3

### Pronunciation
- `add_pronunciation_rule` — IPA phoneme or alias replacement
- `list_pronunciation_rules` — List all rules
- `delete_pronunciation_rule` — Remove a rule

### Timeline / Composition
- `populate_timeline` — Auto-populate from generated segments
- `create_track` — Add narration/SFX/music track
- `list_tracks` — List tracks with clips
- `add_clip` — Place audio clip on timeline
- `update_track` — Adjust gain, pan, mute, solo

### ElevenLabs
- `list_voices` — Your account voices
- `search_voice_library` — Community/shared voices (filter by gender, language, use case)
- `add_shared_voice` — Add community voice to your library
- `get_capabilities` — Available models and features
- `get_usage` — Character count and subscription info
- `generate_sfx` — Sound effects from text prompt
- `generate_music` — Background music from text prompt

### Audio Library
- `list_audio_assets` — All assets (TTS, SFX, music, imported)
- `delete_audio_asset` — Remove asset and file

### AI-Assisted
- `ai_parse_chapters` — Auto-detect characters + assign segments using LLM
- `ai_suggest_v3_tags` — Suggest expressive v3 tags for text

### Settings
- `get_settings` — View current settings (keys masked)
- `update_setting` — Set API keys and preferences

## Pause / Silence Control

Pauses between segments are controlled three ways:

1. **Gap parameters** on `export_chapter_audio`, `export_book_audio`, `populate_timeline`, and `generate_and_populate` — `gap_between_segments_ms` (default 300ms) and `gap_between_chapters_ms` (default 2000ms)
2. **ElevenLabs v3 tags** in segment text: `[dramatic pause]`, `[pauses for effect]`, `[slow]`, `[languid]`
3. **Timeline clip positioning** — manual control via `add_clip` with `position_ms`

## ElevenLabs v3 Tags

Embed these in segment text for expressive narration:

- Emotions: `[happy]`, `[sad]`, `[angry]`, `[excited]`, `[mysterious]`, `[dramatic]`
- Vocal: `[whisper]`, `[shout]`, `[laugh]`, `[sigh]`, `[gasp]`
- Style: `[conversational]`, `[formal]`, `[theatrical]`, `[commanding]`, `[gentle]`
- Rhythm: `[slow]`, `[fast]`, `[dramatic pause]`, `[building tension]`
