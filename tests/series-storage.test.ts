import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument } from "pdf-lib";
import { classifyImportedBooks, getBook, listBooks, store, updateBookMetadata, updateProgress } from "../lib/server/storage";
import { saveUpload } from "../lib/server/upload";
import { ApiError } from "../lib/server/http";
import { login, register } from "../lib/server/auth";
import { createInvitation } from "../lib/server/accounts";
import { PATCH } from "../app/api/books/[id]/route";

let root: string;
const originalEnv = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD, ADMIN_USERNAME: process.env.ADMIN_USERNAME, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN };
function closeStore() {
  const shared = globalThis as typeof globalThis & { __comicStore?: { db: DatabaseSync }; __comicAccountAttempts?: Map<string, unknown> };
  shared.__comicStore?.db.close();
  delete shared.__comicStore;
  shared.__comicAccountAttempts?.clear();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "comic-series-test-"));
  process.env.DATA_DIR = root;
  process.env.BOOKS_PASSWORD = "series-test-password";
  delete process.env.ADMIN_USERNAME;
  delete process.env.PUBLIC_ORIGIN;
});
afterEach(async () => {
  closeStore();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function insert(title: string, db = store().db) {
  const id = randomUUID();
  db.prepare(`INSERT INTO books (id, title, originalName, size, pageCount, currentPage, direction, fit, createdAt, lastReadAt, sha256)
    VALUES (?, ?, ?, 100, 20, 8, 'rtl', 'width', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', ?)`)
    .run(id, title, `original-${id}.pdf`, id);
  return id;
}
function importMetadata(title: string) {
  const { db } = store();
  db.exec("BEGIN IMMEDIATE");
  try {
    const id = insert(title, db);
    classifyImportedBooks(db);
    db.exec("COMMIT");
    return getBook(id);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
const invalid = (error: unknown) => error instanceof ApiError && error.status === 400;

it("migrates existing display titles once, preserving identities and all reading state", () => {
  const legacy = new DatabaseSync(join(root, "library.sqlite"));
  legacy.exec(`CREATE TABLE books (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, originalName TEXT NOT NULL,
    size INTEGER NOT NULL, pageCount INTEGER NOT NULL, currentPage INTEGER NOT NULL DEFAULT 1,
    direction TEXT NOT NULL DEFAULT 'rtl', fit TEXT NOT NULL DEFAULT 'page',
    createdAt TEXT NOT NULL, lastReadAt TEXT, sha256 TEXT NOT NULL UNIQUE
  );
  CREATE TABLE users (id TEXT PRIMARY KEY);
  INSERT INTO users VALUES ('reader');
  CREATE TABLE user_progress (
    userId TEXT NOT NULL REFERENCES users(id), bookId TEXT NOT NULL REFERENCES books(id),
    currentPage INTEGER NOT NULL DEFAULT 1, direction TEXT NOT NULL DEFAULT 'rtl',
    fit TEXT NOT NULL DEFAULT 'page', lastReadAt TEXT, PRIMARY KEY (userId, bookId)
  );`);
  const first = insert("결국은 카논 1권 - 요네시로 쿄", legacy);
  const second = insert("결국은 카논 2권 - 요네시로 쿄", legacy);
  const otherAuthor = insert("결국은 카논 1권 - 다른 작가", legacy);
  const bareFirst = insert("Bare Comic 01", legacy);
  const bareSecond = insert("Bare Comic 02", legacy);
  const loneNumber = insert("Standalone 2001", legacy);
  const standalone = insert("게에게 홀려서 - panpanya", legacy);
  legacy.prepare("INSERT INTO user_progress VALUES ('reader', ?, 4, 'ltr', 'page', '2026-03-01T00:00:00.000Z')").run(first);
  legacy.close();

  const migrated = getBook(first);
  assert.equal(migrated.seriesTitle, "결국은 카논 - 요네시로 쿄");
  assert.equal(migrated.title, "결국은 카논 1권 - 요네시로 쿄");
  assert.equal(migrated.originalName, `original-${first}.pdf`);
  assert.equal(migrated.installmentType, "volume");
  assert.equal(migrated.installmentNumber, 1);
  assert.equal(getBook(second).seriesId, migrated.seriesId);
  assert.notEqual(getBook(otherAuthor).seriesId, migrated.seriesId);
  assert.equal(getBook(bareFirst).seriesId, getBook(bareSecond).seriesId);
  assert.ok(getBook(bareFirst).seriesId);
  assert.equal(getBook(loneNumber).seriesId, null);
  assert.equal(getBook(standalone).seriesId, null);
  assert.equal(migrated.currentPage, 8);
  assert.equal(migrated.direction, "rtl");
  assert.equal(migrated.fit, "width");
  assert.equal(migrated.lastReadAt, "2026-02-01T00:00:00.000Z");
  const personal = getBook(first, "reader");
  assert.equal(personal.currentPage, 4);
  assert.equal(personal.direction, "ltr");
  assert.equal(personal.fit, "page");
  assert.equal(personal.lastReadAt, "2026-03-01T00:00:00.000Z");
  assert.equal(personal.seriesId, migrated.seriesId);
  assert.equal(listBooks("reader").length, 7);

  updateBookMetadata(first, { seriesTitle: null });
  closeStore();
  assert.equal(getBook(first).seriesId, null);
  assert.equal(getBook(second).seriesId, migrated.seriesId);
  assert.equal(getBook(first, "reader").currentPage, 4);
});

it("corroborates bare numbers on later imports and respects durable manual overrides", () => {
  const first = importMetadata("Bare Comic 01");
  assert.equal(first.seriesId, null);
  const second = importMetadata("bare comic 02");
  assert.ok(second.seriesId);
  assert.equal(getBook(first.id).seriesId, second.seriesId);
  assert.equal(getBook(first.id).installmentNumber, 1);
  updateBookMetadata(first.id, { seriesTitle: null });
  const reassigned = updateBookMetadata(second.id, { seriesTitle: "My custom series", installmentType: "chapter", installmentNumber: 25.5 });
  closeStore();
  const third = importMetadata("BARE COMIC 03");
  assert.ok(third.seriesId);
  assert.equal(getBook(first.id).seriesId, null);
  assert.equal(getBook(second.id).seriesId, reassigned.seriesId);
  assert.equal(getBook(second.id).installmentType, "chapter");
  assert.equal(getBook(second.id).installmentNumber, 25.5);
  const fourth = importMetadata("Bare Comic Vol. 4");
  assert.equal(fourth.seriesId, third.seriesId);
  assert.equal(fourth.installmentNumber, 4);
  const duplicateName = importMetadata("Only One 01");
  importMetadata("Only One 01");
  assert.equal(getBook(duplicateName.id).seriesId, null);
});

it("updates metadata atomically, shares stable normalized series IDs and validates inconsistent input", () => {
  const id = insert("Untouched display title");
  const original = getBook(id);
  const edited = updateBookMetadata(id, { seriesTitle: "  New Series  ", installmentType: "chapter", installmentNumber: 0 });
  assert.equal(edited.title, original.title);
  assert.equal(edited.currentPage, original.currentPage);
  assert.equal(edited.seriesTitle, "New Series");
  assert.equal(edited.installmentNumber, 0);
  const next = updateBookMetadata(insert("Another display title"), { seriesTitle: "NEW   SERIES", installmentType: "chapter", installmentNumber: 1.5 });
  assert.equal(next.seriesId, edited.seriesId);
  for (const input of [
    {}, { unexpected: true }, { title: "" }, { seriesTitle: "" }, { seriesTitle: 4 },
    { installmentType: "episode" }, { installmentNumber: -1 }, { installmentNumber: NaN },
    { installmentNumber: Infinity }, { installmentNumber: "2" }, { installmentNumber: undefined },
    { installmentType: null }, { title: "Should roll back", seriesTitle: "Newly created", installmentNumber: -3 },
  ]) {
    assert.throws(() => updateBookMetadata(id, input), invalid, JSON.stringify(input));
    assert.deepEqual(getBook(id), edited);
  }
  assert.equal((store().db.prepare("SELECT count(*) AS count FROM series").get() as { count: number }).count, 1);
  const extra = updateBookMetadata(id, { installmentNumber: null, installmentType: null });
  assert.equal(extra.seriesId, edited.seriesId);
  assert.equal(extra.installmentNumber, null);
  assert.equal(extra.installmentType, null);
  const renamed = updateBookMetadata(id, { title: "New display title" });
  assert.equal(renamed.seriesId, edited.seriesId);
  const cleared = updateBookMetadata(id, { seriesTitle: null, installmentType: "volume", installmentNumber: 2 });
  assert.equal(cleared.seriesId, null);
  assert.equal(cleared.seriesTitle, null);
  assert.equal(cleared.installmentType, null);
  assert.equal(cleared.installmentNumber, null);
  assert.throws(() => updateBookMetadata(id, { installmentType: "volume", installmentNumber: 1 }), invalid);
});

it("assigns series metadata during a real PDF upload", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  const bytes = await pdf.save();
  const uploaded = await saveUpload(new Request("http://localhost:3000/api/books", {
    method: "POST", body: bytes as BodyInit,
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent("새 만화 2화 - 작가.pdf") },
  }));
  assert.equal(uploaded.seriesTitle, "새 만화 - 작가");
  assert.equal(uploaded.installmentType, "chapter");
  assert.equal(uploaded.installmentNumber, 2);
  assert.equal(uploaded.title, "새 만화 2화 - 작가");
});

it("allows metadata-only PATCH for administrators and protects it from readers", async () => {
  const base = new Request("http://localhost:3000/api/session");
  const admin = await login(base, "admin", "series-test-password");
  const invitation = createInvitation();
  const reader = await register(base, invitation.token, "reader", "reader-password");
  const id = insert("Route test");
  updateProgress(id, { currentPage: 3 }, admin.user.id);
  const context = { params: Promise.resolve({ id }) };
  const patch = (cookie?: string, input: unknown = { seriesTitle: "Route series", installmentType: "volume", installmentNumber: 1 }) => PATCH(new Request(`http://localhost:3000/api/books/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(input),
  }), context);
  assert.equal((await patch()).status, 401);
  assert.equal((await patch(reader.cookie)).status, 403);
  const response = await patch(admin.cookie);
  assert.equal(response.status, 200);
  const { book } = await response.json();
  assert.equal(book.seriesTitle, "Route series");
  assert.equal(book.currentPage, 3);
  assert.equal(book.title, "Route test");
  assert.equal((await patch(admin.cookie, { title: "Rename still works" })).status, 200);
  assert.equal(getBook(id).title, "Rename still works");
  assert.equal((await patch(admin.cookie, { seriesTitle: null })).status, 200);
  assert.equal(getBook(id).seriesId, null);
});
