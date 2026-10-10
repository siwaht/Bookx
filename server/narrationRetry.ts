/**
 * Retry policy for provider calls during a long render.
 *
 * The distinction that matters: a *transient* failure (rate limit, gateway
 * timeout, dropped socket, stalled stream) should be retried against the same
 * voice, while a *permanent* one (bad key, unknown voice, malformed request) should
 * stop the run immediately. Retrying a permanent failure burns the whole retry
 * budget on every remaining segment and turns a clear error into a slow one.
 */

export type FailureKind =
  | "rate-limit"
  | "server"
  | "network"
  | "timeout"
  | "stalled"
  | "integrity"
  | "auth"
  /** The account is out of credit or quota: every remaining segment would fail the same way. */
  | "quota"
  /** The provider is not set up (no key, removed, no endpoint): nothing will render until it is. */
  | "config"
  /**
   * The provider refused the *voice*, not the key: a licensed "famous" voice
   * that only the provider's own reader app may synthesise. Only the characters
   * cast with it are affected, so the run carries on and fails just those
   * segments rather than the whole book.
   */
  | "voice"
  | "bad-request"
  | "unknown";

/** Failures that will repeat for every segment, so a run stops at the first one. */
export const FATAL_FAILURE_KINDS: ReadonlySet<FailureKind> = new Set(["auth", "quota", "config"]);

/** Thrown when a provider is not configured; stops a run instead of failing each segment. */
export class ProviderConfigurationError extends Error {
  override name = "ProviderConfigurationError";
}

const QUOTA_BODY = /insufficient_quota|quota_exceeded|exceeded your current quota|quota (has been )?exceeded|out of credits|insufficient (credits|balance|funds)/i;

export type FailureClassification = {
  kind: FailureKind;
  retryable: boolean;
  message: string;
  /** Server-requested wait, parsed from `Retry-After`, in milliseconds. */
  retryAfterMs?: number;
};

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 507, 509, 520, 521, 522, 523, 524, 598, 599]);
const AUTH_STATUSES = new Set([401, 403, 407]);

/** Node/undici network error codes that are worth another attempt. */
const RETRYABLE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Parses `Retry-After`, which may be either a delay in seconds or an HTTP date.
 * Returns undefined for anything unparseable so the caller falls back to backoff.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

export function classifyHttpFailure(status: number, retryAfter?: string | null, body?: string): FailureClassification {
  const detail = body ? `: ${body.slice(0, 200)}` : "";

  // Out of money or quota looks like a rate limit to some providers (OpenAI
  // sends 429 insufficient_quota) but waiting will not fix it.
  if (status === 402 || (status === 429 && body && QUOTA_BODY.test(body))) {
    return { kind: "quota", retryable: false, message: `The provider account is out of credit or quota (HTTP ${status})${detail}` };
  }
  if (status === 429) {
    return {
      kind: "rate-limit",
      retryable: true,
      message: `Provider rate limited the request (HTTP 429)${detail}`,
      retryAfterMs: parseRetryAfter(retryAfter),
    };
  }
  // Read this before the auth branch: the credentials are fine, and calling it
  // an auth failure would send the user to their API key instead of their cast.
  if (VOICE_PERMISSION_BODY.test(body ?? "")) {
    const sentence = providerSentence(body);
    const licensed = LICENSED_VOICE_BODY.test(body ?? "");
    return {
      kind: "voice",
      retryable: false,
      message: `${licensed ? "The provider will not render this voice through its API." : "The provider does not have this voice."}${sentence ? ` ${sentence}` : ""} Pick another voice for this character in Cast voices, then retry.`,
    };
  }
  if (AUTH_STATUSES.has(status)) {
    return { kind: "auth", retryable: false, message: `Provider rejected the credentials (HTTP ${status})${detail}` };
  }
  if (RETRYABLE_STATUSES.has(status)) {
    return {
      kind: "server",
      retryable: true,
      message: `Provider is unavailable (HTTP ${status})${detail}`,
      retryAfterMs: parseRetryAfter(retryAfter),
    };
  }
  if (status >= 400 && status < 500) {
    return { kind: "bad-request", retryable: false, message: `Provider rejected the request (HTTP ${status})${detail}` };
  }
  if (status >= 500) {
    return { kind: "server", retryable: true, message: `Provider error (HTTP ${status})${detail}` };
  }
  return { kind: "unknown", retryable: false, message: `Unexpected provider response (HTTP ${status})${detail}` };
}

