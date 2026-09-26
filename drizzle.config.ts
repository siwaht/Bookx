import { defineConfig } from "drizzle-kit";

/**
 * Migrations for the SQLite schema that runs on Cloudflare D1 in production
 * and on a local SQLite file in development. `pnpm db:generate` writes a new
 * migration after a schema change; the app applies pending migrations itself
 * the first time it opens the database.
 */
export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/sqlite",
  dialect: "sqlite",
});
