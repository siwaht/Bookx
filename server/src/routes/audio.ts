import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import { getStorageProvider } from '../storage/index.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export function audioRouter(db: SqlJsDatabase): Router {
  const router = Router();

  router.get('/:assetId', async (req: Request, res: Response) => {
    try {
      const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [req.params.assetId]) as any;
      if (!asset) { res.status(404).json({ error: 'Audio asset not found' }); return; }

      const storage = getStorageProvider();
      const filePath = asset.file_path;
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };

      if (filePath.startsWith('gridfs://')) {
        // External storage — stream from provider
        const key = filePath.replace('gridfs://', '');
        const fileSize = await storage.size(key);
        res.setHeader('Content-Type', mimeTypes[ext] || 'audio/mpeg');
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Accept-Ranges', 'bytes');
        const stream = await storage.createReadStream(key);
        (stream as any).pipe(res);
      } else {
        // Local file
        if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Audio file not found on disk' }); return; }
        res.setHeader('Content-Type', mimeTypes[ext] || 'audio/mpeg');
        res.setHeader('Content-Length', fs.statSync(filePath).size);
        res.setHeader('Accept-Ranges', 'bytes');
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to stream audio' });
    }
  });

  router.get('/book/:bookId', (req: Request, res: Response) => {
    try {
      const assets = queryAll(db, 'SELECT * FROM audio_assets WHERE book_id = ? ORDER BY created_at DESC', [req.params.bookId]);
      res.json(assets);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list audio assets' });
    }
  });

  // List SFX and music assets for a book (for the library)
  router.get('/book/:bookId/library', (req: Request, res: Response) => {
    try {
      const assets = queryAll(db,
        `SELECT * FROM audio_assets WHERE book_id = ? AND type IN ('sfx', 'music', 'imported') ORDER BY created_at DESC`,
        [req.params.bookId]);
      res.json(assets);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list audio library' });
    }
  });

  // Download an audio asset as a file
  router.get('/:assetId/download', async (req: Request, res: Response) => {
    try {
      const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [req.params.assetId]) as any;
      if (!asset) { res.status(404).json({ error: 'Audio asset not found' }); return; }

      const ext = path.extname(asset.file_path).toLowerCase();
      const name = asset.name || asset.id;
      const safeName = name.replace(/[^a-zA-Z0-9_\-\s]/g, '').slice(0, 60) || 'audio';
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}${ext}"`);
      res.setHeader('Content-Type', ext === '.wav' ? 'audio/wav' : 'audio/mpeg');

      if (asset.file_path.startsWith('gridfs://')) {
        const storage = getStorageProvider();
        const key = asset.file_path.replace('gridfs://', '');
        const fileSize = await storage.size(key);
        res.setHeader('Content-Length', fileSize);
        const stream = await storage.createReadStream(key);
        (stream as any).pipe(res);
      } else {
        if (!fs.existsSync(asset.file_path)) { res.status(404).json({ error: 'Audio file not found on disk' }); return; }
        res.setHeader('Content-Length', fs.statSync(asset.file_path).size);
        fs.createReadStream(asset.file_path).pipe(res);
      }
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to download audio' });
    }
  });

  // Rename an audio asset
  router.put('/:assetId', (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [req.params.assetId]);
      if (!asset) { res.status(404).json({ error: 'Audio asset not found' }); return; }
      if (name !== undefined) {
        if (typeof name !== 'string' || name.length > 200) {
          res.status(400).json({ error: 'Name must be a string under 200 characters' });
          return;
        }
        run(db, 'UPDATE audio_assets SET name = ? WHERE id = ?', [name, req.params.assetId]);
      }
      const updated = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [req.params.assetId]);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update audio asset' });
    }
  });

  // Delete an audio asset
  router.delete('/:assetId', async (req: Request, res: Response) => {
    try {
      const asset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [req.params.assetId]) as any;
      if (!asset) { res.status(404).json({ error: 'Audio asset not found' }); return; }
      if (asset.file_path) {
        const storage = getStorageProvider();
        if (asset.file_path.startsWith('gridfs://')) {
          try { await storage.delete(asset.file_path.replace('gridfs://', '')); } catch {}
        } else if (fs.existsSync(asset.file_path)) {
          try { fs.unlinkSync(asset.file_path); } catch {}
        }
      }
      run(db, 'DELETE FROM clips WHERE audio_asset_id = ?', [req.params.assetId]);
      run(db, 'UPDATE segments SET audio_asset_id = NULL WHERE audio_asset_id = ?', [req.params.assetId]);
      run(db, 'DELETE FROM audio_assets WHERE id = ?', [req.params.assetId]);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete audio asset' });
    }
  });

  // Generate a silence audio asset (for pause insertion)
  router.post('/silence', (req: Request, res: Response) => {
    try {
      const { duration_ms, book_id } = req.body;
      if (!duration_ms || !book_id) { res.status(400).json({ error: 'duration_ms and book_id required' }); return; }

      const durationMs = Math.min(Math.max(100, duration_ms), 30000); // 100ms to 30s
      const assetId = uuid();
      const filePath = path.join(DATA_DIR, 'audio', `${assetId}.mp3`);

      // Generate a silent MP3 frame — minimal valid MP3 with silence
      // For simplicity, create a WAV file with silence then store it
      const sampleRate = 44100;
      const numSamples = Math.round((durationMs / 1000) * sampleRate);
      const dataSize = numSamples * 2; // 16-bit mono
      const headerSize = 44;
      const buffer = Buffer.alloc(headerSize + dataSize);

      // WAV header
      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + dataSize, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16); // chunk size
      buffer.writeUInt16LE(1, 20); // PCM
      buffer.writeUInt16LE(1, 22); // mono
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
      buffer.writeUInt16LE(2, 32); // block align
      buffer.writeUInt16LE(16, 34); // bits per sample
      buffer.write('data', 36);
      buffer.writeUInt32LE(dataSize, 40);
      // Data is already zeroed (silence)

      const wavPath = filePath.replace('.mp3', '.wav');
      fs.writeFileSync(wavPath, buffer);

      run(db,
        `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, file_size_bytes, name)
         VALUES (?, ?, 'sfx', ?, ?, ?, ?)`,
        [assetId, book_id, wavPath, durationMs, buffer.length, `Silence ${durationMs}ms`]);

      res.status(201).json({
        audio_asset_id: assetId,
        duration_ms: durationMs,
        name: `Silence ${durationMs}ms`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload audio for a specific chapter (creates segment + audio asset)
  router.post('/upload-to-chapter', async (req: Request, res: Response) => {
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        res.status(400).json({ error: 'Must be multipart/form-data' });
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) { chunks.push(chunk); }
      const body = Buffer.concat(chunks);

      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) { res.status(400).json({ error: 'No boundary found' }); return; }
      const boundary = boundaryMatch[1];

      const parts = parseMultipart(body, boundary);
      const filePart = parts.find(p => p.filename);
      const chapterIdPart = parts.find(p => p.name === 'chapter_id');
      const bookIdPart = parts.find(p => p.name === 'book_id');

      if (!filePart || !chapterIdPart || !bookIdPart) {
        res.status(400).json({ error: 'file, chapter_id, and book_id required' });
        return;
      }

      const chapterId = chapterIdPart.data.toString('utf-8').trim();
      const bookId = bookIdPart.data.toString('utf-8').trim();
      const originalName = filePart.filename || 'uploaded';
      const ext = path.extname(filePart.filename || '.mp3').toLowerCase();
      const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
      if (!allowed.includes(ext)) {
        res.status(400).json({ error: `Unsupported format: ${ext}. Allowed: ${allowed.join(', ')}` });
        return;
      }

      // Verify chapter exists
      const chapter = queryOne(db, 'SELECT * FROM chapters WHERE id = ? AND book_id = ?', [chapterId, bookId]);
      if (!chapter) {
        res.status(404).json({ error: 'Chapter not found' });
        return;
      }

      // Save audio file
      const assetId = uuid();
      const storage = getStorageProvider();
      const storageKey = `audio/${assetId}${ext}`;
      const storedPath = await storage.write(storageKey, filePart.data, { originalName, bookId, chapterId });

      const fileSizeBytes = filePart.data.length;
      const estimatedDurationMs = ext === '.mp3' ? Math.round((fileSizeBytes / 24000) * 1000) : null;

      // Create audio asset
      run(db,
        `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, file_size_bytes, name)
         VALUES (?, ?, 'imported', ?, ?, ?, ?)`,
        [assetId, bookId, storedPath, estimatedDurationMs, fileSizeBytes, originalName]);

      // Create a segment linked to this audio asset (or update existing if chapter has one segment with no audio)
      const existingSegments = queryAll(db, 'SELECT * FROM segments WHERE chapter_id = ? ORDER BY sort_order', [chapterId]);
      let segmentId: string;

      if (existingSegments.length === 1 && !existingSegments[0].audio_asset_id) {
        // Update existing single segment with the audio
        segmentId = existingSegments[0].id;
        run(db, 'UPDATE segments SET audio_asset_id = ? WHERE id = ?', [assetId, segmentId]);
      } else if (existingSegments.length === 0) {
        // Create a new segment for this audio
        segmentId = uuid();
        const segText = `[Imported audio: ${originalName}]`;
        run(db,
          `INSERT INTO segments (id, chapter_id, sort_order, text, audio_asset_id)
           VALUES (?, ?, 0, ?, ?)`,
          [segmentId, chapterId, segText, assetId]);
      } else {
        // Append a new segment at the end
        const maxOrder = existingSegments[existingSegments.length - 1].sort_order;
        segmentId = uuid();
        const segText = `[Imported audio: ${originalName}]`;
        run(db,
          `INSERT INTO segments (id, chapter_id, sort_order, text, audio_asset_id)
           VALUES (?, ?, ?, ?, ?)`,
          [segmentId, chapterId, maxOrder + 1, segText, assetId]);
      }

      res.status(201).json({
        audio_asset_id: assetId,
        segment_id: segmentId,
        file_path: storedPath,
        name: originalName,
        duration_ms: estimatedDurationMs,
        file_size_bytes: fileSizeBytes,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Replace audio for an existing segment
  router.post('/replace-segment-audio', async (req: Request, res: Response) => {
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        res.status(400).json({ error: 'Must be multipart/form-data' });
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) { chunks.push(chunk); }
      const body = Buffer.concat(chunks);

      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) { res.status(400).json({ error: 'No boundary found' }); return; }
      const boundary = boundaryMatch[1];

      const parts = parseMultipart(body, boundary);
      const filePart = parts.find(p => p.filename);
      const segmentIdPart = parts.find(p => p.name === 'segment_id');
      const bookIdPart = parts.find(p => p.name === 'book_id');

      if (!filePart || !segmentIdPart || !bookIdPart) {
        res.status(400).json({ error: 'file, segment_id, and book_id required' });
        return;
      }

      const segmentId = segmentIdPart.data.toString('utf-8').trim();
      const bookId = bookIdPart.data.toString('utf-8').trim();
      const originalName = filePart.filename || 'uploaded';
      const ext = path.extname(filePart.filename || '.mp3').toLowerCase();
      const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
      if (!allowed.includes(ext)) {
        res.status(400).json({ error: `Unsupported format: ${ext}` });
        return;
      }

      // Verify segment exists
      const segment = queryOne(db, 'SELECT * FROM segments WHERE id = ?', [segmentId]) as any;
      if (!segment) {
        res.status(404).json({ error: 'Segment not found' });
        return;
      }

      // Delete old audio asset if exists
      if (segment.audio_asset_id) {
        const oldAsset = queryOne(db, 'SELECT * FROM audio_assets WHERE id = ?', [segment.audio_asset_id]) as any;
        if (oldAsset?.file_path) {
          const storage = getStorageProvider();
          if (oldAsset.file_path.startsWith('gridfs://')) {
            try { await storage.delete(oldAsset.file_path.replace('gridfs://', '')); } catch {}
          } else if (fs.existsSync(oldAsset.file_path)) {
            try { fs.unlinkSync(oldAsset.file_path); } catch {}
          }
        }
        run(db, 'DELETE FROM clips WHERE audio_asset_id = ?', [segment.audio_asset_id]);
        run(db, 'DELETE FROM audio_assets WHERE id = ?', [segment.audio_asset_id]);
      }

      // Save new audio file
      const assetId = uuid();
      const storage = getStorageProvider();
      const storageKey = `audio/${assetId}${ext}`;
      const storedPath = await storage.write(storageKey, filePart.data, { originalName, bookId, segmentId });

      const fileSizeBytes = filePart.data.length;
      const estimatedDurationMs = ext === '.mp3' ? Math.round((fileSizeBytes / 24000) * 1000) : null;

      run(db,
        `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, file_size_bytes, name)
         VALUES (?, ?, 'imported', ?, ?, ?, ?)`,
        [assetId, bookId, storedPath, estimatedDurationMs, fileSizeBytes, originalName]);

      // Link to segment
      run(db, 'UPDATE segments SET audio_asset_id = ? WHERE id = ?', [assetId, segmentId]);

      res.status(200).json({
        audio_asset_id: assetId,
        segment_id: segmentId,
        name: originalName,
        duration_ms: estimatedDurationMs,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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

      // Use storage provider
      const storage = getStorageProvider();
      const storageKey = `audio/${assetId}${ext}`;
      const storedPath = await storage.write(storageKey, filePart.data, { originalName, bookId });

      // Estimate duration from file size (rough: 192kbps mp3 = 24000 bytes/sec)
      const fileSizeBytes = filePart.data.length;
      const estimatedDurationMs = ext === '.mp3' ? Math.round((fileSizeBytes / 24000) * 1000) : null;

      run(db,
        `INSERT INTO audio_assets (id, book_id, type, file_path, duration_ms, file_size_bytes) VALUES (?, ?, 'imported', ?, ?, ?)`,
        [assetId, bookId, storedPath, estimatedDurationMs, fileSizeBytes]);

      res.status(201).json({
        audio_asset_id: assetId,
        file_path: storedPath,
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
