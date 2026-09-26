import { Container, getContainer } from "@cloudflare/containers";
import { PROXY_HEADERS } from "../shared/proxyHeaders";
import { createBookxHandler, internalSecret, PROVIDER_SECRETS, type BookxSecrets } from "./app";
import { handleD1, handleR2 } from "./bindings";

// Outbound interception (the container's D1 and R2 hosts) needs this export.
export { ContainerProxy } from "@cloudflare/containers";

/**
 * The Bookx Worker on Cloudflare: request handling is in worker/app.ts; this
 * entry adds the container the Node app runs in.
 */

type BookxEnv = Env & BookxSecrets;

const APP_PORT = 8080;

/** Environment for the app process: its D1 and R2 hosts, trusted identity headers, provider keys. */
function containerEnv(env: BookxEnv): Record<string, string> {
  const vars: Record<string, string> = {
    NODE_ENV: "production",
    BOOKX_CONTAINER: "1",
    PORT: String(APP_PORT),
    BOOKX_DB_URL: "http://d1.bookx",
    BOOKX_STORAGE_URL: "http://r2.bookx",
    BOOKX_TRUST_PROXY_AUTH: "1",
    BOOKX_INTERNAL_SECRET: internalSecret(env) ?? "",
  };
  for (const name of PROVIDER_SECRETS) {
    const value = env[name]?.trim();
    if (value) vars[name] = value;
  }
  return vars;
}

export class BookxContainer extends Container<BookxEnv> {
  defaultPort = APP_PORT;
  // Asleep after half an hour with nothing open, unless work is in progress.
  sleepAfter = "30m";
  // Voice and AI providers are on the public internet.
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: BookxEnv) {
    super(ctx, env);
    this.envVars = containerEnv(env);
  }

  /**
   * The quiet spell ran out. A book can take hours to narrate with no page
   * open, so the container only sleeps once the app reports nothing running;
   * returning without stopping keeps it up for another spell.
   */
  override async onActivityExpired(): Promise<void> {
    if (await this.appIsBusy()) {
      console.log("[Bookx] Work in progress; staying awake");
      return;
    }
    await this.stop();
  }

  private async appIsBusy(): Promise<boolean> {
    const secret = internalSecret(this.env);
    if (!secret) return false;
    try {
      const response = await this.containerFetch("http://container/internal/busy", { headers: { [PROXY_HEADERS.secret]: secret } }, APP_PORT);
      if (!response.ok) return false;
      const work = (await response.json()) as { busy?: boolean };
      return work.busy === true;
    } catch {
      return false;
    }
  }
}

// Assigned (not declared as static fields) so the library's setter registers them.
BookxContainer.outboundByHost = {
  "d1.bookx": (request: Request, env: BookxEnv) => handleD1(request, env.DB),
  "r2.bookx": (request: Request, env: BookxEnv) => handleR2(request, env.BUCKET),
};

export default createBookxHandler<BookxEnv>((request, env) => getContainer(env.APP).fetch(request));
