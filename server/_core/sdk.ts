import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

/**
 * Sessions for the one Prosecast account.
 *
 * A successful sign-in (server/_core/passwordAuth.ts) mints an HS256 token
 * signed with `JWT_SECRET` and stores it in the session cookie; every request
 * verifies it and loads the account row. There is no external OAuth service
 * any more — the account's email and password live in the environment.
 */

// `verifySession` runs on every request, so a config warning must not repeat
// once per call.
const warnedMessages = new Set<string>();
const warnOnce = (message: string) => {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(message);
};

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

class SDKServer {
  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    // `ENV.cookieSecret` defaults to "" when JWT_SECRET is unset, and jose then
    // fails deep inside signing with "Zero-length key is not supported" — which
    // surfaces as an opaque 500 on sign-in and a silent auth failure on every
    // request. Name the actual cause instead.
    if (!secret) {
      throw new Error(
        "JWT_SECRET is not configured, so session tokens cannot be signed or verified. Set JWT_SECRET in your environment."
      );
    }
    if (secret.length < 32) {
      warnOnce(
        `[Auth] JWT_SECRET is only ${secret.length} characters. Use at least 32 for HS256.`
      );
    }
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for the account
   * @example
   * const sessionToken = await sdk.createSessionToken(openId);
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId || "bookx",
        name: options.name || "",
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<{ openId: string; appId: string; name: string } | null> {
    if (!cookieValue) {
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name } = payload as Record<string, unknown>;

      if (
        !isNonEmptyString(openId) ||
        !isNonEmptyString(appId) ||
        !isNonEmptyString(name)
      ) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      return {
        openId,
        appId,
        name,
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<User> {
    // 1. Prefer the session cookie (the sign-in page).
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);

    // 2. Fallback to the Authorization header, used when the browser blocks
    //    iframe cookies (Safari ITP, private browsing, iOS/Android WebView).
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }

    const session = await this.verifySession(sessionToken);

    if (!session) {
      throw new Error("Invalid session cookie");
    }

    const user = await db.getUserByOpenId(session.openId);
    if (!user) {
      throw new Error("User not found");
    }

    // Refresh `lastSignedIn` at most once per window so a purely informational
    // column does not cost a database write on every single authenticated call.
    if (shouldRefreshLastSignedIn(user.openId)) {
      await db.upsertUser({
        openId: user.openId,
        lastSignedIn: new Date(),
      });
    }

    return user;
  }
}

const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;
const LAST_SEEN_CACHE_LIMIT = 10_000;
const lastSeenWrites = new Map<string, number>();

function shouldRefreshLastSignedIn(openId: string) {
  const timestamp = Date.now();
  const previous = lastSeenWrites.get(openId);
  if (previous !== undefined && timestamp - previous < LAST_SEEN_REFRESH_MS) {
    return false;
  }
  // Bound the cache so a long-lived process cannot grow it without limit;
  // dropping entries only costs one extra write.
  if (lastSeenWrites.size >= LAST_SEEN_CACHE_LIMIT) lastSeenWrites.clear();
  lastSeenWrites.set(openId, timestamp);
  return true;
}

export const sdk = new SDKServer();
