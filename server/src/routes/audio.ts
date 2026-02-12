import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export function audioRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/:assetId', (req: Request, res: Response) => {
    const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [req.params.assetId]);
    if (!asset || !fs.existsSync(asset.file_path)) { res.status(404).json({ error: 'Audio asset not found' }); return; }

    const ext = path.extname(asset.file_path).toLowerCase();
    const mimeTypes: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
    res.setHeader('Content-Type', mimeTypes[ext] || 'audio/mpeg');
    res.setHeader('Content-Length', fs.statSync(asset.file_path).size);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(asset.file_path).pipe(res);
  });

  router.get('/book/:bookId', (req: Request, res: Response) => {
    const assets = queryAll(db, 'SELECT * FROM audio_assets WHERE book_id = ? ORDER BY created_at DESC', [req.params.bookId]);
    res.json(assets);
  });

  // Upload audio file
  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        res.status(400).json({ error: 'Must be multipart/form-data' });
        return;
      }

      // Manual multipart parsing for the audio file
      const chunks: Buffer[] = [];
      for await (const chunk of req) { chunks.push(chunk); }
      const body = Buffer.concat(chunks);

      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) { res.status(400).json({ error: 'No boundary found' }); return; }
      const boundary = boundaryMatch[1];

      const parts = parseMultipart(body, boundary);
      const filePart = parts.find(p => p.filename);
      const bookIdPart = parts.find(p => p.name === 'book_id');
      const namePart = parts.find(p => p.name === 'name');

      if (!filePart || !bookIdPart) {
        res.status(400).json({ error: 'file and book_id required' });
        return;
      }

      const bookId = bookIdPart.data.toString('utf-8').trim();
      const originalName = namePart ? namePart.data.toString('utf-8').trim() : (filePart.filename || 'uploaded');
      const ext = path.extname(filePart.filename || '.mp3').toLowerCase();
      const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
      if (!allowed.includes(ext)) {
        res.status(400).json({ error: `Unsupported format: ${ext}. Allowed: ${allowed.join(', ')}` });
        return;
      }

      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}${ext}`);
      fs.writeFileSync(filePath, filePart.data);

      // Estimate duration from file size (rough: 192kbps mp3 = 24000 bytes/sec)
      const fileSizeBytes = filePart.data.length;
      const estimatedDurationMs = ext === '.mp3' ? Math.round((fileSizeBytes / 24000) * 1000) : null;

      run(db,
        `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, file_size_bytes) VALUES (?, ?, 'imported', ?, ?, ?)`,
        [assetId, bookId, filePath, estimatedDurationMs, fileSizeBytes]);

      res.status(201).json({
        audio_asset_id: assetId,
        file_path: filePath,
        name: originalName,
        duration_ms: estimatedDurationMs,
        file_size_bytes: fileSizeBytes,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// Simple multipart parser
function parseMultipart(body: Buffer, boundary: string): Array<{ name?: string; filename?: string; data: Buffer }> {
  const parts: Array<{ name?: string; filename?: string; data: Buffer }> = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  let start = body.indexOf(boundaryBuf) + boundaryBuf.length;
  while (start < body.length) {
    const nextBoundary = body.indexOf(boundaryBuf, start);
    if (nextBoundary === -1) break;

    const partData = body.subarray(start, nextBoundary);
    const headerEnd = partData.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = nextBoundary + boundaryBuf.length; continue; }

    const headerStr = partData.subarray(0, headerEnd).toString('utf-8');
    const dataStart = headerEnd + 4;
    // Remove trailing \r\n
    let dataEnd = partData.length;
    if (partData[dataEnd - 2] === 0x0d && partData[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const data = partData.subarray(dataStart, dataEnd);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch?.[1],
      filename: filenameMatch?.[1],
      data,
    });

    start = nextBoundary + boundaryBuf.length;
    if (body.subarray(nextBoundary, nextBoundary + endBuf.length).equals(endBuf)) break;
  }

  return parts;
}
