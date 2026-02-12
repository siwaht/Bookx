import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
const SALT = 'audiobook-maker-salt';

// Simple token-based auth: password → SHA-256 token
export function generateToken(password: string): string {
  return crypto.createHash('sha256').update(password + SALT).digest('hex');
}

const validToken = generateToken(APP_PASSWORD);

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = header.slice(7);
  if (token !== validToken) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  next();
}

export function loginHandler(req: Request, res: Response): void {
  const { password } = req.body;

  if (password !== APP_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  res.json({ token: generateToken(password) });
}
