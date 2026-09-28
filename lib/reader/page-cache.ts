import type { DocumentPage, PageDocument, PageRenderTask } from "./page-document";

export interface PageLayout {
  width: number;
  height: number;
  fit: "page" | "width";
  zoom: number;
  pixelRatio: number;
}

export interface PageSpread {
  pages: number[];
  canvases: HTMLCanvasElement[];
}

// Keep several ordinary-size spreads ready without increasing the bitmap memory cap.
const MAX_CANVASES = 10;
const MAX_TOTAL_PIXELS = 16_000_000;
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_DIMENSION = 8_192;

interface PageSpec {
  page: number;
  layout: PageLayout;
  layoutKey: string;
  key: string;
  spread: boolean;
  spreadOffset: 0 | 1;
}

interface CacheEntry {
  page: number;
  layoutKey: string;
  key: string;
  canvas: HTMLCanvasElement;
  pixels: number;
  ready: boolean;
}

interface Foreground extends PageSpec {
  promise: Promise<PageSpread>;
  resolve: (spread: PageSpread) => void;
  reject: (reason: unknown) => void;
  result?: PageSpread;
  settled: boolean;
}

interface RenderJob extends PageSpec {
  cancelled: boolean;
  controller: AbortController;
  task?: PageRenderTask;
  entry?: CacheEntry;
  created: CacheEntry[];
}

interface PageSize {
  width: number;
  height: number;
}

function aborted(): Error {
  const error = new Error("Page request cancelled");
  error.name = "AbortError";
  return error;
}

function specification(page: number, layout: PageLayout, spread = false, spreadOffset: 0 | 1 = 1): PageSpec {
  if (!Number.isFinite(layout.width) || layout.width <= 0
    || !Number.isFinite(layout.height) || layout.height <= 0
    || !Number.isFinite(layout.zoom) || layout.zoom <= 0
    || (layout.fit !== "page" && layout.fit !== "width")
    || (spreadOffset !== 0 && spreadOffset !== 1)) {
    throw new RangeError("Invalid page layout");
  }
  const normalized = {
    ...layout,
    pixelRatio: Number.isFinite(layout.pixelRatio) && layout.pixelRatio > 0
      ? Math.min(layout.pixelRatio, 2) : 1,
  };
  const layoutKey = JSON.stringify([
    normalized.width, normalized.height, normalized.fit, normalized.zoom, normalized.pixelRatio, spread,
    spread ? spreadOffset : null,
  ]);
  return { page, layout: normalized, layoutKey, key: `${page}:${layoutKey}`, spread, spreadOffset };
}

