import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AUDIOBOOK_STANDARD, EXPORT_PRESETS, chapterFileName, describeOutput, isPassthrough, meetsAudiobookStandard, presetById, type ExportOutput } from "../shared/exportOptions";
import { attachmentDisposition } from "../shared/contentDisposition";
import { scanMp3, scanWav } from "./audioAssembly";
import { LIMITER_CEILING_DB, bookMetadata, buildId3Tag, chapterFilterChain, codecArgs, encodeChapter, escapeFfmetadata, joinBookFiles, levellingGainDb, metadataArgs, writeSilence } from "./exportEncoder";
import { resolveFfmpeg, runFfmpeg, withTempDir } from "./ffmpeg";
import { chapterReason, readinessFrom, type ExportOverview } from "./audioExport";
import { chapterAudioStates, type PlannableSegment } from "./narrationPlan";
import { hashSegmentText } from "./textSegmentation";

const spotify = presetById("spotify").output;

describe("export presets", () => {
  it("default to a Spotify/ACX-compliant MP3", () => {
    expect(spotify).toEqual({
      container: "mp3", mp3Bitrate: 192, bitDepth: 16, sampleRate: 44100, channels: "stereo", master: true, fullBook: true,
      credits: true, chapterHeaders: true, retailSample: true,
    });
    expect(describeOutput(spotify)).toBe("MP3 192 kbps · 44.1 kHz stereo · levelled");
    expect(new Set(EXPORT_PRESETS.map(preset => preset.id)).size).toBe(EXPORT_PRESETS.length);
  });

  it("only treat the original, unlevelled MP3 as a passthrough", () => {
    expect(isPassthrough(presetById("original").output)).toBe(true);
    expect(isPassthrough({ ...presetById("original").output, master: true })).toBe(false);
    expect(isPassthrough(spotify)).toBe(false);
    expect(describeOutput(presetById("original").output)).toBe("Original MP3, no re-encoding");
  });

  it("name chapter files so they sort and survive every filesystem", () => {
    expect(chapterFileName(3, 12, "Chapter 3: The Storm / Harrow?", "mp3")).toBe("03 - Chapter 3 The Storm Harrow.mp3");
    expect(chapterFileName(7, 120, "  ", "wav")).toBe("007 - Chapter 7.wav");
    expect(attachmentDisposition("03 - Café “Noir”.mp3")).toBe(`attachment; filename="03 - Caf_ _Noir_.mp3"; filename*=UTF-8''03%20-%20Caf%C3%A9%20%E2%80%9CNoir%E2%80%9D.mp3`);
  });

  it("judge measured levels against the audiobook standard", () => {
    expect(meetsAudiobookStandard(-20.1, -3.6)).toBe(true);
    expect(meetsAudiobookStandard(-17.5, -3.6)).toBe(false);
    expect(meetsAudiobookStandard(-20, -2.9)).toBe(false);
    expect(meetsAudiobookStandard(null, -4)).toBe(false);
  });
});

