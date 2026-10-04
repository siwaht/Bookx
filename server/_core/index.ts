import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { PROXY_HEADERS, sameSecret, trustsProxyAuth } from "./authenticate";
import { registerPasswordRoutes } from "./passwordAuth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { releaseNarrationLeases, startNarrationRecovery } from "../narrationWorker";
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
        // A book still narrating is handed on, so the next container resumes
        // it as it starts rather than once this one's lease runs out.
        const exit = () => process.exit(0);
        setTimeout(exit, 5_000).unref();
        void releaseNarrationLeases().catch(() => undefined).finally(exit);
        return;
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
  } else {
    // A plain host — Manus, or a local checkout — has no Worker to ask. This
    // is what a deploy's readiness check calls: the database answers, a file
    // round-trips through storage and ffmpeg runs. It is deliberately
    // reachable without signing in, and reports only those results, the
    // providers the app detected and the Node version.
    //
    // Two paths, deliberately: a bare `/healthz` is what a local checkout
    // uses, while the Manus gateway answers that same bare path with its own
    // probe response and never reaches the app, so the published readiness
    // path lives under `/api/`, which the gateway leaves to the application.
    const health = async (_req: express.Request, res: express.Response) => {
      const report = await healthReport();
      res.status(report.ok ? 200 : 503).json(report);
    };
    app.get("/healthz", health);
    app.get("/api/healthz", health);
  }
  registerStorageProxy(app);
  registerExportDownloads(app);
  // The one account's sign-in. Behind Cloudflare Access the Worker has
  // already signed the visitor in, so the routes are not needed there.
  if (!trustsProxyAuth()) registerPasswordRoutes(app);
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

  // A narration run interrupted by a restart, a crash or a deploy is left
  // `running` under a lease nobody renews. The sweep resumes it once that lease
  // lapses, now and every few seconds after, so a book never just stops.
  startNarrationRecovery();
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
