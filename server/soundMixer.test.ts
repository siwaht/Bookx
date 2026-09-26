import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assembleAudio, scanMp3, scanWav } from "./audioAssembly";
import { measureLoudness, resolveFfmpeg, runFfmpeg, withTempDir } from "./ffmpeg";
import { SOUND_TAGS, builtinSoundArgs, soundTag } from "./soundLibrary";
import { cueGainDb, cueStartMs, layoutChapterCues } from "./soundPlan";
import { buildMixGraph, describeTarget, encodeArgs, mixTargetFor, mixUnderNarration } from "./soundMixer";

// ---------------------------------------------------------------------------
// Synthetic streams
// ---------------------------------------------------------------------------

const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];

/** MPEG-1 Layer III frames at 44.1 kHz with the given bitrates (kbps), one per entry. */
function mp3Frames(bitrates: number[], channelModeBits = 3): Buffer {
  return Buffer.concat(bitrates.map(kbps => {
    const index = MPEG1_BITRATES.indexOf(kbps);
    const frame = Buffer.alloc(Math.floor(144 * ((kbps * 1000) / 44100)), 0x31);
    frame[0] = 0xff;
    frame[1] = 0xe0 | (3 << 3) | (0b01 << 1) | 1;
    frame[2] = (index << 4) | (0 << 2);
    frame[3] = channelModeBits << 6;
    return frame;
  }));
}

