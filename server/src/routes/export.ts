import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';

const DATA_DIR = process.env.DATA_DIR || './data';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

export function exportRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId as string;
      const target = req.body.target || 'acx';
      const book = queryOne(db, 'SELECT * FROM books WHERE id = ?', [bookId]);
      if (!book) { res.status(404).json({ error: 'Book not found' }); return; }

      const exportId = uuid();

      if (target === 'podcast') {
        // Podcast export: simpler validation, just needs rendered audio
        const validation = validateForPodcast(db, bookId, book);
        run(db, `INSERT INTO exports (id, book_id, target, status, validation_report) VALUES (?, ?, 'podcast', ?, ?)`,
          [exportId, bookId, validation.pass ? 'ready' : 'validation_failed', JSON.stringify(validation)]);
        if (!validation.pass) {
          res.json({ export_id: exportId, status: 'validation_failed', validation });
          return;
        }
        const outputPath = await buildPodcastPackage(db, bookId, book, exportId);
        run(db, `UPDATE exports SET status = 'completed', output_path = ? WHERE id = ?`, [outputPath, exportId]);
        res.json({ export_id: exportId, status: 'completed', validation });
      } else {
        // ACX export
        const validation = validateForACX(db, bookId, book);
        run(db, `INSERT INTO exports (id, book_id, target, status, validation_report) VALUES (?, ?, 'acx', ?, ?)`,
          [exportId, bookId, validation.pass ? 'ready' : 'validation_failed', JSON.stringify(validation)]);
        if (!validation.pass) {
          res.json({ export_id: exportId, status: 'validation_failed', validation });
          return;
        }
        const outputPath = await buildACXPackage(db, bookId, book, exportId);
        run(db, `UPDATE exports SET status = 'completed', output_path = ? WHERE id = ?`, [outputPath, exportId]);
        res.json({ export_id: exportId, status: 'completed', validation });
      }
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/:exportId', (req: Request, res: Response) => {
    const exp = queryOne(db, 'SELECT * FROM exports WHERE id = ?', [req.params.exportId]);
    if (!exp) { res.status(404).json({ error: 'Export not found' }); return; }
    res.json({ ...exp, validation_report: exp.validation_report ? JSON.parse(exp.validation_report) : null });
  });

  router.get('/:exportId/download', (req: Request, res: Response) => {
    const exp = queryOne(db, 'SELECT * FROM exports WHERE id = ?', [req.params.exportId]);
    if (!exp?.output_path || !fs.existsSync(exp.output_path)) { res.status(404).json({ error: 'Export file not found' }); return; }
    res.download(exp.output_path);
  });

  return router;
}

