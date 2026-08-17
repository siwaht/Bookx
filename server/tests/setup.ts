import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import express from 'express';
import { initializeSchema } from '../src/db/schema.js';
import { authMiddleware, loginHandler } from '../src/middleware/auth.js';
import { booksRouter } from '../src/routes/books.js';
import { chaptersRouter } from '../src/routes/chapters.js';
import { charactersRouter } from '../src/routes/characters.js';
import http from 'node:http';

// Set test password before anything else
process.env.APP_PASSWORD = 'testpassword';

export interface TestContext {
  app: express.Express;
  db: SqlJsDatabase;
  server: http.Server;
  baseUrl: string;
}

export async function createTestApp(): Promise<TestContext> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  initializeSchema(db);

  const app = express();

  // Body parsing
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Health check (no auth)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Auth
  app.post('/api/auth/login', loginHandler);
  app.get('/api/auth/verify', authMiddleware, (_req, res) => res.json({ ok: true }));
  app.use('/api', authMiddleware);

  // API Routes
  app.use('/api/books', booksRouter(db));
  app.use('/api/books/:bookId/chapters', chaptersRouter(db));
  app.use('/api/books/:bookId/characters', charactersRouter(db));

  // 404 handler for API routes
  app.use('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Start on random port
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return { app, db, server, baseUrl };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ctx.server.close((err) => (err ? reject(err) : resolve()));
  });
  ctx.db.close();
}
