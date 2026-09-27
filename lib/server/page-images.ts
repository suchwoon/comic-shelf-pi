import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { Book } from "../types";
import { ApiError } from "./http";
import { bookFile, dataRoot, getBook } from "./storage";

const MAX_RENDERERS = 2;
const MAX_WAITING = 16;
const MAX_CACHE_BYTES = 192 * 1024 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
interface RenderState {
  active: number;
  waiting: Array<() => void>;
  pending: Map<string, Promise<Buffer>>;
  pruning: Promise<void>;
}
const shared = globalThis as typeof globalThis & { __comicPageImages?: RenderState };
const state: RenderState = shared.__comicPageImages ??= { active: 0, waiting: [], pending: new Map(), pruning: Promise.resolve() };
const cacheRoot = () => join(dataRoot(), "pages", "v1");

export function parsePageNumber(value: string, pageCount: number) {
  if (!/^[1-9]\d{0,4}$/.test(value)) throw new ApiError(400, "The page number is invalid.");
  const page = Number(value);
  if (page > pageCount) throw new ApiError(404, "Page not found.");
  return page;
}

async function renderSlot<T>(render: () => Promise<T>): Promise<T> {
  if (state.active >= MAX_RENDERERS) {
    if (state.waiting.length >= MAX_WAITING) throw new ApiError(429, "Pages are busy rendering. Please try again shortly.");
    await new Promise<void>(resolve => state.waiting.push(resolve));
  } else state.active++;
  try { return await render(); }
  finally {
    const next = state.waiting.shift();
    if (next) next(); else state.active--;
  }
}

async function renderPdfPage(input: string, output: string, page: number) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=384", join(process.cwd(), "scripts", "pdf-render-page.mjs"), input, output, String(page)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BOOKS_PASSWORD: undefined },
    });
    let stdout = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString("utf8"); else child.kill("SIGKILL");
    });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timeout); reject(new ApiError(500, "Could not render this page. Please try again.")); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (timedOut) return reject(new ApiError(504, "This page took too long to render. Please try again."));
      let result: { width?: number; height?: number } = {};
      try { result = JSON.parse(stdout.trim().split("\n").at(-1) || "{}"); } catch { /* reject below */ }
      if (code !== 0 || !Number.isInteger(result.width) || !Number.isInteger(result.height)
        || result.width! < 1 || result.height! < 1 || result.width! > 2400 || result.height! > 2400
        || result.width! * result.height! > 6_000_000) {
        return reject(new ApiError(422, "Could not render this page. The PDF may be damaged."));
      }
      resolve();
    });
  });
}

async function readImage(path: string) {
  const metadata = await stat(path);
  if (metadata.size < 4 || metadata.size > MAX_IMAGE_BYTES) throw new ApiError(422, "The rendered page is invalid.");
  const bytes = await readFile(path);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new ApiError(422, "The rendered page is invalid.");
  }
  return bytes;
}

async function trimCache(root: string) {
  const entries = await readdir(root);
  const files = (await Promise.all(entries.filter(name => name.endsWith(".jpg")).map(async name => {
    const path = join(root, name);
    try { const metadata = await stat(path); return { path, size: metadata.size, used: metadata.mtimeMs }; }
    catch { return null; }
  }))).filter(file => file !== null);
  let size = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.used - b.used)) {
    if (size <= MAX_CACHE_BYTES) break;
    await rm(file.path, { force: true });
    size -= file.size;
  }
}

/** Returns only a rasterized JPEG; original document bytes stay on the server. */
export async function pageImage(book: Book, page: number): Promise<Buffer> {
  parsePageNumber(String(page), book.pageCount);
  const root = cacheRoot();
  const destination = join(root, `${book.id}-${page}.jpg`);
  try {
    const bytes = await readImage(destination);
    const now = new Date();
    await utimes(destination, now, now).catch(() => undefined);
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pending = state.pending.get(destination);
  if (pending) return pending;
  const task = renderSlot(async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `${book.id}-${page}-${randomUUID()}.tmp`);
    try {
      await renderPdfPage(bookFile(book.id), temporary, page);
      const bytes = await readImage(temporary);
      // Deleting a book during rendering must not repopulate its image cache.
      getBook(book.id);
      await rename(temporary, destination);
      state.pruning = state.pruning.catch(() => undefined).then(() => trimCache(root));
      await state.pruning;
      return bytes;
    } finally { await rm(temporary, { force: true }); }
  });
  state.pending.set(destination, task);
  try { return await task; }
  finally { if (state.pending.get(destination) === task) state.pending.delete(destination); }
}

export async function deletePageImages(id: string) {
  const root = cacheRoot();
  const prefix = join(root, `${id}-`);
  await Promise.allSettled([...state.pending].filter(([path]) => path.startsWith(prefix)).map(([, task]) => task));
  let names: string[];
  try { names = await readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await Promise.all(names.filter(name => name.startsWith(`${id}-`)).map(name => rm(join(root, name), { force: true })));
}
