# UI Spec — Audiobook Maker

## Layout
Single-page app with a sidebar nav and main content area.

```
┌──────┬──────────────────────────────────────────┐
│      │                                          │
│  N   │           Main Content Area              │
│  A   │                                          │
│  V   │  (switches between screens below)        │
│      │                                          │
│  B   │                                          │
│  A   │                                          │
│  R   │                                          │
│      │                                          │
└──────┴──────────────────────────────────────────┘
```

## Screens

### 1. Dashboard
- List of book projects (cards with cover art, title, progress)
- "New Book" button → create dialog (title, author, narrator)
- Quick stats: total chapters, generated segments, render status

### 2. Manuscript Editor
- Left panel: chapter list (reorderable, add/delete)
- Center: rich text editor for selected chapter
- Right panel: segment breakdown
  - Each paragraph/dialogue line is a segment
  - Color-coded by assigned character
  - Click to assign character, edit text, add emotion tags
  - Generate/regenerate button per segment
  - Mini waveform + play button for generated audio

### 3. Voice Manager
- Top: character list for this book (add/edit/delete)
- Per character card:
  - Name, role (narrator/character)
  - Voice selector (search ElevenLabs library, preview)
  - Model selector (v3, multilingual_v2, flash_v2.5, turbo_v2.5)
  - Sliders: stability, similarity, style, speed
  - Speaker boost toggle
- Bottom: pronunciation lexicon editor (table: word → phoneme/alias)

### 4. Timeline Editor
- Top toolbar: zoom, snap toggle, play/pause/stop, loop, record position
- Track headers (left):
  - Track name, type icon, gain slider, pan knob
  - Mute/Solo/Lock buttons
  - Color indicator
- Timeline area (center, canvas-rendered):
  - Time ruler with chapter markers
  - Tracks with clip waveforms
  - Clips: draggable, resizable edges (trim), right-click menu
  - Fade handles on clip edges
  - Automation lane (expandable per track): draggable points
- Bottom: transport bar with current time, total duration, chapter jump

### 5. QC & Render
- Render controls: render full book or selected chapter
- Progress bar with status
- QC Report table per chapter:
  - Duration, RMS (dB), True Peak (dB), LUFS, Noise Floor (dB)
  - Pass/Fail indicators per ACX spec
  - Suggested fixes for failures
- Waveform preview of rendered output

### 6. Export
- Target selector (ACX/Audible — only option in v1)
- Pre-flight checklist:
  - ✓/✗ All chapters rendered
  - ✓/✗ QC passed
  - ✓/✗ Opening credits present
  - ✓/✗ Closing credits present
  - ✓/✗ Cover art meets specs (min 2400x2400, square, JPEG/PNG)
- Export button → generates ZIP
- Validation report with any warnings
- Download button

## Key Interactions
- **Segment generation**: click generate → shows spinner → waveform appears → auto-placed on timeline
- **Timeline playback**: spacebar play/pause, click to seek, scroll to zoom
- **Clip editing**: drag to move, edge-drag to trim, double-click for properties dialog
- **Ducking**: when music track exists, narration clips auto-trigger ducking visualization
- **Chapter navigation**: click chapter markers to jump, or use chapter dropdown
