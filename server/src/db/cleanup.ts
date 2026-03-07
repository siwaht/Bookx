import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, run } from './helpers.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export interface CleanupResult {
  exports_removed: number;
  renders_removed: number;
  orphan_assets_removed: number;
  bytes_freed: number;
}

/**
 * Remove old export ZIP files older than `maxAgeDays`.
 */
function cleanOldExports(db: SqlJsDatabase, maxAgeDays: number): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;

  const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
  const oldExports = queryAll(db,
    `SELECT id, output_path FROM exports WHERE created_at < ? AND output_path IS NOT NULL`,
    [cutoff]
  );

  for (const exp of oldExports as any[]) {
    if (exp.output_path && fs.existsSync(exp.output_path)) {
      try {
        const stats = fs.statSync(exp.output_path);
        bytes += stats.size;
        fs.unlinkSync(exp.output_path);
        removed++;
      } catch { /* skip */ }
    }
    run(db, `UPDATE exports SET output_path = NULL WHERE id = ?`, [exp.id]);
  }

  return { removed, bytes };
}

/**
 * Remove old render output directories older than `maxAgeDays`.
 * Keeps the QC report and metadata, just removes the large audio files.
 */
function cleanOldRenders(db: SqlJsDatabase, maxAgeDays: number): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;

  const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
  const oldRenders = queryAll(db,
    `SELECT id, output_path FROM render_jobs WHERE completed_at < ? AND output_path IS NOT NULL AND status = 'completed'`,
    [cutoff]
  );

  for (const job of oldRenders as any[]) {
    if (job.output_path && fs.existsSync(job.output_path)) {
      try {
        bytes += getDirSize(job.output_path);
        fs.rmSync(job.output_path, { recursive: true, force: true });
        removed++;
      } catch { /* skip */ }
    }
    run(db, `UPDATE render_jobs SET output_path = NULL WHERE id = ?`, [job.id]);
  }

  return { removed, bytes };
}

/**
 * Remove orphaned audio assets (files on disk not referenced by any segment or clip).
 */
function cleanOrphanAssets(db: SqlJsDatabase): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;

  const orphans = queryAll(db,
    `SELECT a.id, a.file_path, a.file_size_bytes FROM audio_assets a
     WHERE a.id NOT IN (SELECT DISTINCT audio_asset_id FROM segments WHERE audio_asset_id IS NOT NULL)
       AND a.id NOT IN (SELECT DISTINCT audio_asset_id FROM clips)
       AND a.created_at < datetime('now', '-7 days')`,
    []
  );

  for (const asset of orphans as any[]) {
    if (asset.file_path && fs.existsSync(asset.file_path)) {
      try {
        const stats = fs.statSync(asset.file_path);
        bytes += stats.size;
        fs.unlinkSync(asset.file_path);
      } catch { /* skip */ }
    }
    run(db, `DELETE FROM audio_assets WHERE id = ?`, [asset.id]);
    removed++;
  }

  return { removed, bytes };
}

function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        size += fs.statSync(fullPath).size;
      } else if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      }
    }
  } catch { /* skip */ }
  return size;
}

/**
 * Run all cleanup tasks. Returns summary of what was cleaned.
 * @param maxAgeDays - Age threshold for exports/renders (default: 30 days)
 */
export function runCleanup(db: SqlJsDatabase, maxAgeDays = 30): CleanupResult {
  const exports = cleanOldExports(db, maxAgeDays);
  const renders = cleanOldRenders(db, maxAgeDays);
  const orphans = cleanOrphanAssets(db);

  return {
    exports_removed: exports.removed,
    renders_removed: renders.removed,
    orphan_assets_removed: orphans.removed,
    bytes_freed: exports.bytes + renders.bytes + orphans.bytes,
  };
}

/**
 * Get disk usage summary for the data directory.
 */
export function getDiskUsage(): { audio_mb: number; exports_mb: number; renders_mb: number; backups_mb: number; total_mb: number } {
  const toMb = (b: number) => Math.round(b / 1024 / 1024 * 100) / 100;
  const audio = getDirSize(path.join(DATA_DIR, 'audio'));
  const exports = getDirSize(path.join(DATA_DIR, 'exports'));
  const renders = getDirSize(path.join(DATA_DIR, 'renders'));
  const backups = getDirSize(path.join(DATA_DIR, 'backups'));

  return {
    audio_mb: toMb(audio),
    exports_mb: toMb(exports),
    renders_mb: toMb(renders),
    backups_mb: toMb(backups),
    total_mb: toMb(audio + exports + renders + backups),
  };
}
