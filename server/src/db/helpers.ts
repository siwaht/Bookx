import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDb } from './schema.js';

// Thin wrapper to provide a simpler query interface over sql.js

export function queryAll(db: SqlJsDatabase, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

export function queryOne(db: SqlJsDatabase, sql: string, params: any[] = []): any | undefined {
  const results = queryAll(db, sql, params);
  return results[0];
}

export function run(db: SqlJsDatabase, sql: string, params: any[] = []): void {
  db.run(sql, params);
  // Note: Don't call saveDb() here - the server has an auto-save interval
}

export function runMany(db: SqlJsDatabase, sql: string, paramSets: any[][]): void {
  for (const params of paramSets) {
    db.run(sql, params);
  }
  // Note: Don't call saveDb() here - the server has an auto-save interval
}

/**
 * Execute multiple operations inside a transaction.
 * Automatically rolls back on error.
 */
export function withTransaction<T>(db: SqlJsDatabase, fn: () => T): T {
  db.run('BEGIN TRANSACTION');
  try {
    const result = fn();
    db.run('COMMIT');
    return result;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}