function wavBuffer(options: { sampleRate?: number; channels?: number; bits?: number; audioFormat?: number; dataBytes?: number } = {}): Buffer {
  const sampleRate = options.sampleRate ?? 22050;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const blockAlign = channels * (bits / 8);
  const data = Buffer.alloc(options.dataBytes ?? blockAlign * 100);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(options.audioFormat ?? 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("mix target", () => {
  it("reproduces a CBR MP3's own rate, channels and bitrate", () => {
    expect(mixTargetFor(mp3Frames(Array(20).fill(128)))).toEqual({ container: "mp3", sampleRate: 44100, channels: 1, bitrateKbps: 128, jointStereo: false });
    expect(mixTargetFor(mp3Frames(Array(20).fill(192), 1))).toEqual({ container: "mp3", sampleRate: 44100, channels: 2, bitrateKbps: 192, jointStereo: true });
  });

  it("does not trust a VBR stream's first frame for the bitrate", () => {
    const vbr = mp3Frames([32, 128, 160, 96, 128, 192, 128]);
    expect(mixTargetFor(vbr)).toMatchObject({ container: "mp3", bitrateKbps: 128 });
  });

  it("keeps a WAV narration's exact format, and refuses what it cannot reproduce", () => {
    expect(mixTargetFor(wavBuffer())).toMatchObject({ container: "wav", format: { sampleRate: 22050, channels: 1, bitsPerSample: 16, audioFormat: 1 } });
    expect(() => mixTargetFor(wavBuffer({ channels: 6 }))).toThrow(/mono or stereo/);
    expect(() => mixTargetFor(wavBuffer({ bits: 24, audioFormat: 0xfffe }))).toThrow(/cannot mix/);
  });

  it("describes the encoding for the export record", () => {
    expect(describeTarget(mixTargetFor(mp3Frames(Array(5).fill(128))))).toBe("MP3 128 kbps 44.1 kHz mono");
    expect(describeTarget(mixTargetFor(wavBuffer()))).toBe("WAV 16-bit 22.05 kHz mono");
  });
});

describe("encoder arguments", () => {
  it("encode MP3 as CBR in the target's format with no metadata frames", () => {
    const args = encodeArgs({ container: "mp3", sampleRate: 44100, channels: 1, bitrateKbps: 128, jointStereo: false });
    expect(args.join(" ")).toContain("-c:a libmp3lame -b:a 128k -ar 44100 -ac 1");
    expect(args.join(" ")).toContain("-write_xing 0 -id3v2_version 0 -f mp3");
    expect(args).not.toContain("-joint_stereo");
    expect(encodeArgs({ container: "mp3", sampleRate: 48000, channels: 2, bitrateKbps: 192, jointStereo: true }).join(" ")).toContain("-joint_stereo 1");
  });

  it("write WAV as raw PCM, to be wrapped in the narration's own header", () => {
    const format = scanWav(wavBuffer()).format;
    expect(encodeArgs({ container: "wav", format }).join(" ")).toContain("-c:a pcm_s16le -ar 22050 -ac 1 -map_metadata -1 -f s16le");
  });
});

describe("mix graph", () => {
  it("only reformats (and pads) the voice when there are no cues", () => {
    const base = { cues: [], sampleRate: 44100, channels: 1 as const, voiceDurationMs: 12_000, duckThreshold: 0.03 };
    expect(buildMixGraph({ ...base, tailMs: 0 })).toBe("[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono[out]");
    expect(buildMixGraph({ ...base, tailMs: 900 })).toBe("[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,apad=pad_dur=0.900[out]");
  });

  it("trims, fades, levels and delays each cue, then ducks the bed under the voice", () => {
    const graph = buildMixGraph({
      cues: [
        { input: 1, startMs: 198, lengthMs: 5500, fadeInMs: 900, fadeOutMs: 2600, gainDb: -18.44 },
        { input: 2, startMs: 8120, lengthMs: 1300, fadeInMs: 0, fadeOutMs: 650, gainDb: -21 },
      ],
      sampleRate: 44100,
      channels: 1,
      voiceDurationMs: 12_000,
      tailMs: 900,
      duckThreshold: 0.03162,
    });
    const chains = graph.split(";");
    expect(chains[0]).toBe("[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,apad=pad_dur=0.900,asplit=2[voice][key]");
    expect(chains[1]).toBe("[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,atrim=duration=5.500,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.900,afade=t=out:st=2.900:d=2.600,volume=-18.4dB,adelay=delays=198:all=1[c0]");
    // A zero fade still gets a 1 ms ramp so the filter accepts it.
    expect(chains[2]).toContain("afade=t=in:st=0:d=0.001");
    expect(chains[2]).toContain("adelay=delays=8120:all=1[c1]");
    expect(chains[3]).toBe("[c0][c1]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=12.900,atrim=duration=12.900[bed]");
    expect(chains[4]).toBe("[bed][key]sidechaincompress=threshold=0.03162:ratio=4:attack=20:release=350:makeup=1[ducked]");
    expect(chains[5]).toBe("[voice][ducked]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.99:level=0[out]");
  });

  it("passes a single cue straight to the bed", () => {
    const graph = buildMixGraph({ cues: [{ input: 1, startMs: 0, lengthMs: 1000, fadeInMs: 10, fadeOutMs: 500, gainDb: -20 }], sampleRate: 24000, channels: 2, voiceDurationMs: 3000, tailMs: 0, duckThreshold: 0.05 });
    expect(graph).toContain("[c0]anull,apad=whole_dur=3.000");
    expect(graph).toContain("channel_layouts=stereo");
    expect(graph).not.toContain("amix=inputs=1");
  });
});

// ---------------------------------------------------------------------------
// Against real ffmpeg
// ---------------------------------------------------------------------------

const ffmpeg = await resolveFfmpeg();

/** Speech-like test signal: a voiced buzz with syllable-rate modulation. */
async function speech(dir: string, name: string, seconds: number, format: "mp3" | "wav" = "mp3"): Promise<Buffer> {
  const file = path.join(dir, `${name}.${format}`);
  const encode = format === "mp3"
    ? ["-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3"]
    : ["-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-f", "wav"];
  await runFfmpeg([
    "-f", "lavfi", "-i", `aevalsrc=exprs='0.35*(0.5+0.5*sin(2*PI*4*t))*(sin(2*PI*140*t)+0.5*sin(2*PI*280*t)+0.25*sin(2*PI*420*t))':s=44100:d=${seconds}`,
    ...encode, file,
  ]);
  return readFile(file);
}

async function builtin(dir: string, tag: string) {
  const file = path.join(dir, `${tag}.mp3`);
  await runFfmpeg(builtinSoundArgs(soundTag(tag)!, file));
  return { buffer: await readFile(file), ...(await measureLoudness(file)) };
}

/** Mean level of `buffer` between two points, in dB (-91 for digital silence). */
async function levelBetween(dir: string, buffer: Buffer, fromMs: number, toMs: number): Promise<number> {
  const file = path.join(dir, `window-${fromMs}-${toMs}-${buffer.length}.${buffer.subarray(0, 4).toString("latin1") === "RIFF" ? "wav" : "mp3"}`);
  await writeFile(file, buffer);
  const { stderr } = await runFfmpeg(["-ss", (fromMs / 1000).toFixed(3), "-t", ((toMs - fromMs) / 1000).toFixed(3), "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const mean = /mean_volume:\s*(-?[\d.]+|-inf)/.exec(stderr)?.[1];
  return mean === undefined || mean === "-inf" ? -91 : Number(mean);
}

describe.skipIf(!ffmpeg)("with ffmpeg", () => {
  it("renders every built-in sound: audible, unclipped and about as long as asked", async () => {
    await withTempDir(async dir => {
      const results: Array<{ definition: (typeof SOUND_TAGS)[number]; measured: Awaited<ReturnType<typeof builtin>> }> = [];
      const queue = [...SOUND_TAGS];
      await Promise.all(Array.from({ length: 6 }, async () => {
        for (let definition = queue.shift(); definition; definition = queue.shift()) {
          results.push({ definition, measured: await builtin(dir, definition.tag) });
        }
      }));
      expect(results).toHaveLength(SOUND_TAGS.length);
      for (const { definition, measured } of results) {
        expect(measured.meanDb, definition.tag).toBeGreaterThan(-45);
        expect(measured.peakDb, definition.tag).toBeLessThan(0);
        expect(measured.durationMs, definition.tag).toBeGreaterThan(definition.durationSeconds * 1000 - 150);
        // Echo tails (gunshot, music) run a little past the requested length.
        expect(measured.durationMs, definition.tag).toBeLessThan(definition.durationSeconds * 1000 + 450);
      }
    });
  }, 120_000);

  it("mixes cues into the pauses, well under the voice, without changing the speech", async () => {
    await withTempDir(async dir => {
      const segments = [await speech(dir, "a", 3), await speech(dir, "b", 3), await speech(dir, "c", 3)];
      const rain = await builtin(dir, "rain");
      const swell = await builtin(dir, "music-romantic");
      const cues = [
        { index: 0, kind: "music" as const, placement: "before" as const, tag: "music-romantic", asset: swell },
        { index: 1, kind: "sfx" as const, placement: "after" as const, tag: "rain", asset: rain },
      ];
      const layout = layoutChapterCues([350, 350, 350], cues, 350);
      const assembled = assembleAudio(segments.map((buffer, index) => ({ buffer, gapAfterMs: layout.gaps[index] })), { leadInMs: layout.leadInMs });
      const target = mixTargetFor(assembled.buffer);
      const mixed = await mixUnderNarration({
        voice: assembled.buffer,
        voiceDurationMs: assembled.durationMs,
        level: "very-subtle",
        target,
        tailMs: layout.tailMs,
        cues: cues.map(cue => ({
          audio: cue.asset.buffer,
          startMs: cueStartMs(assembled.marks[cue.index]!, cue),
          kind: cue.kind,
          tag: cue.tag,
          assetDurationMs: cue.asset.durationMs,
          assetMeanDb: cue.asset.meanDb,
          assetPeakDb: cue.asset.peakDb,
          trimDb: 0,
        })),
      });

      // Same format as the narration, so it still joins frame by frame.
      const scan = scanMp3(mixed.buffer);
      expect(scan.format).toMatchObject({ sampleRate: 44100, bitrateKbps: 128, channelModeBits: 3 });
      expect(Math.abs(mixed.durationMs - assembled.durationMs)).toBeLessThan(120);
      expect(mixed.gainsDb).toEqual(cues.map(cue => cueGainDb({
        narrationMeanDb: mixed.narrationMeanDb!, kind: cue.kind, level: "very-subtle", assetMeanDb: cue.asset.meanDb, assetPeakDb: cue.asset.peakDb, trimDb: 0,
      })));

      const preRoll = [150, layout.leadInMs - 150] as const;
      const rainGap = [assembled.marks[1]!.startMs + assembled.marks[1]!.durationMs + 200, assembled.marks[2]!.startMs - 50] as const;
      const talking = [assembled.marks[1]!.startMs + 200, assembled.marks[1]!.startMs + 2600] as const;
      expect(await levelBetween(dir, assembled.buffer, ...preRoll)).toBe(-91);
      expect(await levelBetween(dir, assembled.buffer, ...rainGap)).toBe(-91);

      const narration = mixed.narrationMeanDb!;
      const musicLevel = await levelBetween(dir, mixed.buffer, ...preRoll);
      const rainLevel = await levelBetween(dir, mixed.buffer, ...rainGap);
      // Present, but far below the voice: 20-40 dB under its average.
      expect(musicLevel).toBeLessThan(narration - 20);
      expect(musicLevel).toBeGreaterThan(narration - 40);
      expect(rainLevel).toBeLessThan(narration - 20);
      expect(rainLevel).toBeGreaterThan(narration - 40);

      const speechBefore = await levelBetween(dir, assembled.buffer, ...talking);
      const speechAfter = await levelBetween(dir, mixed.buffer, ...talking);
      expect(Math.abs(speechAfter - speechBefore)).toBeLessThan(1);
    });
  }, 120_000);

  it("keeps a WAV narration's exact format", async () => {
    await withTempDir(async dir => {
      const voice = await speech(dir, "voice", 4, "wav");
      const knock = await builtin(dir, "knock");
      const source = scanWav(voice);
      const mixed = await mixUnderNarration({
        voice,
        voiceDurationMs: source.durationMs,
        level: "subtle",
        target: mixTargetFor(voice),
        tailMs: 1720,
        cues: [{ audio: knock.buffer, startMs: source.durationMs + 120, kind: "sfx", tag: "knock", assetDurationMs: knock.durationMs, assetMeanDb: knock.meanDb, assetPeakDb: knock.peakDb, trimDb: 0 }],
      });
      expect(mixed.container).toBe("wav");
      const result = scanWav(mixed.buffer);
      expect(result.format).toEqual(source.format);
      expect(Math.abs(result.durationMs - (source.durationMs + 1720))).toBeLessThan(60);
      // The knock plays in the tail, after the last word.
      expect(await levelBetween(dir, mixed.buffer, source.durationMs + 150, source.durationMs + 900)).toBeGreaterThan(-70);
    });
  }, 60_000);

  it("only re-encodes when a chapter has no cues", async () => {
    await withTempDir(async dir => {
      const voice = await speech(dir, "voice", 3);
      const mixed = await mixUnderNarration({ voice, voiceDurationMs: scanMp3(voice).durationMs, level: "very-subtle", target: mixTargetFor(voice), cues: [] });
      expect(mixed.narrationMeanDb).toBeNull();
      expect(mixed.gainsDb).toEqual([]);
      expect(scanMp3(mixed.buffer).format).toMatchObject({ sampleRate: 44100, bitrateKbps: 128, channelModeBits: 3 });
      expect(Math.abs(mixed.durationMs - scanMp3(voice).durationMs)).toBeLessThan(120);
    });
  }, 60_000);
});
