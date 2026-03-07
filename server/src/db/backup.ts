import fs from 'fs';
import path from 'path';
import { saveDb } from './schema.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 10;

/**
 * Create a timestamped backup of the SQLite database.
 * Keeps the last MAX_BACKUPS copies and deletes older ones.
 */
export function createBackup(): { path: string; size: number } | null {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // Ensure latest data is flushed
    saveDb();

    const dbPath = path.join(DATA_DIR, 'db.sqlite');
    if (!fs.existsSync(dbPath)) return null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `db_${timestamp}.sqlite`);

    fs.copyFileSync(dbPath, backupPath);
    const stats = fs.statSync(backupPath);

    // Prune old backups
    pruneBackups();

    return { path: backupPath, size: stats.size };
  } catch (err) {
    console.error('[Backup] Failed to create backup:', err);
    return null;
  }
}

function pruneBackups(): void {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('db_') && f.endsWith('.sqlite'))
      .sort()
      .reverse();

    // Keep only the most recent MAX_BACKUPS
    for (let i = MAX_BACKUPS; i < files.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
    }
  } catch { /* ignore pruning errors */ }
}

/**
 * List available backups with metadata.
 */
export function listBackups(): Array<{ filename: string; size: number; created: string }> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('db_') && f.endsWith('.sqlite'))
      .map(f => {
        const stats = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size: stats.size, created: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  } catch { return []; }
}

/**
 * Restore a backup by filename. Returns true on success.
 * The current DB is backed up first as a safety measure.
 */
export function restoreBackup(filename: string): boolean {
  try {
    const backupPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(backupPath)) return false;

    // Safety: back up current DB before restoring
    const dbPath = path.join(DATA_DIR, 'db.sqlite');
    if (fs.existsSync(dbPath)) {
      const safetyPath = path.join(BACKUP_DIR, `db_pre-restore_${Date.now()}.sqlite`);
      fs.copyFileSync(dbPath, safetyPath);
    }

    fs.copyFileSync(backupPath, dbPath);
    return true;
  } catch (err) {
    console.error('[Backup] Failed to restore:', err);
    return false;
  }
}
