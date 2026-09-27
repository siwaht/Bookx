/**
 * End-to-end check against a running Bookx server (`pnpm dev`).
 *
 * Signs in with the one account's email + password, imports the sample EPUB,
 * edits and selects chapters, analyses the cast, narrates ONE chapter and
 * exports it (the other chapter must not block the export), checks every
 * export format, the ZIP and the levels, then narrates the rest and checks
 * sound design. The project and its files are removed afterwards unless
 * --keep.
 *
 *   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/e2e.ts [--keep]
 *
 * Against the Cloudflare stack (the Worker in `wrangler dev`, with Cloudflare
 * Access simulated, in front of the app), set E2E_AUTH=access and
 * E2E_BASE_URL to the Worker. Every request is then signed in by Access, and
 * E2E_R2_URL (the dev bridge's R2 handler) lets the run confirm that deleted
 * files are gone from R2.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../server/routers";
import { runFfmpeg } from "../server/ffmpeg";
import { AUDIOBOOK_STANDARD, presetById, type ExportOutput, type ExportPresetId } from "../shared/exportOptions";
import { buildSampleEpub } from "./sample-book";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const accessMode = process.env.E2E_AUTH === "access";
const R2_URL = process.env.E2E_R2_URL?.replace(/\/+$/, "");
const keep = process.argv.includes("--keep");
const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(condition: unknown, message: string, detail?: unknown) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}${detail === undefined ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!condition) failures.push(message);
}
async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  console.log(`\n== ${name}`);
  const result = await work();
  console.log(`   (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  return result;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Sign in and client
// ---------------------------------------------------------------------------

let cookie = "";
if (!accessMode) {
  const email = process.env.BOOKX_SIGNIN_EMAIL;
  const password = process.env.BOOKX_SIGNIN_PASSWORD;
  if (!email || !password) throw new Error("BOOKX_SIGNIN_EMAIL and BOOKX_SIGNIN_PASSWORD must be set (see .env).");
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  if (login.status !== 200 || !cookie) throw new Error(`Sign-in failed (HTTP ${login.status}). Is the server running, and are the credentials right?`);
}
const session = (): Record<string, string> => (cookie ? { cookie } : {});

const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${BASE}/api/trpc`, transformer: superjson, headers: session })],
});

/** Files known to exist during the run, checked to be gone after the project is deleted. */
const storedKeys: string[] = [];

