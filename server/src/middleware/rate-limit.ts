import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitEntry>();

// Clean up expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now > entry.resetAt) buckets.delete(key);
  }
}, 60_000);

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

/**
 * Generic rate limiter middleware.
 * @param maxRequests - Max requests per window
 * @param windowMs - Window duration in milliseconds
 * @param keyPrefix - Prefix for the bucket key (allows different limits per route group)
 */
export function rateLimit(maxRequests: number, windowMs: number, keyPrefix = 'global') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    const remaining = Math.max(0, maxRequests - entry.count);
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'Too many requests',
        retry_after_seconds: retryAfter,
      });
      return;
    }

    next();
  };
}

/**
 * Stricter rate limit for TTS generation endpoints (expensive API calls).
 * 60 requests per minute per IP.
 */
export const ttsRateLimit = rateLimit(60, 60_000, 'tts');

/**
 * General API rate limit: 200 requests per minute per IP.
 */
export const apiRateLimit = rateLimit(200, 60_000, 'api');
