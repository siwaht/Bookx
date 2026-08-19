# Bookx QA Inventory

## Dashboard and navigation

- [ ] Brand home button returns to the project shelf.
- [ ] Projects, Library, Series, search, profile, and view-all controls behave as intended.
- [ ] Exact New project and Import audio entry points open the appropriate flows.
- [ ] Each recent project card opens the intended workspace.

## Project creation and import

- [ ] Creation wizard validates required Basics fields and advances through Basics, Narration, and Review.
- [ ] Audiobook and podcast type selection updates the review and create action.
- [ ] Single-cast and multi-cast narration styles are selectable.
- [ ] Voice provider, voice model, language-model provider, language model, language, and manuscript selection controls work.
- [ ] Create project adds a project to the shelf and opens its workspace.
- [ ] Import audio accepts supported selection flow and returns a clear state.

## Production workspace

- [ ] Back navigation returns to the project shelf.
- [ ] Write, Cast voices, Pronunciation, Generate, Audio studio, Review, Publish & export, and Settings tabs render.
- [ ] Manuscript chapter selection, segment split, preview, advanced tools, and continue navigation work.
- [ ] Casting search, voice selection, and auto-cast work.
- [ ] Pronunciation rule entry and add action work.
- [ ] Generation chapter selection, full/selected generation, cancellation/resume state, and history controls work.
- [ ] Studio playback, podcast guest/cast controls, chapter batching, music, sound-effect, and mix controls work.
- [ ] Review controls and export format controls work for exact ACX, Podcast, and InAudio package labels.

## Provider and API behavior

- [ ] Provider catalog returns configured capability-specific models.
- [ ] Persistent provider defaults, fallback choices, custom endpoint metadata, and validation checks work.
- [ ] TTS, STT, and manuscript organisation routes resolve compatible providers and degrade safely.
- [ ] ElevenLabs, Deepgram, Cloudflare, and OpenAI credential checks pass without exposing secrets.

## Presentation and release

- [ ] Desktop, tablet, and mobile layouts retain readable controls and no overflow.
- [ ] Unauthenticated preview has intentional fallback behavior and protected connection actions request authentication.
- [ ] Permanent domain loads and core entry points render.
