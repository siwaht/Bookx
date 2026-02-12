import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb, initializeSchema, saveDb } from './db/schema.js';
import { queryAll, queryOne } from './db/helpers.js';
import { authMiddleware, loginHandler } from './middleware/auth.js';
import { booksRouter } from './routes/books.js';
import { chaptersRouter } from './routes/chapters.js';
import { charactersRouter } from './routes/characters.js';
import { segmentsRouter } from './routes/segments.js';
import { elevenlabsRouter } from './routes/elevenlabs.js';
import { timelineRouter } from './routes/timeline.js';
import { importRouter } from './routes/import.js';
import { renderRouter } from './routes/render.js';
import { exportRouter } from './routes/export.js';
import { audioRouter } from './routes/audio.js';
import { settingsRouter, getSetting } from './routes/settings.js';
import { aiParseRouter } from './routes/ai-parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  // Initialize database
  const db = await getDb();
  initializeSchema(db);
  console.log('[DB] SQLite initialized');

  // Load API keys from settings into env if not already set
  const storedElKey = getSetting(db, 'elevenlabs_api_key');
  if (storedElKey && !process.env.ELEVENLABS_API_KEY) {
    process.env.ELEVENLABS_API_KEY = storedElKey;
  }

  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Auth
  app.post('/api/auth/login', loginHandler);
  app.get('/api/auth/verify', authMiddleware, (_req, res) => res.json({ ok: true }));
  app.use('/api', authMiddleware);

  // Routes
  app.use('/api/books', booksRouter(db));
  app.use('/api/books/:bookId/chapters', chaptersRouter(db));
  app.use('/api/books/:bookId/characters', charactersRouter(db));
  app.use('/api/chapters/:chapterId/segments', segmentsRouter(db));
  app.use('/api/elevenlabs', elevenlabsRouter(db));
  app.use('/api/books/:bookId', timelineRouter(db));
  app.use('/api/books/:bookId/import', importRouter(db));
  app.use('/api/books/:bookId/render', renderRouter(db));
  app.use('/api/books/:bookId/export', exportRouter(db));
  app.use('/api/audio', audioRouter(db));
  app.use('/api/settings', settingsRouter(db));
  app.use('/api/books/:bookId/ai-parse', aiParseRouter(db));

  // Save DB explicitly
  app.post('/api/save', (_req, res) => {
    saveDb();
    res.json({ ok: true, saved_at: new Date().toISOString() });
  });

  // Download project as zip (all audio files + DB snapshot)
  app.get('/api/books/:bookId/download-project', async (req, res) => {
    try {
      const bookId = req.params.bookId;
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [bookId]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      const archiver = (await import('archiver')).default;
      const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitize(book.title)}_project.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err: any) => { res.status(500).json({ error: err.message }); });
      archive.pipe(res);

      // Add all audio assets for this book
      const assets = queryAll(db, 'SELECT * FROM audio_assets WHERE book_id = ?', [bookId]);
      for (const asset of assets as any[]) {
        if (asset.file_path && fs.existsSync(asset.file_path)) {
          archive.file(asset.file_path, { name: `audio/${path.basename(asset.file_path)}` });
        }
      }

      // Add rendered files if they exist
      const latestRender = queryOne(db, `SELECT * FROM render_jobs WHERE book_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, [bookId]);
      if (latestRender?.output_path && fs.existsSync(latestRender.output_path)) {
        archive.directory(latestRender.output_path, 'rendered');
      }

      // Add a project manifest
      const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
      const characters = queryAll(db, 'SELECT * FROM characters WHERE book_id = ?', [bookId]);
      const tracks = queryAll(db, 'SELECT * FROM tracks WHERE book_id = ? ORDER BY sort_order', [bookId]);
      const manifest = {
        book, chapters, characters, tracks,
        assets: assets.length,
        exported_at: new Date().toISOString(),
      };
      archive.append(JSON.stringify(manifest, null, 2), { name: 'project.json' });

      await archive.finalize();
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // Serve static client in production
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`[Server] Audiobook Maker running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
