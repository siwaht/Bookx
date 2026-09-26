import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { User } from "../../drizzle/schema";
import { accessOpenId, PROXY_HEADERS } from "../../shared/proxyHeaders";
import * as db from "../db";
import { sdk } from "./sdk";

export { PROXY_HEADERS } from "../../shared/proxyHeaders";

/**
 * Who is making a request.
 *
 * On Cloudflare the app runs behind a Worker that has already checked the
 * visitor's Cloudflare Access login. The Worker forwards the verified identity
 * in `X-Bookx-User-*` headers together with a shared secret, and the app is
 * started with `BOOKX_TRUST_PROXY_AUTH=1` so it accepts them. Nothing but the
 * Worker can reach the app there, and the secret stops a forged header from
 * working even if something could.
 *
 * Everywhere else (a local checkout) the session cookie is used, as before.
 */

export class UnauthenticatedError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export const trustsProxyAuth = () => process.env.BOOKX_TRUST_PROXY_AUTH === "1";

/** Constant-time comparison; an unset or short secret never matches anything. */
export function sameSecret(given: string, expected: string): boolean {
  if (expected.length < 32) return false;
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const header = (req: Request, name: string): string => {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
};

/** Seen recently, so `lastSignedIn` is not rewritten on every API call. */
const recentlySeen = new Map<string, number>();
const SEEN_REFRESH_MS = 5 * 60_000;

async function authenticateProxied(req: Request): Promise<User> {
  const expected = process.env.BOOKX_INTERNAL_SECRET ?? "";
  if (expected.length < 32) throw new UnauthenticatedError("BOOKX_INTERNAL_SECRET is not configured");
  if (!sameSecret(header(req, PROXY_HEADERS.secret), expected)) throw new UnauthenticatedError("Request did not come through the Bookx Worker");

  const email = header(req, PROXY_HEADERS.email).toLowerCase();
  if (!email || !email.includes("@")) throw new UnauthenticatedError("No Cloudflare Access identity on the request");
  const openId = accessOpenId(email);
  let name = email.split("@")[0]!;
  try {
    name = decodeURIComponent(header(req, PROXY_HEADERS.name)).slice(0, 200) || name;
  } catch {
    // A malformed name is not worth refusing the request over.
  }

  let user = await db.getUserByOpenId(openId);
  const last = recentlySeen.get(openId) ?? 0;
  if (!user || Date.now() - last > SEEN_REFRESH_MS) {
    await db.upsertUser({ openId, email, name: user?.name || name, loginMethod: "cloudflare-access", lastSignedIn: new Date() });
    recentlySeen.set(openId, Date.now());
    if (recentlySeen.size > 1_000) recentlySeen.clear();
    user = await db.getUserByOpenId(openId);
  }
  if (!user) throw new UnauthenticatedError("User could not be created");
  return user;
}

/** The signed-in user, or an error when there is none. */
export async function authenticateRequest(req: Request): Promise<User> {
  if (trustsProxyAuth()) return authenticateProxied(req);
  return sdk.authenticateRequest(req);
}
