import { config } from "dotenv";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The server loads its configuration via `import "dotenv/config"` in
// `server/_core/index.ts`, which never runs under vitest. Without this, the
// integration tests below see an empty `process.env` and fail on a missing
// credential that is in fact configured in `.env`.
config({ path: path.resolve(import.meta.dirname, "..", ".env") });

// Every test process gets its own throwaway SQLite database (the same schema
// and driver as D1 in production), so tests never touch the development data
// and never depend on a database server.
const testDatabase = path.join(os.tmpdir(), `bookx-test-${process.pid}.sqlite`);
process.env.BOOKX_SQLITE_PATH = testDatabase;
process.env.BOOKX_LOCAL_STORAGE_DIR = path.join(os.tmpdir(), `bookx-test-storage-${process.pid}`);
// Cloudflare settings from the shell must not redirect tests to a live D1 or
// R2 (the R2 client tests point BOOKX_STORAGE_URL at their own stand-in).
for (const name of ["BOOKX_DB_URL", "BOOKX_STORAGE_URL", "BOOKX_TRUST_PROXY_AUTH", "BOOKX_CONTAINER"]) delete process.env[name];

process.on("exit", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${testDatabase}${suffix}`, { force: true });
    } catch {
      // Still open on Windows; the temp folder is cleaned up eventually.
    }
  }
  try {
    rmSync(process.env.BOOKX_LOCAL_STORAGE_DIR!, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});
