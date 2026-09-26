import path from "node:path";
import { and, eq, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import * as schema from "../drizzle/schema";
import { bookxChapters, type InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { D1_LIMITS, openSqlTransport, type SqlTransport } from "./sqlTransport";

/**
 * The database: Cloudflare D1 in production, a local SQLite file elsewhere,
 * with one schema and one driver for both (see `sqlTransport.ts`).
 *
 * Migrations in `drizzle/sqlite` are applied automatically the first time the
 * database is used, so a fresh D1 database or a fresh checkout needs no setup.
 */

export type Db = SqliteRemoteDatabase<typeof schema>;

let connection: Promise<{ db: Db; transport: SqlTransport }> | null = null;

export function migrationsFolder(): string {
  return path.resolve(process.env.BOOKX_MIGRATIONS_DIR || path.join(process.cwd(), "drizzle", "sqlite"));
}

async function connect(): Promise<{ db: Db; transport: SqlTransport }> {
  const transport = await openSqlTransport();
  const db = drizzle(
    (sql, params, method) => transport.query({ sql, params, method }),
    queries => transport.batch(queries),
    { schema },
  );
  await migrate(db, statements => transport.migrate(statements), { migrationsFolder: migrationsFolder() });
  return { db, transport };
}

export async function getDb(): Promise<Db> {
  connection ??= connect().catch(error => {
    connection = null;
    console.error("[Database] Could not open the database:", error);
    throw error;
  });
  return (await connection).db;
}

export async function databaseKind(): Promise<"local" | "d1"> {
  await getDb();
  return (await connection!).transport.kind;
}

// ---------------------------------------------------------------------------
// Staying inside D1's limits
// ---------------------------------------------------------------------------

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) parts.push(items.slice(offset, offset + size));
  return parts;
}

/**
 * Splits ids so one chunk plus `reserved` other parameters fits in a single
 * statement (D1 allows 100). Duplicates are dropped.
 */
export function idChunks<T>(ids: readonly T[], reserved = 8): T[][] {
  return chunk([...new Set(ids)], D1_LIMITS.maxParams - reserved);
}

/** Runs `select` for each chunk of ids and concatenates the rows. */
export async function selectInChunks<T, R>(ids: readonly T[], select: (part: T[]) => Promise<R[]>, reserved = 8): Promise<R[]> {
  const rows: R[] = [];
  for (const part of idChunks(ids, reserved)) rows.push(...(await select(part)));
  return rows;
}

/** Runs a write for each chunk of ids. */
export async function forEachChunk<T>(ids: readonly T[], write: (part: T[]) => Promise<unknown>, reserved = 8): Promise<void> {
  for (const part of idChunks(ids, reserved)) await write(part);
}

/** Runs statements in atomic batches, one round trip per batch. */
export async function runBatched(db: Db, statements: BatchItem<"sqlite">[], size = 40): Promise<void> {
  for (const part of chunk(statements, size)) {
    if (part.length) await db.batch(part as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

/** Inserts rows, as many per statement as the parameter limit allows. */
export async function insertMany<TTable extends SQLiteTable>(db: Db, table: TTable, rows: Array<TTable["$inferInsert"]>): Promise<void> {
  if (!rows.length) return;
  // Every row of a multi-row insert binds the same columns, so the first row
  // tells us how many parameters one row costs.
  const perRow = Math.max(1, db.insert(table).values(rows[0]!).toSQL().params.length);
  const rowsPerStatement = Math.max(1, Math.floor(D1_LIMITS.maxParams / perRow));
  await runBatched(db, chunk(rows, rowsPerStatement).map(part => db.insert(table).values(part)));
}

/** The ids of a project's chapters, as a subquery (one parameter however long the book is). */
export function projectChapterIds(db: Db, projectId: string, options: { includedOnly?: boolean } = {}) {
  const conditions: SQL[] = [eq(bookxChapters.projectId, projectId)];
  if (options.includedOnly) conditions.push(eq(bookxChapters.included, 1));
  return db.select({ id: bookxChapters.id }).from(bookxChapters).where(and(...conditions));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }
    updateSet.updatedAt = new Date();

    await db.insert(users).values(values).onConflictDoUpdate({ target: users.openId, set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}
