# Prosecast audio break-up fix brief (2026-10-03)

This is a diagnose-then-fix task with an ambiguous, intermittent symptom. The root cause is unknown and may sit anywhere in the audio path: TTS rendering, segment storage, chapter assembly, sound-design mixing, export, serving (local storage proxy or Cloudflare R2 through the Worker), client playback, or the narration job loop itself. Front-load an evidence-based investigation before any code change. Gate the implementation with a reviewer, and put the reviewer last in the loop.

## The user's report (verbatim)

> "Seems to be some issues with the audio generation. Sometimes it breaks up in between, stops, and starts so you need to see where the error is happening and you need to fix it."

There are two readings. Investigate both; either or both may be true:

- (A) The audio itself is broken. Narration that was generated, assembled, mixed, exported or played back has gaps, cuts off mid-word or mid-sentence, drops out, stutters, or restarts.
- (B) The generation run is broken. A narration run stalls, pauses or restarts by itself partway through, then carries on.

The orchestrator has asked the user whether they use local or hosted mode, where they hear the problem (in-app player while a run continues, a chapter or segment preview, a downloaded export, a sound-design mix), and which TTS provider and model they use. Answers may be relayed to the running step. Until then, cover all of these.

Don't declare the issue "not reproducible" or "already fine" from reading code. Gather runtime evidence. If something can't be reproduced, record exactly what was checked, and still fix the defects that evidence confirms (a deterministic repro script, ffmpeg analysis output, a failing request, a browser trace).

## 0. Isolation: work in a dedicated git worktree

Two other Kiro sessions may be running against this repo right now:

- "Frontend visual polish" edits client/ in place in the main checkout (c:\Users\asif6\Documents\Bookx, branch `main`, uncommitted). Its reviewer rejects any logic change it sees in `git diff -- client`. Its dev server uses ports 3000, 3001, 5173 or 8787. Brief: c:\Users\asif6\Documents\Bookx\.agents\tasks\frontend-polish-2026-10-03\brief.md.
- "Audio studio upgrades" works in c:\Users\asif6\Documents\Bookx\.worktrees\audio-studio-upgrades on branch feat/audio-studio-upgrades, with port 3210 and scratch folder $env:TEMP\prosecast-audio-upgrades. It is building a chapter player, chapter regenerate, progress and ETA, live model catalogs, Eleven v4 direction, and SFX and music editing, so it will touch many of the same narration and sound files. Brief: c:\Users\asif6\Documents\Bookx\.agents\tasks\audio-studio-upgrades-2026-10-03\brief.md. Sections 1 and 4 there are useful context.

Never write to either session's worktree or task folder, and never stop processes you didn't start.

Setup:

- Confirm `git -C c:\Users\asif6\Documents\Bookx rev-parse main`. It was 1374868 when this brief was written.
- `git -C c:\Users\asif6\Documents\Bookx worktree add c:\Users\asif6\Documents\Bookx\.worktrees\audio-breakup-fix -b fix/audio-breakup main`
- `.worktrees/` is already in c:\Users\asif6\Documents\Bookx\.git\info\exclude. Don't add it again, and don't edit the tracked .gitignore.
- Run `pnpm install --frozen-lockfile` with the worktree as cwd. Never touch the main checkout's node_modules.

Rules for every step:

- Step agents start in the main checkout. Use absolute paths under the worktree, and pass the worktree as cwd for every command.
- Never edit, format or build files in the main checkout. The only exception is artifacts in this task folder: c:\Users\asif6\Documents\Bookx\.agents\tasks\audio-breakup-fix-2026-10-03\ (untracked).
- Don't run any git command that changes the main checkout or the `main` ref: checkout, switch, reset, stash, clean, merge, rebase, `branch -f`, or pull.
- Commit only on fix/audio-breakup inside the worktree: one commit per reviewer-approved change set, with a clear message.
- Never push. A push to main auto-deploys to Cloudflare through .github/workflows/deploy.yml.
- Don't merge into main, don't rebase onto main, and don't remove the worktree. The orchestrator integrates the branch with the user afterwards.

## 1. Product and stack

Prosecast (repo name Bookx) turns a manuscript into an audiobook: import a manuscript, cast voices, run narration (TTS per segment and chapter), add sound design (background music and SFX), and export a package. There's also a podcast path: import audio, transcribe it (STT) and edit the script.

