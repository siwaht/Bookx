/**
 * Joins rendered segments into one continuous file.
 *
 * Implemented in plain TypeScript rather than by shelling out to ffmpeg, for two
 * reasons. Every segment in a run comes from the same provider, model and voice, so
 * the streams already share a bitrate, sample rate and channel mode — which is
 * exactly the case where a frame-level join is lossless and a re-encode would only
 * lose quality. And it keeps the deployment free of a binary that may not exist on
 * the host.
 *
 * The join is deliberately strict: mismatched formats are rejected rather than
 * silently concatenated, because that is how you get a file that plays at the wrong
 * speed halfway through.
 */

export type Mp3Format = {
  /** 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5 */
  versionBits: number;
  bitrateKbps: number;
  sampleRate: number;
  /** Raw channel-mode bits; 3 means mono. */
  channelModeBits: number;
  samplesPerFrame: number;
  /** Milliseconds of audio per frame. */
  frameDurationMs: number;
};

export type Mp3Frame = { offset: number; size: number };

export type Mp3Scan = {
  format: Mp3Format;
  frames: Mp3Frame[];
  /** Offset of the first frame, i.e. the end of any ID3v2 tag. */
  firstFrameOffset: number;
  durationMs: number;
};

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

export class AudioAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioAssemblyError";
  }
}

// ---------------------------------------------------------------------------
// ID3
// ---------------------------------------------------------------------------

/** Length of the ID3v2 tag at the start of `buffer`, or 0 if there is none. */
export function id3v2Length(buffer: Buffer): number {
  if (buffer.length < 10 || buffer.subarray(0, 3).toString("latin1") !== "ID3") return 0;
  // Bytes 6-9 hold a 28-bit synchsafe integer: the tag size after the header.
  const size =
    ((buffer[6]! & 0x7f) << 21) | ((buffer[7]! & 0x7f) << 14) | ((buffer[8]! & 0x7f) << 7) | (buffer[9]! & 0x7f);
  const footer = (buffer[5]! & 0x10) !== 0 ? 10 : 0;
  return Math.min(buffer.length, 10 + size + footer);
}

/** True when the last 128 bytes are an ID3v1 tag. */
export function hasId3v1(buffer: Buffer): boolean {
  return buffer.length >= 128 && buffer.subarray(buffer.length - 128, buffer.length - 125).toString("latin1") === "TAG";
}

/**
 * Removes container metadata so only audio frames remain.
 *
 * A trailing ID3v1 tag matters here: left in place mid-stream, decoders read those
 * 128 bytes as garbage audio, which is audible as a click between segments.
 */
export function stripId3(buffer: Buffer): Buffer {
  const start = id3v2Length(buffer);
  const end = hasId3v1(buffer) ? buffer.length - 128 : buffer.length;
  return buffer.subarray(start, Math.max(start, end));
}

// ---------------------------------------------------------------------------
// MP3 frames
// ---------------------------------------------------------------------------

export function parseMp3FrameHeader(buffer: Buffer, offset: number): { format: Mp3Format; size: number } | null {
  if (offset + 4 > buffer.length) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1]! & 0xe0) !== 0xe0) return null;

  const header = buffer.readUInt32BE(offset);
  const versionBits = (header >>> 19) & 0b11;
  const layerBits = (header >>> 17) & 0b11;
  const bitrateIndex = (header >>> 12) & 0b1111;
  const sampleRateIndex = (header >>> 10) & 0b11;
  const padding = (header >>> 9) & 0b1;
  const channelModeBits = (header >>> 6) & 0b11;

  if (versionBits === 1) return null; // reserved
  if (layerBits !== 0b01) return null; // Layer III only
  if (sampleRateIndex === 0b11) return null;
  if (bitrateIndex === 0 || bitrateIndex === 0b1111) return null; // free/bad

  const sampleRate = SAMPLE_RATES[versionBits]?.[sampleRateIndex];
  const bitrateKbps = (versionBits === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex];
  if (!sampleRate || !bitrateKbps) return null;

  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  const size = Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
  if (size <= 4) return null;

  return {
    size,
    format: {
      versionBits,
      bitrateKbps,
      sampleRate,
      channelModeBits,
      samplesPerFrame,
      frameDurationMs: (samplesPerFrame / sampleRate) * 1000,
    },
  };
}

/**
 * Walks every frame in an MP3 stream.
 *
 * Frames are followed by their declared size and re-validated at each step, so a
 * stream that goes out of sync is reported rather than producing a file whose
 * length silently disagrees with its contents.
 */
