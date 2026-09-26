import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBook, store, updateProgress } from "../lib/server/storage";
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
