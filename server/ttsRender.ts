import { nanoid } from "nanoid";
import { AURA_2_SPEAKERS, buildCloudflareTtsBody, cloudflareHeaders, getCloudflareEndpoint } from "./providerCredentials";
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
  language?: string | null;
  ownerId?: number;
  requestTimeoutMs?: number;
  stallTimeoutMs?: number;
  /** Aborts the attempt when the run is paused or cancelled. */
  signal?: AbortSignal;
};

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

type ProviderCall = { url: string; init: RequestInit; expectsJsonAudio: boolean };

async function buildProviderCall(request: PinnedRenderRequest, signal: AbortSignal): Promise<ProviderCall> {
  const { provider, model, voiceId, text } = request;

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
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ELEVENLABS_API_KEY is not configured");
    return {
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId || "21m00Tcm4TlvDq8ikWAM"}`,
      init: {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.75 } }),
        signal,
      },
      expectsJsonAudio: false,
    };
  }

  if (provider === "Deepgram") {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error("DEEPGRAM_API_KEY is not configured");
    return {
      url: `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`,
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
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not configured");
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
      const classification = classifyHttpFailure(response.status, response.headers.get("retry-after"), body);
      const error = new Error(classification.message);
      // Carry the classification so the worker does not have to re-derive it.
      Object.assign(error, { classification });
      throw error;
    }

    const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
    const raw = await readWithStallWatchdog(response, stallTimeoutMs, request.signal);

    const contentType = response.headers.get("content-type") || "";
    const looksJson = contentType.includes("application/json") || raw.subarray(0, 1).toString("latin1") === "{";
    const buffer = call.expectsJsonAudio && looksJson ? decodeJsonAudio(raw) ?? raw : raw;

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
