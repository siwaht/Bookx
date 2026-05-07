/**
 * Estimate MP3 duration from buffer length and bitrate.
 * Default assumes 192kbps CBR (ElevenLabs mp3_44100_192 format).
 * Formula: duration_ms = (bytes / (bitrate_kbps * 1000 / 8)) * 1000
 */
export function estimateMp3DurationMs(bufferLength: number, bitrateKbps: number = 192): number {
  return Math.round((bufferLength / (bitrateKbps * 1000 / 8)) * 1000);
}
