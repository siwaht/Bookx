import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { R2_PART_BYTES, storageDeletePrefix, storageDownloadUrl, storageGetBuffer, storageGetSignedUrl, storageGetStream, storageMode, storagePut, storagePutFile } from "./storage";

/**
 * The app side of the R2 protocol (server/storage.ts in r2 mode) against an
 * in-memory stand-in for the Worker's handler (worker/bindings.ts). The real
 * handler is exercised against real R2 by the Cloudflare end-to-end run.
 */

type Upload = { key: string; contentType: string; parts: Map<number, Buffer>; aborted: boolean };

const objects = new Map<string, { body: Buffer; contentType: string }>();
const uploads = new Map<string, Upload>();
const log: string[] = [];
/** Answers to fail with, by route, before the real handling runs. */
const failures = new Map<string, number[]>();

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url!, "http://r2.test");
  const route = `${req.method} ${url.pathname}`;
  log.push(`${route}${url.searchParams.get("part") ? ` part=${url.searchParams.get("part")}` : ""}`);
  const planned = failures.get(route);
  if (planned?.length) {
    const status = planned.shift()!;
    await readBody(req);
    send(res, status, { error: "injected failure" });
    return;
  }
  const key = url.searchParams.get("key") ?? "";
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const body = await readBody(req);
  switch (route) {
    case "PUT /object":
      if (Number(req.headers["content-length"]) !== body.length) return send(res, 400, { error: "content-length is required" });
      objects.set(key, { body, contentType: String(req.headers["content-type"]) });
      return send(res, 200, { key, bytes: body.length });
    case "GET /object": {
      const object = objects.get(key);
      if (!object) return send(res, 404, { error: "Not found" });
      res.writeHead(200, { "content-type": object.contentType, "content-length": object.body.length });
      res.end(object.body);
      return;
    }
    case "DELETE /prefix": {
      const prefix = url.searchParams.get("prefix")!;
      let deleted = 0;
      for (const stored of [...objects.keys()]) {
        if (stored.startsWith(prefix)) {
          objects.delete(stored);
          deleted++;
        }
      }
      return send(res, 200, { deleted });
    }
    case "POST /multipart/create": {
      const id = `upload-${uploads.size + 1}`;
      uploads.set(id, { key, contentType: String(req.headers["content-type"]), parts: new Map(), aborted: false });
      return send(res, 200, { uploadId: id });
    }
    case "PUT /multipart/part": {
      const upload = uploads.get(uploadId)!;
      const partNumber = Number(url.searchParams.get("part"));
      upload.parts.set(partNumber, body);
      return send(res, 200, { partNumber, etag: `etag-${partNumber}` });
    }
    case "POST /multipart/complete": {
      const upload = uploads.get(uploadId)!;
      const { parts } = JSON.parse(body.toString()) as { parts: Array<{ partNumber: number; etag: string }> };
      const joined = Buffer.concat(parts.map(part => upload.parts.get(part.partNumber)!));
      objects.set(upload.key, { body: joined, contentType: upload.contentType });
      return send(res, 200, { key: upload.key, bytes: joined.length });
    }
    case "POST /multipart/abort":
      uploads.get(uploadId)!.aborted = true;
      return send(res, 200, { ok: true });
  }
  send(res, 404, { error: "Not found" });
}

