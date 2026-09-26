import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { UPLOAD_CHUNK_BYTES, type Book, type UploadSession } from "../types";
import { ApiError } from "./http";
import { getBook, maxUploadBytes, store } from "./storage";
import { saveUpload, uploadName } from "./upload";

const MAX_SESSIONS = 4;
const MAX_RESERVED_BYTES = 2 * 1024 * 1024 * 1024;
const EXPIRY_MS = 60 * 60 * 1000;
const RESULT_EXPIRY_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface PendingUpload {
  id: string;
  path: string;
  name: string;
  size: number;
  offset: number;
  touchedAt: number;
  busy: boolean;
  completion?: Promise<Book>;
  bookId?: string;
  cancel?: () => void;
  receiving?: Promise<void>;
}
interface UploadState {
  root: string;
  sessions: Map<string, PendingUpload>;
  cleanup?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}
const shared = globalThis as typeof globalThis & { __comicChunkUploads?: UploadState };

function state() {
  const root = store().root;
  if (shared.__comicChunkUploads?.root === root) return shared.__comicChunkUploads;
  if (shared.__comicChunkUploads?.timer) clearInterval(shared.__comicChunkUploads.timer);
  const value: UploadState = { root, sessions: new Map() };
  value.timer = setInterval(() => { void cleanup(value).catch(() => undefined); }, 60_000);
  value.timer.unref();
  return shared.__comicChunkUploads = value;
}

async function discard(value: UploadState, upload: PendingUpload) {
  await rm(upload.path, { force: true });
  value.sessions.delete(upload.id);
}

async function cleanup(value: UploadState) {
  if (value.cleanup) return value.cleanup;
  value.cleanup = (async () => {
    const now = Date.now();
    for (const upload of value.sessions.values()) {
      if (!upload.busy && now - upload.touchedAt >= (upload.bookId ? RESULT_EXPIRY_MS : EXPIRY_MS)) {
        await discard(value, upload);
      }
    }
    // A terminated process may leave files that no longer have an in-memory session.
    for (const name of await readdir(join(value.root, "tmp"))) {
      if (!name.startsWith("chunk-") || !name.endsWith(".part")) continue;
      const id = name.slice(6, -5);
      if (!UUID.test(id) || value.sessions.has(id)) continue;
      const path = join(value.root, "tmp", name);
      await rm(path, { force: true });
    }
  })().finally(() => { value.cleanup = undefined; });
  return value.cleanup;
}

function findUpload(id: string) {
  const value = state();
  const upload = UUID.test(id) ? value.sessions.get(id) : undefined;
  if (!upload) throw new ApiError(404, "This upload has expired. Please try again.");
  if (!upload.busy && Date.now() - upload.touchedAt >= (upload.bookId ? RESULT_EXPIRY_MS : EXPIRY_MS)) {
    void discard(value, upload).catch(() => undefined);
    throw new ApiError(404, "This upload has expired. Please try again.");
  }
  return { value, upload };
}

export async function createUpload(input: Record<string, unknown>): Promise<UploadSession> {
  if (Object.keys(input).some(key => !["name", "size"].includes(key)) || typeof input.name !== "string"
    || typeof input.size !== "number" || !Number.isSafeInteger(input.size) || input.size < 8) {
    throw new ApiError(400, "The file details are invalid.");
  }
  if (input.size > maxUploadBytes() || input.size > MAX_RESERVED_BYTES) throw new ApiError(413, "This file exceeds the upload size limit.");
  let name: string;
  try {
    name = uploadName(new Request("http://localhost", { headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(input.name) } }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "The file name could not be read.");
  }
  const value = state();
  await cleanup(value);
  const active = [...value.sessions.values()].filter(upload => !upload.bookId);
  if (active.length >= MAX_SESSIONS || active.reduce((sum, upload) => sum + upload.size, 0) + input.size > MAX_RESERVED_BYTES) {
    throw new ApiError(429, "Other files are being uploaded. Please try again shortly.");
  }
  // Bound the small cache of completed results as well as temporary file space.
  if (value.sessions.size >= 100) {
    const oldest = [...value.sessions.values()].find(upload => !!upload.bookId);
    if (oldest) value.sessions.delete(oldest.id);
  }
  const id = randomUUID();
  const upload: PendingUpload = { id, name, size: input.size, offset: 0, touchedAt: Date.now(), busy: true, path: join(value.root, "tmp", `chunk-${id}.part`) };
  value.sessions.set(id, upload);
  try {
    const file = await open(upload.path, "wx", 0o600);
    await file.close();
    upload.busy = false;
    return { id, chunkBytes: UPLOAD_CHUNK_BYTES };
  } catch (error) {
    await discard(value, upload);
    throw error;
  }
}

