import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInvitation, ensureAccountState, inspectInvitation, listInvitations, listUsers, registerAccount, revokeInvitation, setUserDisabled, signIn } from "../lib/server/accounts";
import { authenticated, changePassword, currentUser, login, logoutCookie, register, requireAdmin, requireAuth } from "../lib/server/auth";
import { hashPassword, validatePassword, verifyPassword } from "../lib/server/passwords";
import { ApiError } from "../lib/server/http";
import { getBook, store } from "../lib/server/storage";
import { GET as sessionGET, POST as sessionPOST, DELETE as sessionDELETE, PATCH as sessionPATCH } from "../app/api/session/route";
import { GET as usersGET } from "../app/api/admin/users/route";
import { PATCH as usersPATCH } from "../app/api/admin/users/[id]/route";
import { GET as invitationsGET, POST as invitationsPOST } from "../app/api/admin/invitations/route";
import { DELETE as invitationsDELETE } from "../app/api/admin/invitations/[id]/route";
import { POST as registerPOST } from "../app/api/register/route";
import { POST as inspectPOST } from "../app/api/invitations/inspect/route";

const initialPassword = "old-short";
const readerPassword = "reader password 123";
const originalEnv = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD, ADMIN_USERNAME: process.env.ADMIN_USERNAME, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN };
let root: string;
const errorStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
function request(path = "/api/session", method = "GET", body?: unknown, cookie?: string, origin = "http://localhost:3000") {
  const headers = new Headers({ Origin: origin });
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function administrator() { return login(request(), "admin", initialPassword); }
async function reader(username = "reader.one") {
  const invitation = createInvitation();
  return register(request(), invitation.token, username, readerPassword);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "comic-accounts-test-"));
  process.env.DATA_DIR = root;
  process.env.BOOKS_PASSWORD = initialPassword;
  delete process.env.ADMIN_USERNAME;
  delete process.env.PUBLIC_ORIGIN;
});

