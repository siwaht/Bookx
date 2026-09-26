import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AudioAssemblyError, scanMp3, scanWav, wavHeader, type WavFormat } from "./audioAssembly";
import { measureLoudness, runFfmpeg, withTempDir } from "./ffmpeg";
import type { SoundKind, SoundLevel } from "./soundLibrary";
import { cueEnvelope, cueGainDb, duckThreshold } from "./soundPlan";

/**
 * Mixes sound cues under an assembled chapter.
 *
 * This is the one place Bookx re-encodes audio, and only when the creator has
 * turned sound design on. The output is encoded in the narration's own format
 * (sample rate, channels, bitrate), so mixed chapters still join frame by frame
 * into the combined file, and cues are ducked under speech with a sidechain
 * compressor keyed on the voice itself.
 */

export type MixTarget =
  | { container: "mp3"; sampleRate: number; channels: 1 | 2; bitrateKbps: number; jointStereo: boolean }
  | { container: "wav"; format: WavFormat };

/** A bitrate for a VBR source, whose first frame says nothing useful. */
const VBR_FALLBACK_KBPS = { mpeg1: 128, mpeg2: 64 };

/** The encoding that reproduces `voice`'s format. */
export function mixTargetFor(voice: Buffer): MixTarget {
  const isWav = voice.length >= 12 && voice.subarray(0, 4).toString("latin1") === "RIFF";
  if (isWav) {
    const { format } = scanWav(voice);
    if (format.channels < 1 || format.channels > 2) throw new AudioAssemblyError(`Sound design supports mono or stereo narration, not ${format.channels} channels`);
    pcmCodec(format); // throws for sample formats the mixer cannot reproduce
    return { container: "wav", format };
  }
  const scan = scanMp3(voice);
  // CBR frames differ by at most the padding byte; anything more is VBR.
  const sizes = new Set(scan.frames.map(frame => frame.size));
  const cbr = Math.max(...sizes) - Math.min(...sizes) <= 1;
  const mpeg1 = scan.format.versionBits === 3;
  return {
    container: "mp3",
    sampleRate: scan.format.sampleRate,
    channels: scan.format.channelModeBits === 3 ? 1 : 2,
    bitrateKbps: cbr ? scan.format.bitrateKbps : mpeg1 ? VBR_FALLBACK_KBPS.mpeg1 : VBR_FALLBACK_KBPS.mpeg2,
    jointStereo: scan.format.channelModeBits === 1,
  };
}

/**
 * A lossless 24-bit WAV target at the voice's own rate and channels, for mixes
 * that will be encoded again for delivery, so the audio is only lossy-encoded
 * once.
 */
export function pcmMixTarget(voice: Buffer): MixTarget {
  const source = mixTargetFor(voice);
  const sampleRate = source.container === "wav" ? source.format.sampleRate : source.sampleRate;
  const channels = source.container === "wav" ? source.format.channels : source.channels;
  const blockAlign = channels * 3;
  return { container: "wav", format: { audioFormat: 1, channels, sampleRate, bitsPerSample: 24, blockAlign, byteRate: sampleRate * blockAlign } };
}

function pcmCodec(format: WavFormat): { codec: string; muxer: string } {
  if (format.audioFormat === 1 && format.bitsPerSample === 16) return { codec: "pcm_s16le", muxer: "s16le" };
  if (format.audioFormat === 1 && format.bitsPerSample === 24) return { codec: "pcm_s24le", muxer: "s24le" };
  if (format.audioFormat === 1 && format.bitsPerSample === 32) return { codec: "pcm_s32le", muxer: "s32le" };
  if (format.audioFormat === 1 && format.bitsPerSample === 8) return { codec: "pcm_u8", muxer: "u8" };
  if (format.audioFormat === 3 && format.bitsPerSample === 32) return { codec: "pcm_f32le", muxer: "f32le" };
  throw new AudioAssemblyError(`Sound design cannot mix ${format.bitsPerSample}-bit WAV (format ${format.audioFormat}) narration`);
}

const targetRate = (target: MixTarget) => (target.container === "wav" ? target.format.sampleRate : target.sampleRate);
const targetChannels = (target: MixTarget) => (target.container === "wav" ? target.format.channels : target.channels);