export function classifyThrownFailure(error: unknown): FailureClassification {
  if (error instanceof ProviderConfigurationError) {
    return { kind: "config", retryable: false, message: error.message };
  }
  if (error instanceof StalledStreamError) {
    return { kind: "stalled", retryable: true, message: error.message };
  }
  if (error instanceof AudioIntegrityError) {
    // The provider claimed success but the bytes were unusable. Another attempt
    // usually succeeds, and storing this would be exactly the broken audio we are
    // trying to avoid.
    return { kind: "integrity", retryable: true, message: error.message };
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(message)) {
    return { kind: "timeout", retryable: true, message: `Provider request timed out: ${message}` };
  }

  const code = (error as { code?: string; cause?: { code?: string } })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) {
    return { kind: "network", retryable: true, message: `Network error (${code}) while contacting the provider` };
  }
  if (/fetch failed|socket hang up|network|ECONN|EPIPE/i.test(message)) {
    return { kind: "network", retryable: true, message: `Network error while contacting the provider: ${message}` };
  }

  return { kind: "unknown", retryable: false, message };
}

/** Raised when a response body stops producing bytes for longer than allowed. */
export class StalledStreamError extends Error {
  constructor(stallMs: number, receivedBytes: number) {
    super(`Provider stopped sending audio for ${Math.round(stallMs / 1000)}s after ${receivedBytes} bytes`);
    this.name = "StalledStreamError";
  }
}

/** Raised when a payload arrives intact-looking but fails verification. */
export class AudioIntegrityError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AudioIntegrityError";
  }
}

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  /** Injected for deterministic tests; defaults to Math.random. */
  random?: () => number;
};

/**
 * Exponential backoff with full jitter, floored by any server-requested wait.
 *
 * Full jitter (rather than a fixed multiplier) matters when a book fans out many
 * segments after an outage: without it every pending segment retries in lockstep
 * and immediately re-triggers the rate limit.
 */
export function backoffDelayMs(attempt: number, retryAfterMs?: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 60_000;
  const random = options.random ?? Math.random;

  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(random() * exponential);
  // Never wait less than a quarter of the window, or a burst of fast retries can
  // still hammer a recovering provider.
  const floor = Math.round(exponential / 4);
  const delay = Math.max(floor, jittered);

  if (retryAfterMs !== undefined) return Math.min(max, Math.max(delay, retryAfterMs));
  return delay;
}

/** Total attempts per segment, including the first. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * No single request may exceed this. Generous, because a long segment on a cold
 * model legitimately takes a while, but bounded so a hung socket cannot pin the
 * run forever.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Maximum gap between bytes before the stream is considered stalled.
 *
 * This is the check a total timeout cannot make: a provider that accepts the
 * request, sends a few bytes and then hangs would otherwise occupy the full
 * request timeout on every attempt.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;

/**
 * A 401/403 whose body names the voice rather than the key. ElevenLabs answers
 * a licensed voice with `voice_access_denied` / `famous_voice_not_permitted`
 * and "Famous voices can only be used within the Reader App".
 */
const LICENSED_VOICE_BODY = /voice_access_denied|voice_not_permitted|famous_voice_not_permitted|can only be used within the reader app/i;

/**
 * A voice the provider has never heard of — most often an id carried over from
 * another provider, which is what changing the provider leaves behind.
 */
const UNKNOWN_VOICE_BODY = /voice[_ -]?(id[_ -]?)?not[_ -]?found|invalid voice|unknown voice|voice does not exist|not a valid voice|unsupported voice/i;

/** Either way the run cannot voice this character, and the fix is the same. */
const VOICE_PERMISSION_BODY = new RegExp(`${LICENSED_VOICE_BODY.source}|${UNKNOWN_VOICE_BODY.source}`, "i");

/**
 * The provider's own explanation from a JSON error body, when it has one.
 *
 * Providers wrap it differently — ElevenLabs nests it under `detail.message`,
 * OpenAI under `error.message` — and the sentence is what belongs in front of
 * the reader; the envelope it arrived in is not.
 */
export function providerSentence(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = (parsed.detail ?? parsed.error ?? parsed) as Record<string, unknown>;
    const candidate = nested?.message ?? nested?.detail ?? parsed.message;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