async function download(url: string, withCookie = true): Promise<{ status: number; type: string | null; disposition: string | null; length: string | null; buffer: Buffer }> {
  const response = await fetch(new URL(url, BASE), { headers: withCookie ? session() : {} });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    disposition: response.headers.get("content-disposition"),
    length: response.headers.get("content-length"),
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

// ---------------------------------------------------------------------------
// Audio inspection
// ---------------------------------------------------------------------------

type Probe = { codec: string; sampleRate: number; channels: number; bitRate: number; bitsPerSample: number; durationMs: number; tags: Record<string, string>; chapters: number };

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_chapters", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate,bits_per_sample,bits_per_raw_sample:format=duration:format_tags", "-of", "json", file]);
  const parsed = JSON.parse(stdout) as { streams: Array<Record<string, string | number>>; format: { duration: string; tags?: Record<string, string> }; chapters?: unknown[] };
  const stream = parsed.streams[0]!;
  return {
    codec: String(stream.codec_name),
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
    bitRate: Number(stream.bit_rate),
    bitsPerSample: Number(stream.bits_per_raw_sample || stream.bits_per_sample || 0),
    durationMs: Math.round(Number(parsed.format.duration) * 1000),
    tags: Object.fromEntries(Object.entries(parsed.format.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
    chapters: parsed.chapters?.length ?? 0,
  };
}

async function levels(file: string): Promise<{ rmsDb: number; peakDb: number }> {
  const { stderr } = await runFfmpeg(["-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  return { rmsDb: Number(/mean_volume:\s*(-?[\d.]+)/.exec(stderr)?.[1] ?? -91), peakDb: Number(/max_volume:\s*(-?[\d.]+)/.exec(stderr)?.[1] ?? -91) };
}

/** RMS level of every 100 ms window, in dB (-120 for digital silence). */
async function levelProfile(file: string, sampleRate: number): Promise<number[]> {
  const { stdout } = await runFfmpeg([
    "-i", file,
    "-af", `asetnsamples=n=${Math.round(sampleRate / 10)}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`,
    "-f", "null", "-",
  ], { timeoutMs: 300_000 });
  return [...stdout.toString().matchAll(/RMS_level=(-?[\d.]+|-inf|inf|nan)/g)].map(match => (/^-?[\d.]+$/.test(match[1]!) ? Number(match[1]) : -120));
}

/** Stretches of at least 300 ms that are neither silence nor speech: a cue playing alone in a pause. */
function bedRuns(profile: number[], narrationMeanDb: number): Array<{ startMs: number; lengthMs: number; maxDb: number; medianDb: number }> {
  const runs: Array<{ startMs: number; lengthMs: number; maxDb: number; medianDb: number }> = [];
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end - start >= 3) {
      const values = profile.slice(start, end).sort((left, right) => left - right);
      runs.push({ startMs: start * 100, lengthMs: (end - start) * 100, maxDb: values.at(-1)!, medianDb: values[Math.floor(values.length / 2)]! });
    }
    start = -1;
  };
  profile.forEach((value, index) => {
    const bed = value > -80 && value < narrationMeanDb - 15;
    if (bed && start < 0) start = index;
    if (!bed) close(index);
  });
  close(profile.length);
  return runs;
}

const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? -120;

// ---------------------------------------------------------------------------
// Helpers for the flow
// ---------------------------------------------------------------------------

const work = await mkdtemp(path.join(os.tmpdir(), "bookx-e2e-"));
let projectId = "";

async function narrate(chapterIds?: string[]) {
  await api.bookx.startNarration.mutate({ projectId, chapterIds });
  let status = await api.bookx.narrationStatus.query({ projectId });
  let last = "";
  while (!["completed", "failed", "cancelled", "paused"].includes(status.status)) {
    await sleep(2000);
    status = await api.bookx.narrationStatus.query({ projectId });
    const line = `${status.status} ${status.completedSegments}/${status.totalSegments}`;
    if (line !== last) process.stdout.write(`\r  ${line}`.padEnd(40));
    last = line;
  }
  console.log("");
  return status;
}

type ExportRow = Awaited<ReturnType<typeof api.bookx.listExports.query>>[number];

async function exportBook(label: string, preset: ExportPresetId, output?: ExportOutput, chapterIds?: string[]): Promise<{ row: ExportRow; chapterFiles: string[]; bookFile: string | null }> {
  const { id, chapters } = await api.bookx.requestExport.mutate({ projectId, preset, output: output ?? presetById(preset).output, chapterIds });
  let row: ExportRow | undefined;
  for (let attempt = 0; attempt < 600; attempt++) {
    row = (await api.bookx.listExports.query({ projectId })).find(entry => entry.id === id);
    if (row && (row.status === "ready" || row.status === "failed")) break;
    await sleep(1000);
  }
  check(row?.status === "ready", `${label}: package assembled (${chapters} chapter(s))`, row?.error ?? row?.status);
  const chapterFiles: string[] = [];
  for (const [index, file] of (row!.detail?.chapters ?? []).entries()) {
    const { url, fileName } = await api.bookx.exportDownloadUrl.mutate({ projectId, exportId: id, file: file.chapterId });
    const fetched = await download(url);
    check(fetched.status === 200 && fetched.buffer.length === file.bytes, `${label}: chapter ${index + 1} downloads as "${fileName}"`, `${fetched.status}, ${fetched.buffer.length} bytes, ${fetched.disposition}`);
    const target = path.join(work, `${label}-${index + 1}.${row!.detail?.container ?? "mp3"}`);
    await writeFile(target, fetched.buffer);
    chapterFiles.push(target);
  }
  let bookFile: string | null = null;
  if (row!.detail?.fullBook) {
    const { url } = await api.bookx.exportDownloadUrl.mutate({ projectId, exportId: id });
    const fetched = await download(url);
    bookFile = path.join(work, `${label}-book.${row!.detail.container}`);
    await writeFile(bookFile, fetched.buffer);
    check(fetched.status === 200 && fetched.buffer.length === row!.detail.fullBook.bytes, `${label}: whole-book file downloads`, `${fetched.buffer.length} bytes`);
  }
  return { row: row!, chapterFiles, bookFile };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

try {
  if (accessMode) {
    await step("Signed in by Cloudflare Access (simulated)", async () => {
      const user = await api.auth.me.query();
      check(user?.openId?.startsWith("access:") && user.loginMethod === "cloudflare-access", "the app sees the Access identity", user?.email);
      const forged = await fetch(`${BASE}/api/trpc/auth.me`, { headers: { "x-bookx-user-email": "someone-else@example.com", "x-bookx-internal": "x".repeat(64) } });
      const seen = ((await forged.json()) as { result?: { data?: { json?: { email?: string } } } }).result?.data?.json?.email;
      check(seen === user?.email, "identity headers sent by a visitor are ignored", seen);
      const crossSite = await fetch(`${BASE}/api/trpc/bookx.createProject`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
      check(crossSite.status === 403, "a cross-site POST is refused", `HTTP ${crossSite.status}`);
      const appLogin = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@y.z", password: "x" }) });
      check(appLogin.status === 404, "the app-level sign-in does not exist here", `HTTP ${appLogin.status}`);
    });
  } else {
    await step("Sign in with the one account", async () => {
      const user = await api.auth.me.query();
      check(user?.openId === "bookx-owner" && user.loginMethod === "password", "signed in as the account", user?.email);
      const anonymous = await fetch(`${BASE}/api/trpc/bookx.listProjects`);
      check(anonymous.status === 401, "tRPC refuses a request without the session cookie", `HTTP ${anonymous.status}`);
    });
  }

  projectId = await step("Create the project", async () => {
    const { id } = await api.bookx.createProject.mutate({
      title: "E2E · Harrow Pass", author: "Bookx E2E", kind: "audiobook", narrationStyle: "narrator-cast",
      voiceProvider: "Cloudflare", voiceModel: "@cf/deepgram/aura-2-en",
      languageModelProvider: "Cloudflare", languageModel: "@cf/openai/gpt-oss-120b", language: "English",
    });
    check(Boolean(id), "project created", id);
    return id;
  });

  const chapters = await step("Import the whole EPUB", async () => {
    const epub = await buildSampleEpub();
    const imported = await api.bookx.importManuscript.mutate({ projectId, filename: "harrow-pass.epub", base64: epub.toString("base64"), mode: "replace" });
    console.log("  import:", JSON.stringify(imported));
    const workspace = await api.bookx.getWorkspace.query({ projectId });
    const included = workspace.chapters.filter(chapter => chapter.included);
    check(included.length === 2, "both story chapters are included", included.map(chapter => chapter.title));
    check(workspace.chapters.filter(chapter => !chapter.included).every(chapter => chapter.kind !== "chapter"), "only front or back matter starts excluded");
    return workspace.chapters;
  });
  const [pride, storm] = chapters.filter(chapter => chapter.included);

  await step("Edit, select and remove chapters", async () => {
    await api.bookx.updateChapter.mutate({ projectId, chapterId: storm!.id, body: storm!.body!.replace("like a cart on cobbles", "like a cart over cobbles") });
    const extra = await api.bookx.createChapter.mutate({ projectId, title: "Author's note", body: "This chapter will be removed." });
    await api.bookx.setChaptersIncluded.mutate({ projectId, chapterIds: [pride!.id], included: false });
    let status = await api.bookx.narrationStatus.query({ projectId });
    check(!status.chapters.some(chapter => chapter.chapterId === pride!.id), "an excluded chapter drops out of the narration scope");
    await api.bookx.setChaptersIncluded.mutate({ projectId, chapterIds: [pride!.id], included: true });
    await api.bookx.deleteChapter.mutate({ projectId, chapterId: extra.id });
    const workspace = await api.bookx.getWorkspace.query({ projectId });
    check(!workspace.chapters.some(chapter => chapter.id === extra.id), "a removed chapter is gone");
    check(workspace.chapters.find(chapter => chapter.id === storm!.id)?.body?.includes("like a cart over cobbles"), "the edited text is saved");
    status = await api.bookx.narrationStatus.query({ projectId });
    check(status.chapters.length === 2, "both chapters are back in scope");
  });

  await step("Analyse the cast", async () => {
    await api.bookx.startCastAnalysis.mutate({ projectId });
    let status = await api.bookx.analysisStatus.query({ projectId, kind: "cast" });
    while (["queued", "running"].includes(status.status)) {
      await sleep(1500);
      status = await api.bookx.analysisStatus.query({ projectId, kind: "cast" });
    }
    check(status.status === "completed", "cast analysis completed", status.message);
    const workspace = await api.bookx.getWorkspace.query({ projectId });
    const names = workspace.characters.map(character => character.name);
    check([/^Mr\.? Bennet/, /^Mrs\.? Bennet/, /Mira/, /Aldric/].every(pattern => names.some(name => pattern.test(name))), "found Mr. and Mrs. Bennet, Mira and Aldric", names);
    const voices = workspace.characters.map(character => character.voiceId);
    check(voices.every(Boolean) && new Set(voices).size === voices.length, "every character has a distinct voice");
  });

  await step("Narrate only chapter 2", async () => {
    const status = await narrate([storm!.id]);
    check(status.status === "completed", "the chapter 2 run completed", `${status.completedSegments}/${status.totalSegments}`);
    const overview = await api.bookx.exportReadiness.query({ projectId });
    const states = Object.fromEntries(overview.chapters.map(chapter => [chapter.title, chapter.state]));
    check(overview.chapters.find(chapter => chapter.chapterId === pride!.id)?.state === "unrendered" && overview.chapters.find(chapter => chapter.chapterId === storm!.id)?.state === "ready", "chapter 1 is unrendered, chapter 2 is ready", states);
    check(overview.ready && overview.exportableChapters === 1, "the book can be exported with one chapter unrendered", overview.reason);
    await api.bookx.requestExport.mutate({ projectId, preset: "spotify", chapterIds: [pride!.id] }).then(
      () => check(false, "exporting an unrendered chapter on purpose is refused"),
      error => check(/cannot be exported yet/.test(String(error.message)), "exporting an unrendered chapter on purpose is refused", error.message),
    );
  });

  const spotify = await step("Export Spotify & ACX (chapter 2 only)", async () => {
    const result = await exportBook("spotify", "spotify");
    check(result.chapterFiles.length === 1, "one chapter file: the unrendered chapter was left out");
    const file = await probe(result.chapterFiles[0]!);
    console.log("  chapter file:", JSON.stringify(file));
    check(file.codec === "mp3" && file.sampleRate === 44100 && file.channels === 2 && Math.abs(file.bitRate - 192_000) <= 1_000, "MP3 192 kbps, 44.1 kHz, stereo");
    check(file.tags.title?.includes("Storm") && file.tags.album === "E2E · Harrow Pass" && file.tags.track === "1/1", "tagged with chapter title, book and track number", file.tags);
    const measured = await levels(result.chapterFiles[0]!);
    check(measured.rmsDb >= AUDIOBOOK_STANDARD.minRmsDb && measured.rmsDb <= AUDIOBOOK_STANDARD.maxRmsDb && measured.peakDb <= AUDIOBOOK_STANDARD.maxPeakDb, "levels meet the audiobook standard (RMS -23 to -18 dB, peak <= -3 dB)", measured);
    const recorded = result.row.detail?.chapters?.[0];
    check(recorded && Math.abs((recorded.rmsDb ?? 0) - measured.rmsDb) < 0.3, "the package records the measured levels", recorded && { rmsDb: recorded.rmsDb, peakDb: recorded.peakDb });
    const book = await probe(result.bookFile!);
    check(book.codec === "mp3" && book.chapters === 1, "the whole-book MP3 carries chapter markers", book.chapters);
    return result;
  });

  await step("Download all chapters as a ZIP", async () => {
    const zip = await download(`/api/exports/${spotify.row.id}/zip?projectId=${projectId}`);
    check(zip.status === 200 && zip.type === "application/zip", "the ZIP streams", `${zip.status} ${zip.type}`);
    check(zip.length === String(zip.buffer.length), "with an exact Content-Length", `${zip.length} vs ${zip.buffer.length}`);
    check(/\.zip/.test(zip.disposition ?? ""), "under a readable file name", zip.disposition);
    const zipFile = path.join(work, "chapters.zip");
    await writeFile(zipFile, zip.buffer);
    const { stdout } = await run("tar", ["-tf", zipFile]);
    const names = stdout.trim().split(/\r?\n/);
    check(names.length === 1 && names[0] === spotify.row.detail?.chapters?.[0]?.fileName, "it holds the chapter file under its chapter name", names);
    const extractDir = path.join(work, "unzipped");
    await mkdir(extractDir, { recursive: true });
    await run("tar", ["-xf", zipFile, "-C", extractDir]);
    const extracted = await readFile(path.join(extractDir, names[0]!));
    check(extracted.equals(await readFile(spotify.chapterFiles[0]!)), "and the file inside is byte-identical to the single download");
    if (!accessMode) {
      // Behind Access every request is signed in, so there is no anonymous case to try.
      const anonymous = await download(`/api/exports/${spotify.row.id}/zip?projectId=${projectId}`, false);
      check(anonymous.status === 401, "the ZIP is refused without a session", `HTTP ${anonymous.status}`);
    }
    const ranged = await fetch(new URL(`/manus-storage/${spotify.row.detail!.chapters![0]!.storageKey}`, BASE), { headers: { ...session(), range: "bytes=100-199" } });
    const slice = Buffer.from(await ranged.arrayBuffer());
    check(ranged.status === 206 && slice.equals((await readFile(spotify.chapterFiles[0]!)).subarray(100, 200)), "audio serves byte ranges, so players can seek", `${ranged.status} ${ranged.headers.get("content-range")}`);
    storedKeys.push(spotify.row.detail!.chapters![0]!.storageKey);
  });

  await step("Export the original MP3 without re-encoding", async () => {
    const result = await exportBook("original", "original");
    const file = await probe(result.chapterFiles[0]!);
    const segment = (await api.bookx.getWorkspace.query({ projectId })).segments.find(entry => entry.chapterId === storm!.id && entry.audioStorageKey);
    const source = await download(`/manus-storage/${segment!.audioStorageKey}`);
    storedKeys.push(segment!.audioStorageKey!);
    const sourceFile = path.join(work, "segment.mp3");
    await writeFile(sourceFile, source.buffer);
    const original = await probe(sourceFile);
    check(file.sampleRate === original.sampleRate && file.channels === original.channels && Math.abs(file.bitRate - original.bitRate) < 2_000, "keeps the provider's own format", `${file.sampleRate} Hz ${file.channels} ch ${file.bitRate} vs ${original.sampleRate} Hz ${original.channels} ch ${original.bitRate}`);
    check(file.tags.title?.includes("Storm"), "and still carries ID3 tags", file.tags);
  });

  await step("Narrate the rest of the book", async () => {
    const status = await narrate();
    check(status.status === "completed", "the remaining chapter rendered", `${status.completedSegments}/${status.totalSegments}`);
    const overview = await api.bookx.exportReadiness.query({ projectId });
    check(overview.readyChapters === 2, "both chapters are ready now");
  });

  await step("Export WAV and FLAC", async () => {
    const wav = await exportBook("wav", "wav", { ...presetById("wav").output, bitDepth: 16, channels: "mono" });
    check(wav.chapterFiles.length === 2 && !wav.bookFile, "two WAV chapter files, no whole-book file (off for WAV)");
    const first = await probe(wav.chapterFiles[0]!);
    check(first.codec === "pcm_s16le" && first.sampleRate === 44100 && first.channels === 1, "WAV is 16-bit PCM, 44.1 kHz, mono", first);
    check(first.tags.title === "Chapter 1", "WAV carries its title", first.tags);
    const flac = await exportBook("flac", "flac", { ...presetById("flac").output, bitDepth: 24, fullBook: true });
    const flacFile = await probe(flac.chapterFiles[1]!);
    check(flacFile.codec === "flac" && flacFile.bitsPerSample === 24 && flacFile.channels === 2, "FLAC is 24-bit stereo", flacFile);
    const book = await probe(flac.bookFile!);
    const sum = flac.row.detail!.chapters!.reduce((total, file) => total + file.durationMs, 0);
    check(Math.abs(book.durationMs - sum) < 300, "the whole-book FLAC is as long as its chapters (levelled, so no extra gap)", `${book.durationMs} vs ${sum} ms`);
    const numbered = flac.row.detail!.chapters!.map(file => file.fileName);
    check(numbered[0]?.startsWith("01 - ") && numbered[1]?.startsWith("02 - "), "chapter files are numbered in book order", numbered);
  });

  const plain = await step("Export Spotify & ACX with sound design off", async () => exportBook("plain", "spotify"));

  await step("Turn on background sounds and music", async () => {
    await api.bookx.updateSoundSettings.mutate({ projectId, effects: true, music: true, level: "very-subtle", source: "auto" });
    const overview = await api.bookx.exportReadiness.query({ projectId });
    check(overview.ready && overview.warnings.some(warning => /no sound plan/.test(warning)), "an unplanned book still exports, with a note", overview.warnings);
    await api.bookx.startScenePlan.mutate({ projectId });
    let status = await api.bookx.analysisStatus.query({ projectId, kind: "scenes" });
    while (["queued", "running"].includes(status.status)) {
      await sleep(1500);
      status = await api.bookx.analysisStatus.query({ projectId, kind: "scenes" });
    }
    check(status.status === "completed", "scene planning completed", status.message);
    const design = await api.bookx.soundDesign.query({ projectId });
    check(design.totals.sfx >= 1 && design.totals.music >= 2 && design.totals.missingSounds === 0, "cues planned with sounds ready", design.totals);
  });

  const mixed = await step("Export Spotify & ACX with sound design on", async () => {
    const result = await exportBook("mixed", "spotify");
    check((result.row.detail?.soundDesign?.cues ?? 0) > 0, "sound cues were mixed in", result.row.detail?.soundDesign);
    return result;
  });

  await step("Inspect the mix", async () => {
    for (const [index, file] of mixed.chapterFiles.entries()) {
      const plainFile = plain.chapterFiles[index]!;
      const plainLevels = await levels(plainFile);
      const [plainProfile, mixedProfile] = [await levelProfile(plainFile, 44100), await levelProfile(file, 44100)];
      const runs = bedRuns(mixedProfile, plainLevels.rmsDb);
      // Levelled speech has short quiet tails and breaths of its own, so short
      // quiet windows prove nothing. A second or more that is neither silence
      // nor speech only happens where a music swell or an effect plays alone.
      const long = (profile: number[]) => bedRuns(profile, plainLevels.rmsDb).filter(bed => bed.lengthMs >= 1_000);
      console.log(`  chapter ${index + 1}: narration RMS ${plainLevels.rmsDb} dB; ${long(mixedProfile).length} stretch(es) of 1 s+ with sound alone`);
      for (const bed of long(mixedProfile)) console.log(`    at ${(bed.startMs / 1000).toFixed(1)} s for ${(bed.lengthMs / 1000).toFixed(1)} s: median ${bed.medianDb.toFixed(1)} dB, peak ${bed.maxDb.toFixed(1)} dB`);
      check(long(plainProfile).length === 0, `chapter ${index + 1}: without sound design no pause carries sound`, long(plainProfile).length);
      check(long(mixedProfile).length >= 1, `chapter ${index + 1}: with it, sounds are heard in the pauses`);
      check(runs.every(bed => bed.lengthMs <= 2_500), `chapter ${index + 1}: each sound comes and goes within 2.5 s`);
      check(runs.every(bed => bed.maxDb <= plainLevels.rmsDb - 15), `chapter ${index + 1}: even the loudest 100 ms of any sound is 15+ dB under the narration's average`);
      const loud = (profile: number[]) => median(profile.filter(value => value >= plainLevels.rmsDb - 15));
      check(Math.abs(loud(mixedProfile) - loud(plainProfile)) < 1, `chapter ${index + 1}: the speech level is unchanged`, `${(loud(mixedProfile) - loud(plainProfile)).toFixed(2)} dB`);
      const mixedLevels = await levels(file);
      check(mixedLevels.rmsDb >= AUDIOBOOK_STANDARD.minRmsDb && mixedLevels.rmsDb <= AUDIOBOOK_STANDARD.maxRmsDb && mixedLevels.peakDb <= AUDIOBOOK_STANDARD.maxPeakDb, `chapter ${index + 1}: the mixed file still meets the audiobook standard`, mixedLevels);
    }
  });

  await step("Delete a package", async () => {
    const key = plain.row.detail!.chapters![0]!.storageKey;
    await api.bookx.deleteExport.mutate({ projectId, exportId: plain.row.id });
    const rows = await api.bookx.listExports.query({ projectId });
    check(!rows.some(row => row.id === plain.row.id), "the package is gone from the list");
    const gone = await download(`/manus-storage/${key}`);
    check(gone.status === 404, "and its files are deleted", `HTTP ${gone.status}`);
  });

  console.log(`\nProject ${projectId}; files in ${work}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error("\nE2E aborted:", error);
} finally {
  if (projectId && !keep) {
    await api.bookx.deleteProject.mutate({ projectId }).catch(error => console.error("cleanup: delete project failed", error));
    if (accessMode) {
      if (R2_URL && storedKeys.length) {
        const left = [];
        for (const key of storedKeys) {
          const response = await fetch(`${R2_URL}/object?key=${encodeURIComponent(key)}`, { method: "HEAD" });
          if (response.status !== 404) left.push(`${key} (HTTP ${response.status})`);
        }
        check(!left.length, `deleting the project removes its files from R2 (${storedKeys.length} checked)`, left);
      }
      // 404 while the Worker still remembers the owner (a minute), 403 after.
      const after = await download(`/manus-storage/${storedKeys[0] ?? `bookx/${projectId}/x`}`);
      check(after.status === 403 || after.status === 404, "and its file URLs stop working", `HTTP ${after.status}`);
    } else {
      const folder = path.resolve(process.env.BOOKX_LOCAL_STORAGE_DIR || path.join("data", "storage"), "bookx", projectId);
      check(!existsSync(folder), "deleting the project removes its stored files", folder);
    }
    await rm(work, { recursive: true, force: true });
  }
  console.log(failures.length ? `\n${failures.length} check(s) FAILED:\n - ${failures.join("\n - ")}` : "\nAll checks passed.");
  process.exit(failures.length ? 1 : 0);
}
