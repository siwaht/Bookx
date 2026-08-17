# Audiobook capability map for Bookx

Research basis: official ElevenLabs Audiobooks and Studio documentation, accessed 2026-08-17.

## Core creation workflow

ElevenLabs supports creating an audiobook from a manuscript upload, selecting a narration style, choosing a model, parsing the manuscript into metadata and chapters, reviewing the cover, reviewing detected structural sections, casting voices, adding pronunciation rules, and creating the audiobook. Supported source material in the current guide includes EPUB.

## Production capabilities

The editor supports paragraph-level narration generation and playback, selection-based or until-end generation modes, editing text and timing, changing voice and model settings, adding music and sound effects on separate timeline tracks, and previewing generated audio. A contextual sidebar provides playback controls, voice/model selection, override settings, generation history, and AI tools.

## Casting and pronunciation

Character Casting detects characters, proposes voices, previews voices on real dialogue, and updates all lines for a character when that character's voice changes. The Voice Library can be searched and filtered by language, accent, category, gender, and age. Pronunciation tooling surfaces unusual terms, supports aliases and phoneme rules, allows context previews, and supports reusable pronunciation dictionaries.

## Organization and delivery

Audiobooks are organized by chapters, which can be created, renamed, reordered, and generated individually. The product distinguishes original audio from dynamic narration. Export can cover the full project or individual chapters, audio or timeline data/subtitles, single file or chapter ZIP, and MP3 or WAV. Publishing can target ElevenReader and partner platforms. Series management groups related books with metadata and author information.

## Bookx mapping

Bookx already has routes/components for manuscript editing, cast management, pronunciation, audio studio, generation, background enhancement, timeline, quality control, export, library, series, and settings. The high-impact gap is not raw backend surface area but the experience: a unified audiobook setup flow, richer manuscript parsing review, first-class chapter/section management, contextual generation controls, generation history, clearer publishing/export choices, and a more focused bookshelf.

## Sources

1. https://elevenlabs.io/docs/eleven-creative/products/audiobooks — official Audiobooks documentation.
2. https://elevenlabs.io/audiobooks — official Audiobooks product overview.
3. https://elevenlabs.io/blog/introducing-audiobooks-in-elevencreative — official Audiobooks launch overview.
4. https://elevenlabs.io/docs/help-center/product/studio — official Studio product documentation index.
