// Storage helpers.
//
// Three backends, one set of keys (`bookx/{projectId}/…`) and one browser URL
// shape (`/manus-storage/{key}`):
//
// - r2: on Cloudflare the app runs in a container, and `BOOKX_STORAGE_URL`
//   points at a virtual host that the container's Worker answers with its R2
//   binding. The Worker also serves `/manus-storage/*` straight from R2, so
//   playback and downloads do not pass through the container.
// - forge: the Manus Forge storage service. Uploads go to S3 through a
//   presigned PUT, and reads are a 307 redirect to a presigned GET.
// - local: a checkout writes objects to disk under `BOOKX_LOCAL_STORAGE_DIR`.
//   Local mode is never chosen silently in production, where an ephemeral
//   container disk would lose a finished book on the next deploy.

import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { isSafeStorageKey } from "../shared/storageKeys";
import { ENV } from "./_core/env";

export { isSafeStorageKey } from "../shared/storageKeys";

export type StorageMode = "r2" | "forge" | "local";

function forgeConfigured(): boolean {
  return Boolean(ENV.forgeApiUrl && ENV.forgeApiKey);
}

/** Base URL of the Worker's R2 handler, when the app runs in the Cloudflare container. */
function r2Base(): string {
  return (process.env.BOOKX_STORAGE_URL ?? "").trim().replace(/\/+$/, "");
}

/**
 * Which backend handles storage right now.
 *
 * R2 wins when the container was given its handler. Local disk is used only
 * when neither R2 nor Forge is configured *and* either this is not a
 * production process or a local directory was configured explicitly.
 */
export function storageMode(): StorageMode {
  if (r2Base()) return "r2";
  if (forgeConfigured()) return "forge";
  if (process.env.NODE_ENV !== "production" || process.env.BOOKX_LOCAL_STORAGE_DIR) return "local";
  throw new Error(
    "Storage config missing: set BOOKX_STORAGE_URL (Cloudflare R2), BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY, or BOOKX_LOCAL_STORAGE_DIR for local disk storage",
  );
}

// ---------------------------------------------------------------------------
// R2, through the container's Worker
// ---------------------------------------------------------------------------

/**
 * Objects up to this size go up in one request; larger ones (a whole-book WAV)
 * in parts of exactly this size, which R2 requires of every part but the last.
 */
export const R2_PART_BYTES = 50 * 1024 * 1024;

const query = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([name, value]) => [name, String(value)])).toString();

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type R2RequestInit = Omit<RequestInit, "signal"> & {
  /** Limit for the whole exchange, body included. */
  timeoutMs?: number;
  /** Limit for the response headers only, for bodies that are streamed onwards. */
  headersTimeoutMs?: number;
  /** Tries in total. Only for requests that are safe to repeat. */
  attempts?: number;
};

/**
 * One request to the Worker's R2 handler. Network failures and 5xx answers are
 * retried when `attempts` allows it; any other answer is returned as-is.
 */
