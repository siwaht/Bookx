/**
 * Environment loading, resolved relative to this file rather than to the
 * current working directory.
 *
 * `import 'dotenv/config'` reads `.env` from `process.cwd()`. In development the
 * server starts via `npm run dev --workspace=server`, so cwd is `server/` and
 * the repo-root `.env` — the one `.env.example` and the README tell you to
 * create — was silently ignored. Keys appeared to be configured but never
 * reached the process.
 *
 * Files are loaded most-specific first. dotenv does not overwrite variables that
 * are already set, so `server/.env` wins over the repo-root `.env`, and real
 * environment variables (Docker, CI, hosting platforms) win over both.
 *
 * This module must be imported before anything that reads `process.env` at
 * module scope; ES modules evaluate imports in order, so importing it first in
 * `index.ts` is enough.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

// Same relative depth from `src/` and from the compiled `dist/`.
const candidates = [
  path.resolve(here, '..', '.env'), // server/.env
  path.resolve(here, '..', '..', '.env'), // repo root .env
  path.resolve(process.cwd(), '.env'), // cwd, for container images
];

const loaded: string[] = [];
const seen = new Set<string>();

for (const file of candidates) {
  if (seen.has(file)) continue;
  seen.add(file);
  if (!fs.existsSync(file)) continue;
  const result = dotenv.config({ path: file });
  if (!result.error) loaded.push(file);
}

/** Absolute paths of the .env files that were read, for startup diagnostics. */
export const loadedEnvFiles = loaded;
