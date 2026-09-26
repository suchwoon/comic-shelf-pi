import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ApiError } from "./http";

export function parseRange(range: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return null;
    end = Math.min(requestedEnd, size - 1);
  }
  return start < 0 || start >= size || end < start ? null : { start, end };
}

export async function serveFile(request: Request, path: string, contentType: string, filename?: string) {
  let size: number;
  try { size = (await stat(path)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "File not found. Check your library backup.");
    throw error;
  }
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Content-Length": String(size),
  });
  if (filename) headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  let range: { start: number; end: number } | undefined;
  // If-Range without a known validator requires the whole representation.
  const rangeHeader = request.method === "HEAD" || request.headers.has("if-range") ? null : request.headers.get("range");
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, size);
    if (!parsed) {
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    range = parsed;
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const stream = createReadStream(path, { ...range, signal: request.signal });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
}
