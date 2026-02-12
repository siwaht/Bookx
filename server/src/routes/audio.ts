import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne } from '../db/helpers.js';

export function audioRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/:assetId', (req: Request, res: Response) => {
    const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [req.params.assetId]);
    if (!asset || !fs.existsSync(asset.file_path)) { res.status(404).json({ error: 'Audio asset not found' }); return; }

    const ext = path.extname(asset.file_path).toLowerCase();
    const mimeTypes: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
    res.setHeader('Content-Type', mimeTypes[ext] || 'audio/mpeg');
    res.setHeader('Content-Length', fs.statSync(asset.file_path).size);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(asset.file_path).pipe(res);
  });

  router.get('/book/:bookId', (req: Request, res: Response) => {
    const assets = queryAll(db, 'SELECT * FROM audio_assets WHERE book_id = ? ORDER BY created_at DESC', [req.params.bookId]);
    res.json(assets);
  });

  return router;
}
