import type { CookieOptions, Request } from "express";

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");

  return protoList.some(proto => proto.trim().toLowerCase() === "https");
}

/**
 * Attributes for the session cookie.
 *
 * `domain` is deliberately never set: a host-only cookie cannot be read by a
 * sibling subdomain, which is what we want for a session credential.
 */
export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  const secure = isSecureRequest(req);

  return {
    httpOnly: true,
    path: "/",
    // `SameSite=None` is only valid *together with* `Secure` — browsers reject
    // the pair outright, which silently dropped the session cookie whenever the
    // app was served over plain HTTP (local dev, or a proxy that does not send
    // `x-forwarded-proto`). Over HTTPS we still need `None` so the app works
    // when embedded in a preview iframe; otherwise fall back to `Lax`, which is
    // valid without `Secure` and survives top-level navigation.
    sameSite: secure ? "none" : "lax",
    secure,
  };
}
