import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticated, checkOrigin, login, logoutCookie, requireAuth } from "../lib/server/auth";
import { ApiError } from "../lib/server/http";
import { parseRange } from "../lib/server/files";
import { bookFile, coverFile, getBook, listBooks, store, updateProgress } from "../lib/server/storage";
import { deleteBook, saveUpload } from "../lib/server/upload";
import { GET as fileRoute, HEAD as fileHead } from "../app/api/books/[id]/file/route";
import { GET as coverRoute } from "../app/api/books/[id]/cover/route";
import { PATCH as progressRoute } from "../app/api/books/[id]/progress/route";
import { GET as sessionRoute, POST as sessionLogin } from "../app/api/session/route";
import type { Book } from "../lib/types";

let dataDir: string;
let fixture: Uint8Array;
let book: Book;
let sessionCookie: string;
const testPassword = "server-test-library-password";
const originalEnv = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD, MAX_UPLOAD_MB: process.env.MAX_UPLOAD_MB, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN };
const apiError = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const anonymous = (path = "/api/books", init: RequestInit = {}) => new Request(`http://localhost:3000${path}`, init);
const local = (path = "/api/books", init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Cookie", sessionCookie);
  return anonymous(path, { ...init, headers });
};
function upload(bytes: Uint8Array = fixture, name = "작은 만화.pdf") {
  return local("/api/books", {
    method: "POST", body: bytes as BodyInit,
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(name) },
  });
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "comic-shelf-server-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BOOKS_PASSWORD = testPassword;
  delete process.env.MAX_UPLOAD_MB;
  delete process.env.PUBLIC_ORIGIN;
  sessionCookie = (await login(anonymous("/api/session"), "admin", testPassword)).cookie.split(";")[0];
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
  it("requires named account sign-in even on loopback and keeps migrated accounts independent of environment changes", async () => {
    assert.equal(authenticated(anonymous()), false);
    assert.equal(authenticated(local()), true);
    assert.throws(() => requireAuth(new Request("https://books.example/api/books", { headers: { Host: "localhost:3000" } })), apiError(401));
    assert.throws(() => checkOrigin(local("/api/books", { headers: { Origin: "https://evil.example" } })), apiError(403));
    assert.throws(() => authenticated(local("/api/books", { headers: { "Sec-Fetch-Site": "cross-site" } })), apiError(403));
    const response = await sessionLogin(anonymous("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: testPassword }) }));
    assert.equal(response.status, 401);
    delete process.env.BOOKS_PASSWORD;
    try {
      assert.equal(authenticated(local()), true);
      assert.equal((await sessionRoute(local())).status, 200);
      await login(anonymous(), "admin", testPassword);
    } finally { process.env.BOOKS_PASSWORD = testPassword; }
  });

  it("issues opaque private cookies, detects tampering, and revokes the exact session on logout", async () => {
    await assert.rejects(login(anonymous(), "admin", "wrong"), apiError(401));
    const { cookie } = await login(anonymous(), "admin", testPassword);
    assert.match(cookie, /^comic_shelf_session=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const request = anonymous("/api/books", { headers: { Cookie: cookie } });
    assert.equal(authenticated(request), true);
    const tampered = cookie.replace("comic_shelf_session=", "comic_shelf_session=9");
    assert.equal(authenticated(anonymous("/api/books", { headers: { Cookie: tampered } })), false);
    assert.match(logoutCookie(request), /Max-Age=0/);
    assert.equal(authenticated(request), false);
    assert.equal(authenticated(local()), true);
  });

  it("uses the canonical HTTPS origin behind a tunnel and permits local host aliases and forwarded ports", async () => {
    try {
      for (const configured of ["", "https://books.catfish.cc"]) {
        process.env.PUBLIC_ORIGIN = configured;
        for (const [url, host, origin] of [
          ["http://localhost:3212/api/session", "127.0.0.1:3212", "http://127.0.0.1:3212"],
          ["http://localhost:3212/api/session", "[::1]:3212", "http://[::1]:3212"],
          ["http://localhost:3000/api/session", "127.0.0.1:3001", "http://127.0.0.1:3001"],
          ["http://0.0.0.0:3000/api/session", "localhost:3001", "http://localhost:3001"],
        ]) {
          const request = new Request(url, { headers: { Host: host, Origin: origin, "Sec-Fetch-Site": "same-origin" } });
          assert.doesNotMatch((await login(request, "admin", testPassword)).cookie, /; Secure/);
          assert.doesNotMatch(logoutCookie(request), /; Secure/);
        }
        const lan = new Request("http://0.0.0.0:3000/api/session", { headers: { Host: "192.168.1.4:3000", Origin: "http://192.168.1.4:3000" } });
        if (configured) assert.throws(() => checkOrigin(lan), apiError(403));
        else assert.doesNotThrow(() => checkOrigin(lan));
        assert.throws(() => checkOrigin(new Request("http://0.0.0.0:3000/api/session", { headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3001" } })), apiError(403));
      }
      const tunneled = anonymous("/api/session", { headers: { Origin: "https://books.catfish.cc", Host: "localhost:3000", "X-Forwarded-Proto": "http" } });
      assert.match((await login(tunneled, "admin", testPassword)).cookie, /; Secure$/);
      assert.match(logoutCookie(tunneled), /; Secure$/);
      assert.match((await login(anonymous("/api/session"), "admin", testPassword)).cookie, /; Secure$/);
      for (const request of [
        anonymous("/api/session", { headers: { Origin: "https://evil.example", Host: "evil.example", "X-Forwarded-Proto": "https" } }),
        new Request("https://evil.example/api/session", { headers: { Origin: "https://evil.example" } }),
        anonymous("/api/session", { headers: { Origin: "http://localhost:9999" } }),
        anonymous("/api/session", { headers: { Origin: "https://books.catfish.cc.evil.example" } }),
      ]) assert.throws(() => checkOrigin(request), apiError(403));
    } finally { delete process.env.PUBLIC_ORIGIN; }
  });

  it("ignores forged forwarding headers and fails closed for an invalid public origin", async () => {
    assert.throws(() => checkOrigin(anonymous("/api/session", { headers: { Origin: "https://evil.example", Host: "evil.example", "X-Forwarded-Proto": "https" } })), apiError(403));
    assert.match((await login(new Request("https://books.example/api/session", { headers: { "X-Forwarded-Proto": "http" } }), "admin", testPassword)).cookie, /; Secure$/);
    process.env.PUBLIC_ORIGIN = "https://books.catfish.cc/not-an-origin";
    try { assert.throws(() => checkOrigin(anonymous("/api/session")), apiError(503)); }
    finally { delete process.env.PUBLIC_ORIGIN; }
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
    assert.equal((await fileRoute(anonymous(), context)).status, 401);
    assert.equal((await coverRoute(anonymous(), context)).status, 401);
    const forgedProgress = await progressRoute(local("/api/books", {
      method: "PATCH", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ currentPage: 3 }),
    }), context);
    assert.equal(forgedProgress.status, 403);
    assert.equal(getBook(book.id).currentPage, 2);
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
