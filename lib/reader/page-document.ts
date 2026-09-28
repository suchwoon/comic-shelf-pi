export interface PageViewport {
  width: number;
  height: number;
}

export interface PageRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface DocumentPage {
  getViewport(options: { scale: number }): PageViewport;
  render(options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PageViewport;
    background: string;
  }): PageRenderTask;
  cleanup(): void;
}

export interface PageDocument {
  readonly numPages: number;
  getPage(page: number, signal?: AbortSignal): Promise<DocumentPage>;
  /** Prepare compressed images in reading order without allocating decoded images or canvases. */
  prefetch?(pages: readonly number[]): void;
  destroy(): void;
}

const MAX_CACHED_IMAGES = 12;
const MAX_CACHED_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_REQUESTS = 2;

interface ImageRequest {
  page: number;
  controller: AbortController;
  promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
  consumers: number;
  started: boolean;
}

function aborted(): Error {
  const error = new Error("Page request cancelled");
  error.name = "AbortError";
  return error;
}

/** Decodes a server-rendered image without ever requesting the source PDF. */
function decodeImage(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.decoding = "async";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", onAbort);
      URL.revokeObjectURL(url);
      if (error) {
        image.src = "";
        reject(error);
      } else {
        resolve(image);
      }
    };
    const onAbort = () => finish(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) finish(new Error("Invalid page image dimensions"));
      else finish();
    };
    image.onerror = () => finish(new Error("Page image could not be decoded"));
    image.src = url;
  });
}

/** Keeps bounded compressed images; decoded resources live only until their canvas finishes rendering. */
export class ImagePageDocument implements PageDocument {
  private readonly consumers = new Set<AbortController>();
  private readonly requests = new Map<number, ImageRequest>();
  private readonly images = new Map<number, Blob>();
  private preferred: number[] = [];
  private imageBytes = 0;
  private readonly pages = new Set<DocumentPage>();
  private destroyed = false;

  constructor(private readonly bookId: string, readonly numPages: number) {
    if (!Number.isInteger(numPages) || numPages < 1) throw new RangeError("Invalid page count");
  }