export async function appendUpload(id: string, request: Request) {
  const { value, upload } = findUpload(id);
  if (upload.busy || upload.completion || upload.bookId) throw new ApiError(409, "This upload is already being processed.");
  const offset = request.headers.get("upload-offset") || "";
  if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset)) || Number(offset) !== upload.offset) {
    throw new ApiError(409, "The upload could not be continued. Please try again.");
  }
  const expected = Math.min(UPLOAD_CHUNK_BYTES, upload.size - upload.offset);
  const length = request.headers.get("content-length");
  if (expected <= 0) throw new ApiError(409, "This upload is already complete.");
  if (length && (!/^\d+$/.test(length) || Number(length) !== expected)) throw new ApiError(400, "The uploaded file size is invalid.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/octet-stream") {
    throw new ApiError(415, "The uploaded file format is invalid.");
  }
  if (!request.body) throw new ApiError(400, "The uploaded file is empty.");
  upload.busy = true;
  let finishReceiving!: () => void;
  upload.receiving = new Promise<void>(resolve => { finishReceiving = resolve; });
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let cancelled = false;
  let received = 0;
  const cancel = () => { cancelled = true; void reader.cancel().catch(() => undefined); };
  upload.cancel = cancel;
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  timer = setTimeout(() => { timedOut = true; cancel(); }, 2 * 60 * 1000);
  try {
    const file = await open(upload.path, "r+");
    try {
      while (true) {
        const { value: bytes, done } = await reader.read();
        if (done) break;
        if (received + bytes.byteLength > expected) {
          cancel();
          throw new ApiError(413, "This upload exceeds the expected file size.");
        }
        let written = 0;
        while (written < bytes.byteLength) {
          const { bytesWritten } = await file.write(bytes, written, bytes.byteLength - written, upload.offset + received + written);
          written += bytesWritten;
        }
        received += bytes.byteLength;
        upload.touchedAt = Date.now();
      }
      if (timedOut || cancelled || request.signal.aborted) throw new ApiError(408, "The upload was interrupted. Please try again.");
      if (received !== expected) throw new ApiError(400, "The uploaded file size is invalid.");
      await file.sync();
      if (cancelled || request.signal.aborted) throw new ApiError(408, "The upload was interrupted. Please try again.");
      upload.offset += received;
      upload.touchedAt = Date.now();
      return { offset: upload.offset };
    } finally { await file.close(); }
  } catch (error) {
    cancel();
    await discard(value, upload);
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
    upload.busy = false;
    upload.cancel = undefined;
    finishReceiving();
  }
}

export async function completeUpload(id: string): Promise<Book> {
  const { value, upload } = findUpload(id);
  if (upload.bookId) return getBook(upload.bookId);
  if (upload.completion) return upload.completion;
  if (upload.busy || upload.offset !== upload.size) throw new ApiError(409, "The file has not finished uploading. Please try again.");
  upload.busy = true;
  upload.completion = (async () => {
    try {
      if ((await stat(upload.path)).size !== upload.size) throw new ApiError(400, "The uploaded file size is invalid.");
      const stream = createReadStream(upload.path);
      let book: Book;
      try {
        book = await saveUpload(new Request("http://localhost/api/books", {
          method: "POST",
          headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(upload.name), "Content-Length": String(upload.size) },
          body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          duplex: "half",
        } as RequestInit));
      } finally { stream.destroy(); }
      upload.bookId = book.id;
      upload.touchedAt = Date.now();
      return book;
    } catch (error) {
      value.sessions.delete(id);
      throw error;
    } finally {
      await rm(upload.path, { force: true });
      upload.busy = false;
    }
  })();
  return upload.completion;
}

export async function cancelUpload(id: string) {
  if (!UUID.test(id)) throw new ApiError(404, "Upload not found.");
  const value = state();
  const upload = value.sessions.get(id);
  if (!upload) return;
  if (upload.completion) await upload.completion.catch(() => undefined);
  if (upload.cancel) {
    upload.cancel();
    await upload.receiving;
  }
  if (upload.busy) throw new ApiError(409, "This upload is still being received. Please try again shortly.");
  await discard(value, upload);
}
