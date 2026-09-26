import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import { sdk } from "./sdk";

/**
 * One-click sign-in for a local checkout.
 *
 * Manus OAuth only works on the hosted app, so a developer running Bookx on
 * their own machine had no way to reach any persisted feature. This route signs
 * in a fixed local user instead.
 *
 * It is a deliberate backdoor and is fenced accordingly: it only exists when
 * `BOOKX_DEV_LOGIN=1` *and* the process is not running in production.
 */
export function devLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOOKX_DEV_LOGIN === "1" && env.NODE_ENV !== "production";
}

export const DEV_USER_OPEN_ID = "local-dev-user";
const DEV_USER_NAME = "Local creator";

/** Only same-site relative paths, so the route cannot be used as an open redirect. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export function registerDevLoginRoutes(app: Express) {
  if (!devLoginEnabled()) return;

  console.warn("[Auth] Local dev sign-in is enabled at /api/dev/login (BOOKX_DEV_LOGIN=1). Never enable this in production.");

  app.get("/api/dev/login", async (req: Request, res: Response) => {
    try {
      await db.upsertUser({
        openId: DEV_USER_OPEN_ID,
        name: DEV_USER_NAME,
        email: null,
        loginMethod: "dev",
        lastSignedIn: new Date(),
      });
      const token = await sdk.signSession({
        openId: DEV_USER_OPEN_ID,
        // `verifySession` requires a non-empty appId, which a local checkout
        // without Manus OAuth does not have.
        appId: ENV.appId || "bookx-local",
        name: DEV_USER_NAME,
      });
      res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
      res.redirect(302, safeReturnPath(req.query.returnTo));
    } catch (error) {
      console.error("[Auth] Dev sign-in failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Dev sign-in failed" });
    }
  });
}
