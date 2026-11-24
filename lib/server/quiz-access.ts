import { createHash, randomBytes } from "node:crypto";
import type { AccountUser } from "../types";
import { ensureAccountState, tokenHash } from "./accounts";
import { requestToken } from "./auth";
import { ApiError, readJson } from "./http";

const newToken = () => randomBytes(32).toString("base64url");
const CODE_LIFETIME = 60_000;
const validToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const unauthorized = () => new ApiError(401, "Quiz Room sign-in has expired. Sign in again from Quiz Room.");

export function quizOrigin() {
  try {
    const value = process.env.QUIZ_PUBLIC_ORIGIN?.trim();
    if (!value) throw Error();
    const url = new URL(value);
    const local = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.origin !== value.replace(/\/$/, "")) throw Error();
    return url.origin;
  } catch {
    throw new ApiError(503, "Quiz Room sign-in is unavailable. Check the server's QUIZ_PUBLIC_ORIGIN.");
  }
}

// Only the Quiz Room backend exchanges or presents a grant. Browser navigations use /quiz/connect.
export async function quizPayload(request: Request) {
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    throw new ApiError(403, "This endpoint accepts server requests only.");
  }
  quizOrigin();
  return readJson(request);
}

export function issueQuizCode(request: Request, challenge: string) {
  const session = requestToken(request);
  if (!validToken(session)) return null;
  const db = ensureAccountState();
  const now = new Date().toISOString();
  const code = newToken();
  db.prepare("DELETE FROM quiz_credentials WHERE expiresAt <= ?").run(now);
  const saved = db.prepare(`INSERT INTO quiz_credentials (tokenHash, sessionHash, challenge, expiresAt)
    SELECT ?, s.tokenHash, ?, ? FROM sessions s JOIN users u ON u.id = s.userId
    WHERE s.tokenHash = ? AND s.expiresAt > ? AND u.disabled = 0`)
    .run(tokenHash(code), challenge, new Date(Date.now() + CODE_LIFETIME).toISOString(), tokenHash(session), now);
  return saved.changes ? code : null;
}

export function quizIdentity(grant: unknown) {
  if (!validToken(grant)) throw unauthorized();
  const db = ensureAccountState();
  const now = new Date().toISOString();
  const row = db.prepare(`SELECT u.id, u.username, u.role, s.expiresAt FROM quiz_credentials q
    JOIN sessions s ON s.tokenHash = q.sessionHash JOIN users u ON u.id = s.userId
    WHERE q.tokenHash = ? AND q.challenge IS NULL AND q.expiresAt > ? AND s.expiresAt > ? AND u.disabled = 0`)
    .get(tokenHash(grant), now, now) as (Pick<AccountUser, "id" | "username" | "role"> & { expiresAt: string }) | undefined;
  if (!row) throw unauthorized();
  const { id, username, role, expiresAt } = row;
  return { user: { id, username, role }, expiresAt };
}

export function exchangeQuizCode(code: unknown, verifier: unknown) {
  if (!validToken(code) || !validToken(verifier)) throw unauthorized();
  const db = ensureAccountState();
  const grant = newToken();
  const now = new Date().toISOString();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // Replacing the code's hash consumes it exactly once, even across server processes.
  const changed = db.prepare(`UPDATE quiz_credentials AS q SET tokenHash = ?, challenge = NULL,
    expiresAt = (SELECT expiresAt FROM sessions WHERE tokenHash = q.sessionHash)
    WHERE tokenHash = ? AND challenge = ? AND expiresAt > ?
    AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.userId
      WHERE s.tokenHash = q.sessionHash AND s.expiresAt > ? AND u.disabled = 0)`)
    .run(tokenHash(grant), tokenHash(code), challenge, now, now);
  if (!changed.changes) throw unauthorized();
  return { grant, ...quizIdentity(grant) };
}

export function revokeQuizGrant(grant: unknown) {
  if (validToken(grant)) ensureAccountState().prepare("DELETE FROM quiz_credentials WHERE tokenHash = ? AND challenge IS NULL").run(tokenHash(grant));
}