  async getPage(pageNumber: number, signal?: AbortSignal): Promise<DocumentPage> {
    if (this.destroyed || signal?.aborted) throw aborted();
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.numPages) {
      throw new RangeError("Invalid page number");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.consumers.add(controller);
    let image: HTMLImageElement | undefined;
    try {
      const blob = await this.getImage(pageNumber, controller.signal);
      image = await decodeImage(blob, controller.signal);
      if (controller.signal.aborted || this.destroyed) throw aborted();
      const decoded = image;
      const width = decoded.naturalWidth;
      const height = decoded.naturalHeight;
      let released = false;
      const page: DocumentPage = {
        getViewport: ({ scale }) => ({ width: width * scale, height: height * scale }),
        render: ({ canvas, canvasContext, background }) => {
          let cancelled = false;
          const promise = Promise.resolve().then(() => {
            if (cancelled || released || this.destroyed) throw aborted();
            canvasContext.fillStyle = background;
            canvasContext.fillRect(0, 0, canvas.width, canvas.height);
            canvasContext.drawImage(decoded, 0, 0, canvas.width, canvas.height);
          });
          return { promise, cancel() { cancelled = true; } };
        },
        cleanup: () => {
          if (released) return;
          released = true;
          decoded.src = "";
          this.pages.delete(page);
        },
      };
      this.pages.add(page);
      return page;
    } catch (error) {
      if (image) image.src = "";
      // A bad decode must be refetched on retry, rather than poisoning the image cache.
      if (!controller.signal.aborted) this.forgetImage(pageNumber);
      throw error;
    } finally {
      this.consumers.delete(controller);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  prefetch(pages: readonly number[]): void {
    if (this.destroyed) return;
    this.preferred = [...new Set(pages.filter(page => Number.isInteger(page) && page >= 1 && page <= this.numPages))]
      .slice(0, MAX_CACHED_IMAGES);
    for (const page of this.images.keys()) {
      if (!this.preferred.includes(page)) this.forgetImage(page);
    }
    for (const request of this.requests.values()) {
      if (!request.consumers && !this.preferred.includes(request.page)) this.cancelRequest(request);
    }
    for (const page of this.preferred) {
      if (!this.images.has(page)) this.requestImage(page);
    }
    this.pump();
  }

  private requestImage(page: number): ImageRequest {
    const existing = this.requests.get(page);
    if (existing) return existing;
    let resolve!: ImageRequest["resolve"];
    let reject!: ImageRequest["reject"];
    const promise = new Promise<Blob>((accept, fail) => { resolve = accept; reject = fail; });
    // Background failures remain retryable when a reader actually requests that page.
    void promise.catch(() => undefined);
    const request = { page, controller: new AbortController(), promise, resolve, reject, consumers: 0, started: false };
    this.requests.set(page, request);
    return request;
  }

  private async getImage(page: number, signal: AbortSignal): Promise<Blob> {
    const cached = this.images.get(page);
    if (cached) {
      this.images.delete(page);
      this.images.set(page, cached);
      return cached;
    }
    const request = this.requestImage(page);
    request.consumers++;
    let onAbort!: () => void;
    try {
      const result = new Promise<Blob>((resolve, reject) => {
        onAbort = () => reject(aborted());
        signal.addEventListener("abort", onAbort, { once: true });
        request.promise.then(resolve, reject);
      });
      this.pump();
      return await result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      request.consumers--;
      if (!request.consumers && !this.preferred.includes(page)) this.cancelRequest(request);
      this.pump();
    }
  }

  private pump(): void {
    if (this.destroyed) return;
    const requests = [...this.requests.values()];
    const active = requests.filter(request => request.started);
    const queue = requests.filter(request => !request.started).sort((a, b) => {
      if (!!a.consumers !== !!b.consumers) return a.consumers ? -1 : 1;
      return this.preferred.indexOf(a.page) - this.preferred.indexOf(b.page);
    });
    for (const request of queue) {
      if (active.length >= MAX_IMAGE_REQUESTS) {
        if (!request.consumers) break;
        // A promoted image can become background again when its canvas render is cancelled.
        // Preempt the farthest unused fetch so that two such images cannot delay a page jump.
        const displaced = active.filter(item => !item.consumers)
          .sort((a, b) => this.imagePriority(b.page) - this.imagePriority(a.page))[0];
        if (!displaced) break;
        this.cancelRequest(displaced);
        active.splice(active.indexOf(displaced), 1);
        if (this.preferred.includes(displaced.page)) this.requestImage(displaced.page);
      }
      // Keep a fetch lane available for a jump to an uncached foreground page.
      if (!request.consumers && active.some(item => !item.consumers)) continue;
      active.push(request);
      this.startRequest(request);
    }
  }

  private imagePriority(page: number): number {
    const index = this.preferred.indexOf(page);
    return index === -1 ? MAX_CACHED_IMAGES : index;
  }

  private startRequest(request: ImageRequest): void {
    request.started = true;
    void (async () => {
      try {
        const response = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/pages/${request.page}`, {
          signal: request.controller.signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        if (request.controller.signal.aborted || this.destroyed) throw aborted();
        if (response.status === 401) window.location.replace("/");
        if (!response.ok) throw new Error("Page image could not be loaded");
        if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/jpeg") {
          throw new Error("Invalid page image response");
        }
        const blob = await response.blob();
        if (request.controller.signal.aborted || this.destroyed) throw aborted();
        this.rememberImage(request.page, blob);
        request.resolve(blob);
      } catch (error) {
        request.reject(error);
      } finally {
        if (this.requests.get(request.page) === request) this.requests.delete(request.page);
        this.pump();
      }
    })();
  }

  private rememberImage(page: number, blob: Blob): void {
    if (blob.size > MAX_CACHED_BYTES) return;
    this.forgetImage(page);
    this.images.set(page, blob);
    this.imageBytes += blob.size;
    const evictionOrder = [...this.images.keys()].sort((a, b) => this.imagePriority(b) - this.imagePriority(a));
    for (const candidate of evictionOrder) {
      if (this.images.size <= MAX_CACHED_IMAGES && this.imageBytes <= MAX_CACHED_BYTES) break;
      this.forgetImage(candidate);
    }
  }

  private forgetImage(page: number): void {
    const blob = this.images.get(page);
    if (!blob) return;
    this.imageBytes -= blob.size;
    this.images.delete(page);
  }

  private cancelRequest(request: ImageRequest): void {
    if (this.requests.get(request.page) !== request) return;
    this.requests.delete(request.page);
    request.controller.abort();
    request.reject(aborted());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const consumer of this.consumers) consumer.abort();
    for (const request of this.requests.values()) this.cancelRequest(request);
    this.preferred = [];
    this.images.clear();
    this.imageBytes = 0;
    for (const page of this.pages) page.cleanup();
  }
}
