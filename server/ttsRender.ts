import { nanoid } from "nanoid";
import { isCustomProviderId } from "../shared/providers";
import { wavHeader } from "./audioAssembly";
import { customProviderHeaders, requireCustomProvider } from "./customProviders";
import { AURA_2_SPEAKERS, buildCloudflareTtsBody, cloudflareHeaders, getCloudflareEndpoint, requireProviderApiKey } from "./providerCredentials";
import type { ProviderId } from "./providerRouting";
import { storagePut } from "./storage";
import { verifyAudioPayload, type AudioInspection } from "./audioIntegrity";
import {
  AudioIntegrityError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  StalledStreamError,
  classifyHttpFailure,
} from "./narrationRetry";
import { ABSOLUTE_TEXT_LIMIT } from "../shared/narration";

/**
 * A single, provider-pinned render of one segment.
 *
 * This deliberately does **not** fall back to another provider. `synthesizeNarration`
 * does, which is right for a one-off preview but wrong for a book: switching
 * provider mid-run changes the narrator's voice partway through, which is a worse
 * outcome than a clear failure the user can retry. The worker retries the same
 * voice instead, and only the user may change it.
 */

export type PinnedRenderRequest = {
  projectId: string;
  segmentId: string;
  provider: ProviderId;
  model: string;
  voiceId?: string | null;
  text: string;
  /** Text immediately before and after this segment, for continuity across joins. */
  previousText?: string;
  nextText?: string;
  language?: string | null;
  ownerId?: number;
  requestTimeoutMs?: number;
  stallTimeoutMs?: number;
  /** Aborts the attempt when the run is paused or cancelled. */
  signal?: AbortSignal;
};

/**
 * Every ElevenLabs segment is requested in the same encoding, so chapters can be
 * joined frame by frame and mixed without a sample-rate or bitrate mismatch.
 */
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

/** Context sent alongside a segment; the provider only uses it to shape intonation. */
const CONTINUITY_CHARS = 400;

/** Eleven v3 does not accept request stitching, so context is only sent to the others. */
export function supportsElevenLabsContinuity(model: string): boolean {
  return !/^eleven_v3/.test(model);
}

/** Deepgram voices are models; a per-character voice id like "aura-2-zeus-en" is used as the model. */
export function deepgramModelFor(model: string, voiceId?: string | null): string {
  return voiceId && /^aura-(?:2-)?[a-z]+-[a-z]{2}$/.test(voiceId) ? voiceId : model;
}

export function buildElevenLabsBody(request: Pick<PinnedRenderRequest, "text" | "model" | "previousText" | "nextText">): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text: request.text,
    model_id: request.model,
    voice_settings: { stability: 0.45, similarity_boost: 0.75 },
  };
  if (supportsElevenLabsContinuity(request.model)) {
    if (request.previousText?.trim()) body.previous_text = request.previousText.trim().slice(-CONTINUITY_CHARS);
    if (request.nextText?.trim()) body.next_text = request.nextText.trim().slice(0, CONTINUITY_CHARS);
  }
  return body;
}

export type PinnedRenderResult = {
  storageKey: string;
  audioUrl: string;
  inspection: AudioInspection;
};

const openAiVoiceForStarter: Record<string, string> = {
  "iris-narrative": "nova",
  "theo-dramatic": "onyx",
  "sage-conversational": "alloy",
  "noor-global": "shimmer",
  "rowan-deep": "echo",
};

const OPENAI_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer", "ash", "sage", "coral"]);

/** Maps a Bookx voice id onto a voice the OpenAI speech API accepts. */
function openAiVoice(voiceId?: string | null): string {
  const raw = (voiceId || "").trim();
  if (!raw) return "alloy";
  const mapped = openAiVoiceForStarter[raw];
  if (mapped) return mapped;
  const lower = raw.toLowerCase();
  if (OPENAI_VOICES.has(lower)) return lower;
  // An Aura-2 speaker or an arbitrary catalog id is meaningless here; a known
  // voice keeps the render consistent instead of failing the whole book.
  if ((AURA_2_SPEAKERS as readonly string[]).includes(lower)) return "alloy";
  return "alloy";
}

