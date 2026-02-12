import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';

// Simple token-based auth: password → SHA-256 token
export function generateToken(password: string): string {
  return crypto.createHash('sha256').update(password + 'audiobook-maker-salt').digest('hex');
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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
