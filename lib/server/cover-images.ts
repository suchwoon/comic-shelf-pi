import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveFile } from "./files";
import { ApiError } from "./http";
import { coverFile, dataRoot, getBook } from "./storage";

const WIDTHS = new Set(["96", "320", "480", "680"]);
const CACHE_VERSION = "v1";
interface CoverState {
  active: number;
  waiting: Array<() => void>;
  pending: Map<string, Promise<Buffer>>;
}
const shared = globalThis as typeof globalThis & { __comicCoverImages?: CoverState };
const state = shared.__comicCoverImages ??= { active: 0, waiting: [], pending: new Map() } as CoverState;
const cacheDirectory = (id: string) => join(dataRoot(), "cover-thumbnails", CACHE_VERSION, id);
class SourceChanged extends Error {}

async function sourceVersion(path: string) {
  try {
    const source = await stat(path, { bigint: true });
    // ctime also catches replacements that preserve the file's size and mtime.
    return createHash("sha256").update(`${source.ino}:${source.size}:${source.mtimeNs}:${source.ctimeNs}`).digest("hex").slice(0, 32);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "Cover not found. Check your library backup.");
    throw error;
  }
}

async function renderSlot<T>(render: () => Promise<T>): Promise<T> {
  // Small images still occupy native canvas memory; keep generation bounded.
  if (state.active >= 2) await new Promise<void>(resolve => state.waiting.push(resolve));
  else state.active++;
  try { return await render(); }
  finally {
    const next = state.waiting.shift();
    if (next) next(); else state.active--;
  }
}

async function thumbnail(id: string, source: string, version: string, width: number) {
  const directory = cacheDirectory(id);
  const destination = join(directory, `${version}-${width}.webp`);
  try { return await readFile(destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pending = state.pending.get(destination);
  if (pending) return pending;
  const task = renderSlot(async () => {
    const image = await loadImage(await readFile(source));
    const scale = Math.min(1, width / image.width);
    const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const drawing = canvas.getContext("2d");
    drawing.imageSmoothingQuality = "high";
    drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
    const bytes = await canvas.encode("webp", 80);
    if (await sourceVersion(source) !== version) throw new SourceChanged();
    // A book removed during generation must not leave a new thumbnail behind.
    getBook(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    // Replacing a cover should not accumulate old thumbnail generations.
    const names = await readdir(directory);
    await Promise.all(names.filter(name => name.endsWith(".webp") && !name.startsWith(`${version}-`))
      .map(name => rm(join(directory, name), { force: true })));
    return bytes;
  });
  state.pending.set(destination, task);
  try { return await task; }
  finally { if (state.pending.get(destination) === task) state.pending.delete(destination); }
}

function matchesValidator(value: string | null, etag: string) {
  return value?.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, "")) ?? false;
}

/** Call only after checking the active session and the book's existence. */
export async function serveCover(request: Request, id: string): Promise<Response> {
  const widths = new URL(request.url).searchParams.getAll("w");
  if (widths.length > 1 || (widths.length === 1 && !WIDTHS.has(widths[0]))) throw new ApiError(400, "The cover size is invalid.");
  const width = widths.length ? Number(widths[0]) : null;
  const source = coverFile(id);
  for (let attempt = 0; attempt < 2; attempt++) {
    const version = await sourceVersion(source);
    const etag = `W/"cover-${CACHE_VERSION}-${version}-${width ?? "original"}"`;
    const headers = new Headers({
      "Cache-Control": "private, no-cache",
      "ETag": etag,
      "Vary": "Cookie",
      "X-Content-Type-Options": "nosniff",
    });
    // This saves the body transfer, while the route still checks auth each time.
    if (matchesValidator(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    if (width === null) {
      const response = await serveFile(request, source, "image/jpeg");
      headers.forEach((value, key) => response.headers.set(key, value));
      return response;
    }
    try {
      const bytes = await thumbnail(id, source, version, width);
      headers.set("Content-Type", "image/webp");
      headers.set("Content-Length", String(bytes.length));
      return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { headers });
    } catch (error) {
      if (!(error instanceof SourceChanged)) throw error;
    }
  }
  throw new ApiError(503, "The cover is being updated. Please try again shortly.");
}

export async function deleteCoverImages(id: string) {
  const directory = cacheDirectory(id);
  await Promise.allSettled([...state.pending].filter(([path]) => path.startsWith(`${directory}/`)).map(([, task]) => task));
  await rm(directory, { recursive: true, force: true });
}
