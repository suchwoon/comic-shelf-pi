import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/chat/route";
import { createInvitation, setUserDisabled } from "../lib/server/accounts";
import { login, register } from "../lib/server/auth";
import { store } from "../lib/server/storage";
import { CHAT_HISTORY_LIMIT, CHAT_MESSAGE_LIMIT, type ChatMessage } from "../lib/types";

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
};
let root: string;

function closeStore() {
  const shared = globalThis as typeof globalThis & { __comicStore?: { db: { close(): void } } };
  shared.__comicStore?.db.close();
  delete shared.__comicStore;
}

function request(method = "GET", cookie?: string, body?: unknown, origin = "http://localhost:3000") {
  const headers = new Headers({ Origin: origin });
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("http://localhost:3000/api/chat", {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function administrator() { return login(request(), "admin", "chat-test-password"); }
async function reader() { return register(request(), createInvitation().token, "reader.one", "reader-test-password"); }
async function send(cookie: string, body: string, clientId: string = randomUUID()) {
  return POST(request("POST", cookie, { body, clientId }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "comic-chat-test-"));
  process.env.DATA_DIR = root;
  process.env.BOOKS_PASSWORD = "chat-test-password";
  delete process.env.ADMIN_USERNAME;
  delete process.env.PUBLIC_ORIGIN;
});

afterEach(async () => {
  closeStore();
  const shared = globalThis as typeof globalThis & { __comicAccountAttempts?: Map<string, unknown> };
  shared.__comicAccountAttempts?.clear();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

it("requires a valid session to read or write and rejects requests from other origins", async () => {
  assert.equal((await GET(request())).status, 401);
  assert.equal((await POST(request("POST", undefined, { body: "hello", clientId: randomUUID() }))).status, 401);
  assert.equal((await GET(request("GET", "comic_shelf_session=forged"))).status, 401);
  const admin = await administrator();
  assert.equal((await GET(request("GET", admin.cookie, undefined, "https://other.example"))).status, 403);
  assert.equal((await POST(request("POST", admin.cookie, { body: "hello", clientId: randomUUID() }, "https://other.example"))).status, 403);
  assert.deepEqual(await (await GET(request("GET", admin.cookie))).json(), { messages: [] });
});

it("lets readers participate with their authenticated identity and keeps messages as plain text", async () => {
  const admin = await administrator();
  const member = await reader();
  const body = "안녕하세요 👋\n<script>alert('hello')</script>";
  const response = await send(member.cookie, `  ${body}  `);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { message } = await response.json() as { message: ChatMessage };
  assert.equal(message.id, 1);
  assert.equal(message.userId, member.user.id);
  assert.equal(message.username, member.user.username);
  assert.equal(message.body, body);
  assert.ok(Number.isFinite(Date.parse(message.createdAt)));
  assert.deepEqual(Object.keys(message).sort(), ["body", "createdAt", "id", "userId", "username"]);
  const listing = await GET(request("GET", admin.cookie));
  assert.equal(listing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listing.json(), { messages: [message] });
  for (const identity of [{ userId: admin.user.id }, { username: "admin" }, { createdAt: "2020-01-01" }]) {
    const forged = await POST(request("POST", member.cookie, { body: "spoof", clientId: randomUUID(), ...identity }));
    assert.equal(forged.status, 400);
  }
  assert.equal((await (await GET(request("GET", member.cookie))).json()).messages.length, 1);
});

it("blocks existing reader sessions immediately for both history and sending", async () => {
  const admin = await administrator();
  const member = await reader();
  assert.equal((await send(member.cookie, "before blocking")).status, 201);
  setUserDisabled(member.user.id, true);
  assert.equal((await GET(request("GET", member.cookie))).status, 401);
  assert.equal((await send(member.cookie, "after blocking")).status, 401);
  const { messages } = await (await GET(request("GET", admin.cookie))).json() as { messages: ChatMessage[] };
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "before blocking");
});

it("validates text and client IDs before storage and bounds the JSON request size", async () => {
  const admin = await administrator();
  for (const body of [undefined, null, 42, {}, "", " \n\t ", "x".repeat(CHAT_MESSAGE_LIMIT + 1), "bad\u0000text", "bad\u001btext"]) {
    assert.equal((await POST(request("POST", admin.cookie, { body, clientId: randomUUID() }))).status, 400);
  }
  for (const clientId of [undefined, null, 123, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
    assert.equal((await POST(request("POST", admin.cookie, { body: "hello", clientId }))).status, 400);
  }
  assert.equal((await POST(request("POST", admin.cookie, []))).status, 400);
  assert.equal((await send(admin.cookie, "x".repeat(17_000))).status, 413);
  assert.deepEqual(await (await GET(request("GET", admin.cookie))).json(), { messages: [] });
  const maximum = await send(admin.cookie, "한".repeat(CHAT_MESSAGE_LIMIT));
  assert.equal(maximum.status, 201);
  assert.equal((await maximum.json()).message.body.length, CHAT_MESSAGE_LIMIT);
});

it("returns the latest 50 messages in stable chronological order after reopening storage", async () => {
  const admin = await administrator();
  await GET(request("GET", admin.cookie));
  const insert = store().db.prepare("INSERT INTO chat_messages (userId, clientId, body, createdAt) VALUES (?, ?, ?, ?)");
  for (let index = 1; index <= CHAT_HISTORY_LIMIT + 7; index++) {
    insert.run(admin.user.id, randomUUID(), `Message ${index}`, "2026-01-01T00:00:00.000Z");
  }
  closeStore();
  const response = await GET(request("GET", admin.cookie));
  assert.equal(response.status, 200);
  const { messages } = await response.json() as { messages: ChatMessage[] };
  assert.equal(messages.length, CHAT_HISTORY_LIMIT);
  assert.deepEqual(messages.map(message => message.id), Array.from({ length: CHAT_HISTORY_LIMIT }, (_, index) => index + 8));
  assert.equal(messages[0].body, "Message 8");
  assert.equal(messages.at(-1)?.body, `Message ${CHAT_HISTORY_LIMIT + 7}`);
  assert.ok(messages.every(message => message.username === admin.user.username));
});

it("deduplicates concurrent and later retries per user without rewriting the original message", async () => {
  const admin = await administrator();
  const member = await reader();
  const clientId = randomUUID();
  const results = await Promise.all([send(admin.cookie, "original", clientId), send(admin.cookie, "original", clientId.toUpperCase())]);
  assert.ok(results.every(response => response.status === 201));
  const first = await results[0].json();
  assert.deepEqual(await results[1].json(), first);
  closeStore();
  const retried = await send(admin.cookie, "changed contents", clientId);
  assert.equal(retried.status, 201);
  assert.deepEqual(await retried.json(), first);
  const otherUser = await send(member.cookie, "another user", clientId);
  assert.equal(otherUser.status, 201);
  assert.notEqual((await otherUser.json()).message.id, first.message.id);
  assert.equal((await (await GET(request("GET", admin.cookie))).json()).messages.length, 2);
});

it("limits each user to 20 new messages per rolling minute while allowing retries and later messages", async () => {
  const admin = await administrator();
  const member = await reader();
  const clientId = randomUUID();
  const first = await send(admin.cookie, "first", clientId);
  const original = await first.json();
  for (let index = 1; index < 20; index++) assert.equal((await send(admin.cookie, `Message ${index}`)).status, 201);
  assert.equal((await send(admin.cookie, "too many")).status, 429);
  assert.deepEqual(await (await send(admin.cookie, "first", clientId)).json(), original);
  closeStore();
  assert.equal((await send(admin.cookie, "still too many")).status, 429);
  assert.equal((await send(member.cookie, "other user can send")).status, 201);
  store().db.prepare("UPDATE chat_messages SET createdAt = ? WHERE userId = ?")
    .run(new Date(Date.now() - 60_001).toISOString(), admin.user.id);
  assert.equal((await send(admin.cookie, "the next minute")).status, 201);
  const { messages } = await (await GET(request("GET", admin.cookie))).json() as { messages: ChatMessage[] };
  assert.equal(messages.length, 22);
  assert.equal(messages.at(-1)?.body, "the next minute");
});
