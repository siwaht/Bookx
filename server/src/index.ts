import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, initializeSchema } from './db/schema.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  // Initialize database
  const db = await getDb();
  initializeSchema(db);
  console.log('[DB] SQLite initialized');

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