async function r2Request(route: string, init: R2RequestInit = {}): Promise<Response> {
  const { timeoutMs = 120_000, headersTimeoutMs, attempts = 1, ...rest } = init;
  const label = `R2 ${rest.method ?? "GET"} ${route.split("?")[0]}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A streamed body must outlive the header timeout; a buffered one must not
    // outlive `timeoutMs`, which the signal enforces while the body is read.
    const controller = headersTimeoutMs === undefined ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(new Error(`${label} timed out`)), headersTimeoutMs) : undefined;
    try {
      const response = await fetch(`${r2Base()}${route}`, { ...rest, signal: controller?.signal ?? AbortSignal.timeout(timeoutMs) });
      if (response.status < 500) return response;
      lastError = new Error(`${label} failed (HTTP ${response.status}): ${(await response.text().catch(() => "")).slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await pause(300 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function r2Json<T>(route: string, init: R2RequestInit = {}): Promise<T> {
  const response = await r2Request(route, init);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `R2 ${init.method ?? "GET"} ${route.split("?")[0]} failed (HTTP ${response.status})`);
  return payload;
}

// Buffers here are never backed by a SharedArrayBuffer, which is all `BodyInit` objects to.
type Bytes = Uint8Array<ArrayBuffer>;

async function r2PutBytes(key: string, data: Uint8Array, contentType: string): Promise<void> {
  const bytes = data as Bytes;
  if (bytes.byteLength <= R2_PART_BYTES) {
    // Same key, same bytes: repeating a PUT that already landed is harmless.
    await r2Json(`/object?${query({ key })}`, { method: "PUT", headers: { "content-type": contentType }, body: bytes, timeoutMs: 180_000, attempts: 3 });
    return;
  }
  await r2Multipart(key, contentType, bytes.byteLength, async (offset, length) => bytes.subarray(offset, offset + length));
}

async function r2Multipart(key: string, contentType: string, size: number, readPart: (offset: number, length: number) => Promise<Bytes>): Promise<void> {
  const { uploadId } = await r2Json<{ uploadId: string }>(`/multipart/create?${query({ key })}`, { method: "POST", headers: { "content-type": contentType } });
  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let offset = 0, partNumber = 1; offset < size; offset += R2_PART_BYTES, partNumber++) {
      const body = await readPart(offset, Math.min(R2_PART_BYTES, size - offset));
      // Uploading a part number again replaces it, so parts are safe to retry.
      parts.push(await r2Json<{ partNumber: number; etag: string }>(`/multipart/part?${query({ key, uploadId, part: partNumber })}`, { method: "PUT", body, timeoutMs: 300_000, attempts: 3 }));
    }
    await r2Json(`/multipart/complete?${query({ key, uploadId })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts }), timeoutMs: 120_000 });
  } catch (error) {
    await r2Request(`/multipart/abort?${query({ key, uploadId })}`, { method: "POST", timeoutMs: 30_000 }).catch(() => undefined);
    throw error;
  }
}

/**
 * The raw R2 object response (200, 206, 304, 404 or 416), for the container's
 * own `/manus-storage` route. `range` and conditional headers pass through, so
 * `<audio>` can seek.
 */
export async function r2ObjectResponse(relKey: string, headers: Record<string, string> = {}): Promise<Response> {
  return r2Request(`/object?${query({ key: normalizeKey(relKey) })}`, { headers, headersTimeoutMs: 60_000, attempts: 2 });
}

/** Root directory for local-mode objects. */
export function localStorageRoot(): string {
  return path.resolve(process.env.BOOKX_LOCAL_STORAGE_DIR || path.join("data", "storage"));
}

function getForgeConfig() {
  const forgeUrl = ENV.forgeApiUrl;
  const forgeKey = ENV.forgeApiKey;

  if (!forgeUrl || !forgeKey) {
    throw new Error(
      "Storage config missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY",
    );
  }

  return { forgeUrl: forgeUrl.replace(/\/+$/, ""), forgeKey };
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Absolute path for a key in local mode, or null when the key is unsafe. */
export function localPathForKey(relKey: string): string | null {
  const key = normalizeKey(relKey);
  if (!isSafeStorageKey(key)) return null;
  const root = localStorageRoot();
  const resolved = path.resolve(root, ...key.split("/"));
  // Belt and braces: the resolved path must still sit inside the root.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  const lastSlash = relKey.lastIndexOf("/");
  if (lastDot === -1 || lastDot < lastSlash) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const mode = storageMode();

  if (mode === "r2") {
    if (!isSafeStorageKey(key)) throw new Error(`Refusing to store an unsafe key: ${key}`);
    await r2PutBytes(key, typeof data === "string" ? Buffer.from(data) : data, contentType);
    return { key, url: `/manus-storage/${key}` };
  }

  if (mode === "local") {
    const target = localPathForKey(key);
    if (!target) throw new Error(`Refusing to store an unsafe key: ${key}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof data === "string" ? Buffer.from(data) : data);
    return { key, url: `/manus-storage/${key}` };
  }

  const { forgeUrl, forgeKey } = getForgeConfig();

  // 1. Get presigned PUT URL from Forge
  const presignUrl = new URL("v1/storage/presign/put", forgeUrl + "/");
  presignUrl.searchParams.set("path", key);

  const presignResp = await fetch(presignUrl, {
    headers: { Authorization: `Bearer ${forgeKey}` },
  });

  if (!presignResp.ok) {
    const msg = await presignResp.text().catch(() => presignResp.statusText);
    throw new Error(`Storage presign failed (${presignResp.status}): ${msg}`);
  }

  const { url: s3Url } = (await presignResp.json()) as { url: string };
  if (!s3Url) throw new Error("Forge returned empty presign URL");

  // 2. PUT file directly to S3
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([data as any], { type: contentType });

  const uploadResp = await fetch(s3Url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });

  if (!uploadResp.ok) {
    throw new Error(`Storage upload to S3 failed (${uploadResp.status})`);
  }

  return { key, url: `/manus-storage/${key}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/manus-storage/${key}` };
}

/**
 * A URL a *browser* can fetch the object from.
 *
 * Forge returns a presigned S3 URL. R2 and local mode return the app's own
 * storage route, which checks the signed-in user owns the project first.
 */
