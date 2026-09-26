/**
 * Headers the Bookx Worker adds when it forwards a request to the app
 * container: a shared secret, and the visitor's Cloudflare Access identity.
 * The Worker strips any incoming `x-bookx-*` header first, so a visitor
 * cannot supply them.
 */
export const PROXY_HEADERS = {
  secret: "x-bookx-internal",
  email: "x-bookx-user-email",
  name: "x-bookx-user-name",
} as const;

/** The user id Bookx stores for a Cloudflare Access identity. */
export const accessOpenId = (email: string) => `access:${email.trim().toLowerCase()}`;
