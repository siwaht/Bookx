import { sql } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { databaseKind, getDb } from "../db";
import { resolveFfmpeg } from "../ffmpeg";
import { configuredProviders } from "../providerRouting";
import { storageDeletePrefix, storageGetBuffer, storageMode, storagePut } from "../storage";
import { workInProgress } from "./workload";

type Check = { ok: boolean; ms: number; detail?: string; error?: string };

async function timed(work: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await work();
    return { ok: true, ms: Date.now() - started, detail };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether the app can actually work, checked for real rather than assumed:
 * the database answers (with its migrations applied), a file can be stored,
 * read back and deleted, and ffmpeg runs. The Worker's `/api/__health`
 * reports this, so a deploy can be confirmed without signing in.
 */
export async function healthReport() {
  const database = await timed(async () => {
    const db = await getDb();
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(users);
    return `${await databaseKind()}, ${row?.count ?? 0} user(s)`;
  });
  const storage = await timed(async () => {
    const probe = Buffer.from(`bookx health check ${new Date().toISOString()}`);
    const stored = await storagePut("bookx/__health/probe.txt", probe, "text/plain");
    const readBack = await storageGetBuffer(stored.key, { timeoutMs: 30_000 });
    await storageDeletePrefix("bookx/__health/");
    if (!readBack.equals(probe)) throw new Error("The stored file came back different");
    return storageMode();
  });
  const ffmpeg = await timed(async () => {
    const found = await resolveFfmpeg();
    if (!found) throw new Error("ffmpeg was not found");
    return found;
  });
  return {
    ok: database.ok && storage.ok && ffmpeg.ok,
    checks: { database, storage, ffmpeg },
    providers: configuredProviders(),
    work: workInProgress(),
    node: process.version,
  };
}
