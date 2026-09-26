import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { ExportDetail } from "../drizzle/schema";
import { exportZipPlan } from "../shared/exportZip";
import { accessOpenId, PROXY_HEADERS } from "../shared/proxyHeaders";
import { isSafeStorageKey, projectIdFromKey } from "../shared/storageKeys";
import { zipResponse } from "../server/zipStream";
import { objectResponse } from "./bindings";

/**
 * The Bookx Worker's request handling, shared by the real entry (worker/index.ts,
 * which forwards to the app container) and the local test bridge
 * (worker/dev-bridge.ts, which forwards to an app process on this machine).
 *
 * - The web app is static assets, served by the platform.
 * - Every `/api/*` and `/manus-storage/*` request comes here first. Cloudflare
 *   Access has already signed the visitor in; the Worker checks the Access
 *   token itself (see Identity below), and without a valid Access identity
 *   nothing is served (fail closed).
 * - Audio and export files stream straight from R2 after an ownership check
 *   against D1, and so do export ZIPs, so playback and downloads never wait
 *   on the container.
 * - Everything else goes to the Node app, with the visitor's identity in
 *   trusted headers.
 */

/** Optional provider keys, set with `wrangler secret put` when wanted. */
export const PROVIDER_SECRETS = [
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "FISH_AUDIO_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_GATEWAY_ID",
] as const;

export type BookxSecrets = {
  BOOKX_INTERNAL_SECRET?: string;
  /** The Zero Trust team domain, e.g. `https://myteam.cloudflareaccess.com` (or just `myteam`). */
  ACCESS_TEAM_DOMAIN?: string;
  /** The AUD tag of the Access application protecting the Worker (comma-separated for several). */
  ACCESS_AUD?: string;
} & Partial<Record<(typeof PROVIDER_SECRETS)[number], string>>;

/** The bindings every Bookx Worker entry has. */
export type BookxBindings = { DB: D1Database; BUCKET: R2Bucket; ASSETS: Fetcher } & BookxSecrets;

/** Sends a request, already carrying the trusted identity headers, to the app. */
export type AppUpstream<E> = (request: Request, env: E) => Promise<Response>;

export function internalSecret(env: BookxSecrets): string | null {
  const secret = env.BOOKX_INTERNAL_SECRET?.trim() ?? "";
  return secret.length >= 32 ? secret : null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
//
// Cloudflare Access signs every visitor in before the Worker runs. A Worker
// with static assets runs behind Cloudflare's asset router, which does not
// pass `ctx.access` on, so in production the identity comes from the token
// Access adds to each request (the `Cf-Access-Jwt-Assertion` header, or the
// `CF_Authorization` cookie), checked against the team's signing keys and
// this application's AUD tag (ACCESS_TEAM_DOMAIN and ACCESS_AUD).
// `ctx.access` is still used when present: `wrangler dev` simulates it from
// the `access.dev` block in wrangler.jsonc.

type Identity = { email: string; name: string; openId: string };

/** Identities by Access token, so the check is not repeated on every request. */
const identities = new Map<string, { identity: Identity; until: number }>();

/** The Access team and application this Worker accepts tokens from, or null if not set. */
export function accessSettings(env: BookxSecrets): { issuer: string; audiences: string[] } | null {
  let host = (env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (host && !host.includes(".")) host = `${host}.cloudflareaccess.com`;
  const audiences = (env.ACCESS_AUD ?? "").split(",").map(aud => aud.trim()).filter(Boolean);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host) || !audiences.length) return null;
  return { issuer: `https://${host}`, audiences };
}

/** Each team's public signing keys; jose caches them and refetches when Access rotates them. */
const teamKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function signingKeys(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let keys = teamKeys.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    teamKeys.set(issuer, keys);
  }
  return keys;
}

/** The Access token on a request: the header Access adds, else its cookie. */
function accessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (header) return header;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === "CF_Authorization") return part.slice(at + 1).trim() || null;
  }
  return null;
}

