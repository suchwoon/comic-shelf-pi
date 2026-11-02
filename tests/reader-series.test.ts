import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Book } from "../lib/types";
import { store, updateBookMetadata, updateProgress } from "../lib/server/storage";
import { login, register } from "../lib/server/auth";
import { createInvitation } from "../lib/server/accounts";
import { GET } from "../app/api/books/[id]/route";

let root: string;
const originalEnv = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD, ADMIN_USERNAME: process.env.ADMIN_USERNAME, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "comic-reader-series-test-"));
  process.env.DATA_DIR = root;
  process.env.BOOKS_PASSWORD = "reader-series-test-password";
  delete process.env.ADMIN_USERNAME;
  delete process.env.PUBLIC_ORIGIN;
});
afterEach(async () => {
  const shared = globalThis as typeof globalThis & { __comicStore?: { db: DatabaseSync }; __comicAccountAttempts?: Map<string, unknown> };
  shared.__comicStore?.db.close();
  delete shared.__comicStore;
  shared.__comicAccountAttempts?.clear();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function insert(title: string, installmentNumber: number | null, seriesTitle: string | null = "Reader series") {
  const id = randomUUID();
  store().db.prepare(`INSERT INTO books (id, title, originalName, size, pageCount, currentPage, direction, fit, createdAt, lastReadAt, sha256)
    VALUES (?, ?, ?, 100, 20, 8, 'ltr', 'width', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', ?)`)
    .run(id, title, `${id}.pdf`, id);
  return updateBookMetadata(id, { seriesTitle, installmentType: installmentNumber === null ? null : "volume", installmentNumber });
}
function get(id: string, cookie?: string, extraHeaders: Record<string, string> = {}) {
  return GET(new Request(`http://localhost:3000/api/books/${id}`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
  }), { params: Promise.resolve({ id }) });
}
function administrator() {
  return login(new Request("http://localhost:3000/api/session"), "admin", "reader-series-test-password");
}

it("returns only the current series in installment order with each account's personal progress", async () => {
  const admin = await administrator();
  const invitation = createInvitation();
  const reader = await register(new Request("http://localhost:3000/api/session"), invitation.token, "reader", "reader-test-password");
  // Insert out of order, including gaps, decimals, duplicate numbers and extras.
  const tenth = insert("Volume 10", 10);
  const extraTenth = insert("Special 10", null);
  const secondB = insert("Volume 2 B", 2);
  const first = insert("Volume 1", 1);
  const decimal = insert("Volume 2.5", 2.5);
  const secondA = insert("Volume 2 A", 2);
  const extraSecond = insert("Special 2", null);
  const unrelated = insert("Other series 1", 1, "Other series");
  const standalone = insert("Standalone", null, null);
  updateProgress(secondA.id, { currentPage: 13, direction: "ltr", fit: "width" }, admin.user.id);
  updateProgress(secondA.id, { currentPage: 3, direction: "rtl", fit: "page" }, reader.user.id);
  updateProgress(tenth.id, { currentPage: 7 }, admin.user.id);
  const order = [first, secondA, secondB, decimal, tenth, extraSecond, extraTenth].map(book => book.id);

  const readerResponse = await get(secondA.id, reader.cookie);
  assert.equal(readerResponse.status, 200);
  assert.equal(readerResponse.headers.get("cache-control"), "no-store");
  const data = await readerResponse.json() as { book: Book; seriesBooks: Book[] };
  assert.deepEqual(data.seriesBooks.map(book => book.id), order);
  assert.ok(data.seriesBooks.every(book => book.seriesId === secondA.seriesId));
  assert.ok(!data.seriesBooks.some(book => book.id === unrelated.id || book.id === standalone.id));
  assert.deepEqual(data.seriesBooks.find(book => book.id === secondA.id), data.book);
  assert.equal(data.book.currentPage, 3);
  assert.equal(data.book.direction, "rtl");
  assert.equal(data.book.fit, "page");
  const unread = data.seriesBooks.find(book => book.id === tenth.id)!;
  assert.equal(unread.currentPage, 1);
  assert.equal(unread.direction, "rtl");
  assert.equal(unread.fit, "page");
  assert.equal(unread.lastReadAt, null);

  const adminData = await (await get(secondA.id, admin.cookie)).json() as { book: Book; seriesBooks: Book[] };
  assert.deepEqual(adminData.seriesBooks.map(book => book.id), order);
  assert.equal(adminData.book.currentPage, 13);
  assert.equal(adminData.book.direction, "ltr");
  assert.equal(adminData.seriesBooks.find(book => book.id === tenth.id)!.currentPage, 7);
});

it("keeps standalone and single-book series responses distinct, with authentication and missing-book protections", async () => {
  const admin = await administrator();
  const standalone = insert("Standalone", null, null);
  const only = insert("Only volume", 1, "Single-book series");
  const standaloneResponse = await get(standalone.id, admin.cookie);
  assert.equal(standaloneResponse.status, 200);
  const standaloneData = await standaloneResponse.json() as { book: Book; seriesBooks: Book[] };
  assert.equal(standaloneData.book.id, standalone.id);
  assert.deepEqual(standaloneData.seriesBooks, []);
  const onlyData = await (await get(only.id, admin.cookie)).json() as { book: Book; seriesBooks: Book[] };
  assert.deepEqual(onlyData.seriesBooks, [onlyData.book]);

  for (const [response, expected] of [
    [await get(only.id), 401],
    [await get(only.id, "comic_shelf_session=invalid"), 401],
    [await get(only.id, admin.cookie, { "Sec-Fetch-Site": "cross-site" }), 403],
    [await get(randomUUID(), admin.cookie), 404],
    [await get("invalid-id", admin.cookie), 404],
  ] as const) {
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal(body.book, undefined);
    assert.equal(body.seriesBooks, undefined);
  }
});
