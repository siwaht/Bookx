import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUDIOBOOK_STANDARD, isPassthrough, type ExportOutput } from "../shared/exportOptions";
import { FILE_WORK_LIMITS, QUICK_LIMITS, parseLoudness, runFfmpeg, withTempDir, type FfmpegLimits } from "./ffmpeg";
import { scanMp3, scanWav } from "./audioAssembly";

/**
 * Turns an assembled chapter into a deliverable file.
 *
 * The assembled chapter is in whatever the voice provider produced (often
 * 24 kHz mono MP3). Distributors want 44.1 kHz, a fixed bitrate and consistent
 * loudness, so every non-passthrough export goes through one ffmpeg pass that
 * resamples, sets the channel layout, levels the chapter to the audiobook
 * standard (optional), adds room tone at both ends, and encodes.
 */

export type ChapterTags = {
  title: string;
  album: string;
  artist?: string | null;
  track: number;
  totalTracks: number;
  year?: number;
};

export type EncodedChapter = {
  buffer: Buffer;
  durationMs: number;
  /** Whole-file RMS and sample peak of the delivered audio, in dBFS. */
  rmsDb: number;
  peakDb: number;
  /** Gain applied to reach the loudness target, when levelling. */
  gainDb: number | null;
};

const dbToLinear = (db: number) => 10 ** (db / 20);

/** The limiter sits a little under the -3 dB ceiling so MP3 encoding cannot push a peak over it. */
export const LIMITER_CEILING_DB = -3.8;

/**
 * Gain that brings a chapter measured at `meanDb` to the RMS target, allowing
 * for the room tone that will be added around it.
 */
export function levellingGainDb(meanDb: number, durationMs: number, addedSilenceMs: number): number {
  if (!(meanDb > -80) || durationMs <= 0) return 0;
  // Silence lowers whole-file RMS by 10·log10(total / audible).
  const silenceLoss = 10 * Math.log10((durationMs + addedSilenceMs) / durationMs);
  const gain = AUDIOBOOK_STANDARD.targetRmsDb - meanDb + silenceLoss;
  return Math.round(Math.max(-30, Math.min(30, gain)) * 100) / 100;
}

function channelFilter(inputChannels: number, output: ExportOutput): string | null {
  if (output.channels === "stereo" && inputChannels === 1) return "pan=stereo|c0=c0|c1=c0";
  if (output.channels === "mono" && inputChannels >= 2) return "pan=mono|c0=0.5*c0+0.5*c1";
  return null;
}

/** The `-af` chain for one chapter. Pure, so it can be tested without ffmpeg. */
export function chapterFilterChain(input: { inputChannels: number; output: ExportOutput; gainDb: number | null }): string {
  const { output } = input;
  const filters = [`aresample=${output.sampleRate}`];
  const channels = channelFilter(input.inputChannels, output);
  if (channels) filters.push(channels);
  if (output.master && input.gainDb !== null) {
    filters.push(`volume=${input.gainDb.toFixed(2)}dB`);
    filters.push(`alimiter=limit=${dbToLinear(LIMITER_CEILING_DB).toFixed(4)}:attack=5:release=60:level=0`);
    filters.push(`adelay=delays=${AUDIOBOOK_STANDARD.headMs}:all=1`);
    filters.push(`apad=pad_dur=${(AUDIOBOOK_STANDARD.tailMs / 1000).toFixed(3)}`);
  }
  // Dither when the delivery format is 16-bit PCM; MP3 and 24-bit keep float precision.
  if (output.container !== "mp3" && output.bitDepth === 16) filters.push("aresample=osf=s16:dither_method=triangular");
  return filters.join(",");
}

