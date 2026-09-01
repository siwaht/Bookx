import { describe, expect, it } from "vitest";
import {
  AudioAssemblyError,
  assembleAudio,
  buildSilentMp3,
  concatMp3,
  concatWav,
  hasId3v1,
  id3v2Length,
  parseMp3FrameHeader,
  scanMp3,
  scanWav,
  stripId3,
} from "./audioAssembly";

/**
 * Builds a valid CBR MPEG-1 Layer III stream.
 * At 128 kbps / 44.1 kHz a frame is 417 bytes and lasts ~26.12 ms.
 */
function mp3(frameCount: number, options: { bitrateIndex?: number; sampleRateIndex?: number; channelModeBits?: number } = {}): Buffer {
  const bitrateIndex = options.bitrateIndex ?? 9; // 128 kbps
  const sampleRateIndex = options.sampleRateIndex ?? 0; // 44100
  const channelModeBits = options.channelModeBits ?? 1; // joint stereo
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const rates = [44100, 48000, 32000];
  const size = Math.floor(144 * ((bitrates[bitrateIndex]! * 1000) / rates[sampleRateIndex]!));

  const frames: Buffer[] = [];
  for (let index = 0; index < frameCount; index++) {
    const frame = Buffer.alloc(size, 0x31);
    frame[0] = 0xff;
    frame[1] = 0xe0 | (3 << 3) | (0b01 << 1) | 1;
    frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2);
    frame[3] = channelModeBits << 6;
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

function withId3v2(audio: Buffer, tagBytes = 64): Buffer {
  const header = Buffer.alloc(10 + tagBytes, 0);
  header.write("ID3", 0, "latin1");
  header[3] = 3;
  header[6] = 0;
  header[7] = 0;
  header[8] = (tagBytes >> 7) & 0x7f;
  header[9] = tagBytes & 0x7f;
  return Buffer.concat([header, audio]);
}

function withId3v1(audio: Buffer): Buffer {
  const tag = Buffer.alloc(128, 0);
  tag.write("TAG", 0, "latin1");
  return Buffer.concat([audio, tag]);
}

function wav(dataBytes: number, options: { sampleRate?: number; channels?: number; bits?: number; fill?: number } = {}): Buffer {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes, options.fill ?? 0x22)]);
}

describe("ID3 handling", () => {
  it("measures an ID3v2 tag", () => {
    expect(id3v2Length(withId3v2(mp3(1), 64))).toBe(74);
    expect(id3v2Length(mp3(1))).toBe(0);
  });

  it("detects an ID3v1 trailer", () => {
    expect(hasId3v1(withId3v1(mp3(2)))).toBe(true);
    expect(hasId3v1(mp3(2))).toBe(false);
  });

  it("strips tags from both ends", () => {
    const audio = mp3(3);
    const tagged = withId3v1(withId3v2(audio, 32));
    expect(stripId3(tagged).equals(audio)).toBe(true);
  });
});

describe("parseMp3FrameHeader", () => {
  it("reads a 128kbps 44.1kHz frame", () => {
    const parsed = parseMp3FrameHeader(mp3(1), 0);
    expect(parsed).not.toBeNull();
    expect(parsed!.size).toBe(417);
    expect(parsed!.format).toMatchObject({ bitrateKbps: 128, sampleRate: 44100, samplesPerFrame: 1152 });
    expect(parsed!.format.frameDurationMs).toBeCloseTo(26.12, 1);
  });

  it("rejects non-frames", () => {
    expect(parseMp3FrameHeader(Buffer.from("not audio here"), 0)).toBeNull();
  });

  it("rejects a free-format or reserved bitrate", () => {
    const frame = mp3(1);
    frame[2] = (0 << 4) | (0 << 2); // bitrate index 0
    expect(parseMp3FrameHeader(frame, 0)).toBeNull();
    frame[2] = (0b1111 << 4) | (0 << 2);
    expect(parseMp3FrameHeader(frame, 0)).toBeNull();
  });

  it("rejects a reserved sample rate", () => {
    const frame = mp3(1);
    frame[2] = (9 << 4) | (0b11 << 2);
    expect(parseMp3FrameHeader(frame, 0)).toBeNull();
  });
});

