import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Where SQL goes.
 *
 * Bookx talks to its database through drizzle's `sqlite-proxy` driver, and
 * this module is the other end of that proxy:
 *
 * - On Cloudflare the app runs in a container, and `BOOKX_DB_URL` points at a
 *   virtual host that the container's Worker answers with its D1 binding.
 * - Everywhere else it is a local SQLite file, through Node's built-in
 *   `node:sqlite`, so a checkout needs no database server at all.
 *
 * The local transport enforces D1's per-statement limits, so code that would
 * fail on D1 fails the same way in development and in tests.
 */

export type SqlMethod = "run" | "all" | "values" | "get";
export type SqlQuery = { sql: string; params: unknown[]; method: SqlMethod };
// `rows` is an array of value arrays, or a single value array for `get`.
export type SqlResult = { rows: any };

export interface SqlTransport {
  readonly kind: "local" | "d1";
  query(query: SqlQuery): Promise<SqlResult>;
  /** Runs statements in order as one atomic unit, in one round trip. */
  batch(queries: SqlQuery[]): Promise<SqlResult[]>;
  /** Applies migration statements atomically. */
  migrate(statements: string[]): Promise<void>;
}

/** Cloudflare D1's limits per statement. */
export const D1_LIMITS = { maxParams: 100, maxSqlBytes: 100_000, maxValueBytes: 2_000_000 } as const;

export class D1LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1LimitError";
  }
}

export function checkD1Limits(query: { sql: string; params: unknown[] }): void {
  if (query.params.length > D1_LIMITS.maxParams) {
    throw new D1LimitError(`D1 allows at most ${D1_LIMITS.maxParams} bound parameters per statement; this one has ${query.params.length}: ${query.sql.slice(0, 120)}`);
  }
  if (Buffer.byteLength(query.sql) > D1_LIMITS.maxSqlBytes) {
    throw new D1LimitError(`D1 statements are limited to ${D1_LIMITS.maxSqlBytes} bytes: ${query.sql.slice(0, 120)}`);
  }
  for (const value of query.params) {
    if (typeof value === "string" && value.length * 3 > D1_LIMITS.maxValueBytes && Buffer.byteLength(value) > D1_LIMITS.maxValueBytes) {
      throw new D1LimitError(`D1 rows are limited to 2 MB; a value of ${Buffer.byteLength(value)} bytes does not fit`);
    }
  }
}

/** Parameters as SQLite (and JSON) understand them. */
export function toSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value;
}

// ---------------------------------------------------------------------------
// Local file
// ---------------------------------------------------------------------------

class LocalTransport implements SqlTransport {
  readonly kind = "local" as const;
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  static async open(file: string): Promise<LocalTransport> {
    // Loaded at runtime: `node:sqlite` only exists with its `node:` prefix,
    // which Vite (vitest) strips from static imports.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new DatabaseSync(file);
    if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    return new LocalTransport(db);
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      if (this.statements.size > 500) this.statements.clear();
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private execute(query: SqlQuery): SqlResult {
    checkD1Limits(query);
    const statement = this.prepare(query.sql);
    const params = query.params.map(toSqlValue) as Array<string | number | null | Uint8Array>;
    if (query.method === "run") {
      statement.run(...params);
      return { rows: [] };
    }
    statement.setReturnArrays(true);
    if (query.method === "get") return { rows: statement.get(...params) };
    return { rows: statement.all(...params) };
  }

  async query(query: SqlQuery): Promise<SqlResult> {
    return this.execute(query);
  }

  async batch(queries: SqlQuery[]): Promise<SqlResult[]> {
    // node:sqlite is synchronous, so nothing else can interleave between BEGIN
    // and COMMIT; this matches D1, where a batch is all-or-nothing.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = queries.map(query => this.execute(query));
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async migrate(statements: string[]): Promise<void> {
    if (!statements.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) this.db.exec(statement);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// D1, through the container's Worker
// ---------------------------------------------------------------------------

const isRead = (query: SqlQuery) => query.method !== "run" && /^\s*select\b/i.test(query.sql);

class HttpTransport implements SqlTransport {
  readonly kind = "d1" as const;

  constructor(private readonly base: string) {}

  private async post(route: string, body: unknown, attempts: number): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(`${this.base}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.ok) return payload;
        lastError = new Error(payload.error || `D1 request failed with HTTP ${response.status}`);
        // D1 reports some transient conditions; everything else will not change on retry.
        if (!/overloaded|network connection lost|internal error|reset/i.test(String(payload.error ?? ""))) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 150 * attempt));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async query(query: SqlQuery): Promise<SqlResult> {
    checkD1Limits(query);
    // Only reads are retried: repeating a write that may already have landed
    // could apply it twice.
    return (await this.post("/query", { ...query, params: query.params.map(toSqlValue) }, isRead(query) ? 3 : 1)) as SqlResult;
  }

  async batch(queries: SqlQuery[]): Promise<SqlResult[]> {
    for (const query of queries) checkD1Limits(query);
    const payload = (await this.post("/batch", { queries: queries.map(query => ({ ...query, params: query.params.map(toSqlValue) })) }, 1)) as { results: SqlResult[] };
    return payload.results;
  }

  async migrate(statements: string[]): Promise<void> {
    if (!statements.length) return;
    await this.post("/migrate", { statements }, 1);
  }
}

export function localDatabasePath(): string {
  return process.env.BOOKX_SQLITE_PATH?.trim() || path.join("data", "bookx.sqlite");
}

export async function openSqlTransport(): Promise<SqlTransport> {
  const remote = process.env.BOOKX_DB_URL?.trim();
  if (remote) return new HttpTransport(remote.replace(/\/+$/, ""));
  return LocalTransport.open(localDatabasePath());
}
