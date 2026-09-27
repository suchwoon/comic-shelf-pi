import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { clearProgress, getBook, listBooks, migrateLegacyProgress, store, updateProgress } from "../lib/server/storage";
import { ApiError } from "../lib/server/http";

let dataDir: string;
const previousDataDir = process.env.DATA_DIR;
const writerA = "reader-a-000000000000";
const writerB = "reader-b-000000000000";

function closeStore() {
  const state = globalThis as typeof globalThis & { __comicStore?: { db: { close(): void } } };
  state.__comicStore?.db.close();
  delete state.__comicStore;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "comic-progress-storage-"));
  process.env.DATA_DIR = dataDir;
});

after(async () => {
  closeStore();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

function createBook() {
  const id = randomUUID();
  store().db.prepare(`INSERT INTO books (id, title, originalName, size, pageCount, createdAt, sha256)
    VALUES (?, 'Progress fixture', 'progress.pdf', 100, 10, ?, ?)`).run(id, new Date().toISOString(), id);
  return id;
}

function createUser() {
  // Account initialization owns this table; these tests exercise storage only.
  store().db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL, role TEXT NOT NULL, createdAt TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  )`);
  const id = randomUUID();
  store().db.prepare("INSERT INTO users (id, username, passwordHash, role, createdAt) VALUES (?, ?, 'unused-test-hash', 'reader', ?)")
    .run(id, `user-${id}`, new Date().toISOString());
  return id;
}

it("a delayed older save cannot overwrite the later sequence, including after reopening storage", async () => {
  const id = createBook();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const olderRequest = (async () => {
    await gate;
    return updateProgress(id, { currentPage: 2, direction: "ltr", writerId: writerA, sequence: 1 });
  })();
  updateProgress(id, { currentPage: 3, direction: "rtl", writerId: writerA, sequence: 2 });
  closeStore();
  release();
  assert.equal((await olderRequest).currentPage, 3);
  assert.equal(getBook(id).direction, "rtl");
  const timestamp = getBook(id).lastReadAt;
  updateProgress(id, { currentPage: 1, writerId: writerA, sequence: 2 });
  assert.equal(getBook(id).currentPage, 3);
  assert.equal(getBook(id).lastReadAt, timestamp);
});

it("newer saves can move backwards and separate devices still use arrival order", () => {
  const id = createBook();
  updateProgress(id, { currentPage: 8, writerId: writerA, sequence: 4 });
  updateProgress(id, { currentPage: 2, writerId: writerA, sequence: 5 });
  assert.equal(getBook(id).currentPage, 2);
  updateProgress(id, { currentPage: 6, writerId: writerB, sequence: 1 });
  assert.equal(getBook(id).currentPage, 6);
  updateProgress(id, { currentPage: 8, writerId: writerA, sequence: 4 });
  assert.equal(getBook(id).currentPage, 6);
  updateProgress(id, { currentPage: 3, writerId: writerA, sequence: 6 });
  assert.equal(getBook(id).currentPage, 3);
});

it("legacy partial updates preserve settings and do not reset sequence protection", () => {
  const id = createBook();
  updateProgress(id, { currentPage: 7, direction: "rtl", fit: "width", writerId: writerA, sequence: 2 });
  updateProgress(id, { currentPage: 4 });
  assert.equal(getBook(id).direction, "rtl");
  assert.equal(getBook(id).fit, "width");
  updateProgress(id, { currentPage: 2, writerId: writerA, sequence: 1 });
  assert.equal(getBook(id).currentPage, 4);
});

it("rejects malformed sequence metadata atomically and removes writer state with its book", () => {
  const id = createBook();
  for (const invalid of [
    { writerId: writerA }, { sequence: 1 }, { writerId: "x", sequence: 1 },
    { writerId: writerA, sequence: 0 }, { writerId: writerA, sequence: 1.5 },
    { writerId: writerA, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { writerId: writerA, sequence: 1, direction: "invalid" },
  ]) {
    assert.throws(() => updateProgress(id, { currentPage: 2, ...invalid }),
      error => error instanceof ApiError && error.status === 400);
    assert.equal(getBook(id).currentPage, 1);
  }
  updateProgress(id, { currentPage: 4, writerId: writerA, sequence: 1 });
  assert.equal(getBook(id).currentPage, 4);
  store().db.prepare("DELETE FROM books WHERE id = ?").run(id);
  assert.equal(store().db.prepare("SELECT COUNT(*) AS count FROM progress_writers WHERE bookId = ?").get(id)?.count, 0);
});

it("each account starts fresh and keeps its own page, direction, fit and reading timestamp", () => {
  const id = createBook();
  const alice = createUser();
  const bob = createUser();
  updateProgress(id, { currentPage: 9, direction: "rtl", fit: "width" });
  for (const user of [alice, bob]) {
    const fresh = getBook(id, user);
    assert.equal(fresh.currentPage, 1);
    assert.equal(fresh.direction, "ltr");
    assert.equal(fresh.fit, "page");
    assert.equal(fresh.lastReadAt, null);
  }
  updateProgress(id, { currentPage: 4, direction: "rtl", fit: "width" }, alice);
  assert.equal(getBook(id, bob).currentPage, 1);
  assert.equal(getBook(id, bob).lastReadAt, null);
  updateProgress(id, { currentPage: 2 }, bob);
  const aliceBook = listBooks(alice).find(book => book.id === id)!;
  const bobBook = listBooks(bob).find(book => book.id === id)!;
  assert.deepEqual([aliceBook.currentPage, aliceBook.direction, aliceBook.fit], [4, "rtl", "width"]);
  assert.deepEqual([bobBook.currentPage, bobBook.direction, bobBook.fit], [2, "ltr", "page"]);
  assert.ok(aliceBook.lastReadAt);
  assert.ok(bobBook.lastReadAt);
  assert.equal(getBook(id).currentPage, 9);
  closeStore();
  assert.equal(getBook(id, alice).currentPage, 4);
  assert.equal(getBook(id, bob).currentPage, 2);
});

it("writer sequence collisions across accounts do not suppress or overwrite their progress", () => {
  const id = createBook();
  const alice = createUser();
  const bob = createUser();
  updateProgress(id, { currentPage: 6, writerId: writerA, sequence: 20 }, alice);
  updateProgress(id, { currentPage: 2, writerId: writerA, sequence: 1 }, bob);
  updateProgress(id, { currentPage: 4, writerId: writerA, sequence: 19 }, alice);
  assert.equal(getBook(id, alice).currentPage, 6);
  assert.equal(getBook(id, bob).currentPage, 2);
  updateProgress(id, { currentPage: 3, writerId: writerA, sequence: 2 }, bob);
  assert.equal(getBook(id, alice).currentPage, 6);
  assert.equal(getBook(id, bob).currentPage, 3);
});

it("clearing history resets only that account and book while keeping reading preferences", () => {
  const id = createBook();
  const anotherId = createBook();
  const alice = createUser();
  const bob = createUser();
  updateProgress(id, { currentPage: 9 });
  updateProgress(id, { currentPage: 7, direction: "rtl", fit: "width" }, alice);
  updateProgress(id, { currentPage: 4 }, bob);
  updateProgress(anotherId, { currentPage: 6 }, alice);
  const bobBefore = getBook(id, bob);
  const anotherBefore = getBook(anotherId, alice);
  const legacyBefore = getBook(id);

  const cleared = clearProgress(id, alice);
  assert.deepEqual([cleared.currentPage, cleared.lastReadAt, cleared.direction, cleared.fit], [1, null, "rtl", "width"]);
  assert.deepEqual(getBook(id, bob), bobBefore);
  assert.deepEqual(getBook(anotherId, alice), anotherBefore);
  assert.deepEqual(getBook(id), legacyBefore);
  closeStore();
  assert.deepEqual(getBook(id, alice), cleared);
  assert.deepEqual(listBooks(alice).find(book => book.id === id), cleared);
});

it("clearing history preserves sequence protection and allows fresh progress afterwards", () => {
  const id = createBook();
  const user = createUser();
  updateProgress(id, { currentPage: 4, writerId: writerA, sequence: 2 }, user);
  clearProgress(id, user);
  closeStore();
  for (const sequence of [1, 2]) {
    const ignored = updateProgress(id, { currentPage: 3, writerId: writerA, sequence }, user);
    assert.equal(ignored.currentPage, 1);
    assert.equal(ignored.lastReadAt, null);
  }
  const resumed = updateProgress(id, { currentPage: 5, writerId: writerA, sequence: 3 }, user);
  assert.equal(resumed.currentPage, 5);
  assert.ok(resumed.lastReadAt);
  clearProgress(id, user);
  const reopened = updateProgress(id, { currentPage: 2, writerId: writerB, sequence: 1 }, user);
  assert.equal(reopened.currentPage, 2);
  assert.ok(reopened.lastReadAt);
});

it("clearing history is idempotent, works for unread books and rejects missing books", () => {
  const id = createBook();
  const user = createUser();
  const fresh = getBook(id, user);
  assert.deepEqual(clearProgress(id, user), fresh);
  updateProgress(id, { currentPage: 10 }, user);
  const cleared = clearProgress(id, user);
  assert.deepEqual(clearProgress(id, user), cleared);
  for (const missingId of ["invalid", randomUUID()]) {
    assert.throws(() => clearProgress(missingId, user), error => error instanceof ApiError && error.status === 404);
  }
  // Failed clears leave the connection ready for a subsequent transaction.
  assert.deepEqual(clearProgress(id, user), cleared);
});

it("legacy progress migration is scoped to its administrator and is idempotent", () => {
  const id = createBook();
  const admin = createUser();
  const reader = createUser();
  updateProgress(id, { currentPage: 5, direction: "rtl", fit: "width", writerId: writerA, sequence: 3 });
  migrateLegacyProgress(admin);
  const inherited = getBook(id, admin);
  assert.deepEqual([inherited.currentPage, inherited.direction, inherited.fit], [5, "rtl", "width"]);
  assert.equal(inherited.lastReadAt, getBook(id).lastReadAt);
  assert.equal(getBook(id, reader).currentPage, 1);
  assert.equal(getBook(id, reader).lastReadAt, null);
  updateProgress(id, { currentPage: 2, writerId: writerA, sequence: 2 }, admin);
  assert.equal(getBook(id, admin).currentPage, 5);
  updateProgress(id, { currentPage: 7, writerId: writerA, sequence: 4 }, admin);
  migrateLegacyProgress(admin);
  assert.equal(getBook(id, admin).currentPage, 7);
  assert.equal(getBook(id, reader).currentPage, 1);
});

it("deleting a book cascades every account's saved position and writer metadata", () => {
  const id = createBook();
  const alice = createUser();
  const bob = createUser();
  for (const user of [alice, bob]) updateProgress(id, { currentPage: 3, writerId: writerA, sequence: 1 }, user);
  store().db.prepare("DELETE FROM books WHERE id = ?").run(id);
  for (const table of ["user_progress", "user_progress_writers"]) {
    assert.equal(store().db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE bookId = ?`).get(id)?.count, 0);
  }
  assert.equal(store().db.prepare("SELECT COUNT(*) AS count FROM users WHERE id IN (?, ?)").get(alice, bob)?.count, 2);
});
