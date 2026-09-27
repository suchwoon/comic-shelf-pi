import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, open, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument, rgb } from "pdf-lib";
import { loadImage } from "@napi-rs/canvas";
import { createInvitation, setUserDisabled } from "../lib/server/accounts";
import { login, register } from "../lib/server/auth";
import { bookFile } from "../lib/server/storage";
import { deleteBook, saveUpload } from "../lib/server/upload";
import { GET as originalGET, HEAD as originalHEAD } from "../app/api/books/[id]/file/route";
import { GET as pageGET, HEAD as pageHEAD } from "../app/api/books/[id]/pages/[page]/route";
import type { Book } from "../lib/types";

let root: string;
let adminCookie: string;
let readerCookie: string;
let readerId: string;
let book: Book;
let original: Uint8Array;
const originalEnv = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD, ADMIN_USERNAME: process.env.ADMIN_USERNAME, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN };
const originalContext = () => ({ params: Promise.resolve({ id: book.id }) });
const pageContext = (page = "1", id = book.id) => ({ params: Promise.resolve({ id, page }) });
function request(cookie?: string, method = "GET", range?: string) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (range) headers.set("Range", range);
  return new Request("http://localhost:3000/api/books", { method, headers });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "comic-page-images-test-"));
  process.env.DATA_DIR = root;
  process.env.BOOKS_PASSWORD = "page-images-test-admin-passphrase";
  delete process.env.ADMIN_USERNAME;
  delete process.env.PUBLIC_ORIGIN;
  adminCookie = (await login(request(), "admin", process.env.BOOKS_PASSWORD)).cookie;
  const member = await register(request(), createInvitation().token, "page-reader", "page-images-reader-passphrase");
  readerCookie = member.cookie;
  readerId = member.user.id;
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([600, 900]);
  first.drawRectangle({ x: 0, y: 0, width: 600, height: 900, color: rgb(1, 0, 0) });
  const second = pdf.addPage([5000, 5000]);
  second.drawRectangle({ x: 0, y: 0, width: 5000, height: 5000, color: rgb(0, 0, 1) });
  original = await pdf.save();
  book = await saveUpload(new Request("http://localhost:3000/api/books", {
    method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/pdf", "X-File-Name": "Raster permissions.pdf" }, body: original as BodyInit,
  }));
});

after(async () => {
  const shared = globalThis as typeof globalThis & { __comicStore?: { db: { close(): void } } };
  shared.__comicStore?.db.close();
  delete shared.__comicStore;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

it("rejects original PDF GET, HEAD, and Range access by readers and anonymous visitors", async () => {
  for (const [cookie, status] of [[undefined, 401], [readerCookie, 403]] as const) {
    for (const method of ["GET", "HEAD"]) {
      for (const range of [undefined, "bytes=0-4", "bytes=0-"]) {
        const response = await (method === "HEAD" ? originalHEAD : originalGET)(request(cookie, method, range), originalContext());
        assert.equal(response.status, status);
        assert.notEqual(response.headers.get("content-type"), "application/pdf");
        assert.equal(response.headers.get("content-range"), null);
        assert.ok(!(await response.text()).includes("%PDF-"));
      }
    }
  }
});

it("preserves original PDF downloads, HEAD, and ranges for administrators", async () => {
  const full = await originalGET(request(adminCookie), originalContext());
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "application/pdf");
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), original);
  const range = await originalGET(request(adminCookie, "GET", "bytes=0-4"), originalContext());
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "%PDF-");
  const head = await originalHEAD(request(adminCookie, "HEAD"), originalContext());
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(original.length));
  assert.equal(await head.text(), "");
});

it("requires authentication before looking up pages or creating the private cache", async () => {
  for (const method of ["GET", "HEAD"]) {
    for (const range of [undefined, "bytes=0-4"]) {
      const response = await (method === "HEAD" ? pageHEAD : pageGET)(request(undefined, method, range), pageContext());
      assert.equal(response.status, 401);
    }
  }
  assert.equal((await pageGET(request(), pageContext("../file", "../../.env"))).status, 401);
  await assert.rejects(stat(join(root, "pages")), { code: "ENOENT" });
});

it("serves only bounded JPEG pages, reuses private cache, and ignores ranges without exposing PDF bytes", async () => {
  const [first, concurrent] = await Promise.all([
    pageGET(request(readerCookie), pageContext()),
    pageGET(request(readerCookie), pageContext()),
  ]);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/jpeg");
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  const bytes = Buffer.from(await first.arrayBuffer());
  assert.deepEqual(bytes.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  assert.deepEqual(Buffer.from(await concurrent.arrayBuffer()), bytes);
  const image = await loadImage(bytes);
  assert.equal(image.width, 1600);
  assert.equal(image.height, 2400);
  const cacheFile = join(root, "pages", "v1", `${book.id}-1.jpg`);
  assert.deepEqual(await readFile(cacheFile), bytes);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, "pages", "v1")), [`${book.id}-1.jpg`]);
  const head = await pageHEAD(request(readerCookie, "HEAD"), pageContext());
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "image/jpeg");
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(await head.text(), "");
  const range = await pageGET(request(readerCookie, "GET", "bytes=0-4"), pageContext());
  assert.equal(range.status, 200);
  assert.equal(range.headers.get("content-range"), null);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes);
  // A sparse fixture tests the disk budget without allocating hundreds of MB.
  const oldCache = join(root, "pages", "v1", `${book.id}-50000.jpg`);
  const sparse = await open(oldCache, "wx", 0o600);
  try { await sparse.truncate(192 * 1024 * 1024 + 1); } finally { await sparse.close(); }
  await utimes(oldCache, new Date(0), new Date(0));
  const second = await pageGET(request(adminCookie), pageContext("2"));
  assert.equal(second.status, 200);
  const secondBytes = Buffer.from(await second.arrayBuffer());
  assert.notDeepEqual(secondBytes, bytes);
  const oversized = await loadImage(secondBytes);
  assert.equal(oversized.width, 2400);
  assert.equal(oversized.height, 2400);
  assert.ok(oversized.width * oversized.height <= 6_000_000);
  await assert.rejects(stat(oldCache), { code: "ENOENT" });
});

it("rejects invalid page paths and unknown books without rendering", async () => {
  for (const page of ["0", "-1", "1.5", "NaN", "1e0", "01", "../file", "99999999999999999999999"]) {
    assert.equal((await pageGET(request(readerCookie), pageContext(page))).status, 400, page);
  }
  assert.equal((await pageGET(request(readerCookie), pageContext("3"))).status, 404);
  assert.equal((await pageGET(request(readerCookie), pageContext("1", "../../.env"))).status, 404);
  assert.equal((await pageGET(request(readerCookie), pageContext("1", "00000000-0000-4000-8000-000000000000"))).status, 404);
});

it("blocks revoked sessions even for cached images and removes page caches on book deletion", async () => {
  setUserDisabled(readerId, true);
  for (const method of ["GET", "HEAD"]) {
    assert.equal((await (method === "HEAD" ? pageHEAD : pageGET)(request(readerCookie, method), pageContext())).status, 401);
    assert.equal((await (method === "HEAD" ? originalHEAD : originalGET)(request(readerCookie, method), originalContext())).status, 401);
  }
  const pdfPath = bookFile(book.id);
  await deleteBook(book.id);
  assert.deepEqual(await readdir(join(root, "pages", "v1")), []);
  await assert.rejects(stat(pdfPath), { code: "ENOENT" });
  assert.equal((await pageGET(request(adminCookie), pageContext())).status, 404);
});