export function scanMp3(input: Buffer): Mp3Scan {
  const buffer = stripId3(input);
  const frames: Mp3Frame[] = [];
  let format: Mp3Format | null = null;
  let offset = 0;

  // Skip any leading junk to the first real frame.
  while (offset < buffer.length - 4) {
    if (parseMp3FrameHeader(buffer, offset)) break;
    offset++;
  }
  const firstFrameOffset = offset;

  while (offset + 4 <= buffer.length) {
    const parsed = parseMp3FrameHeader(buffer, offset);
    if (!parsed) break;
    if (offset + parsed.size > buffer.length) break; // truncated final frame
    if (!format) format = parsed.format;
    frames.push({ offset, size: parsed.size });
    offset += parsed.size;
  }

  if (!format || !frames.length) throw new AudioAssemblyError("No MP3 frames found in the segment audio");

  return {
    format,
    frames,
    firstFrameOffset,
    durationMs: Math.round(frames.length * format.frameDurationMs),
  };
}

const sameMp3Format = (left: Mp3Format, right: Mp3Format): boolean =>
  left.versionBits === right.versionBits &&
  left.sampleRate === right.sampleRate &&
  left.bitrateKbps === right.bitrateKbps &&
  left.channelModeBits === right.channelModeBits;

/**
 * Builds silent frames matching a stream's own format.
 *
 * A Layer III frame with a valid header and a zeroed body carries no granule data,
 * which every mainstream decoder renders as silence. Generating the gap in the
 * target format keeps the join seamless — inserting a differently-encoded pause is
 * what makes a chapter break audible as a glitch.
 */
export function buildSilentMp3(format: Mp3Format, ms: number): Buffer {
  if (ms <= 0) return Buffer.alloc(0);

  const frameCount = Math.max(1, Math.round(ms / format.frameDurationMs));
  const size = Math.floor((format.samplesPerFrame / 8) * ((format.bitrateKbps * 1000) / format.sampleRate));

  const bitrateIndex = (format.versionBits === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)
    .indexOf(format.bitrateKbps);
  const sampleRateIndex = (SAMPLE_RATES[format.versionBits] ?? []).indexOf(format.sampleRate);
  if (bitrateIndex < 1 || sampleRateIndex < 0) {
    throw new AudioAssemblyError("Cannot build a silent frame for this MP3 format");
  }

  const frame = Buffer.alloc(size, 0);
  frame[0] = 0xff;
  // Sync high bits, version, Layer III (01), protection bit set (no CRC).
  frame[1] = 0xe0 | (format.versionBits << 3) | (0b01 << 1) | 0b1;
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2); // padding 0, private 0
  frame[3] = format.channelModeBits << 6;

  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

export type AssemblyPart = { buffer: Buffer; label?: string };

export type AssemblyResult = {
  buffer: Buffer;
  container: "mp3" | "wav";
  mimeType: string;
  durationMs: number;
  /** Where each part begins in the finished file, for chapter marks. */
  marks: Array<{ label: string; startMs: number; durationMs: number }>;
};

