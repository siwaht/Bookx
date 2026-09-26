import type { Express } from "express";
import { Readable } from "node:stream";
import { exportZipEntries } from "../audioExport";
import { storageGetStream } from "../storage";
import { zipResponse } from "../zipStream";
import { authenticateRequest } from "./authenticate";

/**
 * `GET /api/exports/:exportId/zip?projectId=…` streams every chapter file of a
 * finished export as one ZIP. On Cloudflare the Worker answers this route
 * straight from R2; this handler serves local checkouts.
 */
export function registerExportDownloads(app: Express) {
  app.get("/api/exports/:exportId/zip", async (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    if (!projectId) {
      res.status(400).send("projectId is required");
      return;
    }
    let userId: number;
    try {
      userId = (await authenticateRequest(req)).id;
    } catch {
      res.status(401).send("Sign in to download this package");
      return;
    }
    try {
      const { zipName, entries } = await exportZipEntries({ projectId, ownerId: userId, exportId: req.params.exportId! });
      if (!entries.length) {
        res.status(404).send("This package has no chapter files");
        return;
      }
      const response = zipResponse(
        entries.map(entry => ({ ...entry, open: () => storageGetStream(entry.storageKey) })),
        zipName,
      );
      res.status(200);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).on("error", error => {
        console.error("[Export] ZIP stream failed:", error);
        res.destroy(error);
      }).pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed";
      res.status(/not found/i.test(message) ? 404 : 400).send(message);
    }
  });
}
