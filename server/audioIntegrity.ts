/**
 * Verification for a synthesised audio payload, run **before** it is stored.
 *
 * The failure the user actually cares about is a book that plays back with a
 * clipped or silent passage. In practice that comes from a provider returning a
 * short 200: a truncated body, an empty body, or a JSON error served with an audio
 * content type. None of those are visible to a status-code check, so every payload
 * is sniffed and measured here and a suspect one is retried rather than saved.
 */

export type AudioContainer = "mp3" | "wav" | "ogg" | "flac" | "mp4" | "unknown";

export type AudioInspection = {
  container: AudioContainer;
  bytes: number;
  /** Derived from the container when it can be read exactly or estimated. */
  durationMs?: number;
  /** Exact for WAV, estimated from the first frame for CBR MP3. */
  durationSource?: "exact" | "estimated";
  mimeType: string;
};

export type AudioVerdict =
  | { ok: true; inspection: AudioInspection }
  | { ok: false; reason: string; inspection: AudioInspection };

const MIME_BY_CONTAINER: Record<AudioContainer, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "audio/mp4",
  unknown: "application/octet-stream",
};

const startsWith = (buffer: Buffer, ascii: string, offset = 0): boolean =>
  buffer.length >= offset + ascii.length && buffer.subarray(offset, offset + ascii.length).toString("latin1") === ascii;

/** Offset of the first MPEG audio frame, skipping an ID3v2 tag if present. */
function firstMpegFrameOffset(buffer: Buffer): number {
  let offset = 0;
  if (startsWith(buffer, "ID3") && buffer.length >= 10) {
    // ID3v2 size is a 28-bit synchsafe integer in bytes 6..9.
    const size =
      ((buffer[6]! & 0x7f) << 21) | ((buffer[7]! & 0x7f) << 14) | ((buffer[8]! & 0x7f) << 7) | (buffer[9]! & 0x7f);
    offset = 10 + size;
  }
  for (let i = offset; i < Math.min(buffer.length - 1, offset + 8192); i++) {
    if (buffer[i] === 0xff && (buffer[i + 1]! & 0xe0) === 0xe0) return i;
  }
  return -1;
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/**
 * Reads bitrate and sample rate from the first MPEG frame header.
 * Duration is then `bytes * 8 / bitrate`, which is exact for constant-bitrate
 * output and a close estimate otherwise. Good enough for progress and for
 * detecting a body that is far shorter than its text.
 */
function inspectMp3(buffer: Buffer): { durationMs?: number } {
  const offset = firstMpegFrameOffset(buffer);
  if (offset < 0 || buffer.length < offset + 4) return {};

  const header = buffer.readUInt32BE(offset);
  const versionBits = (header >>> 19) & 0b11;
  const layerBits = (header >>> 17) & 0b11;
  const bitrateIndex = (header >>> 12) & 0b1111;
  const sampleRateIndex = (header >>> 10) & 0b11;

  if (layerBits !== 0b01) return {}; // Layer III only
  if (sampleRateIndex === 0b11) return {};

  const rates = SAMPLE_RATES[versionBits];
  const sampleRate = rates?.[sampleRateIndex];
  const table = versionBits === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES;
  const kbps = table[bitrateIndex];
  if (!sampleRate || !kbps) return {};

  const audioBytes = buffer.length - offset;
  return { durationMs: Math.round((audioBytes * 8) / kbps) };
}

/** Reads the WAV fmt/data chunks for an exact duration. */
function inspectWav(buffer: Buffer): { durationMs?: number } {
  if (buffer.length < 44) return {};
  let offset = 12; // past "RIFF" size "WAVE"
  let byteRate = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("latin1");
    const size = buffer.readUInt32LE(offset + 4);

    if (id === "fmt " && offset + 8 + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16);
    } else if (id === "data" && byteRate > 0) {
      // Trust the smaller of the declared and the actual remaining size so a
      // truncated file reports its real length rather than its intended one.
      const available = Math.max(0, buffer.length - (offset + 8));
      return { durationMs: Math.round((Math.min(size, available) / byteRate) * 1000) };
    }

    offset += 8 + size + (size % 2);
  }
  return {};
}

