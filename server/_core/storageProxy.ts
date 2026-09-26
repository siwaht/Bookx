import { and, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { bookxProjects } from "../../drizzle/schema";
import { getDb } from "../db";
import { attachmentDisposition } from "../../shared/contentDisposition";
import { projectIdFromKey } from "../../shared/storageKeys";
import { isSafeStorageKey, localObject, r2ObjectResponse, storageMode } from "../storage";
import { authenticateRequest } from "./authenticate";
import { ENV } from "./env";

/**
 * Resolves whether the caller may read `key`.
 *
 * The route used to hand a presigned URL to anyone who knew a key. Keys are hard
 * to guess, but they end up in logs, browser history and shared links, so the
 * session is now checked against the project that owns the object.
 */
async function authorize(req: Request, key: string): Promise<"ok" | "unauthenticated" | "forbidden"> {
  const projectId = projectIdFromKey(key);
  if (!projectId) return "forbidden";

  let userId: number;
  try {
    const user = await authenticateRequest(req);
    userId = user.id;
  } catch {
    return "unauthenticated";
  }

  const db = await getDb();
  if (!db) return "forbidden";
  const [project] = await db
    .select({ id: bookxProjects.id })
    .from(bookxProjects)
    .where(and(eq(bookxProjects.id, projectId), eq(bookxProjects.ownerId, userId)))
    .limit(1);
  return project ? "ok" : "forbidden";
}

async function serveLocal(req: Request, res: Response, key: string) {
  const object = await localObject(key);
  if (!object) {
    res.status(404).send("Not found");
    return;
  }
  res.set("Cache-Control", "private, no-cache");
  if (req.query.download === "1") {
    const name = typeof req.query.name === "string" && req.query.name.trim() ? req.query.name : path.basename(object.path);
    res.set("Content-Disposition", attachmentDisposition(name));
  }
  // sendFile handles Range requests, which `<audio>` needs for seeking.
  res.sendFile(object.path, { dotfiles: "deny" }, error => {
    if (error && !res.headersSent) res.status(500).send("Storage read error");
  });
}

/** Response headers worth passing on from R2 to the browser. */
const R2_PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"] as const;

/**
 * On Cloudflare the Worker answers `/manus-storage/*` itself; this path serves
 * the same objects when a request reaches the container anyway.
 */
async function serveR2(req: Request, res: Response, key: string) {
  const forwarded: Record<string, string> = {};
  for (const name of ["range", "if-none-match", "if-modified-since", "if-range"] as const) {
    const value = req.headers[name];
    if (typeof value === "string" && value) forwarded[name] = value;
  }
  const upstream = await r2ObjectResponse(key, forwarded);
  if (upstream.status === 404) {
    await upstream.body?.cancel();
    res.status(404).send("Not found");
    return;
  }
  res.status(upstream.status);
  for (const name of R2_PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.set("Cache-Control", "private, no-cache");
  if (req.query.download === "1") {
    const name = typeof req.query.name === "string" && req.query.name.trim() ? req.query.name : path.posix.basename(key);
    res.set("Content-Disposition", attachmentDisposition(name));
  }
  if (!upstream.body || req.method === "HEAD") {
    await upstream.body?.cancel();
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream)
    .on("error", error => {
      console.error("[StorageProxy] R2 stream failed:", error);
      res.destroy(error);
    })
    .pipe(res);
}

async function serveForge(res: Response, key: string) {
  const forgeUrl = new URL("v1/storage/presign/get", ENV.forgeApiUrl.replace(/\/+$/, "") + "/");
  forgeUrl.searchParams.set("path", key);

  const forgeResp = await fetch(forgeUrl, {
    headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
  });

  if (!forgeResp.ok) {
    const body = await forgeResp.text().catch(() => "");
    console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
    res.status(502).send("Storage backend error");
    return;
  }

  const { url } = (await forgeResp.json()) as { url: string };
  if (!url) {
    res.status(502).send("Empty signed URL from backend");
    return;
  }

  res.set("Cache-Control", "no-store");
  res.redirect(307, url);
}

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key || !isSafeStorageKey(key)) {
      res.status(400).send("Missing or invalid storage key");
      return;
    }

    let mode: ReturnType<typeof storageMode>;
    try {
      mode = storageMode();
    } catch {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      const access = await authorize(req, key);
      if (access === "unauthenticated") {
        res.status(401).send("Sign in to play this audio");
        return;
      }
      if (access === "forbidden") {
        res.status(403).send("Not allowed");
        return;
      }

      if (mode === "r2") await serveR2(req, res, key);
      else if (mode === "local") await serveLocal(req, res, key);
      else await serveForge(res, key);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      if (!res.headersSent) res.status(502).send("Storage proxy error");
    }
  });
}
