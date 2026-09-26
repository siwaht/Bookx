import { downloadZip } from "client-zip";
import { attachmentDisposition } from "../shared/contentDisposition";

/**
 * A ZIP of stored files, streamed as it is built.
 *
 * Audio does not compress, so entries are stored as-is and nothing is held in
 * memory: each object is opened only when the ZIP reaches it. When every size
 * is known the response carries an exact Content-Length, so the browser can
 * show real download progress. Runs on Node and on Workers alike.
 */
export type ZipSource = {
  name: string;
  bytes: number | null;
  lastModified: Date;
  open: () => Promise<ReadableStream<Uint8Array>>;
};

export function zipResponse(sources: ZipSource[], zipName: string): Response {
  async function* files() {
    for (const source of sources) {
      yield { name: source.name, lastModified: source.lastModified, ...(source.bytes != null ? { size: source.bytes } : {}), input: await source.open() };
    }
  }
  const sized = sources.every(source => source.bytes != null);
  const zip = downloadZip(files(), {
    buffersAreUTF8: true,
    ...(sized ? { metadata: sources.map(source => ({ name: source.name, size: source.bytes!, lastModified: source.lastModified })) } : {}),
  });
  const headers = new Headers(zip.headers);
  headers.set("Content-Type", "application/zip");
  headers.set("Content-Disposition", attachmentDisposition(zipName));
  headers.set("Cache-Control", "private, no-store");
  return new Response(zip.body, { status: 200, headers });
}
