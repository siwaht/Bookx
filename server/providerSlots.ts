/**
 * Caps how many text-to-speech requests run at once against one provider
 * account, across every narration run, retake and clip in this process.
 *
 * Several books can narrate together, and each run renders a few lines in
 * parallel. Without a shared cap, three books on one ElevenLabs account would
 * send nine requests at once, the account's concurrency limit would answer
 * most of them with HTTP 429, and every run would stall in backoff. Waiting
 * here instead is cheap: the request has not started, so no provider time or
 * request timeout is spent while it queues.
 *
 * Waiters are served first come, first served, so books sharing an account take
 * turns instead of one starving the others.
 */

/**
 * Concurrent requests per provider account. ElevenLabs' smallest paid plans
 * allow 3 to 5, so 3 is safe for most accounts; the others are generous APIs.
 * Override with `TTS_CONCURRENCY`, e.g. `ElevenLabs=5,OpenAI=8,default=2`.
 */
const DEFAULT_LIMITS: Record<string, number> = {
  ElevenLabs: 3,
  OpenAI: 4,
  Deepgram: 4,
  Cloudflare: 2,
  "Fish Audio": 2,
  Gradium: 2,
  default: 2,
};

const MAX_LIMIT = 32;

export function parseConcurrencyOverrides(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of (raw ?? "").split(",")) {
    const [name, value] = pair.split("=").map(part => part?.trim());
    const limit = Number(value);
    if (name && Number.isInteger(limit) && limit >= 1) out[name] = Math.min(MAX_LIMIT, limit);
  }
  return out;
}

let overrides: Record<string, number> | undefined;

/** How many requests may run at once for `provider`. */
export function providerConcurrency(provider: string): number {
  overrides ??= parseConcurrencyOverrides(process.env.TTS_CONCURRENCY);
  return overrides[provider] ?? DEFAULT_LIMITS[provider] ?? overrides.default ?? DEFAULT_LIMITS.default!;
}

type Waiter = { resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void };
type Pool = { active: number; waiting: Waiter[] };

const pools = new Map<string, Pool>();

const poolKey = (provider: string, ownerId?: number) => `${ownerId ?? "system"}:${provider}`;

function grant(key: string, pool: Pool): () => void {
  pool.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pool.active--;
    const next = pool.waiting.shift();
    if (next) {
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      next.resolve(grant(key, pool));
    } else if (pool.active === 0) {
      pools.delete(key);
    }
  };
}

/**
 * Waits for a free slot for `provider` on `ownerId`'s account and returns the
 * function that gives it back. Rejects with an AbortError when `signal` aborts
 * while waiting, so a pause or cancel never leaves a run queued here.
 */
export function acquireProviderSlot(provider: string, ownerId: number | undefined, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Render aborted", "AbortError"));
  const key = poolKey(provider, ownerId);
  let pool = pools.get(key);
  if (!pool) {
    pool = { active: 0, waiting: [] };
    pools.set(key, pool);
  }
  if (pool.active < providerConcurrency(provider) && !pool.waiting.length) return Promise.resolve(grant(key, pool));

  const owned = pool;
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = owned.waiting.indexOf(waiter);
        if (index >= 0) owned.waiting.splice(index, 1);
        reject(new DOMException("Render aborted", "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    owned.waiting.push(waiter);
  });
}

/** Requests running and waiting per provider account, for the status screen and tests. */
export function providerSlotUsage(provider: string, ownerId?: number): { active: number; waiting: number; limit: number } {
  const pool = pools.get(poolKey(provider, ownerId));
  return { active: pool?.active ?? 0, waiting: pool?.waiting.length ?? 0, limit: providerConcurrency(provider) };
}
