import { UPLOAD_CHUNK_BYTES, type Book, type UploadSession } from "../types";

export class UploadError extends Error {
  constructor(message: string, public status = 0) { super(message); }
  get retryable() { return ![400, 413, 415, 422].includes(this.status); }
}

interface UploadOptions {
  signal: AbortSignal;
  onProgress: (progress: number, checking: boolean) => void;
}

function request<T>(method: string, path: string, body: Blob | string | null, headers: Record<string, string>, signal: AbortSignal,
  onProgress?: (loaded: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const aborted = () => { xhr.abort(); reject(new DOMException("Upload cancelled", "AbortError")); };
    if (signal.aborted) { aborted(); return; }
    xhr.open(method, path);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.timeout = 15 * 60 * 1000;
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded); };
    xhr.onload = () => {
      cleanup();
      let data: unknown;
      try { data = JSON.parse(xhr.responseText); } catch { /* A proxy error may contain HTML. */ }
      if (xhr.status >= 200 && xhr.status < 300 && data && typeof data === "object") resolve(data as T);
      else {
        const error = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error :
          xhr.status === 413 ? "This file exceeds the upload size limit." : "Upload failed. Please try again.";
        reject(new UploadError(error, xhr.status));
      }
    };
    xhr.onerror = () => { cleanup(); reject(new UploadError("Connection lost. Please try again.")); };
    xhr.ontimeout = () => { cleanup(); reject(new UploadError("Upload timed out. Please try again.")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Upload cancelled", "AbortError")); };
    xhr.send(body);
  });
}

export async function uploadPdf(file: File, { signal, onProgress }: UploadOptions): Promise<Book> {
  let sessionId: string | undefined;
  let completed = false;
  const progress = (bytes: number) => {
    const percent = Math.min(100, Math.round(bytes / file.size * 100));
    onProgress(percent, bytes >= file.size);
  };
  try {
    let result: { book: Book };
    if (file.size <= UPLOAD_CHUNK_BYTES) {
      result = await request("POST", "/api/books", file, { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) }, signal, progress);
    } else {
      const session = await request<UploadSession>("POST", "/api/uploads", JSON.stringify({ name: file.name, size: file.size }), { "Content-Type": "application/json" }, signal);
      if (!/^[0-9a-f-]{36}$/i.test(session.id) || session.chunkBytes !== UPLOAD_CHUNK_BYTES) throw new UploadError("Could not start the upload. Please try again.");
      sessionId = session.id;
      for (let offset = 0; offset < file.size; offset += session.chunkBytes) {
        const end = Math.min(file.size, offset + session.chunkBytes);
        const part = await request<{ offset: number }>("PATCH", `/api/uploads/${session.id}`, file.slice(offset, end), {
          "Content-Type": "application/octet-stream", "Upload-Offset": String(offset),
        }, signal, loaded => progress(offset + loaded));
        if (part.offset !== end) throw new UploadError("The upload was interrupted. Please try again.");
        progress(end);
      }
      onProgress(100, true);
      result = await request("POST", `/api/uploads/${session.id}/complete`, null, {}, signal);
    }
    if (!result.book?.id) throw new UploadError("Upload failed. Please try again.");
    completed = true;
    return result.book;
  } finally {
    if (sessionId && !completed) {
      // Best effort even when navigation has aborted the original upload. The
      // server also expires abandoned sessions when a browser cannot send this.
      void fetch(`/api/uploads/${sessionId}`, { method: "DELETE", keepalive: true, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }
  }
}