/**
 * Reads a response body with a stall watchdog.
 *
 * A total request timeout cannot catch the case the user described — a provider
 * that accepts the request, sends a little data, then hangs. Measuring the gap
 * *between* chunks catches it in `stallTimeoutMs` instead of tying up the full
 * request budget, so the retry starts sooner.
 */
async function readWithStallWatchdog(
  response: Response,
  stallTimeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.from(await response.arrayBuffer());

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Render aborted", "AbortError");

      let stallTimer: NodeJS.Timeout | undefined;
      const stall = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => reject(new StalledStreamError(stallTimeoutMs, received)), stallTimeoutMs);
      });

      // If the stall wins the race the read is still outstanding; swallowing its
      // eventual rejection keeps it from surfacing as an unhandled rejection after
      // we have already moved on to the retry.
      const read = reader.read();
      read.catch(() => {});

      try {
        const { done, value } = await Promise.race([read, stall]);
        if (done) break;
        if (value) {
          const chunk = Buffer.from(value);
          chunks.push(chunk);
          received += chunk.length;
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    }
  } catch (error) {
    // Release the socket rather than leaving it half-read for the next attempt.
    await reader.cancel().catch(() => {});
    throw error;
  }

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Fish Audio and Gradium
// ---------------------------------------------------------------------------

export const FISH_AUDIO_DEFAULT_MODEL = "s2.1-pro";
/** Fish Audio's documented example voice (Hannah), used when no voice is chosen. */
export const FISH_AUDIO_DEFAULT_VOICE = "9a9cf47702da476aa4629e2506d4a857";

