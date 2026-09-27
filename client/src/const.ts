export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Where unauthenticated visitors sign in: the one account's email + password
 * page, served by the app itself (see server/_core/passwordAuth.ts).
 */
export const LOGIN_PATH = "/login";

// Start the sign-in flow. Call this from an event handler or effect at the
// moment you want to navigate, e.g. `onClick={() => startLogin()}`.
//
// It navigates immediately and returns void by design, so there is no URL to
// stash across renders.
//
// Pass `automatic: true` when no one clicked anything (an API call came back
// unauthorized), so a misconfiguration cannot turn into a reload loop.
export const startLogin = (options: { automatic?: boolean } = {}) => {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  const target = `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo || "/")}`;
  if (options.automatic) {
    // Only navigate once per moment; a burst of unauthorized API calls must
    // not repeatedly restart the navigation.
    try {
      const key = "bookx-login-redirect";
      const last = Number(sessionStorage.getItem(key) || 0);
      if (Date.now() - last < 5_000 && window.location.pathname !== LOGIN_PATH) return;
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // sessionStorage unavailable; navigating again is harmless.
    }
  }
  if (window.location.pathname === LOGIN_PATH) return;
  window.location.href = target;
};
