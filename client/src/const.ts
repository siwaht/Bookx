import { OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * "access" in the Cloudflare build, where Cloudflare Access signs people in
 * before the page even loads; "app" where the app runs its own sign-in.
 */
export const AUTH_MODE: "access" | "app" = import.meta.env.VITE_AUTH_MODE === "access" ? "access" : "app";

/** Where signing out ends up: Access has to end its own session too. */
export const ACCESS_LOGOUT_URL = "/cdn-cgi/access/logout";

const ACCESS_RELOAD_KEY = "bookx-access-reload";
const ACCESS_RELOAD_GAP_MS = 30_000;

// Start the Manus OAuth login. Call this from an event handler or effect at the
// moment you want to navigate, e.g. `onClick={() => startLogin()}`.
//
// It has SIDE EFFECTS — it mints a one-time nonce, writes the __Host- state
// cookie, and navigates immediately — so the cookie nonce always matches the
// `state` it sends. Do NOT call it during render (no `href={startLogin()}` /
// `loginUrl={...}`): each call overwrites the cookie, so a stray render-phase
// call would desync it from an in-flight login and the callback would reject it
// with "invalid oauth state". It returns void by design, so there is no URL to
// stash across renders.
//
// Pass `automatic: true` when no one clicked anything (an API call came back
// unauthorized), so a misconfiguration cannot turn into a reload loop.
export const startLogin = (options: { automatic?: boolean } = {}) => {
  if (AUTH_MODE === "access") {
    // Signed out behind Access means the Access session ran out mid-visit.
    // Loading the page again lets Access ask the visitor to sign in.
    if (options.automatic) {
      try {
        const last = Number(sessionStorage.getItem(ACCESS_RELOAD_KEY) || 0);
        if (Date.now() - last < ACCESS_RELOAD_GAP_MS) return;
        sessionStorage.setItem(ACCESS_RELOAD_KEY, String(Date.now()));
      } catch {
        return;
      }
    }
    window.location.reload();
    return;
  }

  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
  const appId = import.meta.env.VITE_APP_ID;

  // A local checkout has no Manus OAuth portal. The server exposes a dev-only
  // sign-in route in that case (see server/_core/devLogin.ts); in any build
  // where OAuth is configured this branch is never taken.
  if (!oauthPortalUrl || !appId) {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/api/dev/login?returnTo=${encodeURIComponent(returnTo || "/")}`;
    return;
  }

  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  const nonce = crypto.randomUUID();
  document.cookie = `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=None; Secure`;
  const state = encodeOAuthState({ redirectUri, nonce });

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  window.location.href = url.toString();
};
