import { z } from "zod";

/**
 * How an export is encoded.
 *
 * Every export produces one file per chapter (what Spotify for Authors, ACX and
 * most distributors ask for), plus an optional single file for the whole book.
 */

export const EXPORT_CONTAINERS = ["mp3", "wav", "flac"] as const;
export type ExportContainer = (typeof EXPORT_CONTAINERS)[number];

export const MP3_BITRATES = [128, 192, 256, 320] as const;

export const exportOutputSchema = z.object({
  container: z.enum(EXPORT_CONTAINERS),
  /** MP3 bitrate in kbps; "original" keeps the provider's MP3 frames untouched. */
  mp3Bitrate: z.union([z.literal(128), z.literal(192), z.literal(256), z.literal(320), z.literal("original")]),
  /** Sample depth for WAV and FLAC. */
  bitDepth: z.union([z.literal(16), z.literal(24)]),
  sampleRate: z.union([z.literal(44100), z.literal(48000)]),
  channels: z.enum(["mono", "stereo"]),
  /** Normalise loudness to the audiobook standard and add room tone at each end. */
  master: z.boolean(),
  /** Also produce one file for the whole book. */
  fullBook: z.boolean(),
  /** Narrate opening and closing credits files, as ACX requires. */
  credits: z.boolean(),
  /** Narrate each chapter's title at the start of its file, as ACX requires. */
  chapterHeaders: z.boolean(),
  /** Also produce the first five minutes as a retail sample file. */
  retailSample: z.boolean(),
});

export type ExportOutput = z.infer<typeof exportOutputSchema>;

export const EXPORT_PRESET_IDS = ["spotify", "mp3", "wav", "flac", "original"] as const;
export type ExportPresetId = (typeof EXPORT_PRESET_IDS)[number];

export type ExportPreset = { id: ExportPresetId; label: string; detail: string; output: ExportOutput };

const base: ExportOutput = {
  container: "mp3", mp3Bitrate: 192, bitDepth: 16, sampleRate: 44100, channels: "stereo", master: true, fullBook: true,
  credits: true, chapterHeaders: true, retailSample: true,
};

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: "spotify",
    label: "Spotify & ACX",
    detail: "MP3, 192 kbps constant bitrate, 44.1 kHz, levelled to the audiobook standard. One file per chapter.",
    output: base,
  },
  { id: "wav", label: "WAV", detail: "Uncompressed PCM. Accepted by Spotify for Authors; the largest files.", output: { ...base, container: "wav", fullBook: false } },
  { id: "flac", label: "FLAC", detail: "Lossless like WAV at about half the size. Accepted by Spotify for Authors.", output: { ...base, container: "flac", fullBook: false } },
  { id: "mp3", label: "MP3 (custom)", detail: "Choose the bitrate, channels and whether to level the audio.", output: { ...base, mp3Bitrate: 256 } },
  {
    id: "original",
    label: "Original",
    detail: "The provider's own MP3 frames joined without re-encoding. Fastest, but not levelled.",
    output: { ...base, mp3Bitrate: "original", master: false, channels: "mono", credits: false, chapterHeaders: false, retailSample: false },
  },
];

export const presetById = (id: ExportPresetId): ExportPreset => EXPORT_PRESETS.find(preset => preset.id === id) ?? EXPORT_PRESETS[0]!;

/** True when the chapters can be joined from the stored frames with no re-encode at all. */
export const isPassthrough = (output: ExportOutput): boolean => output.container === "mp3" && output.mp3Bitrate === "original" && !output.master;

export const fileExtension = (output: ExportOutput): string => output.container;

export const mimeTypeFor = (container: ExportContainer): string =>
  container === "mp3" ? "audio/mpeg" : container === "wav" ? "audio/wav" : "audio/flac";

/** "MP3 192 kbps · 44.1 kHz stereo · levelled" */
export function describeOutput(output: ExportOutput): string {
  if (isPassthrough(output)) return "Original MP3, no re-encoding";
  const rate = `${output.sampleRate === 44100 ? "44.1" : "48"} kHz ${output.channels}`;
  const codec = output.container === "mp3"
    ? `MP3 ${output.mp3Bitrate === "original" ? "source bitrate" : `${output.mp3Bitrate} kbps`}`
    : `${output.container.toUpperCase()} ${output.bitDepth}-bit`;
  return `${codec} · ${rate}${output.master ? " · levelled" : ""}`;
}

/**
 * The audiobook loudness standard (ACX, and what Spotify for Authors accepts).
 * RMS is measured over the whole chapter, pauses included.
 */
export const AUDIOBOOK_STANDARD = {
  targetRmsDb: -20,
  minRmsDb: -23,
  maxRmsDb: -18,
  maxPeakDb: -3,
  /** ACX's noise-floor ceiling, in dB RMS. */
  maxNoiseFloorDb: -60,
  /** Silence before the first word and after the last. */
  headMs: 750,
  tailMs: 2500,
  /** ACX's per-file ceiling; longer chapters should be split. */
  maxFileMinutes: 120,
} as const;

/** A chapter's measured result against the standard. */
export function meetsAudiobookStandard(rmsDb: number | null | undefined, peakDb: number | null | undefined): boolean {
  if (rmsDb == null || peakDb == null) return false;
  return rmsDb >= AUDIOBOOK_STANDARD.minRmsDb && rmsDb <= AUDIOBOOK_STANDARD.maxRmsDb && peakDb <= AUDIOBOOK_STANDARD.maxPeakDb;
}

/** True when a measured noise floor sits under ACX's ceiling. */
export function noiseFloorPasses(floorDb: number | null | undefined): boolean {
  if (floorDb == null) return false;
  return floorDb <= AUDIOBOOK_STANDARD.maxNoiseFloorDb;
}

/** A download name that is safe on every filesystem: "03 - The Storm at Harrow Pass.mp3". */
export function chapterFileName(position: number, total: number, title: string, extension: string): string {
  const width = Math.max(2, String(total).length);
  const clean = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90)
    .replace(/[. ]+$/, "");
  return `${String(position).padStart(width, "0")} - ${clean || `Chapter ${position}`}.${extension}`;
}

export function bookFileName(title: string, extension: string): string {
  const clean = title.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90).replace(/[. ]+$/, "");
  return `${clean || "Audiobook"} (full book).${extension}`;
}