/** Codec arguments for the delivery format. */
export function codecArgs(output: ExportOutput): string[] {
  const common = ["-ar", String(output.sampleRate), "-ac", output.channels === "stereo" ? "2" : "1"];
  if (output.container === "mp3") {
    const bitrate = output.mp3Bitrate === "original" ? 192 : output.mp3Bitrate;
    return ["-c:a", "libmp3lame", "-b:a", `${bitrate}k`, "-compression_level", "2", ...common, "-write_xing", "0", "-id3v2_version", "3", "-f", "mp3"];
  }
  if (output.container === "wav") {
    return ["-c:a", output.bitDepth === 24 ? "pcm_s24le" : "pcm_s16le", ...common, "-rf64", "auto", "-f", "wav"];
  }
  return [
    "-c:a", "flac", "-compression_level", "5",
    ...(output.bitDepth === 24 ? ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"] : ["-sample_fmt", "s16"]),
    ...common, "-f", "flac",
  ];
}

/** `-metadata` arguments; ffmpeg writes them as ID3v2.3, RIFF INFO or Vorbis comments. */
export function metadataArgs(tags: ChapterTags): string[] {
  const clean = (value: string) => value.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 250);
  const pairs: Array<[string, string]> = [
    ["title", clean(tags.title)],
    ["album", clean(tags.album)],
    ["track", `${tags.track}/${tags.totalTracks}`],
    ["genre", "Audiobook"],
  ];
  if (tags.artist) pairs.push(["artist", clean(tags.artist)], ["album_artist", clean(tags.artist)]);
  if (tags.year) pairs.push(["date", String(tags.year)]);
  return pairs.flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

function channelsOf(audio: Buffer): number {
  if (audio.subarray(0, 4).toString("latin1") === "RIFF") return scanWav(audio).format.channels;
  return scanMp3(audio).format.channelModeBits === 3 ? 1 : 2;
}

async function measure(file: string, limits: FfmpegLimits = FILE_WORK_LIMITS) {
  const { stderr } = await runFfmpeg(["-i", file, "-af", "volumedetect", "-f", "null", "-"], limits);
  return parseLoudness(stderr);
}

/** Encodes one assembled chapter into the delivery format. */
export async function encodeChapter(input: { audio: Buffer; durationMs: number; output: ExportOutput; tags: ChapterTags }): Promise<EncodedChapter> {
  if (isPassthrough(input.output)) throw new Error("Passthrough exports are not re-encoded");
  // A whole chapter is decoded, filtered and encoded here: minutes of work on a
  // shared CPU. It is guarded by progress rather than by a clock, because the
  // old "assume three times realtime" ceiling stopped healthy encodes whenever
  // the machine was busy, which made long exports fail with a bare SIGKILL.
  const limits = FILE_WORK_LIMITS;
  return withTempDir(async dir => {
    const isWav = input.audio.subarray(0, 4).toString("latin1") === "RIFF";
    const source = path.join(dir, isWav ? "chapter.wav" : "chapter.mp3");
    await writeFile(source, input.audio);

    let gainDb: number | null = null;
    if (input.output.master) {
      const before = await measure(source, limits);
      gainDb = levellingGainDb(before.meanDb, before.durationMs || input.durationMs, AUDIOBOOK_STANDARD.headMs + AUDIOBOOK_STANDARD.tailMs);
    }

    const target = path.join(dir, `delivery.${input.output.container}`);
    await runFfmpeg([
      "-i", source,
      "-map", "0:a",
      "-map_metadata", "-1",
      "-af", chapterFilterChain({ inputChannels: channelsOf(input.audio), output: input.output, gainDb }),
      ...metadataArgs(input.tags),
      ...codecArgs(input.output),
      target,
    ], limits);

    const after = await measure(target, limits);
    return { buffer: await readFile(target), durationMs: after.durationMs, rmsDb: round1(after.meanDb), peakDb: round1(after.peakDb), gainDb };
  });
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Levels of an already-encoded file, for passthrough chapters. */
export async function measureBuffer(audio: Buffer, extension: string): Promise<{ rmsDb: number; peakDb: number; durationMs: number }> {
  return withTempDir(async dir => {
    const file = path.join(dir, `audio.${extension}`);
    await writeFile(file, audio);
    const result = await measure(file);
    return { rmsDb: round1(result.meanDb), peakDb: round1(result.peakDb), durationMs: result.durationMs };
  });
}

// ---------------------------------------------------------------------------
// ID3v2.3 tags, written directly for files that are never re-encoded
// ---------------------------------------------------------------------------

function synchsafe(size: number): Buffer {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

function frame(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function textFrame(id: string, text: string): Buffer {
  // Encoding 1: UCS-2 with a byte-order mark, so titles in any script survive.
  return frame(id, Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, "utf16le")]));
}

/** An ID3v2.3 tag (title, album, artist, track) for chapter files that are never re-encoded. */
export function buildId3Tag(tags: { title: string; album: string; artist?: string | null; track?: string }): Buffer {
  const frames: Buffer[] = [textFrame("TIT2", tags.title), textFrame("TALB", tags.album), textFrame("TCON", "Audiobook")];
  if (tags.artist) frames.push(textFrame("TPE1", tags.artist), textFrame("TPE2", tags.artist));
  if (tags.track) frames.push(textFrame("TRCK", tags.track));
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), synchsafe(body.length), body]);
}