export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  if (storageMode() !== "forge") return `/manus-storage/${key}`;

  const { forgeUrl, forgeKey } = getForgeConfig();

  const getUrl = new URL("v1/storage/presign/get", forgeUrl + "/");
  getUrl.searchParams.set("path", key);

  const resp = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${forgeKey}` },
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`Storage signed URL failed (${resp.status}): ${msg}`);
  }

  const { url } = (await resp.json()) as { url: string };
  return url;
}

/** A URL that downloads the object under a readable file name instead of playing it. */
export async function storageDownloadUrl(relKey: string, fileName: string): Promise<string> {
  const key = normalizeKey(relKey);
  if (storageMode() !== "forge") return `/manus-storage/${key}?download=1&name=${encodeURIComponent(fileName)}`;
  return storageGetSignedUrl(key);
}

/**
 * Reads an object's bytes on the server.
 *
 * Server code must use this rather than fetching `storageGetSignedUrl`, because
 * in R2 and local mode that URL is relative to the app and only meaningful to a
 * browser.
 */
export async function storageGetBuffer(relKey: string, options: { timeoutMs?: number } = {}): Promise<Buffer> {
  const key = normalizeKey(relKey);
  const mode = storageMode();
  if (mode === "r2") {
    const response = await r2Request(`/object?${query({ key })}`, { timeoutMs: options.timeoutMs ?? 60_000, attempts: 3 });
    if (!response.ok) throw new Error(response.status === 404 ? `Stored object not found: ${key}` : `Stored object could not be read (HTTP ${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (mode === "local") {
    const target = localPathForKey(key);
    if (!target) throw new Error(`Unsafe storage key: ${key}`);
    return readFile(target);
  }
  const url = await storageGetSignedUrl(key);
  const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) });
  if (!response.ok) throw new Error(`Stored object could not be read (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Stores a file from disk without reading it into memory first, for outputs
 * (a whole-book WAV) that can run to gigabytes.
 */
export async function storagePutFile(relKey: string, filePath: string, contentType = "application/octet-stream"): Promise<{ key: string; url: string; bytes: number }> {
  const bytes = (await stat(filePath)).size;
  const mode = storageMode();
  if (mode === "local") {
    const key = appendHashSuffix(normalizeKey(relKey));
    const target = localPathForKey(key);
    if (!target) throw new Error(`Refusing to store an unsafe key: ${key}`);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(filePath, target);
    return { key, url: `/manus-storage/${key}`, bytes };
  }
  if (mode === "r2" && bytes > R2_PART_BYTES) {
    // Read and send one part at a time, so a multi-gigabyte file never sits in memory.
    const key = appendHashSuffix(normalizeKey(relKey));
    if (!isSafeStorageKey(key)) throw new Error(`Refusing to store an unsafe key: ${key}`);
    const file = await open(filePath, "r");
    try {
      await r2Multipart(key, contentType, bytes, async (offset, length) => {
        const part = Buffer.allocUnsafe(length) as Bytes;
        const { bytesRead } = await file.read(part, 0, length, offset);
        if (bytesRead !== length) throw new Error(`${path.basename(filePath)} changed while it was being stored`);
        return part;
      });
    } finally {
      await file.close();
    }
    return { key, url: `/manus-storage/${key}`, bytes };
  }
  const stored = await storagePut(relKey, await readFile(filePath), contentType);
  return { ...stored, bytes };
}

/** An object's bytes as a web stream, for downloads assembled on the server (a ZIP). */
export async function storageGetStream(relKey: string): Promise<ReadableStream<Uint8Array>> {
  const key = normalizeKey(relKey);
  const mode = storageMode();
  if (mode === "local") {
    const target = localPathForKey(key);
    if (!target) throw new Error(`Unsafe storage key: ${key}`);
    return Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  }
  const response = mode === "r2"
    ? await r2Request(`/object?${query({ key })}`, { headersTimeoutMs: 60_000, attempts: 3 })
    : await fetch(await storageGetSignedUrl(key));
  if (!response.ok || !response.body) throw new Error(`Stored object could not be read (HTTP ${response.status})`);
  return response.body;
}

/**
 * Deletes every object under a prefix, e.g. `bookx/{projectId}/` when a project
 * is deleted, so removed books do not keep occupying storage. Returns how many
 * objects were removed where the backend can tell.
 */
export async function storageDeletePrefix(prefix: string): Promise<number> {
  const key = normalizeKey(prefix);
  if (!/^bookx\/[^/]+\//.test(key) || !isSafeStorageKey(key.replace(/\/+$/, ""))) throw new Error(`Refusing to delete an unsafe prefix: ${prefix}`);
  const mode = storageMode();
  if (mode === "r2") {
    // Always a whole "folder": `bookx/p1/` must not also match `bookx/p10/`.
    // Deleting is idempotent, so a retry after a lost answer is harmless.
    const folder = key.endsWith("/") ? key : `${key}/`;
    const { deleted } = await r2Json<{ deleted: number }>(`/prefix?${query({ prefix: folder })}`, { method: "DELETE", timeoutMs: 300_000, attempts: 3 });
    return deleted;
  }
  if (mode === "local") {
    const target = localPathForKey(key.replace(/\/+$/, ""));
    if (!target) return 0;
    await rm(target, { recursive: true, force: true });
    return -1;
  }
  // Forge has no delete endpoint; objects there are left in place.
  return 0;
}

/** Local-mode metadata for streaming, or null when the object does not exist. */
export async function localObject(relKey: string): Promise<{ path: string; size: number; stream: () => NodeJS.ReadableStream } | null> {
  const target = localPathForKey(relKey);
  if (!target) return null;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    return { path: target, size: info.size, stream: () => createReadStream(target) };
  } catch {
    return null;
  }
}
