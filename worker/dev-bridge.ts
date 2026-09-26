import { createBookxHandler, internalSecret, text, type BookxBindings } from "./app";
import { handleD1, handleR2 } from "./bindings";

/**
 * LOCAL TESTING ONLY. Run with `pnpm run cf:bridge`; never deployed
 * (wrangler.bridge.jsonc has no public URL).
 *
 * `wrangler dev` cannot run Containers on Windows. This entry runs the real
 * Worker request handling (Access sign-in, R2 file serving, ZIPs) against
 * local D1 and R2, but sends app requests to an app process on this machine
 * or in Docker (BRIDGE_APP_URL). That process reaches D1 and R2 through the
 * same handlers the container uses, at /__bridge/{BOOKX_INTERNAL_SECRET}/d1
 * and /__bridge/{BOOKX_INTERNAL_SECRET}/r2.
 */

type BridgeEnv = BookxBindings & { BRIDGE_APP_URL?: string };

const worker = createBookxHandler<BridgeEnv>(async (request, env) => {
  const target = new URL(request.url);
  const app = new URL(env.BRIDGE_APP_URL || "http://127.0.0.1:3100");
  target.protocol = app.protocol;
  target.host = app.host;
  return fetch(new Request(target, request));
});

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const bridge = url.pathname.match(/^\/__bridge\/([^/]+)\/(d1|r2)(\/.*)$/);
    if (!bridge) return worker.fetch!(request, env, ctx);

    const secret = internalSecret(env);
    if (!secret || bridge[1] !== secret) return text("Not found", 404);
    const inner = new URL(url);
    inner.pathname = bridge[3]!;
    const forwarded = new Request(inner, request);
    return bridge[2] === "d1" ? handleD1(forwarded, env.DB) : handleR2(forwarded, env.BUCKET);
  },
} satisfies ExportedHandler<BridgeEnv>;