// ---------------------------------------------------------------------------
// The whole-book file, joined on disk
// ---------------------------------------------------------------------------

/** Escapes a value for ffmpeg's FFMETADATA format. */
export function escapeFfmetadata(value: string): string {
  return value.replace(/[\u0000-\u001f]+/g, " ").replace(/([=;#\\])/g, "\\$1");
}

export type BookChapterMark = { title: string; startMs: number; endMs: number };

/** FFMETADATA with book tags and, for MP3, one chapter marker per chapter. */
export function bookMetadata(input: { title: string; artist?: string | null; chapters: BookChapterMark[] }): string {
  const lines = [";FFMETADATA1", `title=${escapeFfmetadata(input.title)}`, `album=${escapeFfmetadata(input.title)}`, "genre=Audiobook"];
  if (input.artist) lines.push(`artist=${escapeFfmetadata(input.artist)}`, `album_artist=${escapeFfmetadata(input.artist)}`);
  for (const chapter of input.chapters) {
    lines.push("", "[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(chapter.startMs)}`, `END=${Math.round(chapter.endMs)}`, `title=${escapeFfmetadata(chapter.title)}`);
  }
  return `${lines.join("\n")}\n`;
}

const concatEntry = (file: string) => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;

/**
 * Joins chapter files (already on disk, all in one format) into one file with
 * ffmpeg's concat demuxer, putting `gapFile` between chapters. MP3 and WAV are
 * copied frame for frame; FLAC is re-encoded (losslessly) because its frame
 * numbers restart in every file. Works on disk, so a long lossless book never
 * has to fit in memory.
 */
export async function joinBookFiles(input: {
  dir: string;
  files: string[];
  container: "mp3" | "wav" | "flac";
  gapFile: string | null;
  metadata: string;
}): Promise<{ filePath: string; bytes: number; durationMs: number }> {
  const list = input.files.flatMap((file, index) => (index > 0 && input.gapFile ? [concatEntry(input.gapFile), concatEntry(file)] : [concatEntry(file)]));
  const listFile = path.join(input.dir, "book-list.txt");
  const metadataFile = path.join(input.dir, "book-metadata.txt");
  await writeFile(listFile, `${list.join("\n")}\n`);
  await writeFile(metadataFile, input.metadata);
  const target = path.join(input.dir, `book.${input.container}`);
  const codec = input.container === "mp3"
    ? ["-c", "copy", "-id3v2_version", "3", "-write_xing", "0"]
    : input.container === "wav"
      ? ["-c", "copy", "-rf64", "auto"]
      : ["-c:a", "flac", "-compression_level", "5"];
  await runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-i", metadataFile,
    "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1",
    ...codec,
    "-f", input.container,
    target,
  ], FILE_WORK_LIMITS);
  const { stderr } = await runFfmpeg(["-i", target, "-f", "null", "-"], FILE_WORK_LIMITS);
  return { filePath: target, bytes: (await stat(target)).size, durationMs: parseLoudness(stderr).durationMs };
}

/** Silence in the delivery format, for the pause between chapters of the whole-book file. */
export async function writeSilence(input: { dir: string; output: ExportOutput; ms: number }): Promise<string> {
  const file = path.join(input.dir, `gap.${input.output.container}`);
  await runFfmpeg([
    "-f", "lavfi", "-i", `anullsrc=r=${input.output.sampleRate}:cl=${input.output.channels}`,
    "-t", (input.ms / 1000).toFixed(3),
    "-map_metadata", "-1",
    ...codecArgs(input.output),
    file,
  ], QUICK_LIMITS);
  return file;
}
