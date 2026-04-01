import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const SALT = 'audiobook-maker-salt';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getAppPassword(): string {
  return process.env.APP_PASSWORD || 'changeme';
}

/**
 * Generate a time-bound token. Embeds an expiry timestamp so tokens
 * automatically become invalid after TOKEN_TTL_MS.
 */
export function generateToken(password: string): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${password}:${expiresAt}`;
  const hash = crypto.createHash('sha256').update(payload + SALT).digest('hex');
  // Token format: hash.expiresAt (client stores the whole string)
  return `${hash}.${expiresAt}`;
}

function verifyToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) {
    // Legacy token (no expiry) — still accept but validate against password
    const legacyHash = crypto.createHash('sha256').update(getAppPassword() + SALT).digest('hex');
    return token === legacyHash;
  }

  const [hash, expiresAtStr] = parts;
  const expiresAt = parseInt(expiresAtStr, 10);

  // Check expiry
  if (isNaN(expiresAt) || Date.now() > expiresAt) return false;

  // Verify hash
  const payload = `${getAppPassword()}:${expiresAtStr}`;
  const expected = crypto.createHash('sha256').update(payload + SALT).digest('hex');

  // Timing-safe comparison
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

// Rate limiting for login attempts
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.lastAttempt > WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip: string): void {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.lastAttempt > WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, lastAttempt: Date.now() });
  } else {
    entry.count++;
    entry.lastAttempt = Date.now();
  }
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.lastAttempt > WINDOW_MS) loginAttempts.delete(ip);
  }
}, 60_000);

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);

  if (!token || !verifyToken(token)) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  next();
}

export function loginHandler(req: Request, res: Response): void {
  const ip = getClientIp(req);

  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    return;
  }

  const { password } = req.body;

  if (!password || typeof password !== 'string') {
    recordAttempt(ip);
    res.status(400).json({ error: 'Password required' });
    return;
  }

  if (password !== getAppPassword()) {
    recordAttempt(ip);
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  res.json({ token: generateToken(password) });
}
