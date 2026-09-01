import { describe, expect, it } from "vitest";
import {
  AudioIntegrityError,
  DEFAULT_MAX_ATTEMPTS,
  StalledStreamError,
  backoffDelayMs,
  classifyHttpFailure,
  classifyThrownFailure,
  parseRetryAfter,
} from "./narrationRetry";

describe("parseRetryAfter", () => {
  it("reads a delay in seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:45 GMT", now)).toBe(45_000);
  });

  it("never returns a negative wait for a past date", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("ignores unparseable values", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });
});

describe("classifyHttpFailure", () => {
  it("treats a rate limit as retryable and carries the wait", () => {
    const result = classifyHttpFailure(429, "12");
    expect(result).toMatchObject({ kind: "rate-limit", retryable: true, retryAfterMs: 12_000 });
  });

  it("treats auth failures as fatal", () => {
    for (const status of [401, 403, 407]) {
      expect(classifyHttpFailure(status)).toMatchObject({ kind: "auth", retryable: false });
    }
  });

  it("treats 5xx and gateway codes as retryable", () => {
    for (const status of [500, 502, 503, 504, 522, 524]) {
      expect(classifyHttpFailure(status).retryable).toBe(true);
    }
  });

  it("treats a bad request as fatal so the run fails fast", () => {
    expect(classifyHttpFailure(400, null, "voice not found")).toMatchObject({ kind: "bad-request", retryable: false });
    expect(classifyHttpFailure(404).retryable).toBe(false);
    expect(classifyHttpFailure(413).retryable).toBe(false);
  });

  it("includes a truncated body for context", () => {
    const result = classifyHttpFailure(400, null, "x".repeat(400));
    expect(result.message.length).toBeLessThan(300);
  });
});

describe("classifyThrownFailure", () => {
  it("treats a stalled stream as retryable", () => {
    const result = classifyThrownFailure(new StalledStreamError(30_000, 1024));
    expect(result).toMatchObject({ kind: "stalled", retryable: true });
    expect(result.message).toMatch(/30s after 1024 bytes/);
  });

  it("treats a failed integrity check as retryable", () => {
    const result = classifyThrownFailure(new AudioIntegrityError("Audio stream ended early"));
    expect(result).toMatchObject({ kind: "integrity", retryable: true });
  });

  it("treats an abort or timeout as retryable", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifyThrownFailure(abort)).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("treats a socket error code as retryable", () => {
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(classifyThrownFailure(error)).toMatchObject({ kind: "network", retryable: true });
  });

  it("treats an undici cause code as retryable", () => {
    const error = Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    expect(classifyThrownFailure(error).retryable).toBe(true);
  });

  it("treats an unknown error as fatal", () => {
    expect(classifyThrownFailure(new Error("something structural")).retryable).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially with the attempt number", () => {
    const random = () => 1;
    expect(backoffDelayMs(1, undefined, { random, baseMs: 1000 })).toBe(1000);
    expect(backoffDelayMs(2, undefined, { random, baseMs: 1000 })).toBe(2000);
    expect(backoffDelayMs(3, undefined, { random, baseMs: 1000 })).toBe(4000);
  });

  it("is capped", () => {
    expect(backoffDelayMs(20, undefined, { random: () => 1, baseMs: 1000, maxMs: 30_000 })).toBe(30_000);
  });

  it("keeps a floor so jitter cannot produce a hot loop", () => {
    expect(backoffDelayMs(3, undefined, { random: () => 0, baseMs: 1000 })).toBe(1000);
  });

  it("honours a longer server-requested wait", () => {
    expect(backoffDelayMs(1, 20_000, { random: () => 0.5, baseMs: 1000 })).toBe(20_000);
  });

  it("does not shorten below the computed delay when Retry-After is small", () => {
    expect(backoffDelayMs(4, 100, { random: () => 1, baseMs: 1000 })).toBe(8000);
  });

  it("respects the cap even when Retry-After exceeds it", () => {
    expect(backoffDelayMs(1, 600_000, { random: () => 1, baseMs: 1000, maxMs: 60_000 })).toBe(60_000);
  });

  it("produces spread-out delays across calls so retries do not sync up", () => {
    const values = new Set(Array.from({ length: 40 }, () => backoffDelayMs(5, undefined, { baseMs: 1000 })));
    expect(values.size).toBeGreaterThan(5);
  });
});

describe("attempt budget", () => {
  it("allows more than one retry by default", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBeGreaterThan(2);
  });
});
