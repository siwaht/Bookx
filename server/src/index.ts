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
import { pronunciationRouter } from './routes/pronunciation.js';
import { ttsProvidersRouter } from './routes/tts-providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// ── Structured Logger ──
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
const LOG_LEVEL = IS_PROD ? LOG_LEVELS.info : LOG_LEVELS.debug;

const log = {
  error: (msg: string, meta?: any) => {
    if (LOG_LEVEL >= LOG_LEVELS.error)
      console.error(JSON.stringify({ level: 'error', ts: new Date().toISOString(), msg, ...meta }));
  },
  warn: (msg: string, meta?: any) => {
    if (LOG_LEVEL >= LOG_LEVELS.warn)
      console.warn(JSON.stringify({ level: 'warn', ts: new Date().toISOString(), msg, ...meta }));
  },
  info: (msg: string, meta?: any) => {
    if (LOG_LEVEL >= LOG_LEVELS.info)
      console.log(JSON.stringify({ level: 'info', ts: new Date().toISOString(), msg, ...meta }));
  },
  debug: (msg: string, meta?: any) => {
    if (LOG_LEVEL >= LOG_LEVELS.debug)
      console.log(JSON.stringify({ level: 'debug', ts: new Date().toISOString(), msg, ...meta }));
  },
};

// ── Environment Validation ──
function validateEnv(): void {
  const password = process.env.APP_PASSWORD;
  if (!password || password === 'changeme') {
    log.warn('APP_PASSWORD is not set or still default. Change it for production!');
  }
  if (IS_PROD && (!password || password === 'changeme')) {
    log.error('CRITICAL: APP_PASSWORD must be changed for production deployment');
  }
}

async function main() {
  validateEnv();

  const DATA_DIR = process.env.DATA_DIR || './data';
  for (const sub of ['audio', 'renders', 'exports', 'uploads']) {
    fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  }

  // Initialize database
  const db = await getDb();
  initializeSchema(db);
  log.info('Database initialized', { path: DATA_DIR });

  // Load API keys from settings into env — DB values always take priority
  const storedElKey = getSetting(db, 'elevenlabs_api_key');
  if (storedElKey) {
    process.env.ELEVENLABS_API_KEY = storedElKey;
    log.info('ElevenLabs API key loaded from DB settings');
  } else if (process.env.ELEVENLABS_API_KEY) {
    log.info('ElevenLabs API key loaded from .env');
  } else {
    log.warn('No ElevenLabs API key found. Set it in Settings page.');
  }
  for (const provider of ['openai', 'mistral', 'gemini', 'google_tts', 'aws_access_key', 'aws_secret_access_key']) {
    const settingKey = `${provider}_api_key`;
    const envKey = provider === 'google_tts' ? 'GOOGLE_TTS_API_KEY'
      : provider === 'aws_access_key' ? 'AWS_ACCESS_KEY_ID'
      : provider === 'aws_secret_access_key' ? 'AWS_SECRET_ACCESS_KEY'
      : `${provider.toUpperCase()}_API_KEY`;
    const storedKey = getSetting(db, settingKey);
    if (storedKey) {
      process.env[envKey] = storedKey;
    }
  }
  const awsRegion = getSetting(db, 'aws_region');
  if (awsRegion) process.env.AWS_REGION = awsRegion;

  const app = express();

  // ── Trust proxy (for rate limiting behind reverse proxy) ──
  app.set('trust proxy', 1);

  // ── CORS ──
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : undefined; // undefined = allow all in dev, restrict in prod via env

  app.use(cors({
    origin: allowedOrigins || true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }));

  // ── Body parsing ──
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // ── Compression ──
  // Dynamic import since compression doesn't have ESM default export
  try {
    const compression = (await import('compression')).default;
    app.use(compression());
  } catch {
    log.warn('compression package not available, serving uncompressed');
  }

  // ── Security Headers ──
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0'); // Modern browsers: CSP is preferred
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (IS_PROD) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // ── Request Logging ──
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      // Only log API requests, skip static files in production
      if (req.path.startsWith('/api')) {
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        log[level](`${req.method} ${req.path}`, {
          status: res.statusCode,
          duration_ms: duration,
          ip: req.ip,
        });
      }
    });
    next();
  });

  // ── Health check (no auth) ──
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      env: NODE_ENV,
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  // ── Auth ──
  app.post('/api/auth/login', loginHandler);
  app.get('/api/auth/verify', authMiddleware, (_req, res) => res.json({ ok: true }));
  app.use('/api', authMiddleware);

  // ── API Routes ──
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
  app.use('/api/books/:bookId/pronunciation', pronunciationRouter(db));
  app.use('/api/tts', ttsProvidersRouter(db));

  // ── Save DB explicitly ──
  app.post('/api/save', (_req, res) => {
    saveDb();
    res.json({ ok: true, saved_at: new Date().toISOString() });
  });

  // ── Download project as zip ──
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
      archive.on('error', (err: any) => {
        log.error('Archive error', { error: err.message });
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      archive.pipe(res);

      const assets = queryAll(db, 'SELECT * FROM audio_assets WHERE book_id = ?', [bookId]);
      for (const asset of assets as any[]) {
        if (asset.file_path && fs.existsSync(asset.file_path)) {
          archive.file(asset.file_path, { name: `audio/${path.basename(asset.file_path)}` });
        }
      }

      const latestRender = queryOne(db, `SELECT * FROM render_jobs WHERE book_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, [bookId]);
      if (latestRender?.output_path && fs.existsSync(latestRender.output_path)) {
        archive.directory(latestRender.output_path, 'rendered');
      }

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
      log.error('Download project error', { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ── Serve static client in production ──
  const clientDist = path.join(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, {
      maxAge: IS_PROD ? '1d' : 0,
      etag: true,
      lastModified: true,
    }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    log.warn('Client dist not found, static serving disabled', { path: clientDist });
  }

  // ── 404 handler for API routes ──
  app.use('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // ── Global error handler ──
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error('Unhandled error', { error: err.message, stack: IS_PROD ? undefined : err.stack });
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        error: IS_PROD ? 'Internal server error' : err.message,
      });
    }
  });

  const server = app.listen(PORT, () => {
    log.info(`Server started`, { port: PORT, env: NODE_ENV, pid: process.pid });
  });

  // ── Graceful shutdown ──
  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down gracefully...`);
    saveDb();
    server.close(() => {
      log.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => {
      log.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.message, stack: err.stack });
    saveDb();
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