let server: http.Server;
let work: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    handle(req, res).catch(error => send(res, 500, { error: String(error) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.BOOKX_STORAGE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  work = await mkdtemp(path.join(os.tmpdir(), "bookx-r2-test-"));
});

afterAll(async () => {
  delete process.env.BOOKX_STORAGE_URL;
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
});

beforeEach(() => {
  objects.clear();
  uploads.clear();
  failures.clear();
  log.length = 0;
});

/** Bytes that differ everywhere, so a misplaced part cannot go unnoticed. */
function pattern(length: number): Buffer {
  const buffer = Buffer.alloc(length, 0xab);
  for (let offset = 0; offset + 4 <= length; offset += 4) buffer.writeUInt32LE(offset >>> 2, offset);
  return buffer;
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Moves a few hundred megabytes through a local server, with retry pauses.
describe("R2 storage through the Worker", { timeout: 60_000 }, () => {
  it("is chosen whenever the container is given the R2 host", () => {
    expect(storageMode()).toBe("r2");
  });

  it("stores a small object in one request and reads it back", async () => {
    const data = Buffer.from("not really audio");
    const stored = await storagePut("bookx/p1/narration/seg-1.mp3", data, "audio/mpeg");
    expect(stored.key).toMatch(/^bookx\/p1\/narration\/seg-1_[0-9a-f]{8}\.mp3$/);
    expect(stored.url).toBe(`/api/storage/${stored.key}`);
    expect(log).toEqual(["PUT /object"]);
    expect(objects.get(stored.key)?.contentType).toBe("audio/mpeg");
    expect((await storageGetBuffer(stored.key)).equals(data)).toBe(true);
    expect((await streamBytes(await storageGetStream(stored.key))).equals(data)).toBe(true);
  });

  it("gives browsers the app's own URLs, which check ownership", async () => {
    expect(await storageGetSignedUrl("bookx/p1/a.mp3")).toBe("/api/storage/bookx/p1/a.mp3");
    expect(await storageDownloadUrl("bookx/p1/a.mp3", "01 - Chapter One.mp3")).toBe("/api/storage/bookx/p1/a.mp3?download=1&name=01%20-%20Chapter%20One.mp3");
  });

  it("uploads anything over 50 MiB in equal parts, from a buffer or a file", async () => {
    const data = pattern(R2_PART_BYTES + 3_000);
    const fromBuffer = await storagePut("bookx/p1/export/e1/001-c1.wav", data, "audio/wav");
    expect(log).toEqual(["POST /multipart/create", "PUT /multipart/part part=1", "PUT /multipart/part part=2", "POST /multipart/complete"]);
    const upload = [...uploads.values()][0]!;
    expect(upload.parts.get(1)?.length).toBe(R2_PART_BYTES);
    expect(upload.parts.get(2)?.length).toBe(3_000);
    expect(objects.get(fromBuffer.key)?.body.equals(data)).toBe(true);
    expect(objects.get(fromBuffer.key)?.contentType).toBe("audio/wav");

    log.length = 0;
    const file = path.join(work, "book.wav");
    await writeFile(file, data);
    const fromFile = await storagePutFile("bookx/p1/export/e1/book.wav", file, "audio/wav");
    expect(fromFile.bytes).toBe(data.length);
    expect(log.filter(entry => entry.startsWith("PUT /multipart/part"))).toHaveLength(2);
    expect(objects.get(fromFile.key)?.body.equals(data)).toBe(true);
  });

  it("retries a failed part, and abandons the upload if it keeps failing", async () => {
    const data = pattern(R2_PART_BYTES + 10);
    failures.set("PUT /multipart/part", [503]);
    const stored = await storagePut("bookx/p1/export/e2/001-c1.wav", data, "audio/wav");
    expect(objects.get(stored.key)?.body.equals(data)).toBe(true);

    failures.set("PUT /multipart/part", [503, 503, 503]);
    await expect(storagePut("bookx/p1/export/e3/001-c1.wav", data, "audio/wav")).rejects.toThrow(/HTTP 503/);
    expect([...uploads.values()].at(-1)?.aborted).toBe(true);
  });

  it("retries reads through a passing hiccup, and reports a missing object", async () => {
    const stored = await storagePut("bookx/p1/sound/rain.mp3", Buffer.from("rain"), "audio/mpeg");
    failures.set("GET /object", [502]);
    expect((await storageGetBuffer(stored.key)).toString()).toBe("rain");
    await expect(storageGetBuffer("bookx/p1/sound/missing.mp3")).rejects.toThrow(/not found/);
  });

  it("deletes whole folders and nothing that merely shares a prefix", async () => {
    await storagePut("bookx/p1/export/e1/a.mp3", Buffer.from("a"));
    await storagePut("bookx/p1/export/e10/b.mp3", Buffer.from("b"));
    await storagePut("bookx/p1/narration/c.mp3", Buffer.from("c"));
    await storagePut("bookx/p10/narration/d.mp3", Buffer.from("d"));
    expect(await storageDeletePrefix("bookx/p1/export/e1")).toBe(1);
    expect(await storageDeletePrefix("bookx/p1/")).toBe(2);
    expect([...objects.keys()]).toEqual([expect.stringMatching(/^bookx\/p10\/narration\/d_/)]);
    await expect(storageDeletePrefix("bookx/")).rejects.toThrow(/unsafe prefix/);
    await expect(storageDeletePrefix("bookx/../")).rejects.toThrow(/unsafe prefix/);
  });
});
