import assert from "node:assert/strict";
import { after, before, beforeEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { login, logoutCookie } from "../lib/server/auth";
import { bookFile, coverFile, store } from "../lib/server/storage";
import { deleteBook } from "../lib/server/upload";
import { GET as coverGET, HEAD as coverHEAD } from "../app/api/books/[id]/cover/route";
import { GET as originalGET } from "../app/api/books/[id]/file/route";

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  BOOKS_PASSWORD: process.env.BOOKS_PASSWORD,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
};
const password = "cover-images-test-passphrase";
let root: string;
let cookie: string;
let id: string;
let originalCover: Buffer;
const originalPdf = Buffer.from("%PDF-1.7\ncover image fixture\n%%EOF\n");

function request(query = "", options: { cookie?: string | null; method?: string; etag?: string } = {}) {
  const headers = new Headers();
  const session = options.cookie === undefined ? cookie : options.cookie;
  if (session) headers.set("Cookie", session);
  if (options.etag) headers.set("If-None-Match", options.etag);
  return new Request(`http://localhost:3000/api/books/${id}/cover${query}`, {
    method: options.method || "GET", headers,
  });
}

const context = (bookId = id) => ({ params: Promise.resolve({ id: bookId }) });

function makeCover(background: string) {
  const canvas = createCanvas(680, 940);
  const drawing = canvas.getContext("2d");
  drawing.fillStyle = background;
  drawing.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < 60; index++) {
    drawing.fillStyle = `rgb(${index * 37 % 256}, ${index * 67 % 256}, ${index * 97 % 256})`;
    drawing.fillRect(20 + index * 97 % 600, 30 + index * 83 % 850, 20, 35);
  }
  return canvas.toBuffer("image/jpeg", 80);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "comic-cover-images-test-"));
  process.env.DATA_DIR = root;
  process.env.BOOKS_PASSWORD = password;
  delete process.env.ADMIN_USERNAME;
  delete process.env.PUBLIC_ORIGIN;
  cookie = (await login(new Request("http://localhost:3000/api/session"), "admin", password)).cookie;
  originalCover = makeCover("#f8e2cd");
});

beforeEach(async () => {
  id = randomUUID();
  store().db.prepare("INSERT INTO books (id, title, originalName, size, pageCount, createdAt, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, "Cover fixture", "cover-fixture.pdf", originalPdf.length, 1, "2026-01-01T00:00:00.000Z", id);
  await writeFile(coverFile(id), originalCover, { mode: 0o600 });
  await writeFile(bookFile(id), originalPdf, { mode: 0o600 });
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

it("preserves the original JPEG endpoint and keeps original PDFs out of browser caches", async () => {
  const response = await coverGET(request(), context());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  assert.ok(response.headers.get("etag"));
  assert.equal(response.headers.get("content-length"), String(originalCover.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), originalCover);

  const pdf = await originalGET(request(), context());
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("cache-control"), "private, no-store");
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), originalPdf);
});

it("serves smaller WebP covers at supported widths with matching body-free HEAD responses", async () => {
  const tags = new Set<string>();
  for (const width of [96, 320, 480, 680]) {
    const query = `?w=${width}`;
    const response = await coverGET(request(query), context());
    assert.equal(response.status, 200, query);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    const bytes = Buffer.from(await response.arrayBuffer());
    const image = await loadImage(bytes);
    assert.equal(image.width, width);
    assert.ok(Math.abs(image.height - 940 * width / 680) <= 1, "the cover keeps its aspect ratio");
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    if (width === 320) assert.ok(bytes.length < originalCover.length, "the shelf thumbnail reduces transfer size");
    const etag = response.headers.get("etag");
    assert.ok(etag);
    tags.add(etag);

    const head = await coverHEAD(request(query, { method: "HEAD" }), context());
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(head.headers.get("content-type"), "image/webp");
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal(head.headers.get("cache-control"), "private, no-cache");
    assert.equal(await head.text(), "");
  }
  assert.equal(tags.size, 4, "each representation has its own validator");
});