export function describeTarget(target: MixTarget): string {
  const rate = `${Number((targetRate(target) / 1000).toFixed(2))} kHz`;
  const channels = targetChannels(target) === 1 ? "mono" : "stereo";
  return target.container === "wav"
    ? `WAV ${target.format.bitsPerSample}-bit ${rate} ${channels}`
    : `MP3 ${target.bitrateKbps} kbps ${rate} ${channels}`;
}

/** Encoder arguments for the target. */
export function encodeArgs(target: MixTarget): string[] {
  const common = ["-ar", String(targetRate(target)), "-ac", String(targetChannels(target)), "-map_metadata", "-1"];
  if (target.container === "wav") {
    const { codec, muxer } = pcmCodec(target.format);
    // Raw PCM, wrapped afterwards in the narration's own header, so the
    // chapters' WAV formats match byte for byte.
    return ["-c:a", codec, ...common, "-f", muxer];
  }
  return [
    "-c:a", "libmp3lame",
    "-b:a", `${target.bitrateKbps}k`,
    ...common,
    ...(target.channels === 2 ? ["-joint_stereo", target.jointStereo ? "1" : "0"] : []),
    "-write_xing", "0",
    "-id3v2_version", "0",
    "-f", "mp3",
  ];
}

export type GraphCue = {
  /** ffmpeg input index of the cue's audio (0 is the voice). */
  input: number;
  startMs: number;
  lengthMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  gainDb: number;
};

const seconds = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/**
 * The filter graph: every cue is trimmed, faded, set to its level and delayed
 * to its start; the cues are summed into one bed, the bed is ducked by the
 * voice, and voice and bed are summed with a limiter as a last safety.
 */
export function buildMixGraph(input: {
  cues: GraphCue[];
  sampleRate: number;
  channels: 1 | 2;
  voiceDurationMs: number;
  tailMs: number;
  duckThreshold: number;
}): string {
  const format = `aformat=sample_fmts=fltp:sample_rates=${input.sampleRate}:channel_layouts=${input.channels === 1 ? "mono" : "stereo"}`;
  const voice = [`[0:a]${format}`, ...(input.tailMs > 0 ? [`apad=pad_dur=${seconds(input.tailMs)}`] : [])].join(",");
  if (!input.cues.length) return `${voice}[out]`;

  const total = seconds(input.voiceDurationMs + input.tailMs);
  const chains = [`${voice},asplit=2[voice][key]`];
  input.cues.forEach((cue, index) => {
    const fadeIn = Math.max(1, Math.round(cue.fadeInMs));
    const fadeOut = Math.max(1, Math.round(cue.fadeOutMs));
    chains.push([
      `[${cue.input}:a]${format}`,
      `atrim=duration=${seconds(cue.lengthMs)}`,
      "asetpts=PTS-STARTPTS",
      `afade=t=in:st=0:d=${seconds(fadeIn)}`,
      `afade=t=out:st=${seconds(cue.lengthMs - fadeOut)}:d=${seconds(fadeOut)}`,
      `volume=${cue.gainDb.toFixed(1)}dB`,
      `adelay=delays=${Math.max(0, Math.round(cue.startMs))}:all=1[c${index}]`,
    ].join(","));
  });
  const labels = input.cues.map((_, index) => `[c${index}]`).join("");
  const sum = input.cues.length > 1 ? `${labels}amix=inputs=${input.cues.length}:duration=longest:normalize=0` : `${labels}anull`;
  // Pad and trim the bed to the voice's length so the sidechain and the final
  // sum consume both streams in lockstep (nothing is buffered for minutes).
  chains.push(`${sum},apad=whole_dur=${total},atrim=duration=${total}[bed]`);
  chains.push(`[bed][key]sidechaincompress=threshold=${input.duckThreshold}:ratio=4:attack=20:release=350:makeup=1[ducked]`);
  chains.push("[voice][ducked]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.99:level=0[out]");
  return chains.join(";");
}

export type MixCue = {
  audio: Buffer;
  startMs: number;
  kind: SoundKind;
  tag: string;
  assetDurationMs: number;
  assetMeanDb: number | null;
  assetPeakDb: number | null;
  /** The creator's trim for this cue, in dB. */
  trimDb: number;
};

