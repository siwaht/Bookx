// Bundles the app server into one file for the Cloudflare container image
// (dist/container/index.mjs), so the image needs no node_modules at all.
//
// Run through `pnpm run build:cloudflare`, which wrangler runs before every
// `wrangler dev` and `wrangler deploy`.

import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist/container", { recursive: true, force: true });

await build({
  entryPoints: ["server/_core/index.ts"],
  outfile: "dist/container/index.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  legalComments: "none",
  // CommonJS dependencies inside an ES module still call require() for Node
  // built-ins; give them one.
  banner: {
    js: "import { createRequire as __bookxCreateRequire } from 'node:module'; const require = __bookxCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});

console.log("Built dist/container/index.mjs");