describe("scanMp3", () => {
  it("counts frames and derives duration", () => {
    const scan = scanMp3(mp3(100));
    expect(scan.frames).toHaveLength(100);
    expect(scan.durationMs).toBe(Math.round(100 * (1152 / 44100) * 1000));
  });

  it("sees through an ID3v2 tag", () => {
    expect(scanMp3(withId3v2(mp3(10))).frames).toHaveLength(10);
  });

  it("ignores a truncated final frame rather than emitting it", () => {
    const full = mp3(5);
    const truncated = full.subarray(0, full.length - 100);
    expect(scanMp3(truncated).frames).toHaveLength(4);
  });

  it("throws when there are no frames at all", () => {
    expect(() => scanMp3(Buffer.alloc(500, 0x00))).toThrow(AudioAssemblyError);
  });
});

describe("buildSilentMp3", () => {
  it("produces whole valid frames in the source format", () => {
    const { format } = scanMp3(mp3(1));
    const silence = buildSilentMp3(format, 1000);
    const scan = scanMp3(silence);

    expect(scan.frames.length).toBeGreaterThan(0);
    expect(scan.format).toMatchObject({ bitrateKbps: 128, sampleRate: 44100, channelModeBits: format.channelModeBits });
    // Every byte must belong to a frame: no padding, no trailing junk.
    expect(scan.frames.reduce((total, frame) => total + frame.size, 0)).toBe(silence.length);
    expect(scan.durationMs).toBeGreaterThan(950);
    expect(scan.durationMs).toBeLessThan(1050);
  });

  it("zeroes the frame body so it decodes as silence", () => {
    const { format } = scanMp3(mp3(1));
    const silence = buildSilentMp3(format, 100);
    // Bytes past the 4-byte header carry no granule data.
    expect(silence.subarray(4, 417).every(byte => byte === 0)).toBe(true);
  });

  it("returns nothing for a zero or negative gap", () => {
    const { format } = scanMp3(mp3(1));
    expect(buildSilentMp3(format, 0)).toHaveLength(0);
    expect(buildSilentMp3(format, -5)).toHaveLength(0);
  });

  it("matches mono when the source is mono", () => {
    const { format } = scanMp3(mp3(1, { channelModeBits: 3 }));
    expect(scanMp3(buildSilentMp3(format, 200)).format.channelModeBits).toBe(3);
  });
});

describe("concatMp3", () => {
  it("joins parts losslessly with no gap", () => {
    const a = mp3(20);
    const b = mp3(30);
    const result = concatMp3([{ buffer: a, label: "A" }, { buffer: b, label: "B" }]);

    expect(result.container).toBe("mp3");
    expect(result.buffer.length).toBe(a.length + b.length);
    expect(scanMp3(result.buffer).frames).toHaveLength(50);
  });

  it("drops tags from the middle of the stream", () => {
    // An ID3v1 trailer left inside the joined file is audible as a click.
    const a = withId3v1(mp3(10));
    const b = withId3v2(mp3(10));
    const result = concatMp3([{ buffer: a }, { buffer: b }]);
    expect(scanMp3(result.buffer).frames).toHaveLength(20);
    expect(result.buffer.length).toBe(mp3(20).length);
  });

  it("inserts a format-matched gap between parts", () => {
    const result = concatMp3([{ buffer: mp3(20) }, { buffer: mp3(20) }], 1000);
    const scan = scanMp3(result.buffer);
    // 40 content frames plus ~38 frames of silence.
    expect(scan.frames.length).toBeGreaterThan(70);
    expect(result.durationMs).toBeGreaterThan(2000);
  });

  it("puts no gap before the first part or after the last", () => {
    const single = concatMp3([{ buffer: mp3(10) }], 1000);
    expect(single.buffer.length).toBe(mp3(10).length);
  });

  it("reports where each part starts, for chapter marks", () => {
    const result = concatMp3(
      [{ buffer: mp3(38), label: "Chapter 1" }, { buffer: mp3(38), label: "Chapter 2" }],
      500,
    );
    expect(result.marks).toHaveLength(2);
    expect(result.marks[0]).toMatchObject({ label: "Chapter 1", startMs: 0 });
    expect(result.marks[1]!.label).toBe("Chapter 2");
    // Second mark starts after part one plus the gap.
    expect(result.marks[1]!.startMs).toBeGreaterThan(result.marks[0]!.durationMs);
  });

  it("refuses a bitrate mismatch instead of producing a broken file", () => {
    expect(() => concatMp3([
      { buffer: mp3(5), label: "First" },
      { buffer: mp3(5, { bitrateIndex: 5 }), label: "Second" },
    ])).toThrow(/Second is 64kbps.*first part is 128kbps/);
  });

  it("refuses a sample-rate mismatch", () => {
    expect(() => concatMp3([
      { buffer: mp3(5) },
      { buffer: mp3(5, { sampleRateIndex: 1 }) },
    ])).toThrow(AudioAssemblyError);
  });

  it("refuses a channel-mode mismatch", () => {
    expect(() => concatMp3([
      { buffer: mp3(5) },
      { buffer: mp3(5, { channelModeBits: 3 }) },
    ])).toThrow(AudioAssemblyError);
  });

  it("names the offending part", () => {
    expect(() => concatMp3([
      { buffer: mp3(5), label: "Chapter 1" },
      { buffer: Buffer.alloc(400, 0), label: "Chapter 2" },
    ])).toThrow(/Chapter 2 could not be read as MP3/);
  });

  it("rejects an empty part list", () => {
    expect(() => concatMp3([])).toThrow(/Nothing to assemble/);
  });
});

