# Audio break-up, concurrency and multi-book narration (2026-11-01)

Branch: `improve/audio-concurrency` (from `main` at b998dde). Changes are uncommitted.

## Not verified

The terminal sandbox failed partway through the session ("WindowsSandbox already disposed"), and Node.js under `C:\Program Files\nodejs` was blocked before that. Because of this, none of these ran:

- `pnpm check` (tsc for the app and the worker)
- `pnpm test`
- `pnpm run build`
- a git commit

The local database (`data/bookx.sqlite`) has no projects, segments or jobs left, so there was no run history to analyse. A scratch copy of `data/` sits in `%TEMP%\prosecast-scratch` and can be deleted.

## Changes

### 1. Chapter player stopped and started between lines (client)

`client/src/components/studio/ChapterPlayer.tsx` played a chapter line by line through one `<audio>` element. At every line boundary it swapped `src`, so each new line waited for a request and a decode on top of the scripted pause. On hosted mode the request goes Worker → R2, which makes the wait longer. This matches the "breaks up, stops and starts" report.

- The player now uses two `<audio>` elements. While one line plays, the other loads the next line. When the pause ends, the player switches to the already-buffered element. Events from the standby element are ignored.
- While a run is live, the player used to wait forever on a line that had failed. It now skips failed lines, and stops waiting when the run is no longer live.

### 2. Books narrated together hit provider concurrency limits (server)

New file `server/providerSlots.ts` adds a first-come-first-served cap on concurrent TTS requests per owner and provider. Every narration run, retake and clip in the process shares it. The defaults are ElevenLabs 5 (the account is on the Creator plan, which allows 5 on every model), OpenAI 4, Deepgram 4 and others 2; override them with `TTS_CONCURRENCY`.

`renderSegmentAudio` (`server/ttsRender.ts`) takes a slot before the request timeout starts, and gives it back once the body has been read. Before this change, several books on one ElevenLabs account each sent requests freely, got HTTP 429 `too_many_concurrent_requests`, and backed off. That made runs stall and resume.

### 3. Lines inside a run render in parallel (server)

The segment loop in `driveJob` (`server/narrationWorker.ts`) is now a pool of lanes. The lane count is `NARRATION_RUN_CONCURRENCY` (default 3), capped by the provider's slot limit.

- The cursor is the earliest line still in flight, so a resume rewinds to before anything that was interrupted.
- Pause and cancel abort every lane's request. A pause that is withdrawn quickly re-renders with one fresh controller.
- A fatal failure, or a lane error, stops all lanes before the job is written as failed.
- Each chapter's counts roll up as soon as its last line lands.
- Read-modify-write of `detail` (events and failures) goes through a per-job lock, so lanes cannot drop each other's entries.

Unchanged: one live job per project, the lease timer, "completed only when every planned segment rendered", job and project scoping of pause and cancel, and the fatal kinds.

### 4. "Narrating now" on the dashboard (feature)

- New query `bookx.narrationQueue` lists the owner's queued, running and paused runs across all books.
- New component `client/src/components/NarrationQueue.tsx`, placed on the dashboard above "Recent work". It shows progress, voice and status for each book, with Pause, Resume and Open buttons. It polls every 5 s while something is rendering and every 30 s otherwise.

### Also

- Removed the unused locals `renderedBytes`, `renderedDurationMs` and `currentChapter` from `driveJob`.
- Documented `NARRATION_RUN_CONCURRENCY` and `TTS_CONCURRENCY` in `.env.example`.

## Checked and left alone

- Chunk joins inside one segment: none happen. One request per segment, and text over the limit is refused.
- MP3 and WAV joins: `audioAssembly.ts` strips ID3 and Info frames, refuses mixed formats, and builds silence in the stream's own format.
- Sound mix: `amix` uses `normalize=0`, and the bed is padded and trimmed to the voice's length.
- Range serving: both the local and the R2 paths return 206 with Content-Range and Content-Length.

## Recommended next

- **Trim TTS clip silence.** Each clip's own leading and trailing silence adds to the 150–200 ms pause inside a sentence. Measure it on real segments (`ffmpeg -af silencedetect`). If it is large, trim it at assembly time.
- **Run checks and commit.** Run `pnpm check` and `pnpm test`, then commit the branch. Then do one short paid smoke run with two books at once.
- **Dead code.** `server/_tmp_providers.test.ts` describes itself as temporary. `server/dist/` is an ignored build output from another project. Use `npx knip` for a dead-code pass.
