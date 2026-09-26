import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { PROXY_HEADERS, sameSecret, trustsProxyAuth } from "./authenticate";
import { registerDevLoginRoutes } from "./devLogin";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { recoverInterruptedRuns } from "../narrationWorker";
import { recoverInterruptedAnalyses } from "../analysisJobs";
import { recoverInterruptedExports } from "../audioExport";
import { registerExportDownloads } from "./exportDownloads";
import { serveStatic, setupVite } from "./vite";
import { workInProgress } from "./workload";
import { healthReport } from "./health";

/**
 * On Cloudflare the app runs in a container behind the Bookx Worker, which
 * serves the web app itself and forwards only `/api/*` here.
 */
const containerMode = process.env.BOOKX_CONTAINER === "1";

/** How long a shutdown waits for work in progress; the platform kills at 15 minutes. */
const SHUTDOWN_GRACE_MS = 13 * 60_000;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * The container is stopped with SIGTERM (a deploy, or the Worker letting an
 * idle container sleep). Narration, analysis and exports in progress get the
 * time to finish; anything still running after that is resumable on the next
 * start, as after any restart.
 */
function drainOnSigterm() {
  let draining = false;
  process.on("SIGTERM", () => {
    if (draining) return;
    draining = true;
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    console.log("[Container] Stopping: waiting for work in progress", workInProgress());
    const check = () => {
      if (!workInProgress().busy || Date.now() > deadline) {
        console.log("[Container] Stopped");
        process.exit(0);
      }
      setTimeout(check, 2_000);
    };
    check();
  });
}

async function startServer() {
  if (containerMode) {
    // A stray rejected promise must not take down a container that is halfway
    // through narrating a book; it is logged and the work carries on.
    process.on("unhandledRejection", reason => console.error("[Container] Unhandled rejection:", reason));
  }
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  if (containerMode) {
    // Only the Worker, which holds the shared secret, may ask these.
    const fromWorker = (req: express.Request, res: express.Response) => {
      const given = req.headers[PROXY_HEADERS.secret];
      if (typeof given === "string" && sameSecret(given, process.env.BOOKX_INTERNAL_SECRET ?? "")) return true;
      res.status(403).json({ error: "Forbidden" });
      return false;
    };
    // Asked before an idle container is allowed to sleep.
    app.get("/internal/busy", (req, res) => {
      if (fromWorker(req, res)) res.json(workInProgress());
    });
    // Asked by the Worker's /api/__health after a deploy.
    app.get("/internal/health", async (req, res) => {
      if (!fromWorker(req, res)) return;
      const report = await healthReport();
      res.status(report.ok ? 200 : 503).json(report);
    });
  }
  registerStorageProxy(app);
  registerExportDownloads(app);
  // Behind Cloudflare Access the Worker has already signed the visitor in, and
  // the Manus OAuth callback would only be an unused way around it.
  if (!trustsProxyAuth()) registerOAuthRoutes(app);
  registerDevLoginRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files; in the
  // container the Worker serves the web app, so there is nothing static here.
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else if (containerMode) {
    app.use((_req, res) => {
      res.status(404).send("Not found");
    });
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  // The container's port is fixed by the Worker; a local checkout may move on.
  const port = containerMode ? preferredPort : await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  if (containerMode) drainOnSigterm();

  // A narration run that was interrupted by a restart is left `running` with an
  // expired lease. Mark those resumable so the Generate screen offers to pick them
  // up, rather than leaving a half-rendered book looking active forever.
  void recoverInterruptedRuns().catch(error => {
    console.error("[Narration] Recovery scan failed:", error);
  });
  // Analysis runs (casting, scene cues, sounds) are idempotent, so an
  // interrupted one is marked failed and simply run again by the creator.
  void recoverInterruptedAnalyses().catch(error => {
    console.error("[Analysis] Recovery scan failed:", error);
  });
  void recoverInterruptedExports().catch(error => {
    console.error("[Export] Recovery scan failed:", error);
  });
}

startServer().catch(error => {
  console.error(error);
  // A container that cannot start should exit, so the platform reports it.
  if (containerMode) process.exit(1);
});
