import { attachmentDisposition } from "../shared/contentDisposition";
import { isSafeStorageKey, projectIdFromKey } from "../shared/storageKeys";

/**
 * The container's way into D1 and R2.
 *
 * The app in the container talks plain HTTP to two virtual hosts, `d1.bookx`
 * and `r2.bookx`; the Container class routes those requests here, inside the
 * Workers runtime, where the bindings live. The other ends of these protocols
 * are server/sqlTransport.ts (HttpTransport) and server/storage.ts (r2 mode).
 */

const json = (body: unknown, status = 200) => Response.json(body, { status });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

type SqlMethod = "run" | "all" | "values" | "get";
type SqlQuery = { sql: string; params: unknown[]; method: SqlMethod };

function prepare(db: D1Database, query: SqlQuery): D1PreparedStatement {
  const statement = db.prepare(query.sql);
  return query.params?.length ? statement.bind(...query.params) : statement;
}

/** Rows as arrays, the shape drizzle's sqlite-proxy driver expects; `get` is one row or null. */
function shapeRows(method: SqlMethod, rows: unknown[][]) {
  if (method === "run") return { rows: [] };
  return { rows: method === "get" ? (rows[0] ?? null) : rows };
}

/**
 * `POST /query {sql, params, method}` → `{rows}`
 * `POST /batch {queries}` → `{results: [{rows}]}`, atomically
 * `POST /migrate {statements}` → `{ok}`, atomically
 * Errors come back as `{error}` with status 500.
 */
export async function handleD1(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/query") {
      const query = (await request.json()) as SqlQuery;
      if (query.method === "run") {
        await prepare(db, query).run();
        return json({ rows: [] });
      }
      return json(shapeRows(query.method, await prepare(db, query).raw()));
    }
    if (pathname === "/batch") {
      const { queries } = (await request.json()) as { queries: SqlQuery[] };
      if (!queries.length) return json({ results: [] });
      const results = await db.batch(queries.map(query => prepare(db, query)));
      // A batch has no raw mode; drizzle's own D1 driver maps rows the same way.
      return json({
        results: results.map((result, index) =>
          shapeRows(queries[index]!.method, (result.results ?? []).map(row => Object.values(row as Record<string, unknown>))),
        ),
      });
    }
    if (pathname === "/migrate") {
      const { statements } = (await request.json()) as { statements: string[] };
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: message(error) }, 500);
  }
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

/** Only the app's own layout, `bookx/{projectId}/…`, is readable or writable. */
const isAppKey = (key: string) => isSafeStorageKey(key) && projectIdFromKey(key) !== null;

/** A whole "folder" of the app's layout, such as `bookx/{projectId}/`. */
const isAppPrefix = (prefix: string) => prefix.endsWith("/") && isAppKey(`${prefix}x`);

/**
 * A body R2 accepts as a stream, which needs its length up front. The app
 * always sends Content-Length, so nothing is buffered; the fallback is for
 * a request without one (never more than one 50 MiB part).
 */
async function sizedBody(request: Request): Promise<ReadableStream | ArrayBuffer> {
  const length = Number(request.headers.get("content-length"));
  if (request.body && Number.isSafeInteger(length) && length > 0) {
    const { readable, writable } = new FixedLengthStream(length);
    request.body.pipeTo(writable).catch(() => undefined);
    return readable;
  }
  return request.arrayBuffer();
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  // Always list from the start: each page is deleted before the next is read.
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (!page.objects.length) return deleted;
    await bucket.delete(page.objects.map(object => object.key));
    deleted += page.objects.length;
    if (!page.truncated) return deleted;
  }
}

function resolveRange(range: R2Range | undefined, size: number): { start: number; end: number } | null {
  if (!range) return null;
  if ("suffix" in range && typeof range.suffix === "number") {
    const length = Math.min(range.suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const { offset, length } = range as { offset?: number; length?: number };
  const start = offset ?? 0;
  const end = Math.min(size, start + (length ?? size - start)) - 1;
  return end >= start ? { start, end } : null;
}

/**
 * An R2 object as an HTTP response, honouring Range (so `<audio>` can seek and
 * downloads can resume) and conditional headers.
 */
export async function objectResponse(bucket: R2Bucket, key: string, request: Request, options: { download?: string | null } = {}): Promise<Response> {
  const wantsRange = request.headers.has("range");
  let object: R2Object | R2ObjectBody | null;
  try {
    object = request.method === "HEAD" ? await bucket.head(key) : await bucket.get(key, { range: request.headers, onlyIf: request.headers });
  } catch (error) {
    if (!wantsRange) throw error;
    // An unsatisfiable range.
    const head = await bucket.head(key);
    if (!head) return new Response("Not found", { status: 404 });
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
  }
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-cache");
  if (options.download) headers.set("content-disposition", attachmentDisposition(options.download));

  if (request.method === "HEAD") {
    headers.set("content-length", String(object.size));
    return new Response(null, { status: 200, headers });
  }
  if (!("body" in object)) {
    // A precondition in the request did not hold.
    const notModified = request.headers.has("if-none-match") || request.headers.has("if-modified-since");
    return new Response(null, { status: notModified ? 304 : 412, headers });
  }
  const { body } = object as R2ObjectBody;
  const range = wantsRange ? resolveRange(object.range, object.size) : null;
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${object.size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(body, { status: 200, headers });
}

/**
 * `GET|HEAD /object?key=` (Range and conditionals pass through)
 * `PUT /object?key=` → `{key, bytes}`
 * `DELETE /prefix?prefix=` → `{deleted}`
 * `POST /multipart/create?key=` → `{uploadId}`
 * `PUT /multipart/part?key=&uploadId=&part=` → `{partNumber, etag}`
 * `POST /multipart/complete?key=&uploadId= {parts}` → `{key, bytes}`
 * `POST /multipart/abort?key=&uploadId=` → `{ok}`
 */
export async function handleR2(request: Request, bucket: R2Bucket): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "DELETE /prefix") {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!isAppPrefix(prefix)) return json({ error: "Refusing an unsafe prefix" }, 400);
      return json({ deleted: await deletePrefix(bucket, prefix) });
    }

    const key = url.searchParams.get("key") ?? "";
    if (!isAppKey(key)) return json({ error: "Refusing an unsafe key" }, 400);
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    const uploadId = url.searchParams.get("uploadId") ?? "";

    switch (route) {
      case "GET /object":
      case "HEAD /object":
        // Awaited so a failure lands in the catch below as a JSON error.
        return await objectResponse(bucket, key, request);
      case "PUT /object": {
        const stored = await bucket.put(key, await sizedBody(request), { httpMetadata: { contentType } });
        return json({ key, bytes: stored?.size ?? 0 });
      }
      case "POST /multipart/create": {
        const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
        return json({ uploadId: upload.uploadId });
      }
      case "PUT /multipart/part": {
        const partNumber = Number(url.searchParams.get("part"));
        if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) return json({ error: "Bad part" }, 400);
        const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, await sizedBody(request));
        return json({ partNumber: part.partNumber, etag: part.etag });
      }
      case "POST /multipart/complete": {
        const { parts } = (await request.json()) as { parts: R2UploadedPart[] };
        const object = await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
        return json({ key, bytes: object.size });
      }
      case "POST /multipart/abort": {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
        return json({ ok: true });
      }
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: message(error) }, 500);
  }
}
