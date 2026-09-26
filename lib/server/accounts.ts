import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AccountInvitation, AccountUser, ManagedUser } from "../types";
import { ApiError } from "./http";
import { migrateLegacyProgress, store } from "./storage";
import { hashPassword, hashPasswordSync, validatePassword, verifyPassword } from "./passwords";

export const SESSION_LIFETIME = 30 * 24 * 60 * 60;
const INVITATION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const publicColumns = "id, username, role, createdAt";
interface UserRow extends AccountUser { passwordHash: string; disabled: number }
interface InvitationRow extends AccountInvitation { userId: string | null; usedAt: string | null }
interface Attempt { count: number; expires: number }
const shared = globalThis as typeof globalThis & {
  __comicAccountSchemas?: WeakSet<DatabaseSync>;
  __comicAccountAttempts?: Map<string, Attempt>;
};
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const account = (row: AccountUser): AccountUser => ({ id: row.id, username: row.username, role: row.role, createdAt: row.createdAt });

export function validateUsername(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(value.trim())) {
    throw new ApiError(400, "Use a username with 3 to 32 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.");
  }
  return value.trim();
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function ensureAccountState() {
  const { db } = store();
  shared.__comicAccountSchemas ??= new WeakSet();
  if (!shared.__comicAccountSchemas.has(db)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        passwordHash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
        createdAt TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        tokenHash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
        userId TEXT REFERENCES users(id) ON DELETE CASCADE,
        username TEXT,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        usedAt TEXT
      );
    `);
    shared.__comicAccountSchemas.add(db);
  }
  if (!db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
    const password = process.env.BOOKS_PASSWORD;
    if (!password || password.length > 128) throw new ApiError(503, "The library is not configured yet. Set BOOKS_PASSWORD on the server to enable access.");
    const username = validateUsername(process.env.ADMIN_USERNAME || "admin");
    // Preserve an existing shorter library password during this one-time migration.
    transaction(db, () => {
      if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) return;
      const id = randomUUID();
      db.prepare("INSERT INTO users (id, username, passwordHash, role, createdAt) VALUES (?, ?, ?, 'admin', ?)")
        .run(id, username, hashPasswordSync(password), new Date().toISOString());
      migrateLegacyProgress(id);
    });
  }
  return db;
}

function rateLimit(bucket: string, maximum: number, duration: number) {
  const now = Date.now();
  const attempts = shared.__comicAccountAttempts ??= new Map();
  for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
  const key = `${store().root}:${bucket}`;
  const value = attempts.get(key);
  if (value && value.count >= maximum) throw new ApiError(429, "Too many attempts. Please try again later.");
  if (!value && attempts.size >= 1000) throw new ApiError(429, "Too many attempts. Please try again later.");
  attempts.set(key, { count: (value?.count || 0) + 1, expires: value?.expires || now + duration });
}

function issueSession(db: DatabaseSync, userId: string) {
  const now = new Date().toISOString();
  db.prepare("DELETE FROM sessions WHERE expiresAt <= ?").run(now);
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (tokenHash, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), userId, now, new Date(Date.now() + SESSION_LIFETIME * 1000).toISOString());
  return token;
}

export function sessionUser(token: string | null): AccountUser | null {
  const db = ensureAccountState();
  if (!token || !TOKEN.test(token)) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.role, u.createdAt FROM sessions s JOIN users u ON u.id = s.userId
    WHERE s.tokenHash = ? AND s.expiresAt > ? AND u.disabled = 0`).get(tokenHash(token), new Date().toISOString()) as unknown as AccountUser | undefined;
  return row ? account(row) : null;
}

export function revokeSession(token: string | null) {
  const db = ensureAccountState();
  if (token && TOKEN.test(token)) db.prepare("DELETE FROM sessions WHERE tokenHash = ?").run(tokenHash(token));
}

