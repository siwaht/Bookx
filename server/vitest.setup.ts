import { config } from "dotenv";
import path from "node:path";

// The server loads its configuration via `import "dotenv/config"` in
// `server/_core/index.ts`, which never runs under vitest. Without this, the
// integration tests below see an empty `process.env` and fail on a missing
// credential that is in fact configured in `.env`.
config({ path: path.resolve(import.meta.dirname, "..", ".env") });