it("revalidates JPEG and WebP covers without sending unchanged image bytes", async () => {
  for (const query of ["", "?w=320"]) {
    const first = await coverGET(request(query), context());
    const bytes = Buffer.from(await first.arrayBuffer());
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const repeated = await coverGET(request(query), context());
    assert.equal(repeated.headers.get("etag"), etag);
    assert.deepEqual(Buffer.from(await repeated.arrayBuffer()), bytes);

    for (const method of ["GET", "HEAD"]) {
      for (const validator of [etag, etag.replace(/^W\//, ""), `"another-cover", ${etag}`, "*"]) {
        const response = await (method === "HEAD" ? coverHEAD : coverGET)(request(query, { method, etag: validator }), context());
        assert.equal(response.status, 304, `${query} ${method} ${validator}`);
        assert.equal(response.headers.get("etag"), etag);
        assert.equal(response.headers.get("cache-control"), "private, no-cache");
        assert.equal(await response.text(), "");
      }
    }
    const changedValidator = await coverGET(request(query, { etag: '"different-image"' }), context());
    assert.equal(changedValidator.status, 200);
    assert.deepEqual(Buffer.from(await changedValidator.arrayBuffer()), bytes);
  }
});

it("does not reuse a validator from a different cover size or representation", async () => {
  const first = await coverGET(request("?w=320"), context());
  const etag = first.headers.get("etag")!;
  await first.arrayBuffer();
  for (const query of ["", "?w=480"]) {
    const response = await coverGET(request(query, { etag }), context());
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get("etag"), etag);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
});

it("serves complete consistent images when thumbnail requests arrive concurrently", async () => {
  const widths = [320, 320, 96, 480, 680, 320, 96, 480];
  const images = new Map<number, { bytes: Buffer; etag: string | null }>();
  const responses = await Promise.all(widths.map(async width => {
    const response = await coverGET(request(`?w=${width}`), context());
    assert.equal(response.status, 200);
    return { width, bytes: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag") };
  }));
  for (const { width, bytes, etag } of responses) {
    const image = await loadImage(bytes);
    assert.equal(image.width, width);
    const previous = images.get(width);
    if (previous) {
      assert.equal(etag, previous.etag);
      assert.deepEqual(bytes, previous.bytes);
    } else images.set(width, { bytes, etag });
  }
});

it("refreshes generated covers when the source is replaced with the same size and mtime", async () => {
  const source = coverFile(id);
  const newCover = makeCover("#1250a0");
  const byteLength = Math.max(originalCover.length, newCover.length);
  // JPEG permits trailing bytes. Equal lengths and a fixed timestamp ensure
  // source-change detection also covers replacements preserving both values.
  const padded = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc(byteLength - bytes.length)]);
  const sourceDate = new Date("2026-01-01T00:00:00.000Z");
  await writeFile(source, padded(originalCover));
  await utimes(source, sourceDate, sourceDate);
  const first = await coverGET(request("?w=320"), context());
  const etag = first.headers.get("etag")!;
  const firstBytes = Buffer.from(await first.arrayBuffer());
  const previous = await stat(source);
  const replacement = padded(newCover);
  await writeFile(source, replacement);
  await utimes(source, sourceDate, sourceDate);
  const replaced = await stat(source);
  assert.equal(replaced.size, previous.size);
  assert.equal(replaced.mtimeMs, previous.mtimeMs);

  const refreshed = await coverGET(request("?w=320", { etag }), context());
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.headers.get("etag"), etag);
  const refreshedBytes = Buffer.from(await refreshed.arrayBuffer());
  assert.notDeepEqual(refreshedBytes, firstBytes);
  const image = await loadImage(refreshedBytes);
  assert.equal(image.width, 320);
  const canvas = createCanvas(image.width, image.height);
  const drawing = canvas.getContext("2d");
  drawing.drawImage(image, 0, 0);
  const [red, , blue] = drawing.getImageData(0, 0, 1, 1).data;
  assert.ok(blue > red + 70, "the returned thumbnail reflects the new blue source");

  const original = await coverGET(request(), context());
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), replacement);
});

it("removes generated thumbnails on deletion and rejects old conditional requests", async () => {
  const response = await coverGET(request("?w=320"), context());
  const etag = response.headers.get("etag")!;
  await response.arrayBuffer();
  const thumbnailDirectory = join(root, "cover-thumbnails", "v1", id);
  assert.ok((await stat(thumbnailDirectory)).isDirectory());
  await deleteBook(id);
  await assert.rejects(stat(thumbnailDirectory), { code: "ENOENT" });
  for (const method of ["GET", "HEAD"]) {
    for (const query of ["", "?w=320"]) {
      const deleted = await (method === "HEAD" ? coverHEAD : coverGET)(request(query, { method, etag }), context());
      assert.equal(deleted.status, 404);
      assert.notEqual(deleted.headers.get("etag"), etag);
      await deleted.arrayBuffer();
    }
  }
});

it("rejects unsupported sizes and missing books with an authenticated request", async () => {
  for (const query of ["?w=", "?w=0", "?w=-1", "?w=319", "?w=321", "?w=320.0", "?w=0320", "?w=3.2e2", "?w=NaN", "?w=99999999999999", "?w=320&w=480"]) {
    const response = await coverGET(request(query), context());
    assert.equal(response.status, 400, query);
  }
  for (const bookId of ["../../.env", randomUUID()]) {
    const response = await coverGET(request("?w=320"), context(bookId));
    assert.equal(response.status, 404);
  }
});

it("authenticates conditional requests before returning cached covers or validation results", async () => {
  const separateCookie = (await login(new Request("http://localhost:3000/api/session"), "admin", password)).cookie;
  const first = await coverGET(request("?w=320", { cookie: separateCookie }), context());
  const etag = first.headers.get("etag")!;
  await first.arrayBuffer();
  logoutCookie(request("", { cookie: separateCookie }));

  for (const session of [null, separateCookie]) {
    for (const method of ["GET", "HEAD"]) {
      for (const query of ["", "?w=320", "?w=invalid"]) {
        const response = await (method === "HEAD" ? coverHEAD : coverGET)(request(query, { cookie: session, method, etag }), context());
        assert.equal(response.status, 401, `${query} ${method}`);
        assert.notEqual(response.headers.get("content-type"), "image/webp");
        assert.notEqual(response.headers.get("etag"), etag);
        await response.arrayBuffer();
      }
    }
  }
});
