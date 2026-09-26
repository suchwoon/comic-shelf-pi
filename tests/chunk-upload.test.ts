import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { appendUpload, cancelUpload, completeUpload, createUpload } from "../lib/server/chunk-upload";
import { ApiError } from "../lib/server/http";
import { bookFile, listBooks, store } from "../lib/server/storage";
import { login } from "../lib/server/auth";
import { deleteBook } from "../lib/server/upload";
import { UPLOAD_CHUNK_BYTES } from "../lib/types";
import { POST as startRoute } from "../app/api/uploads/route";
import { PATCH as appendRoute, DELETE as cancelRoute } from "../app/api/uploads/[id]/route";
import { POST as completeRoute } from "../app/api/uploads/[id]/complete/route";

let dataDir: string;
let fixture: Uint8Array;
const env = { DATA_DIR: process.env.DATA_DIR, BOOKS_PASSWORD: process.env.BOOKS_PASSWORD, MAX_UPLOAD_MB: process.env.MAX_UPLOAD_MB };
const errorStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const chunk = (bytes: Uint8Array, offset = 0, signal?: AbortSignal) => new Request("http://localhost/api/uploads", {
  method: "PATCH", body: bytes as BodyInit, signal,
  headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(offset) },
});

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "comic-chunk-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BOOKS_PASSWORD = "chunk-test-password";
  delete process.env.MAX_UPLOAD_MB;
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.context.register(pdf.context.stream(Buffer.alloc(UPLOAD_CHUNK_BYTES + 100, 65)));
  fixture = await pdf.save({ useObjectStreams: false });
});

after(async () => {
  const shared = globalThis as typeof globalThis & { __comicStore?: { db: { close(): void } }; __comicChunkUploads?: { timer?: ReturnType<typeof setInterval> } };
  shared.__comicStore?.db.close();
  clearInterval(shared.__comicChunkUploads?.timer);
  delete shared.__comicStore;
  delete shared.__comicChunkUploads;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true });
});

it("assembles a PDF across requests, validates it, and coalesces concurrent/repeated completion", async () => {
  const session = await createUpload({ name: "Big book.pdf", size: fixture.length });
  assert.equal(session.chunkBytes, UPLOAD_CHUNK_BYTES);
  await assert.rejects(completeUpload(session.id), errorStatus(409));
  assert.deepEqual(await appendUpload(session.id, chunk(fixture.subarray(0, UPLOAD_CHUNK_BYTES))), { offset: UPLOAD_CHUNK_BYTES });
  await appendUpload(session.id, chunk(fixture.subarray(UPLOAD_CHUNK_BYTES), UPLOAD_CHUNK_BYTES));
  const [a, b] = await Promise.all([completeUpload(session.id), completeUpload(session.id)]);
  assert.equal(a.id, b.id);
  assert.equal((await completeUpload(session.id)).id, a.id);
  assert.equal(a.pageCount, 1);
  assert.equal(a.size, fixture.length);
  assert.deepEqual(new Uint8Array(await readFile(bookFile(a.id))), fixture);
  assert.equal(listBooks().length, 1);
  assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
  await cancelUpload(session.id);
});

it("rejects duplicate PDFs through the existing validation and leaves no temporary files", async () => {
  const session = await createUpload({ name: "Duplicate.pdf", size: fixture.length });
  for (let offset = 0; offset < fixture.length; offset += UPLOAD_CHUNK_BYTES) {
    await appendUpload(session.id, chunk(fixture.subarray(offset, offset + UPLOAD_CHUNK_BYTES), offset));
  }
  await assert.rejects(completeUpload(session.id), errorStatus(409));
  assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
  await deleteBook(listBooks()[0].id);
});

