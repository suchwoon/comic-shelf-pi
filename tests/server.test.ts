import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticated, checkOrigin, login, requireAuth } from "../lib/server/auth";
import { ApiError } from "../lib/server/http";
import { parseRange } from "../lib/server/files";
import { bookFile, coverFile, getBook, listBooks, store, updateProgress } from "../lib/server/storage";
import { deleteBook, saveUpload } from "../lib/server/upload";
import { GET as fileRoute, HEAD as fileHead } from "../app/api/books/[id]/file/route";
import { GET as coverRoute } from "../app/api/books/[id]/cover/route";
import { PATCH as progressRoute } from "../app/api/books/[id]/progress/route";
import type { Book } from "../lib/types";

let dataDir: string;
let fixture: Uint8Array;
let book: Book;
const originalEnv = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD, MAX_UPLOAD_MB: process.env.MAX_UPLOAD_MB };
const apiError = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const local = (path = "/api/books", init: RequestInit = {}) => new Request(`http://localhost:3000${path}`, init);
function upload(bytes: Uint8Array = fixture, name = "작은 만화.pdf") {
  return local("/api/books", {
    method: "POST", body: bytes as BodyInit,
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(name) },
  });
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "comic-shelf-server-test-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.BOOKS_PASSWORD;
  delete process.env.MAX_UPLOAD_MB;
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 6; i++) {
    const page = document.addPage(i === 4 ? [800, 500] : [400, 600]);
    page.drawText(`Comic test page ${i}`, { x: 30, y: 300, font, size: 24 });
  }
  fixture = await document.save();
});