export async function signIn(username: unknown, password: unknown) {
  const db = ensureAccountState();
  const name = typeof username === "string" ? username.trim() : "";
  rateLimit("login-global", 90, 60_000);
  rateLimit(`login:${name.toLowerCase().slice(0, 128)}`, 15, 10 * 60_000);
  const fail = () => new ApiError(401, "Incorrect username or password. Please try again.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(name) || typeof password !== "string" || !password.length || password.length > 128) throw fail();
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(name) as unknown as UserRow | undefined;
  const valid = await verifyPassword(password, user?.passwordHash || null);
  const current = user && db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as unknown as UserRow | undefined;
  if (!valid || !user || !current || current.disabled || current.passwordHash !== user.passwordHash) throw fail();
  shared.__comicAccountAttempts?.delete(`${store().root}:login:${name.toLowerCase()}`);
  return { user: account(current), token: issueSession(db, current.id) };
}

export async function changeAccountPassword(userId: string, currentPassword: unknown, newPassword: unknown) {
  const db = ensureAccountState();
  const password = validatePassword(newPassword);
  rateLimit(`password:${userId}`, 15, 10 * 60_000);
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND disabled = 0").get(userId) as unknown as UserRow | undefined;
  if (!user) throw new ApiError(401, "Please sign in to continue.");
  if (typeof currentPassword !== "string" || !currentPassword.length || currentPassword.length > 128
    || !await verifyPassword(currentPassword, user.passwordHash)) throw new ApiError(400, "The current password is incorrect.");
  const hash = await hashPassword(password);
  return transaction(db, () => {
    const updated = db.prepare("UPDATE users SET passwordHash = ? WHERE id = ? AND passwordHash = ? AND disabled = 0").run(hash, userId, user.passwordHash);
    if (!updated.changes) throw new ApiError(401, "Your account changed. Please sign in again.");
    db.prepare("DELETE FROM sessions WHERE userId = ?").run(userId);
    db.prepare("DELETE FROM invitations WHERE userId = ? AND kind = 'reset'").run(userId);
    return { user: account(user), token: issueSession(db, userId) };
  });
}

export function listUsers(): ManagedUser[] {
  return (ensureAccountState().prepare(`SELECT ${publicColumns}, disabled FROM users ORDER BY createdAt, username`).all() as unknown as Array<AccountUser & { disabled: number }>)
    .map(row => ({ ...account(row), disabled: Boolean(row.disabled) }));
}

export function setUserDisabled(id: string, disabled: unknown): ManagedUser {
  if (typeof disabled !== "boolean") throw new ApiError(400, "Choose whether this account is blocked.");
  const db = ensureAccountState();
  return transaction(db, () => {
    const user = db.prepare(`SELECT ${publicColumns}, disabled FROM users WHERE id = ?`).get(id) as unknown as UserRow | undefined;
    if (!user) throw new ApiError(404, "Account not found.");
    if (user.role !== "reader") throw new ApiError(403, "The administrator account cannot be blocked.");
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(Number(disabled), id);
    if (disabled) {
      db.prepare("DELETE FROM sessions WHERE userId = ?").run(id);
      db.prepare("DELETE FROM invitations WHERE userId = ?").run(id);
    }
    return { ...account(user), disabled };
  });
}

export function listInvitations(): AccountInvitation[] {
  return ensureAccountState().prepare("SELECT id, kind, username, expiresAt, createdAt FROM invitations WHERE usedAt IS NULL AND expiresAt > ? ORDER BY createdAt DESC")
    .all(new Date().toISOString()) as unknown as AccountInvitation[];
}

export function createInvitation(userId?: unknown) {
  const db = ensureAccountState();
  let user: AccountUser | undefined;
  if (userId !== undefined) {
    if (typeof userId !== "string") throw new ApiError(400, "Choose an account to reset.");
    user = db.prepare(`SELECT ${publicColumns} FROM users WHERE id = ? AND disabled = 0 AND role = 'reader'`).get(userId) as unknown as AccountUser | undefined;
    if (!user) throw new ApiError(400, "Choose an active reader account to reset.");
  }
  const token = randomBytes(32).toString("base64url");
  const invitation: AccountInvitation = { id: randomUUID(), kind: user ? "reset" : "invite", username: user?.username || null,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + INVITATION_LIFETIME).toISOString() };
  transaction(db, () => {
    db.prepare("DELETE FROM invitations WHERE usedAt IS NOT NULL OR expiresAt <= ?").run(invitation.createdAt);
    if (user) db.prepare("DELETE FROM invitations WHERE userId = ? AND kind = 'reset'").run(user.id);
    db.prepare("INSERT INTO invitations (id, tokenHash, kind, userId, username, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(invitation.id, tokenHash(token), invitation.kind, user?.id || null, invitation.username, invitation.createdAt, invitation.expiresAt);
  });
  return { invitation, token };
}

export function revokeInvitation(id: string) {
  ensureAccountState().prepare("DELETE FROM invitations WHERE id = ?").run(id);
}

function findInvitation(db: DatabaseSync, token: unknown): InvitationRow {
  const invalid = () => new ApiError(400, "This invitation is invalid or has expired. Ask the administrator for a new link.");
  if (typeof token !== "string" || !TOKEN.test(token)) throw invalid();
  const row = db.prepare("SELECT id, kind, userId, username, createdAt, expiresAt, usedAt FROM invitations WHERE tokenHash = ? AND usedAt IS NULL AND expiresAt > ?")
    .get(tokenHash(token), new Date().toISOString()) as unknown as InvitationRow | undefined;
  if (!row) throw invalid();
  if (row.kind === "reset" && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'reader' AND disabled = 0").get(row.userId)) throw invalid();
  return row;
}

export function inspectInvitation(token: unknown) {
  const row = findInvitation(ensureAccountState(), token);
  return { kind: row.kind, username: row.username, expiresAt: row.expiresAt };
}

export async function registerAccount(token: unknown, username: unknown, password: unknown) {
  const db = ensureAccountState();
  rateLimit("register-global", 30, 60_000);
  const name = validateUsername(username);
  const validPassword = validatePassword(password);
  const invitation = findInvitation(db, token);
  if (invitation.kind === "reset" && name.toLowerCase() !== invitation.username!.toLowerCase()) throw new ApiError(400, "Use the username shown in this reset invitation.");
  const hash = await hashPassword(validPassword);
  return transaction(db, () => {
    const current = findInvitation(db, token);
    let user: AccountUser;
    if (current.kind === "invite") {
      if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(name)) throw new ApiError(409, "This username is unavailable. Choose another username.");
      user = { id: randomUUID(), username: name, role: "reader", createdAt: new Date().toISOString() };
      db.prepare("INSERT INTO users (id, username, passwordHash, role, createdAt) VALUES (?, ?, ?, 'reader', ?)").run(user.id, user.username, hash, user.createdAt);
    } else {
      const row = db.prepare(`SELECT ${publicColumns} FROM users WHERE id = ?`).get(current.userId) as unknown as AccountUser;
      user = account(row);
      db.prepare("UPDATE users SET passwordHash = ? WHERE id = ?").run(hash, user.id);
      db.prepare("DELETE FROM sessions WHERE userId = ?").run(user.id);
      db.prepare("DELETE FROM invitations WHERE userId = ? AND kind = 'reset' AND id != ?").run(user.id, current.id);
    }
    db.prepare("UPDATE invitations SET usedAt = ? WHERE id = ?").run(new Date().toISOString(), current.id);
    return { user, token: issueSession(db, user.id) };
  });
}