it("validates names, size, paths, offsets, exact chunk lengths and the final total", async () => {
  for (const input of [{ name: "x.exe", size: 12 }, { name: "x.pdf", size: -1 }, { name: "x.pdf", size: 8.5 }, { name: "x.pdf", size: "12" }, { name: "x.pdf", size: 12, path: "/tmp" }]) {
    await assert.rejects(createUpload(input), errorStatus(400));
  }
  await assert.rejects(createUpload({ name: "x.pdf", size: 257 * 1024 * 1024 }), errorStatus(413));
  await assert.rejects(appendUpload("../../outside", chunk(Buffer.alloc(8))), errorStatus(404));
  const session = await createUpload({ name: "x.pdf", size: 8 });
  await assert.rejects(appendUpload(session.id, chunk(Buffer.alloc(8), 1)), errorStatus(409));
  await assert.rejects(appendUpload(session.id, chunk(Buffer.alloc(9))), errorStatus(413));
  await assert.rejects(completeUpload(session.id), errorStatus(404));
  const short = await createUpload({ name: "x.pdf", size: 9 });
  await assert.rejects(appendUpload(short.id, chunk(Buffer.alloc(8))), errorStatus(400));
  const fake = await createUpload({ name: "x.pdf", size: 10 });
  await appendUpload(fake.id, chunk(Buffer.from("not-a-pdf!")));
  await assert.rejects(completeUpload(fake.id), errorStatus(422));
  assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
});

it("bounds active temporary uploads and cleans cancelled and orphaned sessions", async () => {
  const sessions = await Promise.all(Array.from({ length: 4 }, () => createUpload({ name: "x.pdf", size: 16 })));
  await assert.rejects(createUpload({ name: "x.pdf", size: 16 }), errorStatus(429));
  for (const session of sessions) await cancelUpload(session.id);
  await cancelUpload(sessions[0].id);
  await writeFile(join(dataDir, "tmp", `chunk-${randomUUID()}.part`), "abandoned by an old process");
  const fresh = await createUpload({ name: "fresh.pdf", size: 16 });
  assert.equal((await readdir(join(dataDir, "tmp"))).length, 1);
  await cancelUpload(fresh.id);
  assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
});

it("cancels an in-flight stream and rejects overlapping writes without leaking a partial file", async () => {
  const session = await createUpload({ name: "x.pdf", size: 16 });
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const request = new Request("http://localhost/api/uploads", {
    method: "PATCH", headers: { "Content-Type": "application/octet-stream", "Upload-Offset": "0" },
    body: new ReadableStream({ pull() { started(); } }), duplex: "half",
  } as RequestInit);
  const pending = appendUpload(session.id, request);
  const rejected = assert.rejects(pending, errorStatus(408));
  await beginning;
  await assert.rejects(appendUpload(session.id, chunk(Buffer.alloc(16))), errorStatus(409));
  await cancelUpload(session.id);
  await rejected;
  assert.deepEqual(await readdir(join(dataDir, "tmp")), []);
});

it("requires authentication and same-origin requests on every upload route and bounds JSON", async () => {
  const context = { params: Promise.resolve({ id: randomUUID() }) };
  assert.equal((await startRoute(new Request("http://localhost/api/uploads", { method: "POST" }))).status, 401);
  assert.equal((await appendRoute(chunk(Buffer.alloc(8)), context)).status, 401);
  assert.equal((await completeRoute(new Request("http://localhost/api/uploads", { method: "POST" }), context)).status, 401);
  assert.equal((await cancelRoute(new Request("http://localhost/api/uploads", { method: "DELETE" }), context)).status, 401);
  const cookie = login(new Request("http://localhost/api/session"), "chunk-test-password")!;
  const make = (body: string, origin = "http://localhost") => new Request("http://localhost/api/uploads", {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body,
  });
  assert.equal((await startRoute(make(JSON.stringify({ name: "x.pdf", size: 8 }), "https://other.example"))).status, 403);
  assert.equal((await startRoute(make("{"))).status, 400);
  assert.equal((await startRoute(make(JSON.stringify({ name: "x".repeat(20_000), size: 8 })))).status, 413);
  const response = await startRoute(make(JSON.stringify({ name: "Allowed.pdf", size: 8 })));
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.match(session.id, /^[0-9a-f-]{36}$/);
  await cancelUpload(session.id);
  assert.equal(store().root, dataDir);
});
