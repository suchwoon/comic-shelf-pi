import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { store } from "./storage";
import { ApiError } from "./http";

const COOKIE = "comic_shelf_session";
const LIFETIME = 60 * 60 * 24 * 30;
const authState = globalThis as typeof globalThis & { __comicLoginAttempts?: { count: number; resetAt: number } };

function expectedOrigin(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const protocol = forwardedProto === "https" ? "https:" : url.protocol;
  return `${protocol}//${host}`;
}

export function checkOrigin(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "Requests from other websites are not allowed.");
  const origin = request.headers.get("origin");
  if (origin && origin !== expectedOrigin(request)) throw new ApiError(403, "Check the site address and try again.");
}

export function passwordRequired() { return Boolean(process.env.BOOKS_PASSWORD); }

function localRequest(request: Request) {
  try {
    const hostname = new URL(expectedOrigin(request)).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch { return false; }
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
  if (!passwordRequired()) return localRequest(request);
  const token = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || token.length > 256) return false;
  const [expiry, nonce, suppliedSignature, extra] = token.split(".");
  if (extra || !/^\d{10,13}$/.test(expiry) || !/^[\w-]{32}$/.test(nonce || "") || !suppliedSignature) return false;
  if (Number(expiry) <= Date.now() || Number(expiry) > Date.now() + (LIFETIME + 60) * 1000) return false;
  return same(suppliedSignature, signature(`${expiry}.${nonce}`));
}

export function requireAuth(request: Request) {
  if (!authenticated(request)) {
    throw new ApiError(passwordRequired() ? 401 : 403, passwordRequired() ? "Please sign in to continue." : "Remote access requires a library password to be configured.");
  }
}

export function login(request: Request, password: unknown) {
  checkOrigin(request);
  if (!passwordRequired()) {
    requireAuth(request);
    return null;
  }
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
  return `${COOKIE}=${payload}.${signature(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME}${expectedOrigin(request).startsWith("https:") ? "; Secure" : ""}`;
}

export function logoutCookie(request: Request) {
  checkOrigin(request);
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${expectedOrigin(request).startsWith("https:") ? "; Secure" : ""}`;
}
