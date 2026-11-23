import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET as connect } from "../app/quiz/connect/route";
import { POST as exchange } from "../app/api/quiz/exchange/route";
import { POST as identity } from "../app/api/quiz/identity/route";
import { POST as revoke } from "../app/api/quiz/revoke/route";
import { changeAccountPassword, createInvitation, registerAccount, revokeSession, sessionUser, setUserDisabled, signIn, tokenHash } from "../lib/server/accounts";
import { store } from "../lib/server/storage";

const original = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME, QUIZ_PUBLIC_ORIGIN: process.env.QUIZ_PUBLIC_ORIGIN };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shelf-quiz-account-"));
  Object.assign(process.env, { DATA_DIR: root, BOOKS_PASSWORD: "Test pass", ADMIN_USERNAME: "owner", QUIZ_PUBLIC_ORIGIN: "https://quiz.example" });
});
afterEach(async () => {
  const shared = globalThis as typeof globalThis & { __comicStore?: ReturnType<typeof store> };
  shared.__comicStore?.db.close();
  delete shared.__comicStore;
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
const token = () => randomBytes(32).toString("base64url");
function authorization(session?: string) {
  const state = token();
  const verifier = token();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("https://books.example/quiz/connect");
  url.search = new URLSearchParams({ state, challenge, redirect_uri: "https://other.example/" }).toString();
  const response = connect(new Request(url, session ? { headers: { Cookie: "comic_shelf_session=" + session } } : {}));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { response, state, verifier, challenge };
}
function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://books.example/api/quiz", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function codeFor(session: string) {
  const { response, verifier, state } = authorization(session);
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin + location.pathname, "https://quiz.example/api/auth/callback");
  assert.equal(location.searchParams.get("state"), state);
  return { code: location.searchParams.get("code")!, verifier };
}
async function grantFor(session: string) {
  const response = await exchange(post(codeFor(session)));
  assert.equal(response.status, 200);
  return (await response.json()).grant as string;
}
it("continues native login with fixed handoff parameters and validates the configured callback", () => {
  const { response, state, challenge } = authorization();
  assert.equal(response.status, 303);
  const login = new URL(response.headers.get("location")!, "https://books.example");
  assert.equal(login.origin + login.pathname, "https://books.example/");
  assert.equal(login.searchParams.get("state"), state);
  assert.equal(login.searchParams.get("challenge"), challenge);
  assert.equal(login.searchParams.get("quiz"), "1");
  assert.equal(login.searchParams.has("redirect_uri"), false);
  assert.equal(connect(new Request("https://books.example/quiz/connect?challenge=no")).status, 400);
  process.env.QUIZ_PUBLIC_ORIGIN = "http://localhost:3218";
  assert.equal(authorization().response.status, 303);
  for (const value of ["http://quiz.example", "https://quiz.example/redirect", "https://user@quiz.example", ""]) {
    process.env.QUIZ_PUBLIC_ORIGIN = value;
    assert.equal(authorization().response.status, 503);
  }
});
it("exchanges each code once with its verifier and limits the grant to account identity", async () => {
  const { token: session, user } = await signIn("owner", "Test pass");
  const { code, verifier } = codeFor(session);
  assert.equal((await identity(post({ grant: code }))).status, 401);
  assert.equal((await exchange(post({ code, verifier: token() }))).status, 401);
  const responses = await Promise.all([exchange(post({ code, verifier })), exchange(post({ code, verifier }))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  const { grant, expiresAt, user: exchangedUser } = await responses.find(response => response.ok)!.json();
  assert.deepEqual(exchangedUser, { id: user.id, username: user.username });
  assert.ok(Date.parse(expiresAt) > Date.now());
  assert.equal(sessionUser(grant), null);
  const info = await identity(post({ grant }));
  assert.deepEqual(await info.json(), { user: exchangedUser });
  const row = store().db.prepare("SELECT tokenHash, sessionHash FROM quiz_credentials").get();
  assert.equal(row?.tokenHash, tokenHash(grant));
  assert.equal(row?.sessionHash, tokenHash(session));
  for (const endpoint of [exchange, identity, revoke]) {
    assert.equal((await endpoint(post({ code, verifier, grant }, { Origin: "https://other.example" }))).status, 403);
    assert.equal((await endpoint(post({ code, verifier, grant }, { "Sec-Fetch-Site": "same-site" }))).status, 403);
  }
  assert.equal((await revoke(post({ grant }))).status, 200);
  assert.equal((await revoke(post({ grant }))).status, 200);
  assert.equal((await identity(post({ grant }))).status, 401);
  assert.equal(sessionUser(session)?.id, user.id);
});
it("expires pending codes and stops quiz access when the underlying session expires or is revoked", async () => {
  const admin = await signIn("owner", "Test pass");
  const expired = codeFor(admin.token);
  const db = store().db;
  db.prepare("UPDATE quiz_credentials SET expiresAt = ?").run(new Date(0).toISOString());
  assert.equal((await exchange(post(expired))).status, 401);
  const grant = await grantFor(admin.token);
  db.prepare("UPDATE sessions SET expiresAt = ?").run(new Date(0).toISOString());
  assert.equal((await identity(post({ grant }))).status, 401);
  const reader = await registerAccount(createInvitation().token, "Reader", "readerPass");
  let next = await grantFor(reader.token);
  revokeSession(reader.token);
  assert.equal((await identity(post({ grant: next }))).status, 401);
  const renewed = await signIn("Reader", "readerPass");
  next = await grantFor(renewed.token);
  const changed = await changeAccountPassword(reader.user.id, "readerPass", "updatedPass");
  assert.equal((await identity(post({ grant: next }))).status, 401);
  const disabled = await grantFor(changed.token);
  setUserDisabled(reader.user.id, true);
  assert.equal((await identity(post({ grant: disabled }))).status, 401);
});