/** Fish Audio voice (model) ids are 32 hex characters. */
export function fishAudioVoice(voiceId?: string | null): string {
  const raw = (voiceId || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(raw) ? raw : FISH_AUDIO_DEFAULT_VOICE;
}

/** One complete MP3 per segment, at the rate and bitrate every segment shares. */
export function buildFishAudioBody(text: string, voiceId?: string | null): Record<string, unknown> {
  return { text, reference_id: fishAudioVoice(voiceId), format: "mp3", mp3_bitrate: 128, sample_rate: 44_100, normalize: true, latency: "normal" };
}

export const GRADIUM_DEFAULT_MODEL = "default";
/** Gradium's documented example voice, used when no voice is chosen. */
export const GRADIUM_DEFAULT_VOICE = "YTpq7expH9539ERJ";
/** Gradium is asked for raw 16-bit mono PCM at this rate, which Bookx wraps as WAV. */
export const GRADIUM_SAMPLE_RATE = 44_100;

/** Bookx's own starter personas are not Gradium voices. */
const STARTER_VOICE_IDS = new Set(["iris-narrative", "theo-dramatic", "sage-conversational", "noor-global", "rowan-deep"]);

export function gradiumVoice(voiceId?: string | null): string {
  const raw = (voiceId || "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(raw) && !STARTER_VOICE_IDS.has(raw) ? raw : GRADIUM_DEFAULT_VOICE;
}

export function buildGradiumBody(text: string, model: string, voiceId?: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { text, voice_id: gradiumVoice(voiceId), output_format: `pcm_${GRADIUM_SAMPLE_RATE}`, only_audio: true };
  if (model && model !== GRADIUM_DEFAULT_MODEL) body.model_name = model;
  return body;
}

/**
 * Gradium's raw PCM as a WAV file. Asking for PCM and writing the header here
 * gives every segment an exact, identical format, whatever header a streamed
 * WAV would have carried.
 */
export function pcm16MonoToWav(raw: Buffer, sampleRate = GRADIUM_SAMPLE_RATE): Buffer {
  const head = raw.subarray(0, 4).toString("latin1");
  // Already a WAV, or an error body: leave it for verification to judge.
  if (head === "RIFF" || head.startsWith("{") || head.startsWith("[")) return raw;
  const pcm = raw.subarray(0, raw.length - (raw.length % 2));
  const format = { audioFormat: 1, channels: 1, sampleRate, bitsPerSample: 16, blockAlign: 2, byteRate: sampleRate * 2 };
  return Buffer.concat([wavHeader(format, pcm.length), pcm]);
}

/** Gradium reports authentication and quota failures as HTTP 500 with the real status in the text. */
export function gradiumErrorStatus(status: number, body: string): number {
  const embedded = body.match(/error from server (\d{3})/i)?.[1];
  return embedded ? Number(embedded) : status;
}

export type ProviderCall = {
  url: string;
  init: RequestInit;
  expectsJsonAudio: boolean;
  /** Turns the response body into a playable file, when the provider sends raw samples. */
  decode?: (raw: Buffer) => Buffer;
  /** The HTTP status to classify a failure by, when the provider hides it in the body. */
  errorStatus?: (status: number, body: string) => number;
};

export type ProviderCallRequest = Pick<PinnedRenderRequest, "provider" | "model" | "voiceId" | "text" | "previousText" | "nextText" | "language" | "ownerId">;

/** Audio bytes from a provider response, whatever shape the provider answered in. */
export function decodeProviderAudio(call: ProviderCall, raw: Buffer, contentType: string): Buffer {
  if (call.decode) return call.decode(raw);
  const looksJson = contentType.includes("application/json") || raw.subarray(0, 1).toString("latin1") === "{";
  return call.expectsJsonAudio && looksJson ? decodeJsonAudio(raw) ?? raw : raw;
}

export async function buildProviderCall(request: ProviderCallRequest, signal: AbortSignal): Promise<ProviderCall> {
  const { provider, model, voiceId, text } = request;

  if (isCustomProviderId(provider)) {
    const custom = await requireCustomProvider(provider, request.ownerId, "text-to-speech");
    // A voice cast for another provider means nothing here; the first voice
    // keeps the book rendering, as the OpenAI route does.
    const voice = voiceId && custom.voices.includes(voiceId) ? voiceId : custom.voices[0]!;
    return {
      url: `${custom.baseUrl}/audio/speech`,
      init: {
        method: "POST",
        headers: customProviderHeaders(custom),
        body: JSON.stringify({ model: model || custom.ttsModel, input: text, voice, response_format: "mp3" }),
        signal,
      },
      expectsJsonAudio: false,
    };
  }

  if (provider === "Fish Audio") {
    const key = await requireProviderApiKey("Fish Audio", request.ownerId);
    return {
      url: "https://api.fish.audio/v1/tts",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", model: model || FISH_AUDIO_DEFAULT_MODEL },
        body: JSON.stringify(buildFishAudioBody(text, voiceId)),
        signal,
      },
      expectsJsonAudio: false,
    };
  }

  if (provider === "Gradium") {
    const key = await requireProviderApiKey("Gradium", request.ownerId);
    return {
      url: "https://api.gradium.ai/api/post/speech/tts",
      init: {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(buildGradiumBody(text, model, voiceId)),
        signal,
      },
      expectsJsonAudio: false,
      decode: raw => pcm16MonoToWav(raw),
      errorStatus: gradiumErrorStatus,
    };
  }

  if (provider === "Cloudflare") {
    const endpoint = await getCloudflareEndpoint(request.ownerId);
    if (!endpoint) throw new Error("Cloudflare text-to-speech is not configured. Save an endpoint URL and API key in Settings.");

    if (endpoint.mode === "openai-compatible") {
      return {
        url: `${endpoint.apiBaseUrl}/audio/speech`,
        init: {
          method: "POST",
          headers: cloudflareHeaders(endpoint),
          body: JSON.stringify({ model, input: text, voice: openAiVoice(voiceId), response_format: "mp3" }),
          signal,
        },
        expectsJsonAudio: false,
      };
    }

    return {
      url: `${endpoint.apiBaseUrl}/run/${model}`,
      init: {
        method: "POST",
        headers: cloudflareHeaders(endpoint),
        body: JSON.stringify(buildCloudflareTtsBody(model, text, voiceId, request.language)),
        signal,
      },
      // Native Workers AI may return either raw audio or `{ result: { audio } }`
      // depending on the model, so both shapes are handled downstream.
      expectsJsonAudio: true,
    };
  }

  if (provider === "ElevenLabs") {
    const key = await requireProviderApiKey("ElevenLabs", request.ownerId);
    return {
      url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId || "21m00Tcm4TlvDq8ikWAM")}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
      init: {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify(buildElevenLabsBody({ text, model, previousText: request.previousText, nextText: request.nextText })),
        signal,
      },
      expectsJsonAudio: false,
    };
  }

  if (provider === "Deepgram") {
    const key = await requireProviderApiKey("Deepgram", request.ownerId);
    return {
      url: `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(deepgramModelFor(model, voiceId))}`,
      init: {
        method: "POST",
        headers: { Authorization: `Token ${key}`, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text }),
        signal,
      },
      expectsJsonAudio: false,
    };
  }

  if (provider === "OpenAI") {
    const key = await requireProviderApiKey("OpenAI", request.ownerId);
    return {
      url: "https://api.openai.com/v1/audio/speech",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, voice: openAiVoice(voiceId), input: text, response_format: "mp3" }),
        signal,
      },
      expectsJsonAudio: false,
    };
  }

  throw new Error(`${provider} cannot render narration`);
}