/** The claims of a token that Access issued for this application, or null. */
async function verifiedClaims(token: string, env: BookxSecrets): Promise<JWTPayload | null> {
  const settings = accessSettings(env);
  if (!settings) return null;
  try {
    const { payload } = await jwtVerify(token, signingKeys(settings.issuer), {
      issuer: settings.issuer,
      audience: settings.audiences,
      algorithms: ["RS256"],
      clockTolerance: 30,
    });
    return payload;
  } catch (error) {
    console.warn("[Bookx] Access token refused:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

function identityFrom(claims: Record<string, unknown> | null | undefined): Identity | null {
  const email = typeof claims?.email === "string" ? claims.email.trim().toLowerCase() : "";
  // Service tokens carry no email; Bookx needs a person.
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  const name = typeof claims?.name === "string" && claims.name.trim() ? claims.name.trim() : email.split("@")[0]!;
  return { email, name, openId: accessOpenId(email) };
}

async function accessIdentity(request: Request, env: BookxSecrets, ctx: ExecutionContext): Promise<Identity | null> {
  const token = accessToken(request);
  const cached = token ? identities.get(token) : undefined;
  if (cached && cached.until > Date.now()) return cached.identity;

  let identity: Identity | null = null;
  let until = Date.now() + 5 * 60_000;
  if (ctx.access) {
    identity = identityFrom(await ctx.access.getIdentity());
  } else if (token) {
    const claims = await verifiedClaims(token, env);
    identity = identityFrom(claims);
    if (typeof claims?.exp === "number") until = Math.min(until, claims.exp * 1000);
  }
  if (identity && token) {
    if (identities.size > 1_000) identities.clear();
    identities.set(token, { identity, until });
  }
  return identity;
}

/** State-changing requests must come from Bookx's own pages. */
function isCrossSite(request: Request, url: URL): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  return Boolean(origin && origin !== url.origin);
}

// ---------------------------------------------------------------------------
// Files from R2
// ---------------------------------------------------------------------------

export const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });

/** Ownership confirmed recently, so seeking through a chapter is one D1 query, not dozens. */
const owned = new Map<string, number>();

async function ownsProject(env: BookxBindings, identity: Identity, projectId: string): Promise<boolean> {
  const cacheKey = `${identity.openId}\n${projectId}`;
  if ((owned.get(cacheKey) ?? 0) > Date.now()) return true;
  const row = await env.DB.prepare("SELECT 1 AS owned FROM bookxProjects p JOIN users u ON u.id = p.ownerId WHERE p.id = ?1 AND u.openId = ?2 LIMIT 1")
    .bind(projectId, identity.openId)
    .first();
  if (!row) return false;
  if (owned.size > 5_000) owned.clear();
  owned.set(cacheKey, Date.now() + 60_000);
  return true;
}

/** `GET /manus-storage/{key}[?download=1&name=…]`: an owned object, straight from R2. */
async function serveStorage(request: Request, env: BookxBindings, url: URL, identity: Identity): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice("/manus-storage/".length));
  } catch {
    return text("Missing or invalid storage key", 400);
  }
  if (!isSafeStorageKey(key)) return text("Missing or invalid storage key", 400);
  const projectId = projectIdFromKey(key);
  if (!projectId || !(await ownsProject(env, identity, projectId))) return text("Not allowed", 403);
  const download = url.searchParams.get("download") === "1" ? url.searchParams.get("name")?.trim() || key.split("/").pop()! : null;
  return objectResponse(env.BUCKET, key, request, { download });
}

/** `GET /api/exports/{exportId}/zip?projectId=…`: every chapter file of a package, zipped as it streams. */
async function serveExportZip(request: Request, env: BookxBindings, url: URL, identity: Identity, exportId: string): Promise<Response> {
  if (request.method !== "GET") return text("Method not allowed", 405);
  const projectId = url.searchParams.get("projectId") ?? "";
  if (!projectId) return text("projectId is required", 400);
  const project = await env.DB.prepare("SELECT p.title AS title FROM bookxProjects p JOIN users u ON u.id = p.ownerId WHERE p.id = ?1 AND u.openId = ?2 LIMIT 1")
    .bind(projectId, identity.openId)
    .first<{ title: string }>();
  if (!project) return text("Project not found", 404);
  const row = await env.DB.prepare("SELECT status, detail, updatedAt FROM bookxExports WHERE id = ?1 AND projectId = ?2 LIMIT 1")
    .bind(exportId, projectId)
    .first<{ status: string; detail: string | null; updatedAt: number }>();
  if (!row) return text("Export not found", 404);
  if (row.status !== "ready") return text("This export is not ready yet", 400);

  const plan = exportZipPlan({ projectTitle: project.title, detail: row.detail ? (JSON.parse(row.detail) as ExportDetail) : null, updatedAt: row.updatedAt });
  if (!plan.entries.length) return text("This package has no chapter files", 404);
  const zip = zipResponse(
    plan.entries.map(entry => ({
      name: entry.name,
      bytes: entry.bytes,
      lastModified: entry.lastModified,
      open: async () => {
        const object = await env.BUCKET.get(entry.storageKey);
        if (!object) throw new Error(`${entry.name} is missing from storage`);
        return object.body;
      },
    })),
    plan.zipName,
  );
  // Workers only send a Content-Length with a streamed body that is declared
  // up front, and the browser needs it to show real download progress.
  const length = Number(zip.headers.get("content-length"));
  if (!zip.body || !Number.isSafeInteger(length) || length <= 0) return zip;
  const { readable, writable } = new FixedLengthStream(length);
  zip.body.pipeTo(writable).catch(error => console.error("[Bookx] ZIP stream failed:", error));
  return new Response(readable, { status: zip.status, headers: zip.headers });
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

/** The request as the app should see it: identity from Access, nothing the visitor could forge. */
function forAppWithIdentity(request: Request, secret: string, identity: Identity): Request {
  const headers = new Headers(request.headers);
  // Nobody outside the Worker may speak for the Worker, and the app needs no cookies.
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-bookx-")) headers.delete(name);
  }
  headers.delete("cookie");
  headers.set(PROXY_HEADERS.secret, secret);
  headers.set(PROXY_HEADERS.email, identity.email);
  headers.set(PROXY_HEADERS.name, encodeURIComponent(identity.name));
  return new Request(request, { headers });
}