- client/src: React 19, tRPC v11, TanStack Query v5, wouter, shadcn/ui on Radix, Tailwind v4.
- server: Node v24, Express 4, tRPC. Dev server: `pnpm run dev` (`tsx watch server/_core/index.ts`).
- Data: drizzle-orm on local SQLite (node:sqlite), or on Cloudflare D1 through a Worker bridge (server/sqlTransport.ts and server/storage.ts talk to worker/bindings.ts).
- Hosting: a Cloudflare Worker plus a container (worker/*.ts, Dockerfile, wrangler.jsonc), storage in R2, behind Cloudflare Access with one user per identity, so everything is per-owner.
- Audio: ffmpeg via ffmpeg-static. ffprobe may not be bundled; `ffmpeg -i <file> -af silencedetect,astats -f null -` and the `ffmpeg -i` stream info work without it.
- Environment: Windows and PowerShell. Chain commands with `;`, not `&&`. Use $env:TEMP, never %TEMP%.

Starting points, relative to the worktree root. Verify them, since the code may differ.

- Narration run: server/narrationWorker.ts (driveJob, renderWithRetries, the lease renewal timer, stop flags, recovery), narrationPlan.ts, narrationRetry.ts, pronunciation.ts. In server/routers/bookx.ts: startNarrationRun, pauseNarration, cancelNarration, narrationStatus, generateNarrationClip, auditNarration, exportReadiness, getWorkspace.
- TTS: server/tts.ts (previews), ttsRender.ts (render path, per-provider request shapes, chunking, response handling), voiceCatalog.ts, providerRouting.ts, providerCredentials.ts, customProviders.ts.
- Audio checks and joins: server/audioIntegrity.ts, audioAssembly.ts, ffmpeg.ts. server/textSegmentation.ts decides the units (read it, don't change its splitting rules).
- Sound design: server/soundDesign.ts, soundMixer.ts, soundPlan.ts.
- Export: server/audioExport.ts, exportEncoder.ts, zipStream.ts, shared/exportZip.ts.
- Serving: server/storage.ts, server/_core/storageProxy.ts, server/_core/exportDownloads.ts, server/_core/heartbeat.ts, worker/app.ts, worker/bindings.ts, worker/index.ts (container options, sleep and idle behavior).
- Client playback: grep client/src for `<audio`, `new Audio`, `AudioContext`, `.play(` and `refetchInterval`. Likely places: components/NarrationRun.tsx, SoundDesign.tsx, EnhancedProduction.tsx, CastingReview.tsx, ExportPackage.tsx, PodcastScriptEditor.tsx, and pages/Home.tsx (about 89 KB; read it in chunks).
- Tests: server/**/*.test.ts (vitest).
- Notes: docs/, todo.md, verification-findings.md, and .firecrawl/*.json (silence.json, transitions.json, pacing.json and mastering.json may be relevant).
- c:\Users\asif6\Documents\Bookx\e.log exists but is empty.

## 2. Hypotheses to confirm or rule out

This list isn't exhaustive. For each item, record confirmed, ruled out, or can't verify, with evidence and file:function references.

### (A) Audio content and playback

- H1 Chunk joins inside one segment. Text over a provider's per-request limit is split, possibly mid-sentence, and the pieces are joined by byte concatenation. Concatenated MP3s carry several ID3/Xing/LAME headers plus encoder delay padding, which causes gaps, clicks, or players stopping at the first piece's declared length. Concatenated WAVs carry a second RIFF header and a wrong data size.
- H2 Truncated audio accepted as success. A body cut short by a timeout or an aborted stream, a partial read, or incomplete MP3 frames gets stored as a rendered segment. Check what audioIntegrity.ts and renderWithRetries validate: duration against text length, decodability, minimum bytes.
- H3 Chapter assembly and export joins. Concat with stream copy across segments that differ in codec, sample rate or channel count (mixed providers or fallback voices in one chapter: ElevenLabs 44.1 kHz MP3, OpenAI or Deepgram 24 kHz, Cloudflare, WAV). Gap or silence files in a different format. Timestamp discontinuities. A wrong durationMs driving atrim or apad and cutting speech.
- H4 Spacing at unit boundaries. textSegmentation may split long sentences into several units. If assembly or playback inserts the same pause after every unit, or each TTS clip's own leading and trailing silence stacks on top of the inserted pause, speech stops and starts mid-sentence. Spacing should follow the boundary type: a mid-sentence join gets little or no gap; a sentence end, a paragraph and a scene break get progressively longer pauses. Check how the units end (punctuation) in the real data.
- H5 Prosody resets at unit boundaries. Each unit is rendered with no context, so pitch, pace and loudness reset at every boundary, and a sentence split across two requests ends the first half with a falling, final-sounding intonation. ElevenLabs supports previous_text and next_text (and request stitching) on some models; verify per model in the current docs. This is a decision point: the investigator recommends; the coder implements only a low-risk version that doesn't change textHash or make existing audio stale. Otherwise list it in the report as a recommendation.
- H6 Sound-design mix. amix renormalizing when SFX inputs start or end, so narration level jumps or drops. Ducking or sidechain wired backwards or with extreme settings. `duration=shortest` or `-shortest` cutting narration. adelay unit mistakes. Music loops with gaps.
- H7 Client playback. An `<audio>` whose `src` or React `key` changes on re-render or polling restarts or stops playback. Causes include storage or presigned URLs regenerated per query, nonces regenerated on render, and components remounting when a list re-sorts. Also check segment-by-segment chaining with gaps, two players playing at once, and polling during an active run (narrationStatus, getWorkspace) forcing re-renders.
- H8 Serving. Range handling in server/_core/storageProxy.ts, worker/app.ts and worker/bindings.ts: 206 with correct Content-Range and Content-Length, 416, Accept-Ranges, HEAD, Content-Type. Also caching headers, stream back-pressure, abort cleanup, and streaming through the container bridge. A wrong Range response makes media elements stall, re-buffer or end early.

### (B) Generation run

- H9 Narration loop stops and restarts. Lease expiry or renewal bugs, recovery re-driving a live job, two drivers on one job, readStopRequest misfiring, auto-pause on transient errors, long or repeated backoff, concurrency above the provider's limit (for example ElevenLabs 429 "too_many_concurrent_requests"), retry storms.
- H10 Hosted container lifecycle. The Cloudflare container sleeps or is recycled mid-run because no HTTP traffic keeps it alive (worker/index.ts container options such as sleepAfter, server/_core/heartbeat.ts), and the run resumes only when the next request wakes it.
- H11 Dev restarts. `tsx watch` restarts the server mid-run; check how the run recovers.
- H12 Progress display. Counts or polling that make a healthy run look stalled or jumpy.

## 3. Evidence sources (all free)

- The user's real local data in c:\Users\asif6\Documents\Bookx\data\: about 11 MB in 131 files, including bookx.sqlite with its -wal and -shm files, db.sqlite, audio/, renders/, storage/, exports/ and uploads/. It was last written between 2026-09-27 and 2026-09-30.
  - Copy the whole folder to $env:TEMP\prosecast-audio-breakup\data, keeping the -wal and -shm files together with the DB, and work only on the copy. Never write to the original and never open the original DB.
  - Query the copy: narration jobs (status, detail, logs or events, errors, timestamps), segments (text length, how the text ends, durationMs, bytes, mime, voiceProvider, voiceModel, lastError, renderedAt), chapters, exports, and sound-design rows.
  - Analyze the stored audio with ffmpeg: codec, sample rate, channels and bitrate per segment; duration against character count (narration typically runs about 12 to 18 characters per second, so a much lower ratio suggests truncation); leading and trailing silence; long internal gaps (silencedetect); abrupt endings; several ID3, Xing or RIFF headers inside one file; discontinuities in assembled chapters, mixes and exports.
  - Summarize. Don't paste manuscript text beyond short identifying snippets.
- Hosted mode can't be inspected directly (no remote D1 or R2 access). Reason from code for hosted-only paths, and say so.
- Free provider metadata calls (voice or model listings) are allowed if a key is available. Nothing that renders audio.

## 4. Fix requirements

- Fix every root cause that evidence confirms. Keep each fix minimal and match the surrounding code. No repo-wide formatting.
- Preserve the invariants from commit 7ee56cc. Read c:\Users\asif6\Documents\Bookx\.agents\tasks\bugfix-2026-09-30\brief.md and `git show 7ee56cc --stat`. These matter most here:
  - abortable backoff, the lease renewal timer, and scope and force persisted on the job (B1, B1b, B1c)
  - a job is "completed" only when every planned segment rendered
  - pause and cancel scoped to the job id AND the projectId
  - chapter-scoped progress counts only that run's chapters (B6)
  - generateNarrationClip writes the full metadata (B5)
  - pronunciationHash carried with carried audio, with null equal to "" (B2); phoneme SSML only where supported (B4)
  - quota and configuration errors are fatal to a run (B9)
  - SSRF rules: `redirect: "manual"`, 3xx is an error, providerUrlProblem re-checked at use time
  - the SoundDesign preview `key` nonce (D6), which must still remount on a genuinely new preview
  - NarrationRun invalidations on the active-to-terminal transition (D5)
- Don't change the unit-splitting rules in server/textSegmentation.ts. Changed unit text invalidates users' rendered audio.
- Existing good audio must not become stale just because the code changed. If stored segments are genuinely broken (for example truncated), make the audit and export readiness flag them so the user can re-render selectively. Never trigger paid re-renders automatically.
- Existing exports aren't rewritten. New assemblies and exports get the fix.
- Schema: avoid changes. If one is unavoidable, make it additive only (a new nullable or defaulted column), generate it with the project's drizzle tooling, and report how it reaches local SQLite and D1.
- No new dependencies unless truly needed. If one is, install it with `pnpm add -E` in the worktree and justify it in the report.
- Client edits: minimal and logic-only, where the bug is. No restyling. Use semantic Tailwind tokens if any markup changes. Two other branches will be merged with this one later.
- Tests: the user didn't ask for new tests. Add no new test files. Keep every existing test passing. Update an existing test only when its expectation intentionally changes, and say which.

## 5. Hard constraints

- Paid calls: never trigger TTS, STT, LLM, SFX or music generation, previews, narration runs, cast analysis, or exports that call providers. For runtime checks, use locally generated audio (ffmpeg tones or silence, or the user's existing stored segments from the data copy) and seeded rows in the scratch DB. A local stub TTS server is fine during verification, but never weaken SSRF or provider URL checks in production code to make testing easier.
- Secrets: never read or print .env, .dev.vars, .wrangler/prod-internal-secret.txt or .wrangler/no-dotenv.env. If the worktree dev server or tests need .env or .dev.vars, copy them from the main checkout with Copy-Item without reading them, and delete the copies at the end.
- Infrastructure: never run wrangler deploy, any `wrangler d1 ... --remote` command, or anything else that touches Cloudflare resources. Don't edit .github/workflows/deploy.yml, wrangler*.jsonc or worker/worker-configuration.d.ts. worker/*.ts may change if serving needs it (`npx tsc -p worker` must pass).
- Ports: run the worktree dev server on 3220, or another free port that isn't 3000, 3001, 5173, 8787 or 3210. Confirm how the server picks its port and that the port is free. Point it at the scratch data copy through env vars scoped to that process. First confirm how server/db.ts and storage resolve their paths, and that dotenv doesn't override existing env vars.
- Stop every server or watcher a step starts before that step ends.

## 6. Verification

Run everything in the worktree.

- `npx tsc --noEmit` and `npx tsc -p worker` after each change set.
- `npx vitest run`. A network failure in a live-provider test isn't a regression, but name it.
- `pnpm run build` at the end.
- A deterministic before-and-after repro for each confirmed cause. For example:
  - A temporary tsx script feeds locally generated audio (mixed sample rates and codecs, or real segments from the data copy) through the real assembly, mix or join functions. ffmpeg then shows the output is one consistent stream, the durations add up, and there are no unexpected gaps or cuts (silencedetect, astats).
  - Range requests against the worktree dev server in local mode check 206, Content-Range, Content-Length and a full sequential read.
  - A browser check shows that `audio.currentTime` keeps advancing and `src` stays stable across polling while a seeded run is active. Use playwright-core, pinned exactly and installed with `npm install --prefix $env:TEMP\prosecast-audio-breakup\shots`, launched with `channel: "msedge"`. Edge is at C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe. Don't add Playwright to package.json. Save screenshots or traces to the task folder's screenshots\ and view them.
- "The code looks right" isn't verification.
- Clean up at the end: delete temporary scripts, the scratch data copy, copied env files and scratch folders, and stop servers.

## 7. Deliverables

All artifacts go in c:\Users\asif6\Documents\Bookx\.agents\tasks\audio-breakup-fix-2026-10-03\.

- findings.md: the diagnosis. For H1 to H12 and anything else found: confirmed, ruled out, or can't verify, with evidence (commands, summarized query results, ffmpeg output, file:function references). Say exactly where the error happens.
- harness.md: scratch paths, env var names (no values), the port, commands and scripts, so later steps can reuse them.
- report.md, also returned as the final step's output:
  - each root cause: where it happens (file and function), why it produces the break-up, and whether it affects local mode, hosted mode or both
  - what was fixed and the files touched, plus anything confirmed but not fixed, with the reason
  - before-and-after evidence
  - results: tsc for the app and the worker, vitest pass counts, `pnpm run build`
  - whether the user's existing audio is affected, and what they should do (for example re-export, or re-render the chapters the audit now flags)
  - what needs a live paid smoke test (for example one short chapter render with the user's provider), and anything that couldn't be verified (hosted-only paths)
  - behavior changes
  - integration notes: branch fix/audio-breakup, the commit list, the files touched, likely overlap with feat/audio-studio-upgrades and with the polish work, and a recommended merge order

## 8. Suggested shape

The workflow creator decides the final shape. One workable shape:

1. Set up the worktree (section 0).
2. Investigation: read-only on source, scratch copies only. Map the audio path end to end, analyze the data copy, run the app where useful, and write findings.md and harness.md.
3. Implement-and-review loop. A coder fixes the confirmed causes and proves each fix with its repro. A reviewer, last in the loop, checks the fixes against findings.md, the invariants in section 4 and the verification evidence, then approves or rejects. Commit after approval.
4. Final verification and report.md.
