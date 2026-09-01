import { describe, expect, it } from "vitest";
import { inspectAudio, minimumPlausibleBytes, verifyAudioPayload } from "./audioIntegrity";

/** A CBR MPEG-1 Layer III frame header at 128 kbps / 44.1 kHz, then padding. */
function mp3Fixture(totalBytes: number): Buffer {
  const buffer = Buffer.alloc(Math.max(4, totalBytes), 0x55);
  buffer[0] = 0xff;
  buffer[1] = 0xfb; // MPEG-1, Layer III, no CRC
  buffer[2] = 0x90; // bitrate index 9 (128 kbps), sample rate index 0 (44.1 kHz)
  buffer[3] = 0x00;
  return buffer;
}

function id3Mp3Fixture(totalBytes: number): Buffer {
  const tagSize = 10;
  const head = Buffer.alloc(10 + tagSize, 0);
  head.write("ID3", 0, "latin1");
  head[6] = 0;
  head[7] = 0;
  head[8] = 0;
  head[9] = tagSize;
  return Buffer.concat([head, mp3Fixture(Math.max(4, totalBytes - head.length))]);
}

/** 16-bit mono PCM at 44.1 kHz, so byteRate is 88200. */
function wavFixture(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(88200, 28); // byteRate
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes, 0x01)]);
}

describe("inspectAudio", () => {
  it("recognises a bare MP3 frame", () => {
    const result = inspectAudio(mp3Fixture(16_000));
    expect(result.container).toBe("mp3");
    expect(result.mimeType).toBe("audio/mpeg");
    // 16000 bytes at 128 kbps is about one second.
    expect(result.durationMs).toBeGreaterThan(900);
    expect(result.durationMs).toBeLessThan(1100);
    expect(result.durationSource).toBe("estimated");
  });

  it("skips an ID3v2 tag to find the frame", () => {
    expect(inspectAudio(id3Mp3Fixture(16_000)).container).toBe("mp3");
  });

  it("reads an exact WAV duration", () => {
    const result = inspectAudio(wavFixture(88_200));
    expect(result.container).toBe("wav");
    expect(result.durationMs).toBe(1000);
    expect(result.durationSource).toBe("exact");
  });

  it("reports a truncated WAV by its real length, not its declared one", () => {
    const full = wavFixture(88_200);
    const truncated = full.subarray(0, 44 + 44_100);
    expect(inspectAudio(truncated).durationMs).toBe(500);
  });

  it("recognises OGG, FLAC and MP4", () => {
    expect(inspectAudio(Buffer.from("OggS____")).container).toBe("ogg");
    expect(inspectAudio(Buffer.from("fLaC____")).container).toBe("flac");
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")]);
    expect(inspectAudio(mp4).container).toBe("mp4");
  });

  it("reports unknown for arbitrary bytes", () => {
    expect(inspectAudio(Buffer.from("not audio at all")).container).toBe("unknown");
  });
});

describe("minimumPlausibleBytes", () => {
  it("is zero for empty text and grows with length", () => {
    expect(minimumPlausibleBytes(0)).toBe(0);
    expect(minimumPlausibleBytes(2000)).toBeGreaterThan(minimumPlausibleBytes(200));
  });
});

describe("verifyAudioPayload", () => {
  it("accepts a plausible MP3", () => {
    const verdict = verifyAudioPayload(mp3Fixture(40_000), { text: "a".repeat(300) });
    expect(verdict.ok).toBe(true);
  });

  it("rejects an empty body", () => {
    const verdict = verifyAudioPayload(Buffer.alloc(0));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/empty/i);
  });

  it("rejects a JSON error served as audio", () => {
    const verdict = verifyAudioPayload(Buffer.from('{"errors":[{"message":"boom"}]}'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/JSON/);
  });

  it("rejects a body shorter than its declared length", () => {
    const verdict = verifyAudioPayload(mp3Fixture(10_000), { declaredBytes: 40_000 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/ended early/);
  });

  it("rejects an unrecognised container by default", () => {
    const verdict = verifyAudioPayload(Buffer.from("plain text response"));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/not a recognised container/);
  });

  it("accepts an unrecognised container when allowed", () => {
    const verdict = verifyAudioPayload(Buffer.alloc(50_000, 0x7f), { allowUnknownContainer: true });
    expect(verdict.ok).toBe(true);
  });

  it("rejects audio that is implausibly short for its text", () => {
    // 2000 characters would need far more than 2 KB of audio.
    const verdict = verifyAudioPayload(mp3Fixture(2_000), { text: "b".repeat(2000) });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/implausibly short/);
  });

  it("does not flag a short clip when no text is supplied", () => {
    expect(verifyAudioPayload(mp3Fixture(2_000)).ok).toBe(true);
  });
});
