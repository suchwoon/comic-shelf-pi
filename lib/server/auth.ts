import type { AccountUser } from "../types";
import { ApiError } from "./http";
import { changeAccountPassword, ensureAccountState, registerAccount, revokeSession, SESSION_LIFETIME, sessionUser, signIn } from "./accounts";

const COOKIE = "comic_shelf_session";

function publicOrigin() {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid origin");
    return url.origin;
  } catch {
    throw new ApiError(503, "The library address is not configured correctly. Set PUBLIC_ORIGIN to the site's origin, such as https://books.catfish.cc.");
  }
}

function loopback(url: URL) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
}

function localOrigin(url: URL, origin: string | null, host: string | null): origin is string {
  if (!origin) return false;
  try {
    const candidate = new URL(origin);
    // Next may reconstruct a 127.0.0.1 request as localhost. Treat loopback
    // aliases as equivalent on the same protocol and listening port. A local
    // SSH/Docker port forward can preserve its browser-facing Host and port,
    // even when the server binds to 0.0.0.0 instead of a loopback address.
    return candidate.origin === origin && loopback(candidate)
      && candidate.protocol === url.protocol
      && ((loopback(url) && candidate.port === url.port) || origin === `${url.protocol}//${host}`);
  } catch { return false; }
}

function cookieOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  // A browser signing in directly on this machine can still use HTTP. Public
  // sessions use the configured origin even when a tunnel connects over HTTP.
  if (localOrigin(url, origin, request.headers.get("host"))) return origin;
  return publicOrigin() || url.origin;
}

export function checkOrigin(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "Requests from other websites are not allowed.");
  const origin = request.headers.get("origin");
  const configured = publicOrigin();
  const url = new URL(request.url);
  const host = request.headers.get("host");
  // Without a public origin, preserve browser same-origin checks for LAN and
  // forwarded ports. Host selects the CSRF target; it never grants access.
  const expected = `${url.protocol}//${host || url.host}`;
  if (origin && origin !== configured && !localOrigin(url, origin, host) && (configured || origin !== expected)) {
    throw new ApiError(403, "Check the site address and try again.");
  }
}

export function passwordRequired() { return true; }

export function requirePasswordConfigured() {
  ensureAccountState();
}

function requestToken(request: Request) {
  return request.headers.get("cookie")?.split(";").map(value => value.trim())
    .find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || null;
}

function sessionCookie(request: Request, token: string) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME}${cookieOrigin(request).startsWith("https:") ? "; Secure" : ""}`;
}

export function currentUser(request: Request): AccountUser | null {
  checkOrigin(request);
  return sessionUser(requestToken(request));
}

export function authenticated(request: Request) {
  return Boolean(currentUser(request));
}

export function requireAuth(request: Request): AccountUser {
  const user = currentUser(request);
  if (!user) throw new ApiError(401, "Please sign in to continue.");
  return user;
}

export function requireAdmin(request: Request): AccountUser {
  const user = requireAuth(request);
  if (user.role !== "admin") throw new ApiError(403, "Only the administrator can make this change.");
  return user;
}

export async function login(request: Request, username: unknown, password: unknown) {
  checkOrigin(request);
  const { user, token } = await signIn(username, password);
  return { user, cookie: sessionCookie(request, token) };
}

export async function changePassword(request: Request, currentPassword: unknown, newPassword: unknown) {
  const user = requireAuth(request);
  const result = await changeAccountPassword(user.id, currentPassword, newPassword);
  return { user: result.user, cookie: sessionCookie(request, result.token) };
}

export async function register(request: Request, token: unknown, username: unknown, password: unknown) {
  checkOrigin(request);
  const result = await registerAccount(token, username, password);
  return { user: result.user, cookie: sessionCookie(request, result.token) };
}

export function logoutCookie(request: Request) {
  checkOrigin(request);
  revokeSession(requestToken(request));
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieOrigin(request).startsWith("https:") ? "; Secure" : ""}`;
}
