import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { store } from "./storage";
import { ApiError } from "./http";

const COOKIE = "comic_shelf_session";
const LIFETIME = 60 * 60 * 24 * 30;
const authState = globalThis as typeof globalThis & { __comicLoginAttempts?: { count: number; resetAt: number } };

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

export function passwordRequired() { return Boolean(process.env.BOOKS_PASSWORD); }

export function requirePasswordConfigured() {
  if (!passwordRequired()) throw new ApiError(503, "The library is not configured yet. Set BOOKS_PASSWORD on the server to enable access.");
}

function secret() {
  const file = join(store().root, "session-secret");
  try { return readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const generated = randomBytes(32);
    try { writeFileSync(file, generated, { flag: "wx", mode: 0o600 }); return generated; }
    catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      return readFileSync(file);
    }
  }
}

function signature(payload: string) {
  return createHmac("sha256", secret()).update(process.env.BOOKS_PASSWORD || "").update("\0").update(payload).digest("base64url");
}

function same(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function authenticated(request: Request) {
  checkOrigin(request);
  if (!passwordRequired()) return false;
  const token = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || token.length > 256) return false;
  const [expiry, nonce, suppliedSignature, extra] = token.split(".");
  if (extra || !/^\d{10,13}$/.test(expiry) || !/^[\w-]{32}$/.test(nonce || "") || !suppliedSignature) return false;
  if (Number(expiry) <= Date.now() || Number(expiry) > Date.now() + (LIFETIME + 60) * 1000) return false;
  return same(suppliedSignature, signature(`${expiry}.${nonce}`));
}

export function requireAuth(request: Request) {
  requirePasswordConfigured();
  if (!authenticated(request)) {
    throw new ApiError(401, "Please sign in to continue.");
  }
}

export function login(request: Request, password: unknown) {
  checkOrigin(request);
  requirePasswordConfigured();
  const now = Date.now();
  if (!authState.__comicLoginAttempts || authState.__comicLoginAttempts.resetAt <= now) {
    authState.__comicLoginAttempts = { count: 0, resetAt: now + 10 * 60 * 1000 };
  }
  if (authState.__comicLoginAttempts.count >= 15) throw new ApiError(429, "Too many sign-in attempts. Please try again in 10 minutes.");
  if (typeof password !== "string" || !same(password, process.env.BOOKS_PASSWORD!)) {
    authState.__comicLoginAttempts.count++;
    throw new ApiError(401, "Incorrect password. Please try again.");
  }
  authState.__comicLoginAttempts.count = 0;
  const payload = `${now + LIFETIME * 1000}.${randomBytes(24).toString("base64url")}`;
  return `${COOKIE}=${payload}.${signature(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME}${cookieOrigin(request).startsWith("https:") ? "; Secure" : ""}`;
}

export function logoutCookie(request: Request) {
  checkOrigin(request);
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieOrigin(request).startsWith("https:") ? "; Secure" : ""}`;
}