/** Extracts audio bytes from a native Workers AI JSON envelope. */
function decodeJsonAudio(raw: Buffer): Buffer | null {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { result?: { audio?: string } | string; audio?: string };
    const base64 = typeof parsed.result === "string" ? parsed.result : parsed.result?.audio ?? parsed.audio;
    if (typeof base64 !== "string" || !base64) return null;
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

/**
 * Renders one segment and stores it, or throws a classifiable failure.
 *
 * The payload is verified before it is written, so a truncated or empty body
 * becomes a retry instead of a silent gap in the finished audio.
 */
export async function renderSegmentAudio(request: PinnedRenderRequest): Promise<PinnedRenderResult> {
  const text = request.text.trim();
  if (!text) throw new Error("Segment text is empty");
  if (text.length > ABSOLUTE_TEXT_LIMIT) {
    throw new Error(`Segment is ${text.length} characters; the per-request limit is ${ABSOLUTE_TEXT_LIMIT}`);
  }

  const requestTimeoutMs = request.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const stallTimeoutMs = request.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  // Combine the caller's cancellation with this attempt's own deadline.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const call = await buildProviderCall({ ...request, text }, controller.signal);
    const response = await fetch(call.url, call.init);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const status = call.errorStatus ? call.errorStatus(response.status, body) : response.status;
      const classification = classifyHttpFailure(status, response.headers.get("retry-after"), body);
      const error = new Error(classification.message);
      // Carry the classification so the worker does not have to re-derive it.
      Object.assign(error, { classification });
      throw error;
    }

    const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
    const raw = await readWithStallWatchdog(response, stallTimeoutMs, request.signal);

    const buffer = decodeProviderAudio(call, raw, response.headers.get("content-type") || "");

    const verdict = verifyAudioPayload(buffer, {
      text,
      // Only meaningful when the body was not re-decoded from JSON.
      declaredBytes: buffer === raw && Number.isFinite(declared) ? declared : undefined,
    });
    if (!verdict.ok) throw new AudioIntegrityError(verdict.reason);

    const stored = await storagePut(
      `bookx/${request.projectId}/narration/${request.segmentId}-${nanoid(8)}.${verdict.inspection.container === "wav" ? "wav" : "mp3"}`,
      buffer,
      verdict.inspection.mimeType,
    );

    return { storageKey: stored.key, audioUrl: stored.url, inspection: verdict.inspection };
  } finally {
    clearTimeout(deadline);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
