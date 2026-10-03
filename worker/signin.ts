import { jwtVerify, SignJWT } from "jose";
import { UNAUTHED_ERR_MSG } from "../shared/const";

/**
 * Email + password sign-in for the hosted app, checked by the Worker.
 *
 * Set `BOOKX_SIGNIN_EMAIL` and `BOOKX_SIGNIN_PASSWORD_HASH` (made with
 * `node scripts/signin-hash.mjs`) as Worker secrets and the sign-in page
 * works on Cloudflare too, alongside or instead of Cloudflare Access. Only a
 * salted PBKDF2 hash of the password is stored.
 *
 * A successful sign-in sets a signed, HttpOnly session cookie. The Worker
 * treats a valid one exactly like an Access login: the app container never
 * sees the cookie, only the trusted identity headers the Worker adds.
 */

export const SESSION_COOKIE = "bookx_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_AUDIENCE = "bookx-session";
/** The Workers runtime refuses PBKDF2 above this many iterations. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
const MAX_PASSWORD_LENGTH = 1_024;

export type SigninSecrets = {
  /** The one account's email. */
  BOOKX_SIGNIN_EMAIL?: string;
  /** `pbkdf2-sha256$<iterations>$<salt>$<hash>`, base64url, from `node scripts/signin-hash.mjs`. */
  BOOKX_SIGNIN_PASSWORD_HASH?: string;
};

export type SigninSettings = {
  email: string;
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
  /** The configured hash as written, so a new password signs every session out. */
  raw: string;
};

const encoder = new TextEncoder();

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time for equal lengths; a length mismatch is not a secret here. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/** The configured account, or null when password sign-in is not set up (or the hash is malformed). */
export function signinSettings(env: SigninSecrets): SigninSettings | null {
  const email = (env.BOOKX_SIGNIN_EMAIL ?? "").trim().toLowerCase();
  const raw = (env.BOOKX_SIGNIN_PASSWORD_HASH ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  const parts = raw.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_MAX_ITERATIONS) return null;
  const salt = fromBase64Url(parts[2]!);
  const hash = fromBase64Url(parts[3]!);
  if (!salt || !hash || salt.length < 16 || hash.length < 32) return null;
  return { email, iterations, salt, hash, raw };
}

async function passwordMatches(password: string, settings: SigninSettings): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: settings.salt, iterations: settings.iterations },
    key,
    settings.hash.length * 8,
  );
  return sameBytes(new Uint8Array(bits), settings.hash);
}

/** The cookie's signing key, derived from the internal secret so no extra secret is needed. */
const signingKeys = new Map<string, Uint8Array>();
async function sessionKey(secret: string): Promise<Uint8Array> {
  let key = signingKeys.get(secret);
  if (!key) {
    key = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`bookx-signin-session-v1\n${secret}`)));
    signingKeys.clear();
    signingKeys.set(secret, key);
  }
  return key;
}

/** A short fingerprint of the configured hash: changing the password ends every session. */
async function passwordVersion(settings: SigninSettings): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(settings.raw))).slice(0, 12));
}

const cookieHeader = (value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** `Set-Cookie` that ends the session. */
export const clearedSessionCookie = () => cookieHeader("", 0);

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/** The signed-in email from a valid session cookie, or null. */
export async function sessionEmail(request: Request, settings: SigninSettings | null, secret: string | null): Promise<string | null> {
  if (!settings || !secret) return null;
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await sessionKey(secret), { algorithms: ["HS256"], audience: SESSION_AUDIENCE });
    if (payload.sub !== settings.email || payload.pv !== (await passwordVersion(settings))) return null;
    return settings.email;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Too many attempts: the account's rate limiter, plus a lockout per isolate.
// ---------------------------------------------------------------------------

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

function lockedOut(ip: string): boolean {
  const entry = failures.get(ip);
  return Boolean(entry && Date.now() <= entry.resetAt && entry.count >= MAX_FAILURES);
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now > entry.resetAt) failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  else entry.count += 1;
  if (failures.size > 10_000) failures.clear();
}

const noStore = { "cache-control": "no-store" } as const;

/**
 * `POST /api/auth/login {email, password}`: the sign-in page's request. A
 * vague 401 on any mismatch, so the reply does not say which field was wrong.
 */
export async function handleSignin(request: Request, settings: SigninSettings | null, secret: string | null, limiter?: RateLimit): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: noStore });
  if (!settings || !secret) return Response.json({ error: "Sign-in is not configured on this server." }, { status: 503, headers: noStore });

  const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const tooMany = () => Response.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers: { ...noStore, "retry-after": "60" } });
  if (lockedOut(ip)) return tooMany();
  if (limiter && !(await limiter.limit({ key: `signin:${ip}` })).success) return tooMany();

  let body: { email?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An unreadable body is the same as an empty one.
  }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return Response.json({ error: "Email and password are required." }, { status: 400, headers: noStore });

  // The hash runs whatever the email, so a wrong email takes as long as a wrong password.
  const passwordOk = password.length <= MAX_PASSWORD_LENGTH && (await passwordMatches(password, settings));
  const emailOk = sameBytes(encoder.encode(email), encoder.encode(settings.email));
  if (!emailOk || !passwordOk) {
    recordFailure(ip);
    console.warn("[Bookx] Sign-in refused", { ip });
    return Response.json({ error: "Incorrect email or password." }, { status: 401, headers: noStore });
  }

  failures.delete(ip);
  const token = await new SignJWT({ pv: await passwordVersion(settings) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(settings.email)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_SECONDS)
    .sign(await sessionKey(secret));
  return Response.json(
    { user: { name: settings.email.split("@")[0], email: settings.email } },
    { headers: { ...noStore, "set-cookie": cookieHeader(token, SESSION_SECONDS) } },
  );
}

// ---------------------------------------------------------------------------
// What the app's API answers a signed-out visitor
// ---------------------------------------------------------------------------

/** The tRPC procedures in a `/api/trpc/{a},{b}` path. */
export function trpcProcedures(url: URL): string[] {
  try {
    return decodeURIComponent(url.pathname.slice("/api/trpc/".length)).split(",").map(name => name.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The app's own answers for a signed-out visitor, given without waking the
 * container: `auth.me` is null, `auth.logout` and `system.health` succeed,
 * and every other procedure is UNAUTHORIZED with the message that sends the
 * web app to its sign-in page. Results use superjson's `{ json }` envelope and
 * tRPC's batch format, exactly as the app's router would reply.
 */
export function signedOutTrpcResponse(url: URL): Response {
  const procedures = trpcProcedures(url);
  if (!procedures.length) return Response.json({ error: "Not found" }, { status: 404, headers: noStore });
  const items = procedures.map(path => {
    if (path === "auth.me") return { result: { data: { json: null } } };
    if (path === "auth.logout") return { result: { data: { json: { success: true } } } };
    if (path === "system.health") return { result: { data: { json: { ok: true } } } };
    return { error: { json: { message: UNAUTHED_ERR_MSG, code: -32001, data: { code: "UNAUTHORIZED", httpStatus: 401, path } } } };
  });
  const failed = items.filter(item => "error" in item).length;
  const status = failed === 0 ? 200 : failed === items.length ? 401 : 207;
  const batched = url.searchParams.get("batch") === "1";
  const headers: Record<string, string> = { ...noStore };
  if (procedures.includes("auth.logout")) headers["set-cookie"] = clearedSessionCookie();
  return Response.json(batched ? items : items[0], { status, headers });
}