describe("encoder settings", () => {
  it("levels to the target, allowing for the room tone that is added", () => {
    // 60 s at -26 dB plus 3.25 s of silence: +6 dB, plus the silence loss.
    const gain = levellingGainDb(-26, 60_000, AUDIOBOOK_STANDARD.headMs + AUDIOBOOK_STANDARD.tailMs);
    expect(gain).toBeCloseTo(6 + 10 * Math.log10(63_250 / 60_000), 1);
    expect(levellingGainDb(-91, 60_000, 0)).toBe(0);
    expect(levellingGainDb(-80, 60_000, 0)).toBe(0);
    expect(levellingGainDb(-70, 1_000, 0)).toBe(30);
  });

  it("builds one filter chain: resample, channels, level, limit, room tone, dither", () => {
    expect(chapterFilterChain({ inputChannels: 1, output: spotify, gainDb: 4.5 })).toBe(
      `aresample=44100,pan=stereo|c0=c0|c1=c0,volume=4.50dB,alimiter=limit=${(10 ** (LIMITER_CEILING_DB / 20)).toFixed(4)}:attack=5:release=60:level=0,adelay=delays=${AUDIOBOOK_STANDARD.headMs}:all=1,apad=pad_dur=2.500`,
    );
    const wav: ExportOutput = { ...spotify, container: "wav", channels: "mono", master: false, sampleRate: 48000 };
    expect(chapterFilterChain({ inputChannels: 1, output: wav, gainDb: null })).toBe("aresample=48000,aresample=osf=s16:dither_method=triangular");
    expect(chapterFilterChain({ inputChannels: 2, output: { ...wav, bitDepth: 24 }, gainDb: null })).toBe("aresample=48000,pan=mono|c0=0.5*c0+0.5*c1");
  });

  it("encodes MP3 at a constant bitrate with ID3v2.3, and PCM/FLAC at the chosen depth", () => {
    expect(codecArgs(spotify).join(" ")).toBe("-c:a libmp3lame -b:a 192k -compression_level 2 -ar 44100 -ac 2 -write_xing 0 -id3v2_version 3 -f mp3");
    expect(codecArgs({ ...spotify, container: "wav", bitDepth: 24, channels: "mono" }).join(" ")).toBe("-c:a pcm_s24le -ar 44100 -ac 1 -rf64 auto -f wav");
    expect(codecArgs({ ...spotify, container: "flac" }).join(" ")).toContain("-c:a flac -compression_level 5 -sample_fmt s16");
    expect(codecArgs({ ...spotify, container: "flac", bitDepth: 24 }).join(" ")).toContain("-sample_fmt s32 -bits_per_raw_sample 24");
  });

  it("writes track numbers and strips control characters from tags", () => {
    expect(metadataArgs({ title: "One\nTwo", album: "Book", artist: "Ann", track: 2, totalTracks: 9 })).toEqual([
      "-metadata", "title=One Two", "-metadata", "album=Book", "-metadata", "track=2/9", "-metadata", "genre=Audiobook",
      "-metadata", "artist=Ann", "-metadata", "album_artist=Ann",
    ]);
  });

  it("escapes book metadata and lists one chapter marker per chapter", () => {
    expect(escapeFfmetadata("a=b;c#d\\e")).toBe("a\\=b\\;c\\#d\\\\e");
    const text = bookMetadata({ title: "Harrow", artist: null, chapters: [{ title: "One", startMs: 0, endMs: 1500.4 }, { title: "Two", startMs: 3500, endMs: 5000 }] });
    expect(text.startsWith(";FFMETADATA1\ntitle=Harrow\nalbum=Harrow\ngenre=Audiobook\n")).toBe(true);
    expect(text.match(/\[CHAPTER\]/g)).toHaveLength(2);
    expect(text).toContain("START=3500\nEND=5000\ntitle=Two");
  });

  it("writes a valid ID3v2.3 tag that the frame scanner skips", () => {
    const tag = buildId3Tag({ title: "Chapitre 1 — Été", album: "Livre", artist: "Anne", track: "1/2" });
    expect(tag.subarray(0, 5)).toEqual(Buffer.from([0x49, 0x44, 0x33, 3, 0]));
    const size = (tag[6]! << 21) | (tag[7]! << 14) | (tag[8]! << 7) | tag[9]!;
    expect(size).toBe(tag.length - 10);
    expect(tag.includes(Buffer.from("Été", "utf16le"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Readiness per chapter
// ---------------------------------------------------------------------------

function segment(id: string, chapterId: string, orderIndex: number, patch: Partial<PlannableSegment> = {}): PlannableSegment {
  const text = `Line ${id}.`;
  return {
    id, chapterId, orderIndex, chapterOrderIndex: chapterId === "a" ? 0 : chapterId === "b" ? 1 : 2, text,
    textHash: hashSegmentText(text), audioStorageKey: `k/${id}`, voiceProvider: "Cloudflare", voiceModel: "aura", voiceId: "luna", targetVoiceId: "luna",
    ...patch,
  };
}

describe("chapter export states", () => {
  const pinned = { provider: "Cloudflare", model: "aura" };

  it("separates ready, outdated, partial, unrendered and empty chapters", () => {
    const segments = [
      segment("a1", "a", 0), segment("a2", "a", 1),
      segment("b1", "b", 0, { text: "Edited line." }), segment("b2", "b", 1, { targetVoiceId: "zeus" }),
      segment("c1", "c", 0), segment("c2", "c", 1, { audioStorageKey: null, textHash: null }),
      segment("d1", "d", 0, { audioStorageKey: null, textHash: null }),
    ];
    const durations = new Map<string, number | null>([["a1", 1000], ["a2", 1500], ["b1", 900], ["b2", null], ["c1", 700], ["c2", 0], ["d1", 0]]);
    const states = chapterAudioStates(segments, pinned, durations, ["a", "b", "c", "d", "e"]);
    expect(Object.fromEntries([...states].map(([id, status]) => [id, status.state]))).toEqual({ a: "ready", b: "outdated", c: "partial", d: "unrendered", e: "empty" });
    expect(states.get("a")).toMatchObject({ totalSegments: 2, segmentsWithAudio: 2, durationMs: 2500 });
    expect(states.get("b")).toMatchObject({ stale: 1, mismatchedVoice: 1, unverified: 0 });
    expect(chapterReason(states.get("b")!)).toBe("Exports with the audio it has (1 line edited since narration, 1 line in a different voice). Re-render it to update.");
    expect(chapterReason(states.get("c")!)).toBe("1 of 2 lines narrated. Finish it on the Generate tab to include it.");
    expect(chapterReason(states.get("a")!)).toBeNull();
  });

  it("counts verified-but-unmeasured audio as outdated, not ready", () => {
    const states = chapterAudioStates([segment("a1", "a", 0)], pinned, new Map([["a1", null]]), ["a"]);
    expect(states.get("a")).toMatchObject({ state: "outdated", unverified: 1 });
  });
});

function overviewOf(states: Array<[string, "ready" | "outdated" | "partial" | "unrendered" | "empty", Partial<{ soundPlanned: boolean | null; durationMs: number }>?]>): ExportOverview {
  const chapters = states.map(([id, state, extra], index) => ({
    chapterId: id, title: `Chapter ${id}`, position: index + 1, state, exportable: state === "ready" || state === "outdated",
    reason: state === "ready" ? null : `${state} reason`, totalSegments: state === "empty" ? 0 : 4, segmentsWithAudio: state === "unrendered" ? 0 : 4,
    durationMs: extra?.durationMs ?? 60_000, soundPlanned: extra?.soundPlanned ?? null,
  }));
  return {
    chapters,
    totalSegments: chapters.reduce((total, chapter) => total + chapter.totalSegments, 0),
    exportableChapters: chapters.filter(chapter => chapter.exportable).length,
    readyChapters: chapters.filter(chapter => chapter.state === "ready").length,
    exportableDurationMs: 0,
    soundDesign: { effects: false, music: false, level: "extra-subtle" },
    ffmpeg: true,
  };
}

describe("export readiness", () => {
  it("exports every finished chapter and leaves the rest out, instead of refusing the book", () => {
    const result = readinessFrom(overviewOf([["a", "ready"], ["b", "unrendered"], ["c", "partial"], ["d", "outdated"]]));
    expect(result).toEqual({ ready: true, chapterIds: ["a", "d"], warnings: ["1 chapter will use audio from before later edits or voice changes."] });
  });

  it("refuses only when nothing is finished, or a chosen chapter is not", () => {
    expect(readinessFrom(overviewOf([["a", "empty"]]))).toEqual({ ready: false, reason: "There is no narration to export yet. Add chapter text and render it first." });
    const none = readinessFrom(overviewOf([["a", "unrendered"], ["b", "partial"]]));
    expect(none.ready).toBe(false);
    if (!none.ready) expect(none.reason).toMatch(/no narration to export/);
    const chosen = readinessFrom(overviewOf([["a", "ready"], ["b", "partial"]]), { chapterIds: ["a", "b"] });
    expect(chosen).toEqual({ ready: false, reason: '"Chapter b" cannot be exported yet: partial reason' });
    expect(readinessFrom(overviewOf([["a", "ready"]]), { chapterIds: ["zzz"] }).ready).toBe(false);
    expect(readinessFrom(overviewOf([["a", "ready"], ["b", "ready"]]), { chapterIds: ["b"] })).toMatchObject({ ready: true, chapterIds: ["b"] });
  });

  it("warns about missing sound plans and very long chapters without blocking", () => {
    const result = readinessFrom(overviewOf([["a", "ready", { soundPlanned: false, durationMs: 130 * 60_000 }], ["b", "ready", { soundPlanned: true }]]));
    expect(result).toEqual({
      ready: true,
      chapterIds: ["a", "b"],
      warnings: [
        "1 chapter have no sound plan yet and will export without background sounds or music.",
        "1 chapter run past 120 minutes, the per-file limit some distributors (ACX) set.",
      ],
    });
  });

  it("needs ffmpeg for anything but the original MP3", () => {
    const overview = { ...overviewOf([["a", "ready"]]), ffmpeg: false };
    expect(readinessFrom(overview, { output: spotify }).ready).toBe(false);
    expect(readinessFrom(overview, { output: presetById("original").output }).ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real encodes
// ---------------------------------------------------------------------------

const ffmpeg = await resolveFfmpeg();

/** Speech-like test signal as a 24 kHz mono MP3, the shape Aura-2 returns. */
async function narration(dir: string, seconds: number, amplitude = 0.08): Promise<Buffer> {
  const file = path.join(dir, `voice-${seconds}-${amplitude}.mp3`);
  await runFfmpeg([
    "-f", "lavfi", "-i", `aevalsrc=exprs='${amplitude}*(0.5+0.5*sin(2*PI*4*t))*(sin(2*PI*140*t)+0.5*sin(2*PI*280*t)+0.25*sin(2*PI*420*t))':s=24000:d=${seconds}`,
    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "48k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", file,
  ]);
  return readFile(file);
}

async function tagsOf(dir: string, buffer: Buffer, ext: string): Promise<string> {
  const file = path.join(dir, `probe.${ext}`);
  await writeFile(file, buffer);
  const { stdout } = await runFfmpeg(["-i", file, "-f", "ffmetadata", "-"]);
  return stdout.toString();
}

const tags = { title: "Chapter One", album: "Harrow Pass", artist: "A. Author", track: 1, totalTracks: 2 };

describe.skipIf(!ffmpeg)("encoding with ffmpeg", () => {
  it("delivers a quiet 24 kHz chapter as a levelled 192 kbps 44.1 kHz stereo MP3 with tags", async () => {
    await withTempDir(async dir => {
      const voice = await narration(dir, 6);
      const encoded = await encodeChapter({ audio: voice, durationMs: 6000, output: spotify, tags });
      const scan = scanMp3(encoded.buffer);
      expect(scan.format).toMatchObject({ sampleRate: 44100, bitrateKbps: 192, versionBits: 3 });
      expect(scan.format.channelModeBits).not.toBe(3);
      expect(new Set(scan.frames.map(frame => frame.size)).size).toBeLessThanOrEqual(2); // CBR: padding only
      expect(encoded.gainDb).toBeGreaterThan(5);
      expect(encoded.rmsDb).toBeGreaterThanOrEqual(AUDIOBOOK_STANDARD.minRmsDb);
      expect(encoded.rmsDb).toBeLessThanOrEqual(AUDIOBOOK_STANDARD.maxRmsDb);
      expect(encoded.peakDb).toBeLessThanOrEqual(AUDIOBOOK_STANDARD.maxPeakDb);
      const expected = 6000 + AUDIOBOOK_STANDARD.headMs + AUDIOBOOK_STANDARD.tailMs;
      expect(Math.abs(encoded.durationMs - expected)).toBeLessThan(150);
      const metadata = await tagsOf(dir, encoded.buffer, "mp3");
      expect(metadata).toContain("title=Chapter One");
      expect(metadata).toContain("album=Harrow Pass");
      expect(metadata).toContain("track=1/2");
    });
  }, 60_000);

  it("writes WAV and FLAC at the chosen depth and rate without levelling when asked", async () => {
    await withTempDir(async dir => {
      const voice = await narration(dir, 2, 0.3);
      const wav = await encodeChapter({ audio: voice, durationMs: 2000, output: { ...spotify, container: "wav", bitDepth: 24, sampleRate: 48000, channels: "mono", master: false }, tags });
      // Above 16-bit the WAV spec calls for WAVE_FORMAT_EXTENSIBLE (0xFFFE), which ffmpeg writes.
      const format = scanWav(wav.buffer).format;
      expect(format).toMatchObject({ bitsPerSample: 24, sampleRate: 48000, channels: 1 });
      expect([1, 0xfffe]).toContain(format.audioFormat);
      expect(Math.abs(wav.durationMs - 2000)).toBeLessThan(120);
      expect(wav.gainDb).toBeNull();
      const flac = await encodeChapter({ audio: voice, durationMs: 2000, output: { ...spotify, container: "flac" }, tags });
      expect(flac.buffer.subarray(0, 4).toString("latin1")).toBe("fLaC");
      expect(await tagsOf(dir, flac.buffer, "flac")).toMatch(/title=Chapter One/i);
    });
  }, 60_000);

  it("joins chapters into one book file with chapter markers", async () => {
    await withTempDir(async dir => {
      const files: string[] = [];
      for (const [index, seconds] of [2, 3].entries()) {
        const encoded = await encodeChapter({ audio: await narration(dir, seconds), durationMs: seconds * 1000, output: spotify, tags: { ...tags, track: index + 1 } });
        const file = path.join(dir, `ch${index}.mp3`);
        await writeFile(file, encoded.buffer);
        files.push(file);
      }
      const gapFile = await writeSilence({ dir, output: spotify, ms: 1000 });
      const joined = await joinBookFiles({
        dir, files, container: "mp3", gapFile,
        metadata: bookMetadata({ title: "Harrow Pass", artist: "A. Author", chapters: [{ title: "One", startMs: 0, endMs: 5250 }, { title: "Two", startMs: 6250, endMs: 12500 }] }),
      });
      const book = await readFile(joined.filePath);
      expect(scanMp3(book).format).toMatchObject({ sampleRate: 44100, bitrateKbps: 192 });
      const expected = (2000 + 3000) + 2 * (AUDIOBOOK_STANDARD.headMs + AUDIOBOOK_STANDARD.tailMs) + 1000;
      expect(Math.abs(joined.durationMs - expected)).toBeLessThan(250);
      const metadata = await tagsOf(dir, book, "mp3");
      expect(metadata.match(/\[CHAPTER\]/g)).toHaveLength(2);
      expect(metadata).toContain("title=Two");
      expect(metadata).toContain("title=Harrow Pass");
    });
  }, 90_000);
});
