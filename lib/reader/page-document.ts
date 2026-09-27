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
  destroy(): void;
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

/** Image resources live only until their bounded canvas has finished rendering. */
export class ImagePageDocument implements PageDocument {
  private readonly requests = new Set<AbortController>();
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
    this.requests.add(controller);
    let image: HTMLImageElement | undefined;
    try {
      const response = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/pages/${pageNumber}`, {
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (controller.signal.aborted || this.destroyed) throw aborted();
      if (response.status === 401) window.location.replace("/");
      if (!response.ok) throw new Error("Page image could not be loaded");
      if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/jpeg") {
        throw new Error("Invalid page image response");
      }
      const blob = await response.blob();
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
      throw error;
    } finally {
      this.requests.delete(controller);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const request of this.requests) request.abort();
    for (const page of this.pages) page.cleanup();
  }
}