export function inspectAudio(buffer: Buffer): AudioInspection {
  const bytes = buffer.length;

  if (startsWith(buffer, "RIFF") && startsWith(buffer, "WAVE", 8)) {
    const { durationMs } = inspectWav(buffer);
    return { container: "wav", bytes, durationMs, durationSource: durationMs ? "exact" : undefined, mimeType: MIME_BY_CONTAINER.wav };
  }
  if (startsWith(buffer, "OggS")) {
    return { container: "ogg", bytes, mimeType: MIME_BY_CONTAINER.ogg };
  }
  if (startsWith(buffer, "fLaC")) {
    return { container: "flac", bytes, mimeType: MIME_BY_CONTAINER.flac };
  }
  if (startsWith(buffer, "ftyp", 4)) {
    return { container: "mp4", bytes, mimeType: MIME_BY_CONTAINER.mp4 };
  }
  if (startsWith(buffer, "ID3") || firstMpegFrameOffset(buffer) === 0) {
    const { durationMs } = inspectMp3(buffer);
    return { container: "mp3", bytes, durationMs, durationSource: durationMs ? "estimated" : undefined, mimeType: MIME_BY_CONTAINER.mp3 };
  }

  return { container: "unknown", bytes, mimeType: MIME_BY_CONTAINER.unknown };
}

/**
 * Smallest payload we will believe for a given amount of text.
 *
 * Even the most aggressive codec needs roughly a kilobyte per spoken second. A
 * body far below that for the text it claims to voice is a truncated stream, so we
 * would rather retry than store a clipped sentence.
 */
export function minimumPlausibleBytes(textLength: number): number {
  if (textLength <= 0) return 0;
  // ~14 characters per spoken second at a narration pace, ~1.5 KB per second at
  // a low bitrate, then halved to stay well clear of a false positive.
  const seconds = textLength / 14;
  return Math.max(512, Math.floor(seconds * 750));
}

export type VerifyOptions = {
  /** The text this audio is supposed to voice; enables the length sanity check. */
  text?: string;
  /** `Content-Length` from the response, when the provider sent one. */
  declaredBytes?: number;
  /** Accept containers we cannot parse, e.g. a provider returning raw PCM. */
  allowUnknownContainer?: boolean;
};

/**
 * Decides whether a payload is safe to store.
 *
 * Anything rejected here is treated as a retryable provider failure by the worker,
 * which is the behaviour that keeps a partial body out of the finished book.
 */
export function verifyAudioPayload(buffer: Buffer, options: VerifyOptions = {}): AudioVerdict {
  const inspection = inspectAudio(buffer);

  if (buffer.length === 0) {
    return { ok: false, reason: "The provider returned an empty audio body", inspection };
  }

  // A JSON error body served with an audio content type is common enough on
  // gateway timeouts that it is worth naming precisely.
  const head = buffer.subarray(0, 1).toString("latin1");
  if (head === "{" || head === "[") {
    return { ok: false, reason: "The provider returned JSON where audio was expected", inspection };
  }

  if (options.declaredBytes !== undefined && options.declaredBytes > 0 && buffer.length < options.declaredBytes) {
    return {
      ok: false,
      reason: `Audio stream ended early: received ${buffer.length} of ${options.declaredBytes} bytes`,
      inspection,
    };
  }

  if (inspection.container === "unknown" && !options.allowUnknownContainer) {
    return { ok: false, reason: "Audio payload is not a recognised container", inspection };
  }

  if (options.text) {
    const floor = minimumPlausibleBytes(options.text.length);
    if (buffer.length < floor) {
      return {
        ok: false,
        reason: `Audio is implausibly short for ${options.text.length} characters of text (${buffer.length} bytes, expected at least ${floor})`,
        inspection,
      };
    }
  }

  return { ok: true, inspection };
}
