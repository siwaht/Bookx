import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Express, Request, Response } from "express";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { appSettings as settingsTable } from "../../drizzle/schema";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

/**
 * The one account Bookx signs in.
 *
 * There is exactly one user of this app, so there is no user table to manage
 * and no registration: the email and password live in the environment
 * (`BOOKX_SIGNIN_EMAIL`, `BOOKX_SIGNIN_PASSWORD`), and the password is
 * checked with scrypt against a salted hash kept in the database. The hash is
 * stored rather than the password so a leaked database file does not leak the
 * password itself; the salt is regenerated on every successful change.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SESSION_OPEN_ID = "bookx-owner";

/** The account's email, lower-cased so the sign-in is not case-sensitive. */
export function signinEmail(): string {
  return (process.env.BOOKX_SIGNIN_EMAIL ?? "").trim().toLowerCase();
}

/** The account's password, exactly as configured. */
function signinPassword(): string {
  return process.env.BOOKX_SIGNIN_PASSWORD ?? "";
}

export function signinConfigured(): boolean {
  return Boolean(signinEmail().includes("@") && signinPassword());
}

/** `scrypt$<salt-hex>$<hash-hex>`, or null when no password has been set yet. */
async function storedHash(): Promise<string | null> {
  const dbh = await db.getDb();
  const rows = await dbh.select().from(settingsTable).limit(1);
  return rows[0]?.signinHash ?? null;
}

async function hashPassword(password: string, salt?: Buffer): Promise<string> {
  const useSalt = salt ?? randomBytes(16);
  const derived = await scryptAsync(password, useSalt, KEY_LENGTH);
  return `scrypt$${useSalt.toString("hex")}$${derived.toString("hex")}`;
}

/** Constant-time comparison of `password` against a `scrypt$salt$hash` string. */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scryptAsync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Keeps the stored hash in step with the configured password: the first run
 * (or a change of `BOOKX_SIGNIN_PASSWORD`) stores a fresh salted hash, and a
 * match leaves it alone. Called before every sign-in attempt.
 */
async function syncStoredHash(): Promise<void> {
  const password = signinPassword();
  const stored = await storedHash();
  if (stored && (await verifyPassword(password, stored))) return;
  const next = await hashPassword(password);
  const dbh = await db.getDb();
  await dbh
    .insert(settingsTable)
    .values({ id: 1, signinHash: next })
    .onConflictDoUpdate({ target: settingsTable.id, set: { signinHash: next } });
}

/** The single Prosecast account, created or refreshed on first sign-in. */
async function upsertOwner(): Promise<void> {
  const email = signinEmail();
  await db.upsertUser({
    openId: SESSION_OPEN_ID,
    name: email.split("@")[0] || "Prosecast owner",
    email,
    loginMethod: "password",
    lastSignedIn: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Rate limiting: a small in-memory attempt window per IP.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60_000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
  if (attempts.size > 10_000) attempts.clear();
}

function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

const requestIp = (req: Request): string => req.ip ?? "unknown";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerPasswordRoutes(app: Express) {
  // The one sign-in. Returns the user on success; 401 with a vague message on
  // any mismatch, so the response does not reveal which field was wrong.
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const ip = requestIp(req);
      if (tooManyAttempts(ip)) {
        res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
        return;
      }

      if (!signinConfigured()) {
        res.status(500).json({ error: "Sign-in is not configured. Set BOOKX_SIGNIN_EMAIL and BOOKX_SIGNIN_PASSWORD." });
        return;
      }

      const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";

      if (!email || !password) {
        res.status(400).json({ error: "Email and password are required." });
        return;
      }

      await syncStoredHash();
      const stored = await storedHash();
      const emailOk = email === signinEmail();
      const passwordOk = stored ? await verifyPassword(password, stored) : false;

      if (!emailOk || !passwordOk) {
        recordFailedAttempt(ip);
        res.status(401).json({ error: "Incorrect email or password." });
        return;
      }

      clearAttempts(ip);
      await upsertOwner();
      const user = await db.getUserByOpenId(SESSION_OPEN_ID);
      if (!user) {
        res.status(500).json({ error: "The account could not be created." });
        return;
      }

      const token = await sdk.signSession({
        openId: SESSION_OPEN_ID,
        appId: "bookx",
        name: user.name ?? "",
      });
      res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
      res.json({ user: { name: user.name, email: user.email } });
    } catch (error) {
      console.error("[Auth] Sign-in failed", error);
      res.status(500).json({ error: "Sign-in failed. Try again." });
    }
  });

  // Which credentials the client should ask for (never the password itself).
  app.get("/api/auth/config", (_req: Request, res: Response) => {
    res.json({ configured: signinConfigured(), email: signinEmail() || null });
  });
}

/** Exposed for tests. */
export const _internals = { verifyPassword, hashPassword, SESSION_OPEN_ID, createHash };