function validateForACX(db: SqlJsDatabase, bookId: string, book: any) {
  const checks: Array<{ name: string; pass: boolean; message: string }> = [];

  const chapterCount = queryOne(db, 'SELECT COUNT(*) as count FROM chapters WHERE book_id = ?', [bookId]);
  checks.push({ name: 'Chapters exist', pass: chapterCount.count > 0, message: chapterCount.count > 0 ? `${chapterCount.count} chapters` : 'No chapters' });

  const latestRender = queryOne(db, `SELECT * FROM render_jobs WHERE book_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, [bookId]);
  checks.push({ name: 'Render completed', pass: !!latestRender, message: latestRender ? 'Render available' : 'No completed render' });

  if (latestRender?.qc_report) {
    const qc = JSON.parse(latestRender.qc_report);
    checks.push({ name: 'QC passed', pass: qc.overall_pass, message: qc.overall_pass ? 'All pass' : 'Issues found' });
  } else {
    checks.push({ name: 'QC passed', pass: false, message: 'No QC report' });
  }

  checks.push({ name: 'Cover art', pass: !!book.cover_art_path, message: book.cover_art_path ? 'Set' : 'Not set (optional)' });
  checks.push({ name: 'Title', pass: !!book.title, message: book.title || 'Missing' });

  const pass = checks.filter((c) => c.name !== 'Cover art').every((c) => c.pass);
  return { pass, checks };
}

async function buildACXPackage(db: SqlJsDatabase, bookId: string, book: any, exportId: string): Promise<string> {
  const latestRender = queryOne(db, `SELECT * FROM render_jobs WHERE book_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, [bookId]);
  if (!latestRender?.output_path) throw new Error('No rendered files');

  const renderDir = latestRender.output_path;
  const outputPath = path.join(DATA_DIR, 'exports', `${exportId}.zip`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(outputPath));
    archive.on('error', reject);
    archive.pipe(output);

    const files = fs.readdirSync(renderDir).filter((f: string) => f.endsWith('.mp3')).sort();
    files.forEach((file: string, index: number) => {
      const acxName = `${sanitizeFilename(book.title)}_Chapter${String(index + 1).padStart(2, '0')}.mp3`;
      archive.file(path.join(renderDir, file), { name: acxName });
    });

    if (book.cover_art_path && fs.existsSync(book.cover_art_path)) {
      archive.file(book.cover_art_path, { name: `cover${path.extname(book.cover_art_path)}` });
    }

    const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
    let csv = 'Chapter Number,Chapter Title,File Name\n';
    chapters.forEach((ch: any, i: number) => {
      csv += `${i + 1},"${ch.title}",${sanitizeFilename(book.title)}_Chapter${String(i + 1).padStart(2, '0')}.mp3\n`;
    });
    archive.append(csv, { name: 'metadata.csv' });

    archive.finalize();
  });
}


function validateForPodcast(db: SqlJsDatabase, bookId: string, book: any) {
  const checks: Array<{ name: string; pass: boolean; message: string }> = [];

  const chapterCount = queryOne(db, 'SELECT COUNT(*) as count FROM chapters WHERE book_id = ?', [bookId]);
  checks.push({ name: 'Episodes/chapters exist', pass: chapterCount.count > 0, message: chapterCount.count > 0 ? `${chapterCount.count} episodes` : 'No episodes' });

  const latestRender = queryOne(db, `SELECT * FROM render_jobs WHERE book_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, [bookId]);
  checks.push({ name: 'Render completed', pass: !!latestRender, message: latestRender ? 'Render available' : 'No completed render — run QC & Render first' });

  checks.push({ name: 'Title', pass: !!book.title, message: book.title || 'Missing' });

  const pass = checks.every((c) => c.pass);
  return { pass, checks };
}

async function buildPodcastPackage(db: SqlJsDatabase, bookId: string, book: any, exportId: string): Promise<string> {
  const latestRender = queryOne(db, `SELECT * FROM render_jobs WHERE book_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, [bookId]);
  if (!latestRender?.output_path) throw new Error('No rendered files');

  const renderDir = latestRender.output_path;
  const outputPath = path.join(DATA_DIR, 'exports', `${exportId}.zip`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(outputPath));
    archive.on('error', reject);
    archive.pipe(output);

    const files = fs.readdirSync(renderDir).filter((f: string) => f.endsWith('.mp3')).sort();
    const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);

    files.forEach((file: string, index: number) => {
      const chTitle = index < chapters.length ? sanitizeFilename((chapters[index] as any).title) : `Episode_${index + 1}`;
      const podcastName = `${sanitizeFilename(book.title)}_${chTitle}.mp3`;
      archive.file(path.join(renderDir, file), { name: podcastName });
    });

    if (book.cover_art_path && fs.existsSync(book.cover_art_path)) {
      archive.file(book.cover_art_path, { name: `cover${path.extname(book.cover_art_path)}` });
    }

    // Episode metadata JSON (useful for RSS feed generation)
    const episodes = chapters.map((ch: any, i: number) => ({
      episode_number: i + 1,
      title: ch.title,
      file: `${sanitizeFilename(book.title)}_${sanitizeFilename(ch.title)}.mp3`,
    }));
    const metadata = {
      podcast_title: book.title,
      author: book.author,
      episodes,
      exported_at: new Date().toISOString(),
    };
    archive.append(JSON.stringify(metadata, null, 2), { name: 'podcast_metadata.json' });

    archive.finalize();
  });
}