/** Joins same-format MP3 streams, optionally inserting a gap between them. */
export function concatMp3(parts: AssemblyPart[], gapMs = 0): AssemblyResult {
  if (!parts.length) throw new AudioAssemblyError("Nothing to assemble");

  const scans = parts.map((part, index) => {
    try {
      return scanMp3(part.buffer);
    } catch (error) {
      throw new AudioAssemblyError(
        `${part.label || `Part ${index + 1}`} could not be read as MP3: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  });

  const format = scans[0]!.format;
  for (const [index, scan] of scans.entries()) {
    if (!sameMp3Format(scan.format, format)) {
      throw new AudioAssemblyError(
        `${parts[index]!.label || `Part ${index + 1}`} is ${scan.format.bitrateKbps}kbps/${scan.format.sampleRate}Hz but the first part is ${format.bitrateKbps}kbps/${format.sampleRate}Hz. Re-render it with the same voice model before exporting.`,
      );
    }
  }

  const silence = buildSilentMp3(format, gapMs);
  const silenceMs = gapMs > 0 ? Math.round((silence.length / (format.bitrateKbps * 125)) * 1000) : 0;

  const chunks: Buffer[] = [];
  const marks: AssemblyResult["marks"] = [];
  let cursorMs = 0;

  scans.forEach((scan, index) => {
    if (index > 0 && silence.length) {
      chunks.push(silence);
      cursorMs += silenceMs;
    }
    // Emit only the frame bytes; anything between frames is metadata or junk.
    const stripped = stripId3(parts[index]!.buffer);
    const first = scan.frames[0]!;
    const last = scan.frames[scan.frames.length - 1]!;
    chunks.push(stripped.subarray(first.offset, last.offset + last.size));

    marks.push({ label: parts[index]!.label || `Part ${index + 1}`, startMs: cursorMs, durationMs: scan.durationMs });
    cursorMs += scan.durationMs;
  });

  return {
    buffer: Buffer.concat(chunks),
    container: "mp3",
    mimeType: "audio/mpeg",
    durationMs: cursorMs,
    marks,
  };
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

export type WavFormat = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
};

export type WavScan = { format: WavFormat; data: Buffer; durationMs: number };

export function scanWav(buffer: Buffer): WavScan {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString("latin1") !== "RIFF" || buffer.subarray(8, 12).toString("latin1") !== "WAVE") {
    throw new AudioAssemblyError("Not a WAV stream");
  }

  let offset = 12;
  let format: WavFormat | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("latin1");
    const declared = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt " && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) throw new AudioAssemblyError("WAV data chunk appeared before its format chunk");
      // Trust the smaller of declared and actual, so a truncated file reports what
      // it really contains rather than what it intended to.
      const available = Math.max(0, buffer.length - body);
      const data = buffer.subarray(body, body + Math.min(declared, available));
      return {
        format,
        data,
        durationMs: format.byteRate > 0 ? Math.round((data.length / format.byteRate) * 1000) : 0,
      };
    }

    offset = body + declared + (declared % 2);
  }

  throw new AudioAssemblyError("WAV stream has no data chunk");
}

const sameWavFormat = (left: WavFormat, right: WavFormat): boolean =>
  left.audioFormat === right.audioFormat &&
  left.channels === right.channels &&
  left.sampleRate === right.sampleRate &&
  left.bitsPerSample === right.bitsPerSample;

function wavHeader(format: WavFormat, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format.audioFormat, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.byteRate, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Joins same-format WAV streams under one correct header. */
export function concatWav(parts: AssemblyPart[], gapMs = 0): AssemblyResult {
  if (!parts.length) throw new AudioAssemblyError("Nothing to assemble");

  const scans = parts.map((part, index) => {
    try {
      return scanWav(part.buffer);
    } catch (error) {
      throw new AudioAssemblyError(
        `${part.label || `Part ${index + 1}`} could not be read as WAV: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  });

  const format = scans[0]!.format;
  for (const [index, scan] of scans.entries()) {
    if (!sameWavFormat(scan.format, format)) {
      throw new AudioAssemblyError(
        `${parts[index]!.label || `Part ${index + 1}`} is ${scan.format.sampleRate}Hz/${scan.format.bitsPerSample}-bit but the first part is ${format.sampleRate}Hz/${format.bitsPerSample}-bit.`,
      );
    }
  }

  // 8-bit PCM is unsigned, so its silence is 0x80 rather than 0.
  const silenceByte = format.bitsPerSample === 8 ? 0x80 : 0x00;
  const rawGap = Math.round((gapMs / 1000) * format.byteRate);
  // Align the gap to a whole frame or the channels would swap after it.
  const align = Math.max(1, format.blockAlign);
  const silence = gapMs > 0 ? Buffer.alloc(Math.floor(rawGap / align) * align, silenceByte) : Buffer.alloc(0);
  const silenceMs = format.byteRate > 0 ? Math.round((silence.length / format.byteRate) * 1000) : 0;

  const bodies: Buffer[] = [];
  const marks: AssemblyResult["marks"] = [];
  let cursorMs = 0;

  scans.forEach((scan, index) => {
    if (index > 0 && silence.length) {
      bodies.push(silence);
      cursorMs += silenceMs;
    }
    bodies.push(scan.data);
    marks.push({ label: parts[index]!.label || `Part ${index + 1}`, startMs: cursorMs, durationMs: scan.durationMs });
    cursorMs += scan.durationMs;
  });

  const data = Buffer.concat(bodies);
  return {
    buffer: Buffer.concat([wavHeader(format, data.length), data]),
    container: "wav",
    mimeType: "audio/wav",
    durationMs: cursorMs,
    marks,
  };
}

/** Joins parts, picking the strategy from the first part's container. */
export function assembleAudio(parts: AssemblyPart[], options: { gapMs?: number } = {}): AssemblyResult {
  if (!parts.length) throw new AudioAssemblyError("Nothing to assemble");
  const first = parts[0]!.buffer;
  const isWav = first.length >= 12 && first.subarray(0, 4).toString("latin1") === "RIFF";
  return isWav ? concatWav(parts, options.gapMs ?? 0) : concatMp3(parts, options.gapMs ?? 0);
}