after(async () => {
  const globalState = globalThis as typeof globalThis & { __comicStore?: { db: { close(): void } } };
  globalState.__comicStore?.db.close();
  delete globalState.__comicStore;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe("private library access", () => {
  it("limits password-free access to loopback and rejects cross-site browser requests", () => {
    assert.equal(authenticated(local()), true);
    assert.equal(authenticated(new Request("http://192.168.1.4:3000/api/books")), false);
    assert.throws(() => requireAuth(new Request("https://books.example/api/books")), apiError(403));
    assert.throws(() => checkOrigin(local("/api/books", { headers: { Origin: "https://evil.example" } })), apiError(403));
    assert.throws(() => authenticated(local("/api/books", { headers: { "Sec-Fetch-Site": "cross-site" } })), apiError(403));
    assert.doesNotThrow(() => checkOrigin(local("/api/books", { headers: { Origin: "http://localhost:3000" } })));
  });

  it("issues signed private cookies, detects tampering, and invalidates cookies when the password changes", async () => {
    process.env.BOOKS_PASSWORD = "example-private-password";
    try {
      assert.equal(authenticated(local()), false);
      assert.throws(() => login(local(), "wrong"), apiError(401));
      const cookie = login(local(), "example-private-password")!;
      assert.match(cookie, /HttpOnly; SameSite=Strict/);
      assert.equal(authenticated(local("/api/books", { headers: { Cookie: cookie } })), true);
      const tampered = cookie.replace("comic_shelf_session=", "comic_shelf_session=9");
      assert.equal(authenticated(local("/api/books", { headers: { Cookie: tampered } })), false);
      const secret = await readFile(join(dataDir, "session-secret"));
      assert.equal(secret.length, 32);
      assert.match(login(new Request("https://books.example/api/session"), "example-private-password")!, /; Secure/);
      process.env.BOOKS_PASSWORD = "changed-password";
      assert.equal(authenticated(local("/api/books", { headers: { Cookie: cookie } })), false);
    } finally { delete process.env.BOOKS_PASSWORD; }
  });
});

describe("streamed uploads and persistent reading state", () => {
  it("validates a PDF in a child process, generates a cover, and saves metadata", async () => {
    book = await saveUpload(upload());
    assert.equal(book.title, "작은 만화");
    assert.equal(book.originalName, "작은 만화.pdf");
    assert.equal(book.pageCount, 6);
    assert.equal(book.currentPage, 1);
    assert.equal(book.lastReadAt, null);
    assert.equal(book.size, fixture.length);
    assert.deepEqual(new Uint8Array(await readFile(bookFile(book.id))), fixture);
    assert.deepEqual((await readFile(coverFile(book.id))).subarray(0, 2), Buffer.from([0xff, 0xd8]));
    assert.equal(listBooks().length, 1);
    assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
  });

  it("rejects duplicates, fake PDFs, invalid filenames, corrupted documents, and oversized streams without leftovers", async () => {
    await assert.rejects(saveUpload(upload()), apiError(409));
    await assert.rejects(saveUpload(upload(Buffer.from("This is an executable file"))), apiError(422));
    await assert.rejects(saveUpload(upload(fixture, "wrong.exe")), apiError(400));
    await assert.rejects(saveUpload(upload(Buffer.from("%PDF-1.7\nnot a valid pdf document"))), apiError(422));
    process.env.MAX_UPLOAD_MB = "0.001";
    try { await assert.rejects(saveUpload(upload()), apiError(413)); }
    finally { delete process.env.MAX_UPLOAD_MB; }
    assert.equal(listBooks().length, 1);
    assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
    assert.equal((await readdir(join(dataDir, "books"))).length, 1);
  });

  it("persists backward page changes, preserves partial settings, and rejects invalid values", () => {
    updateProgress(book.id, { currentPage: 6, direction: "rtl", fit: "width" });
    const backwards = updateProgress(book.id, { currentPage: 2 });
    assert.equal(backwards.currentPage, 2);
    assert.equal(backwards.direction, "rtl");
    assert.equal(backwards.fit, "width");
    assert.ok(backwards.lastReadAt);
    for (const value of [0, 7, 1.5, NaN, Infinity, "2", null]) {
      assert.throws(() => updateProgress(book.id, { currentPage: value }), apiError(400));
    }
    assert.throws(() => updateProgress(book.id, { direction: "left" }), apiError(400));
    assert.throws(() => updateProgress(book.id, { fit: "none" }), apiError(400));
    assert.throws(() => updateProgress(book.id, { unexpected: true }), apiError(400));
    assert.equal(getBook(book.id).currentPage, 2);
  });

  it("restores metadata and reading position in a separate process", async () => {
    store().db.exec("PRAGMA wal_checkpoint(FULL)");
    const script = `import {getBook} from './lib/server/storage.ts'; process.stdout.write(JSON.stringify(getBook(${JSON.stringify(book.id)})));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: process.env });
    const restored = JSON.parse(stdout) as Book;
    assert.equal(restored.currentPage, 2);
    assert.equal(restored.direction, "rtl");
    assert.equal(restored.originalName, book.originalName);
  });
});

describe("authenticated PDF byte serving", () => {
  it("handles closed, open-ended, suffix, invalid, and multiple byte ranges", () => {
    assert.deepEqual(parseRange("bytes=0-4", 10), { start: 0, end: 4 });
    assert.deepEqual(parseRange("bytes=8-", 10), { start: 8, end: 9 });
    assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
    assert.deepEqual(parseRange("bytes=7-999", 10), { start: 7, end: 9 });
    assert.deepEqual(parseRange("bytes=-20", 10), { start: 0, end: 9 });
    for (const invalid of ["bytes=10-", "bytes=4-1", "bytes=-0", "bytes=", "bytes=-", "bytes=0-2,5-7", "bytes=0.5-4", "bytes=999999999999999999-"]) {
      assert.equal(parseRange(invalid, 10), null);
    }
  });

  it("returns correct range bytes, 416 and HEAD headers, and protects the PDF and cover", async () => {
    const context = { params: Promise.resolve({ id: book.id }) };
    const partial = await fileRoute(local(`/api/books/${book.id}/file`, { headers: { Range: "bytes=0-7" } }), context);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 0-7/${fixture.length}`);
    assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), fixture.subarray(0, 8));
    const invalid = await fileRoute(local(`/api/books/${book.id}/file`, { headers: { Range: `bytes=${fixture.length}-` } }), context);
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), `bytes */${fixture.length}`);
    const head = await fileHead(local(`/api/books/${book.id}/file`, { method: "HEAD" }), context);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(fixture.length));
    assert.equal(await head.text(), "");
    process.env.BOOKS_PASSWORD = "private";
    try {
      assert.equal((await fileRoute(local(), context)).status, 401);
      assert.equal((await coverRoute(local(), context)).status, 401);
      const forgedProgress = await progressRoute(local("/api/books", {
        method: "PATCH", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ currentPage: 3 }),
      }), context);
      assert.equal(forgedProgress.status, 403);
      assert.equal(getBook(book.id).currentPage, 2);
    } finally { delete process.env.BOOKS_PASSWORD; }
  });

  it("rejects unknown and path-like IDs and removes the book and its files together", async () => {
    assert.throws(() => getBook("../../.env"), apiError(404));
    const pdf = bookFile(book.id);
    const cover = coverFile(book.id);
    await deleteBook(book.id);
    assert.throws(() => getBook(book.id), apiError(404));
    await assert.rejects(readFile(pdf), { code: "ENOENT" });
    await assert.rejects(readFile(cover), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
    assert.equal(listBooks().length, 0);
  });
});