describe("concatWav", () => {
  it("joins data under one correct header", () => {
    const result = concatWav([{ buffer: wav(4410) }, { buffer: wav(4410) }]);
    const scan = scanWav(result.buffer);
    expect(scan.data.length).toBe(8820);
    expect(result.buffer.readUInt32LE(4)).toBe(36 + 8820);
    expect(scan.format).toMatchObject({ sampleRate: 44100, channels: 1, bitsPerSample: 16 });
  });

  it("inserts an exact, frame-aligned gap", () => {
    const result = concatWav([{ buffer: wav(88_200) }, { buffer: wav(88_200) }], 500);
    // 1s + 0.5s + 1s at 88200 bytes/sec.
    expect(scanWav(result.buffer).data.length).toBe(88_200 + 44_100 + 88_200);
    expect(result.durationMs).toBe(2500);
  });

  it("uses 0x80 for 8-bit silence", () => {
    const result = concatWav([{ buffer: wav(1000, { bits: 8 }) }, { buffer: wav(1000, { bits: 8 }) }], 100);
    const scan = scanWav(result.buffer);
    expect(scan.data[1500]).toBe(0x80);
  });

  it("refuses a format mismatch", () => {
    expect(() => concatWav([
      { buffer: wav(100), label: "One" },
      { buffer: wav(100, { sampleRate: 22050 }), label: "Two" },
    ])).toThrow(/Two is 22050Hz/);
  });

  it("reads a truncated data chunk by its real length", () => {
    const full = wav(88_200);
    const truncated = full.subarray(0, 44 + 44_100);
    expect(scanWav(truncated).durationMs).toBe(500);
  });

  it("rejects a non-WAV buffer", () => {
    expect(() => scanWav(mp3(5))).toThrow(/Not a WAV stream/);
  });
});

describe("assembleAudio", () => {
  it("dispatches to WAV when the first part is RIFF", () => {
    expect(assembleAudio([{ buffer: wav(1000) }]).container).toBe("wav");
  });

  it("dispatches to MP3 otherwise", () => {
    expect(assembleAudio([{ buffer: mp3(5) }]).container).toBe("mp3");
  });

  it("carries the gap through", () => {
    const withGap = assembleAudio([{ buffer: mp3(20) }, { buffer: mp3(20) }], { gapMs: 800 });
    const without = assembleAudio([{ buffer: mp3(20) }, { buffer: mp3(20) }]);
    expect(withGap.buffer.length).toBeGreaterThan(without.buffer.length);
  });
});