/** Owns every page canvas, including the visible canvases until their replacements are committed. */
export class PdfPageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly sizes = new Map<number, PageSize>();
  private visible: CacheEntry[] = [];
  private foreground: Foreground | null = null;
  private running: RenderJob | null = null;
  private queue: PageSpec[] = [];
  private preferredKeys: string[] = [];
  private layoutKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly pdf: PageDocument) {}

  request(page: number, layout: PageLayout): Promise<HTMLCanvasElement> {
    return this.requestGroup(page, layout, false).then(result => result.canvases[0]);
  }

  /** Offset 1 leaves the cover alone; offset 0 pairs pages 1–2, 3–4, and so on. */
  requestSpread(page: number, layout: PageLayout, spreadOffset: 0 | 1 = 1): Promise<PageSpread> {
    return this.requestGroup(page, layout, true, spreadOffset);
  }

  /** Call immediately after replacing the displayed DOM canvas, without an intervening await. */
  commit(canvas: HTMLCanvasElement): void {
    this.commitSpread([canvas]);
  }

  /** Commit the complete replacement together, after all canvases have entered the DOM. */
  commitSpread(canvases: HTMLCanvasElement[]): void {
    if (this.disposed || !canvases.length || new Set(canvases).size !== canvases.length) return;
    const entries = canvases.map(canvas => [...this.entries.values()].find(item => item.canvas === canvas));
    if (entries.some(entry => !entry?.ready)) return;
    if (this.foreground && (!this.foreground.result
      || this.foreground.result.canvases.length !== canvases.length
      || this.foreground.result.canvases.some(canvas => !canvases.includes(canvas)))) return;
    this.visible = entries as CacheEntry[];
    this.foreground = null;
    this.prune();
  }

  /** Warm the next four pages and the previous page, as the shared pixel budget allows. */
  prefetch(page: number, layout: PageLayout): void {
    this.prefetchGroup(page, layout, false);
  }

  /** Warm three upcoming spreads and the previous spread within the shared pixel budget. */
  prefetchSpread(page: number, layout: PageLayout, spreadOffset: 0 | 1 = 1): void {
    this.prefetchGroup(page, layout, true, spreadOffset);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.queue = [];
    if (this.foreground && !this.foreground.settled) this.foreground.reject(aborted());
    this.foreground = null;
    this.visible = [];
    this.sizes.clear();
    this.cancelRunning();
    for (const entry of this.entries.values()) {
      // A cancelled render can still touch its canvas until its promise settles.
      if (entry !== this.running?.entry) this.release(entry);
    }
  }

  private requestGroup(page: number, layout: PageLayout, spread: boolean, spreadOffset: 0 | 1 = 1): Promise<PageSpread> {
    if (this.disposed) return Promise.reject(aborted());
    if (!Number.isInteger(page) || page < 1 || page > this.pdf.numPages) {
      return Promise.reject(new RangeError("Invalid page number"));
    }
    let spec: PageSpec;
    try {
      spec = specification(page, layout, spread, spreadOffset);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.foreground?.key === spec.key) return this.foreground.promise;

    if (this.foreground && !this.foreground.settled) this.foreground.reject(aborted());
    this.clearTimer();
    this.queue = [];
    this.layoutKey = spec.layoutKey;
    this.preferredKeys = [...new Set(this.neighbors(spec).flatMap(item => this.keys(item)))];

    let resolve!: Foreground["resolve"];
    let reject!: Foreground["reject"];
    const promise = new Promise<PageSpread>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    this.foreground = { ...spec, promise, resolve, reject, settled: false };

    const pages = this.candidatePages(spec);
    const cached = this.keys(spec).map(key => this.entries.get(key));
    if (cached.every(entry => entry?.ready)) {
      // Ready pages can be displayed immediately while a useful later page is still loading.
      this.foreground.result = { pages, canvases: cached.map(entry => entry!.canvas) };
      this.foreground.settled = true;
      resolve(this.foreground.result);
      if (this.running && !this.keys(this.running).some(key => this.preferredKeys.includes(key))) this.cancelRunning();
      this.prune();
      return promise;
    }

    // A prefetched group already being rendered is promoted without cancelling its work.
    if (this.running && (!this.sameGroup(this.running, spec) || this.running.cancelled)) this.cancelRunning();
    this.prune();
    this.pump();
    return promise;
  }

  private prefetchGroup(page: number, layout: PageLayout, spread: boolean, spreadOffset: 0 | 1 = 1): void {
    if (this.disposed || this.foreground) return;
    let spec: PageSpec;
    try {
      spec = specification(page, layout, spread, spreadOffset);
    } catch {
      return;
    }
    if (!this.visible.some(entry => entry.key === spec.key) || this.layoutKey !== spec.layoutKey) return;
    const neighbors = this.neighbors(spec, this.visible.map(entry => entry.page));
    this.preferredKeys = [...new Set(neighbors.flatMap(item => this.keys(item)))];
    this.prune();
    this.queue = neighbors.slice(1).filter(item => !this.keys(item).every(key => this.entries.get(key)?.ready)
      && (this.running?.key !== item.key || this.running.cancelled));
    this.schedule();
  }

  private candidatePages(spec: PageSpec): number[] {
    if (!spec.spread || (spec.page === 1 && spec.spreadOffset === 1)) return [spec.page];
    const first = spec.page - ((spec.page - 1 - spec.spreadOffset) % 2);
    const pair = [first, first + 1].filter(page => page <= this.pdf.numPages);
    return pair.some(page => {
      const size = this.sizes.get(page);
      return size && size.width > size.height;
    }) ? [spec.page] : pair;
  }

  private keys(spec: PageSpec): string[] {
    return this.candidatePages(spec).map(page => `${page}:${spec.layoutKey}`);
  }

  private sameGroup(first: PageSpec, second: PageSpec): boolean {
    const keys = this.keys(first);
    const other = this.keys(second);
    return keys.length === other.length && keys.every((key, index) => key === other[index]);
  }

  private isForeground(job: RenderJob): boolean {
    return !!this.foreground && this.sameGroup(job, this.foreground);
  }

  private neighbors(spec: PageSpec, pages = this.candidatePages(spec)): PageSpec[] {
    // Include each page number so a landscape scan that splits a pair cannot skip its partner.
    const numbers = spec.spread
      ? [spec.page, ...Array.from({ length: 6 }, (_, index) => Math.max(...pages) + index + 1),
        Math.min(...pages) - 1, Math.min(...pages) - 2]
      : [spec.page, spec.page + 1, spec.page + 2, spec.page + 3, spec.page + 4, spec.page - 1];
    return numbers.filter(page => page >= 1 && page <= this.pdf.numPages)
      .map(page => ({ ...spec, page, key: `${page}:${spec.layoutKey}` }));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private cancelRunning(): void {
    if (!this.running || this.running.cancelled) return;
    this.running.cancelled = true;
    this.running.controller.abort();
    try { this.running.task?.cancel(); } catch { /* Already settled or document destroyed. */ }
  }

  private protected(entry: CacheEntry): boolean {
    return this.visible.includes(entry)
      || !!(this.running && this.keys(this.running).includes(entry.key))
      || !!(this.foreground && this.keys(this.foreground).includes(entry.key));
  }

  private prune(): void {
    for (const entry of this.entries.values()) {
      if (this.protected(entry)) continue;
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

  private makeRoom(pixels: number, job: RenderJob, key: string): boolean {
    const entries = [...this.entries.values()];
    let count = entries.length;
    let allocated = entries.reduce((total, entry) => total + entry.pixels, 0);
    const isForeground = this.isForeground(job);
    const candidates = entries.filter(entry => !this.protected(entry)
      && (isForeground || this.priority(entry.key) > this.priority(key)))
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
        if (candidate.layoutKey === this.layoutKey && !this.keys(candidate).every(key => this.entries.get(key)?.ready)) {
          spec = candidate;
          break;
        }
      }
    }
    if (!spec) return;
    const job: RenderJob = { ...spec, cancelled: false, controller: new AbortController(), created: [] };
    this.running = job;
    void this.render(job);
  }

  private async render(job: RenderJob): Promise<void> {
    const documents = new Map<number, DocumentPage>();
    const active = () => !job.cancelled && !this.disposed;
    const getPage = async (number: number) => {
      const loaded = documents.get(number);
      if (loaded) return loaded;
      const page = await this.pdf.getPage(number, job.controller.signal);
      documents.set(number, page);
      if (!active()) throw aborted();
      const natural = page.getViewport({ scale: 1 });
      if (!Number.isFinite(natural.width) || natural.width <= 0
        || !Number.isFinite(natural.height) || natural.height <= 0) {
        throw new Error("Invalid page dimensions");
      }
      this.sizes.set(number, { width: natural.width, height: natural.height });
      return page;
    };
    try {
      let pages = this.candidatePages(job);
      if (job.spread) {
        // Inspect both members before painting so an existing double-page scan stays alone.
        for (const number of pages) {
          if (!this.sizes.has(number)) await getPage(number);
          if (this.sizes.get(number)!.width > this.sizes.get(number)!.height) break;
        }
        pages = this.candidatePages(job);
        for (const number of pages) if (!this.sizes.has(number)) await getPage(number);
      }
      if (!active()) return;
      const aspectSum = job.spread
        ? pages.reduce((sum, number) => {
          const size = this.sizes.get(number)!;
          return sum + size.width / size.height;
        }, 0) : 0;
      const spreadHeight = (job.layout.fit === "width" ? job.layout.width / aspectSum
        : Math.min(job.layout.height, job.layout.width / aspectSum)) * job.layout.zoom;
      const canvases: HTMLCanvasElement[] = [];
      for (const number of pages) {
        const key = `${number}:${job.layoutKey}`;
        const cached = this.entries.get(key);
        if (cached?.ready) { canvases.push(cached.canvas); continue; }
        const page = await getPage(number);
        if (!active()) return;
        const natural = this.sizes.get(number)!;
        const { layout } = job;
        const fitScale = layout.fit === "width" ? layout.width / natural.width
          : Math.min(layout.width / natural.width, layout.height / natural.height);
        const cssScale = job.spread ? spreadHeight / natural.height : fitScale * layout.zoom;
        const cssViewport = page.getViewport({ scale: cssScale });
        if (!Number.isFinite(cssViewport.width) || cssViewport.width <= 0
          || !Number.isFinite(cssViewport.height) || cssViewport.height <= 0) {
          throw new Error("Invalid page dimensions");
        }
        // Two old and two replacement pages must coexist until the whole spread commits.
        const pixelLimit = job.spread ? MAX_CANVAS_PIXELS / 2 : MAX_CANVAS_PIXELS;
        const pixelRatio = Math.min(layout.pixelRatio,
          Math.sqrt(pixelLimit / (cssViewport.width * cssViewport.height)),
          MAX_CANVAS_DIMENSION / cssViewport.width, MAX_CANVAS_DIMENSION / cssViewport.height);
        const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });
        const width = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.floor(renderViewport.width)));
        const height = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.floor(renderViewport.height)));
        // A newly created HTML canvas briefly has the browser's 300 × 150 bitmap.
        if (!this.makeRoom(Math.max(width * height, 300 * 150), job, key)) {
          if (this.isForeground(job)) throw new Error("Canvas budget exceeded");
          // Later neighbors have lower priority; avoid decoding more images when the budget is full.
          this.queue = [];
          return;
        }

        const canvas = document.createElement("canvas");
        // Clear the browser's default dimensions before allocating the bounded bitmap.
        canvas.width = 0;
        canvas.height = 0;
        const entry: CacheEntry = { page: number, layoutKey: job.layoutKey, key, canvas, pixels: width * height, ready: false };
        job.entry = entry;
        job.created.push(entry);
        this.entries.set(key, entry);
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas unavailable");
        job.task = page.render({ canvas, canvasContext: context, viewport: renderViewport, background: "#ffffff" });
        await job.task.promise;
        if (!active()) return;

        // Mark only complete bitmaps as pages; cached canvases never render a second time.
        canvas.dataset.testid = "pdf-page";
        canvas.dataset.page = String(number);
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Page ${number}`);
        entry.ready = true;
        canvases.push(canvas);
        // Release decoded image resources as soon as their bounded bitmap is ready.
        try { page.cleanup(); } catch { /* The document may already have been destroyed. */ }
        documents.delete(number);
      }
      if (this.foreground && this.isForeground(job)) {
        this.foreground.settled = true;
        this.foreground.result = { pages, canvases };
        this.foreground.resolve(this.foreground.result);
      }
    } catch (error) {
      if (active() && this.foreground && this.isForeground(job)) {
        this.foreground.reject(error);
        this.foreground = null;
      }
      // Background failures leave no failed cache entry, so a later request can retry.
    } finally {
      for (const page of documents.values()) {
        try { page.cleanup(); } catch { /* The document may already have been destroyed. */ }
      }
      for (const entry of job.created) {
        // Completed neighbors remain useful even if a later member was interrupted.
        if (!entry.ready || this.disposed) this.release(entry);
      }
      if (this.running === job) this.running = null;
      this.prune();
      this.schedule();
    }
  }
}
