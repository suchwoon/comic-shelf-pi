import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Book } from "../types";
import { ApiError } from "./http";
import { bookFile, coverFile, getBook, maxUploadBytes, store } from "./storage";
import { deletePageImages } from "./page-images";

const inspectionState = globalThis as typeof globalThis & { __comicInspecting?: boolean };

export function uploadName(request: Request) {
  let name: string;
  try { name = decodeURIComponent(request.headers.get("x-file-name") || ""); }
  catch { throw new ApiError(400, "The file name could not be read."); }
  name = name.split(/[\\/]/).pop()?.trim() || "";
  if (!name || name.length > 250 || /[\u0000-\u001f]/.test(name) || !/\.pdf$/i.test(name)) {
    throw new ApiError(400, "Choose a PDF file with a .pdf extension.");
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
    throw new ApiError(415, "Only PDF files can be uploaded.");
  }
  return name;
}

export async function inspectPdf(input: string, output: string): Promise<number> {
  if (inspectionState.__comicInspecting) throw new ApiError(429, "Another book is being processed. Please try again shortly.");
  inspectionState.__comicInspecting = true;
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=384", join(process.cwd(), "scripts", "pdf-inspect.mjs"), input, output], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BOOKS_PASSWORD: undefined },
      });
      let stdout = "";
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 45_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 65_536) stdout += chunk.toString("utf8");
        else child.kill("SIGKILL");
      });
      // Drain stderr without exposing PDF contents, server paths, or child diagnostics.
      child.stderr.resume();
      child.on("error", () => { clearTimeout(timeout); reject(new ApiError(500, "Could not start processing the PDF. Please try again.")); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) return reject(new ApiError(422, "Processing took too long. Try optimizing the PDF before uploading it again."));
        let result: { pageCount?: number; error?: string } = {};
        try { result = JSON.parse(stdout.trim().split("\n").at(-1) || "{}"); } catch { /* invalid output is an invalid document */ }
        if (result.error === "PASSWORD") return reject(new ApiError(422, "Password-protected PDFs are not supported. Upload an unlocked copy."));
        if (code !== 0 || !Number.isInteger(result.pageCount) || result.pageCount! < 1 || result.pageCount! > 50_000) {
          return reject(new ApiError(422, "Could not open the PDF. Check that the file is not damaged."));
        }
        resolve(result.pageCount!);
      });
    });
  } finally { inspectionState.__comicInspecting = false; }
}

export async function saveUpload(request: Request): Promise<Book> {
  const originalName = uploadName(request);
  const maximum = maxUploadBytes();
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximum)) {
    throw new ApiError(413, "This file exceeds the upload size limit.");
  }
  if (!request.body) throw new ApiError(400, "The file is empty.");
  const id = randomUUID();
  const temporaryPdf = join(store().root, "tmp", `${id}.pdf`);
  const temporaryCover = join(store().root, "tmp", `${id}.jpg`);
  const destinationPdf = bookFile(id);
  const destinationCover = coverFile(id);
  let committed = false;
  let size = 0;
  const hash = createHash("sha256");
  const prefix: Buffer[] = [];
  let prefixSize = 0;
  try {
    const file = await open(temporaryPdf, "wx", 0o600);
    const reader = request.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          throw new ApiError(413, "This file exceeds the upload size limit.");
        }
        if (prefixSize < 1024) {
          const slice = Buffer.from(value.subarray(0, 1024 - prefixSize));
          prefix.push(slice); prefixSize += slice.length;
        }
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
          offset += bytesWritten;
        }
      }
      await file.sync();
    } finally {
      reader.releaseLock();
      await file.close();
    }
    if (size < 8 || !Buffer.concat(prefix).includes(Buffer.from("%PDF-"))) {
      throw new ApiError(422, "This file is not a PDF.");
    }
    const sha256 = hash.digest("hex");
    if (store().db.prepare("SELECT id FROM books WHERE sha256 = ?").get(sha256)) {
      throw new ApiError(409, "This file is already in your library.");
    }
    const pageCount = await inspectPdf(temporaryPdf, temporaryCover);
    await rename(temporaryPdf, destinationPdf);
    await rename(temporaryCover, destinationCover);
    store().db.prepare(`INSERT INTO books (id, title, originalName, size, pageCount, createdAt, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, originalName.replace(/\.pdf$/i, "").slice(0, 200) || "Untitled book", originalName, size, pageCount, new Date().toISOString(), sha256);
    committed = true;
    return getBook(id);
  } catch (error) {
    if ((error as Error)?.message?.includes("UNIQUE constraint failed: books.sha256")) throw new ApiError(409, "This file is already in your library.");
    throw error;
  } finally {
    const leftovers = committed ? [temporaryPdf, temporaryCover] : [temporaryPdf, temporaryCover, destinationPdf, destinationCover];
    await Promise.all(leftovers.map(file => rm(file, { force: true }).catch(() => undefined)));
  }
}

export async function deleteBook(id: string) {
  getBook(id);
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const from of [bookFile(id), coverFile(id)]) {
      const to = join(store().root, "tmp", `${randomUUID()}.deleted`);
      try { await rename(from, to); moved.push({ from, to }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    store().db.prepare("DELETE FROM books WHERE id = ?").run(id);
  } catch (error) {
    await Promise.all(moved.map(file => rename(file.to, file.from)));
    throw error;
  }
  await Promise.all([deletePageImages(id), ...moved.map(file => rm(file.to, { force: true }))]);
}