/** Constant-time comparison of two secrets. */
function sameSecret(given: string, expected: string): boolean {
  const left = new TextEncoder().encode(given);
  const right = new TextEncoder().encode(expected);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

/**
 * `GET /api/__health` with the internal secret in `x-bookx-internal`: checks
 * that D1 and R2 answer the Worker, and that the app starts and can use the
 * database, storage and ffmpeg. For confirming a deploy; anyone without the
 * secret gets a plain 404.
 */
async function serveHealth<E extends BookxBindings>(request: Request, env: E, upstream: AppUpstream<E>): Promise<Response> {
  const secret = internalSecret(env);
  if (!secret || !sameSecret(request.headers.get(PROXY_HEADERS.secret) ?? "", secret)) return text("Not found", 404);
  const timed = async (work: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      const detail = await work();
      return { ok: true, ms: Date.now() - started, detail };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const d1 = await timed(async () => (await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>())?.ok === 1);
  const r2 = await timed(async () => (await env.BUCKET.head("bookx/__health/none")) === null);
  const app = await timed(async () => {
    const response = await upstream(new Request(new URL("/internal/health", request.url), { headers: { [PROXY_HEADERS.secret]: secret } }), env);
    const report = (await response.json()) as { ok?: boolean };
    if (!report.ok) throw new Error(JSON.stringify(report));
    return report;
  });
  const ok = d1.ok && r2.ok && app.ok;
  return Response.json({ ok, d1, r2, app }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}

export function createBookxHandler<E extends BookxBindings>(upstream: AppUpstream<E>): ExportedHandler<E> {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const url = new URL(request.url);
      const isStorage = url.pathname.startsWith("/manus-storage/");
      if (!isStorage && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (url.pathname === "/api/__health" && request.method === "GET") return serveHealth(request, env, upstream);

      const identity = await accessIdentity(request, env, ctx);
      if (!identity) {
        const connected = Boolean(ctx.access) || accessSettings(env) !== null;
        return text(connected ? "Sign in through Cloudflare Access to use Bookx." : "Bookx is not connected to Cloudflare Access yet.", 401);
      }
      if (isCrossSite(request, url)) return text("Cross-site request refused", 403);

      if (isStorage) return serveStorage(request, env, url, identity);
      const zip = url.pathname.match(/^\/api\/exports\/([A-Za-z0-9_-]+)\/zip$/);
      if (zip) return serveExportZip(request, env, url, identity, zip[1]!);
      // Local-only sign-in routes; Access is the only way in here.
      if (url.pathname.startsWith("/api/dev/") || url.pathname.startsWith("/api/oauth/")) return text("Not found", 404);

      const secret = internalSecret(env);
      if (!secret) return text("Bookx is not set up yet: the BOOKX_INTERNAL_SECRET secret is missing.", 500);
      try {
        return await upstream(forAppWithIdentity(request, secret, identity), env);
      } catch (error) {
        console.error("[Bookx] The app did not answer:", error);
        return text("Bookx is starting up. Try again in a few seconds.", 503, { "retry-after": "5" });
      }
    },
  };
}