export type MixResult = {
  buffer: Buffer;
  container: "mp3" | "wav";
  mimeType: string;
  durationMs: number;
  narrationMeanDb: number | null;
  /** Gain applied to each cue, in input order. */
  gainsDb: number[];
};

/**
 * Mixes `cues` under `voice` and encodes the result as `target`.
 *
 * With no cues the voice is only re-encoded, which is how chapters without
 * cues end up in the same format as mixed ones.
 */
export async function mixUnderNarration(input: {
  voice: Buffer;
  voiceDurationMs: number;
  cues: MixCue[];
  level: SoundLevel;
  target: MixTarget;
  tailMs?: number;
}): Promise<MixResult> {
  return withTempDir(async dir => {
    const voiceIsWav = input.voice.subarray(0, 4).toString("latin1") === "RIFF";
    const voicePath = path.join(dir, voiceIsWav ? "voice.wav" : "voice.mp3");
    await writeFile(voicePath, input.voice);

    const narrationMeanDb = input.cues.length ? (await measureLoudness(voicePath)).meanDb : null;
    const args = ["-i", voicePath];
    const graphCues: GraphCue[] = [];
    const gainsDb: number[] = [];
    for (const [index, cue] of input.cues.entries()) {
      const cuePath = path.join(dir, `cue-${index}.${cue.audio.subarray(0, 4).toString("latin1") === "RIFF" ? "wav" : "mp3"}`);
      await writeFile(cuePath, cue.audio);
      args.push("-i", cuePath);
      const envelope = cueEnvelope(cue.tag, cue.kind, cue.assetDurationMs);
      const gainDb = cueGainDb({
        narrationMeanDb: narrationMeanDb ?? -20,
        kind: cue.kind,
        level: input.level,
        assetMeanDb: cue.assetMeanDb,
        assetPeakDb: cue.assetPeakDb,
        trimDb: cue.trimDb,
      });
      gainsDb.push(gainDb);
      graphCues.push({ input: index + 1, startMs: cue.startMs, ...envelope, gainDb });
    }

    const graph = buildMixGraph({
      cues: graphCues,
      sampleRate: targetRate(input.target),
      channels: targetChannels(input.target) as 1 | 2,
      voiceDurationMs: input.voiceDurationMs,
      tailMs: Math.max(0, Math.round(input.tailMs ?? 0)),
      duckThreshold: duckThreshold(narrationMeanDb ?? -20),
    });
    const outputPath = path.join(dir, input.target.container === "wav" ? "mix.pcm" : "mix.mp3");
    // Roughly 15 minutes of processing budget per hour of audio, never under 2.
    const timeoutMs = Math.max(120_000, Math.round(input.voiceDurationMs / 4));
    await runFfmpeg([...args, "-filter_complex", graph, "-map", "[out]", ...encodeArgs(input.target), outputPath], { timeoutMs });
    const encoded = await readFile(outputPath);

    if (input.target.container === "wav") {
      const format = input.target.format;
      const aligned = encoded.subarray(0, encoded.length - (encoded.length % Math.max(1, format.blockAlign)));
      return {
        buffer: Buffer.concat([wavHeader(format, aligned.length), aligned]),
        container: "wav",
        mimeType: "audio/wav",
        durationMs: format.byteRate > 0 ? Math.round((aligned.length / format.byteRate) * 1000) : 0,
        narrationMeanDb,
        gainsDb,
      };
    }

    const scan = scanMp3(encoded);
    const target = input.target;
    const channels = scan.format.channelModeBits === 3 ? 1 : 2;
    if (scan.format.sampleRate !== target.sampleRate || scan.format.bitrateKbps !== target.bitrateKbps || channels !== target.channels) {
      throw new AudioAssemblyError(
        `The mixed chapter came out as ${scan.format.bitrateKbps}kbps/${scan.format.sampleRate}Hz instead of ${target.bitrateKbps}kbps/${target.sampleRate}Hz`,
      );
    }
    return { buffer: encoded, container: "mp3", mimeType: "audio/mpeg", durationMs: scan.durationMs, narrationMeanDb, gainsDb };
  });
}