afterEach(async () => {
  const shared = globalThis as typeof globalThis & { __comicStore?: { db: { close(): void } }; __comicAccountAttempts?: Map<string, unknown> };
  shared.__comicStore?.db.close();
  delete shared.__comicStore;
  shared.__comicAccountAttempts?.clear();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

it("fails closed before first setup, including forged localhost hosts and password-only sign-in", async () => {
  delete process.env.BOOKS_PASSWORD;
  const forged = new Request("https://books.example/api/session", { headers: { Host: "localhost:3000" } });
  assert.throws(() => requireAuth(forged), errorStatus(503));
  const unconfigured = await sessionGET(forged);
  assert.equal(unconfigured.status, 503);
  assert.match((await unconfigured.json()).error, /BOOKS_PASSWORD/);
  process.env.BOOKS_PASSWORD = initialPassword;
  assert.equal((await sessionPOST(request("/api/session", "POST", { password: initialPassword }))).status, 401);
  assert.equal((await sessionGET(forged)).status, 200);
  assert.equal(authenticated(forged), false);
});

it("bootstraps the administrator once, preserves the old password, and migrates legacy progress", async () => {
  const id = randomUUID();
  store().db.prepare("INSERT INTO books (id,title,originalName,size,pageCount,currentPage,direction,fit,createdAt,lastReadAt,sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "Test fixture", "fixture.pdf", 100, 20, 8, "rtl", "width", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "a".repeat(64));
  process.env.ADMIN_USERNAME = "Owner.Name";
  ensureAccountState();
  const user = listUsers()[0];
  assert.equal(user.username, "Owner.Name");
  assert.equal(user.role, "admin");
  assert.equal(getBook(id, user.id).currentPage, 8);
  assert.equal(getBook(id, user.id).direction, "rtl");
  const originalHash = store().db.prepare("SELECT passwordHash FROM users WHERE id = ?").get(user.id) as { passwordHash: string };
  assert.match(originalHash.passwordHash, /^scrypt\$32768\$8\$3\$/);
  assert.ok(!originalHash.passwordHash.includes(initialPassword));
  process.env.ADMIN_USERNAME = "changed";
  process.env.BOOKS_PASSWORD = "changed-environment-password";
  ensureAccountState();
  assert.equal(listUsers().length, 1);
  assert.equal((await signIn("owner.name", initialPassword)).user.id, user.id);
  await assert.rejects(signIn("Owner.Name", "changed-environment-password"), errorStatus(401));
  delete process.env.BOOKS_PASSWORD;
  assert.equal((await signIn("OWNER.NAME", initialPassword)).user.id, user.id);
});

it("stores only opaque session hashes, expires sessions, and invalidates logout immediately", async () => {
  const first = await administrator();
  const second = await administrator();
  const token = first.cookie.split(";")[0].split("=")[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const row = store().db.prepare("SELECT tokenHash,expiresAt FROM sessions WHERE tokenHash = ?").get(createHash("sha256").update(token).digest("hex")) as { tokenHash: string; expiresAt: string };
  assert.notEqual(row.tokenHash, token);
  assert.ok(Date.parse(row.expiresAt) - Date.now() > 29 * 24 * 60 * 60 * 1000);
  const response = await sessionDELETE(request("/api/session", "DELETE", undefined, first.cookie));
  assert.equal(response.status, 200);
  assert.equal(authenticated(request(undefined, "GET", undefined, first.cookie)), false);
  assert.equal(authenticated(request(undefined, "GET", undefined, second.cookie)), true);
  store().db.prepare("UPDATE sessions SET expiresAt = '2000-01-01T00:00:00.000Z'").run();
  assert.equal(authenticated(request(undefined, "GET", undefined, second.cookie)), false);
  assert.throws(() => requireAuth(request(undefined, "GET", undefined, "comic_shelf_session=forged")), errorStatus(401));
});

it("restricts management to admins and creates single-use reader invitations without retaining raw tokens", async () => {
  const admin = await administrator();
  const response = await invitationsPOST(request("/api/admin/invitations", "POST", {}, admin.cookie));
  assert.equal(response.status, 201);
  const invitation = await response.json();
  const stored = store().db.prepare("SELECT tokenHash FROM invitations WHERE id = ?").get(invitation.invitation.id) as { tokenHash: string };
  assert.notEqual(stored.tokenHash, invitation.token);
  assert.equal(stored.tokenHash, createHash("sha256").update(invitation.token).digest("hex"));
  const inspection = await inspectPOST(request("/api/invitations/inspect", "POST", { token: invitation.token }));
  assert.deepEqual(await inspection.json(), { kind: "invite", username: null, expiresAt: invitation.invitation.expiresAt });
  const escalation = await registerPOST(request("/api/register", "POST", { token: invitation.token, username: "Alice", password: readerPassword, role: "admin" }));
  assert.equal(escalation.status, 400);
  const joined = await registerPOST(request("/api/register", "POST", { token: invitation.token, username: "Alice", password: readerPassword }));
  assert.equal(joined.status, 201);
  const data = await joined.json();
  assert.equal(data.user.role, "reader");
  assert.equal(data.user.username, "Alice");
  assert.equal(data.passwordRequired, true);
  const cookie = joined.headers.get("set-cookie")!;
  assert.throws(() => requireAdmin(request(undefined, "GET", undefined, cookie)), errorStatus(403));
  assert.equal((await usersGET(request("/api/admin/users", "GET", undefined, cookie))).status, 403);
  assert.equal((await invitationsPOST(request("/api/admin/invitations", "POST", {}, cookie))).status, 403);
  assert.throws(() => inspectInvitation(invitation.token), errorStatus(400));
  await assert.rejects(registerAccount(invitation.token, "another", readerPassword), errorStatus(400));
  assert.equal((await signIn("alice", readerPassword)).user.id, data.user.id);
  const listing = await usersGET(request("/api/admin/users", "GET", undefined, admin.cookie));
  const users = (await listing.json()).users;
  assert.equal(users.length, 2);
  assert.ok(users.every((user: Record<string, unknown>) => !("passwordHash" in user)));
  const activeInvites = await invitationsGET(request("/api/admin/invitations", "GET", undefined, admin.cookie));
  assert.deepEqual((await activeInvites.json()).invitations, []);
});

it("rejects revoked and expired invitations and consumes concurrent registration atomically", async () => {
  const admin = await administrator();
  const expired = createInvitation();
  store().db.prepare("UPDATE invitations SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.invitation.id);
  assert.throws(() => inspectInvitation(expired.token), errorStatus(400));
  const revoked = createInvitation();
  assert.equal((await invitationsDELETE(request("/api/admin/invitations", "DELETE", undefined, admin.cookie), { params: Promise.resolve({ id: revoked.invitation.id }) })).status, 204);
  assert.throws(() => inspectInvitation(revoked.token), errorStatus(400));
  const invitation = createInvitation();
  const outcomes = await Promise.allSettled([registerAccount(invitation.token, "reader-a", readerPassword), registerAccount(invitation.token, "reader-b", readerPassword)]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(listUsers().length, 2);
  assert.deepEqual(listInvitations(), []);
});

it("validates usernames and passwords without consuming an invitation on a rejected registration", async () => {
  await administrator();
  const invitation = createInvitation();
  for (const username of ["a", "white space", "한글계정", "-starts-wrong", "a".repeat(33)]) {
    await assert.rejects(registerAccount(invitation.token, username, readerPassword), errorStatus(400));
  }
  for (const password of ["short", "x".repeat(129), null]) {
    await assert.rejects(registerAccount(invitation.token, "valid.name", password), errorStatus(400));
  }
  assert.equal(inspectInvitation(invitation.token).kind, "invite");
  const spaced = "  twelve chars  ";
  assert.equal(validatePassword(spaced), spaced);
  const joined = await registerAccount(invitation.token, "Mixed.Case", spaced);
  await assert.rejects(signIn("mixed.case", spaced.trim()), errorStatus(401));
  assert.equal((await signIn("mixed.case", spaced)).user.id, joined.user.id);
  const duplicate = createInvitation();
  await assert.rejects(registerAccount(duplicate.token, "mixed.CASE", readerPassword), errorStatus(409));
  assert.equal(inspectInvitation(duplicate.token).kind, "invite");
});

it("blocks readers immediately, invalidates existing sessions, and forbids blocking the administrator", async () => {
  const admin = await administrator();
  const member = await reader();
  const context = { params: Promise.resolve({ id: member.user.id }) };
  assert.equal((await usersPATCH(request("/api/admin/users", "PATCH", { disabled: true }, member.cookie), context)).status, 403);
  const blocked = await usersPATCH(request("/api/admin/users", "PATCH", { disabled: true }, admin.cookie), context);
  assert.equal(blocked.status, 200);
  assert.equal(authenticated(request(undefined, "GET", undefined, member.cookie)), false);
  await assert.rejects(signIn(member.user.username, readerPassword), errorStatus(401));
  assert.throws(() => setUserDisabled(admin.user.id, true), errorStatus(403));
  setUserDisabled(member.user.id, false);
  assert.equal(authenticated(request(undefined, "GET", undefined, member.cookie)), false);
  assert.equal((await signIn(member.user.username, readerPassword)).user.id, member.user.id);
});

it("changes passwords with the current password and invalidates every old session while issuing a new one", async () => {
  await administrator();
  const member = await reader();
  const second = await login(request(), member.user.username, readerPassword);
  const changedPassword = "changed password 456";
  const bad = await sessionPATCH(request("/api/session", "PATCH", { currentPassword: "wrong", newPassword: changedPassword }, member.cookie));
  assert.equal(bad.status, 400);
  assert.equal(authenticated(request(undefined, "GET", undefined, member.cookie)), true);
  const response = await sessionPATCH(request("/api/session", "PATCH", { currentPassword: readerPassword, newPassword: changedPassword }, member.cookie));
  assert.equal(response.status, 200);
  assert.equal(authenticated(request(undefined, "GET", undefined, member.cookie)), false);
  assert.equal(authenticated(request(undefined, "GET", undefined, second.cookie)), false);
  assert.equal(currentUser(request(undefined, "GET", undefined, response.headers.get("set-cookie")!))?.id, member.user.id);
  await assert.rejects(signIn(member.user.username, readerPassword), errorStatus(401));
  await signIn(member.user.username, changedPassword);
});

it("resets only the invited reader, fixes its username, and invalidates old passwords and sessions", async () => {
  const admin = await administrator();
  const member = await reader();
  const reset = createInvitation(member.user.id);
  assert.deepEqual(inspectInvitation(reset.token), { kind: "reset", username: member.user.username, expiresAt: reset.invitation.expiresAt });
  assert.throws(() => createInvitation(admin.user.id), errorStatus(400));
  await assert.rejects(registerAccount(reset.token, "someone-else", "reset password 789"), errorStatus(400));
  const changed = await register(request(), reset.token, member.user.username, "reset password 789");
  assert.equal(changed.user.id, member.user.id);
  assert.equal(changed.user.role, "reader");
  assert.equal(authenticated(request(undefined, "GET", undefined, member.cookie)), false);
  assert.equal(authenticated(request(undefined, "GET", undefined, changed.cookie)), true);
  await assert.rejects(signIn(member.user.username, readerPassword), errorStatus(401));
  assert.throws(() => inspectInvitation(reset.token), errorStatus(400));
  const invalidated = createInvitation(member.user.id);
  setUserDisabled(member.user.id, true);
  assert.throws(() => inspectInvitation(invalidated.token), errorStatus(400));
});

it("protects account mutations from other origins and uses generic login failures", async () => {
  const admin = await administrator();
  const badOrigin = "https://evil.example";
  assert.equal((await invitationsPOST(request("/api/admin/invitations", "POST", {}, admin.cookie, badOrigin))).status, 403);
  const invitation = createInvitation();
  assert.equal((await registerPOST(request("/api/register", "POST", { token: invitation.token, username: "reader-a", password: readerPassword }, undefined, badOrigin))).status, 403);
  const unknown = await sessionPOST(request("/api/session", "POST", { username: "does-not-exist", password: readerPassword }));
  const wrong = await sessionPOST(request("/api/session", "POST", { username: "admin", password: readerPassword }));
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json());
});

it("limits simultaneous expensive hashes and rejects malformed stored hashes", async () => {
  const outcomes = await Promise.allSettled([hashPassword(readerPassword), hashPassword(readerPassword), hashPassword(readerPassword)]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 2);
  const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal((rejected.reason as ApiError).status, 429);
  const hashes = outcomes.filter(result => result.status === "fulfilled") as PromiseFulfilledResult<string>[];
  assert.notEqual(hashes[0].value, hashes[1].value);
  assert.equal(await verifyPassword(readerPassword, hashes[0].value), true);
  assert.equal(await verifyPassword("wrong", hashes[0].value), false);
  assert.equal(await verifyPassword(readerPassword, "scrypt$invalid"), false);
  assert.equal(await verifyPassword(readerPassword, null), false);
});

it("recovers only the existing administrator using the standalone Node script and invalidates its sessions", async () => {
  const admin = await administrator();
  const member = await reader();
  await mkdir(join(root, "scripts"));
  await copyFile(join(process.cwd(), "scripts/reset-admin-password.mjs"), join(root, "scripts/reset-admin-password.mjs"));
  const recovered = "locally recovered password";
  await writeFile(join(root, ".env.local"), `DATA_DIR=${root}\nADMIN_USERNAME=admin\nBOOKS_PASSWORD=${recovered}\n`, { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, "scripts/reset-admin-password.mjs")]);
  assert.match(stdout, /Administrator password updated/);
  assert.ok(!stdout.includes(recovered));
  assert.equal(authenticated(request(undefined, "GET", undefined, admin.cookie)), false);
  assert.equal(authenticated(request(undefined, "GET", undefined, member.cookie)), true);
  await signIn("admin", recovered);
  await assert.rejects(signIn("admin", initialPassword), errorStatus(401));
  assert.equal(listUsers().length, 2);
});
