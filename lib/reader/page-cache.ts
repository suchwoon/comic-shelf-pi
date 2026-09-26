import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

export interface PageLayout {
  width: number;
  height: number;
  fit: "page" | "width";
  zoom: number;
  pixelRatio: number;
}

const MAX_CANVASES = 4;
const MAX_TOTAL_PIXELS = 16_000_000;
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_DIMENSION = 8_192;

interface PageSpec {
  page: number;
  layout: PageLayout;
  layoutKey: string;
  key: string;
}

interface CacheEntry extends PageSpec {
  canvas: HTMLCanvasElement;
  pixels: number;
  ready: boolean;
}

interface Foreground extends PageSpec {
  promise: Promise<HTMLCanvasElement>;
  resolve: (canvas: HTMLCanvasElement) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

interface RenderJob extends PageSpec {
  cancelled: boolean;
  task?: RenderTask;
  entry?: CacheEntry;
}

function aborted(): Error {
  const error = new Error("Page request cancelled");
  error.name = "AbortError";
  return error;
}

function specification(page: number, layout: PageLayout): PageSpec {
  if (!Number.isFinite(layout.width) || layout.width <= 0
    || !Number.isFinite(layout.height) || layout.height <= 0
    || !Number.isFinite(layout.zoom) || layout.zoom <= 0
    || (layout.fit !== "page" && layout.fit !== "width")) {
    throw new RangeError("Invalid page layout");
  }
  const normalized = {
    ...layout,
    pixelRatio: Number.isFinite(layout.pixelRatio) && layout.pixelRatio > 0
      ? Math.min(layout.pixelRatio, 2) : 1,
  };
  const layoutKey = JSON.stringify([
    normalized.width, normalized.height, normalized.fit, normalized.zoom, normalized.pixelRatio,
  ]);
  return { page, layout: normalized, layoutKey, key: `${page}:${layoutKey}` };
}

/** Owns every page canvas, including the visible canvas until its replacement is committed. */
export class PdfPageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private visible: CacheEntry | null = null;
  private foreground: Foreground | null = null;
  private running: RenderJob | null = null;
  private queue: PageSpec[] = [];
  private preferredKeys: string[] = [];
  private layoutKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly pdf: PDFDocumentProxy) {}

  request(page: number, layout: PageLayout): Promise<HTMLCanvasElement> {
    if (this.disposed) return Promise.reject(aborted());
    if (!Number.isInteger(page) || page < 1 || page > this.pdf.numPages) {
      return Promise.reject(new RangeError("Invalid PDF page"));
    }
    let spec: PageSpec;
    try {
      spec = specification(page, layout);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.foreground?.key === spec.key) return this.foreground.promise;

    if (this.foreground && !this.foreground.settled) this.foreground.reject(aborted());
    this.clearTimer();
    this.queue = [];
    this.layoutKey = spec.layoutKey;
    this.preferredKeys = this.neighbors(spec).map(item => item.key);

    let resolve!: Foreground["resolve"];
    let reject!: Foreground["reject"];
    const promise = new Promise<HTMLCanvasElement>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    this.foreground = { ...spec, promise, resolve, reject, settled: false };

    // A prefetched page already being rendered is promoted without cancelling its work.
    if (this.running && (this.running.key !== spec.key || this.running.cancelled)) {
      this.cancelRunning();
    }
    this.prune();
    const cached = this.entries.get(spec.key);
    if (cached?.ready) {
      this.foreground.settled = true;
      resolve(cached.canvas);
    } else {
      this.pump();
    }
    return promise;
  }

  /** Call immediately after replacing the displayed DOM canvas, without an intervening await. */
  commit(canvas: HTMLCanvasElement): void {
    if (this.disposed) return;
    const entry = [...this.entries.values()].find(item => item.canvas === canvas);
    if (!entry?.ready || (this.foreground && this.foreground.key !== entry.key)) return;
    this.visible = entry;
    if (this.foreground?.key === entry.key) this.foreground = null;
    this.prune();
  }

  /** Warm the next two pages and the previous page, as the shared pixel budget allows. */
  prefetch(page: number, layout: PageLayout): void {
    if (this.disposed || this.foreground) return;
    let spec: PageSpec;
    try {
      spec = specification(page, layout);
    } catch {
      return;
    }
    if (this.visible?.key !== spec.key || this.layoutKey !== spec.layoutKey) return;
    const neighbors = this.neighbors(spec);
    this.preferredKeys = neighbors.map(item => item.key);
    this.prune();
    this.queue = neighbors.slice(1).filter(item => !this.entries.get(item.key)?.ready
      && (this.running?.key !== item.key || this.running.cancelled));
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.queue = [];
    if (this.foreground && !this.foreground.settled) this.foreground.reject(aborted());
    this.foreground = null;
    this.visible = null;
    this.cancelRunning();
    for (const entry of this.entries.values()) {
      // A cancelled PDF.js task can still touch its canvas until its promise settles.
      if (entry !== this.running?.entry) this.release(entry);
    }
  }

  private neighbors(spec: PageSpec): PageSpec[] {
    return [spec.page, spec.page + 1, spec.page + 2, spec.page - 1]
      .filter(page => page >= 1 && page <= this.pdf.numPages)
      .map(page => ({ ...spec, page, key: `${page}:${spec.layoutKey}` }));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private cancelRunning(): void {
    if (!this.running || this.running.cancelled) return;
    this.running.cancelled = true;
    try { this.running.task?.cancel(); } catch { /* Already settled or document destroyed. */ }
  }

  private prune(): void {
    for (const entry of this.entries.values()) {
      if (entry === this.visible || entry === this.running?.entry || entry.key === this.foreground?.key) continue;
      if (entry.layoutKey !== this.layoutKey || !this.preferredKeys.includes(entry.key)) this.release(entry);
    }
  }

  private release(entry: CacheEntry): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }

  private priority(key: string): number {
    const index = this.preferredKeys.indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  private makeRoom(pixels: number, job: RenderJob): boolean {
    const entries = [...this.entries.values()];
    let count = entries.length;
    let allocated = entries.reduce((total, entry) => total + entry.pixels, 0);
    const isForeground = this.foreground?.key === job.key;
    const candidates = entries.filter(entry => entry !== this.visible
      && entry !== this.running?.entry
      && entry.key !== this.foreground?.key
      && (isForeground || this.priority(entry.key) > this.priority(job.key)))
      .sort((first, second) => this.priority(second.key) - this.priority(first.key));
    const evictions: CacheEntry[] = [];
    while (count >= MAX_CANVASES || allocated + pixels > MAX_TOTAL_PIXELS) {
      const entry = candidates.shift();
      if (!entry) return false;
      evictions.push(entry);
      count -= 1;
      allocated -= entry.pixels;
    }
    for (const entry of evictions) this.release(entry);
    return true;
  }

  private schedule(): void {
    if (this.disposed || this.running) return;
    if (this.foreground) {
      if (!this.foreground.settled) this.pump();
      return;
    }
    // Give a newly committed page a chance to paint before preparing its neighbors.
    if (this.queue.length && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, 0);
    }
  }

  private pump(): void {
    if (this.disposed || this.running) return;
    let spec: PageSpec | undefined;
    if (this.foreground) {
      if (this.foreground.settled) return;
      spec = this.foreground;
    } else {
      while (this.queue.length) {
        const candidate = this.queue.shift()!;
        if (candidate.layoutKey === this.layoutKey && !this.entries.get(candidate.key)?.ready) {
          spec = candidate;
          break;
        }
      }
    }
    if (!spec) return;
    const job: RenderJob = {
      page: spec.page, layout: spec.layout, layoutKey: spec.layoutKey, key: spec.key, cancelled: false,
    };
    this.running = job;
    void this.render(job);
  }

  private async render(job: RenderJob): Promise<void> {
    let page: PDFPageProxy | undefined;
    try {
      page = await this.pdf.getPage(job.page);
      if (job.cancelled || this.disposed) return;
      const natural = page.getViewport({ scale: 1 });
      const { layout } = job;
      const fitScale = layout.fit === "width" ? layout.width / natural.width
        : Math.min(layout.width / natural.width, layout.height / natural.height);
      const cssScale = fitScale * layout.zoom;
      const cssViewport = page.getViewport({ scale: cssScale });
      if (!Number.isFinite(cssViewport.width) || cssViewport.width <= 0
        || !Number.isFinite(cssViewport.height) || cssViewport.height <= 0) {
        throw new Error("Invalid PDF page dimensions");
      }
      const pixelRatio = Math.min(layout.pixelRatio,
        Math.sqrt(MAX_CANVAS_PIXELS / (cssViewport.width * cssViewport.height)),
        MAX_CANVAS_DIMENSION / cssViewport.width, MAX_CANVAS_DIMENSION / cssViewport.height);
      const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });
      const width = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.floor(renderViewport.width)));
      const height = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.floor(renderViewport.height)));
      // A newly created HTML canvas briefly has the browser's 300 × 150 bitmap.
      if (!this.makeRoom(Math.max(width * height, 300 * 150), job)) {
        if (this.foreground?.key === job.key) throw new Error("Canvas budget exceeded");
        return;
      }

      const canvas = document.createElement("canvas");
      // Clear the browser's default dimensions before allocating the bounded bitmap.
      canvas.width = 0;
      canvas.height = 0;
      const entry: CacheEntry = { ...job, canvas, pixels: width * height, ready: false };
      job.entry = entry;
      this.entries.set(job.key, entry);
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas unavailable");
      job.task = page.render({ canvas, canvasContext: context, viewport: renderViewport, background: "#ffffff" });
      await job.task.promise;
      if (job.cancelled || this.disposed) return;

      // Mark only complete bitmaps as pages; cached canvases never render a second time.
      canvas.dataset.testid = "pdf-page";
      canvas.dataset.page = String(job.page);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Page ${job.page}`);
      entry.ready = true;
      if (this.foreground?.key === job.key) {
        this.foreground.settled = true;
        this.foreground.resolve(canvas);
      }
    } catch (error) {
      if (!job.cancelled && !this.disposed && this.foreground?.key === job.key) {
        this.foreground.reject(error);
        this.foreground = null;
      }
      // Background failures leave no failed cache entry, so a later request can retry.
    } finally {
      try { page?.cleanup(); } catch { /* PDF document may already have been destroyed. */ }
      if (job.entry && (job.cancelled || this.disposed || !job.entry.ready)) this.release(job.entry);
      if (this.running === job) this.running = null;
      this.prune();
      this.schedule();
    }
  }
}
