import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import type { PageDocument } from "../lib/reader/page-document";
import { PdfPageCache, type PageLayout } from "../lib/reader/page-cache";

const layout: PageLayout = { width: 800, height: 900, fit: "page", zoom: 1, pixelRatio: 1 };
const abortError = (error: unknown) => error instanceof Error && error.name === "AbortError";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await nextTurn();
  }
}

type Render = {
  page: number;
  canvas: FakeCanvas;
  cancelled: boolean;
  settled: boolean;
  holdCancellation: boolean;
  complete(): void;
  fail(error: Error): void;
};

class FakeCanvas {
  private canvasWidth = 300;
  private canvasHeight = 150;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  releases = 0;
  context: { canvas: FakeCanvas };

  constructor(private changed: () => void) { this.context = { canvas: this }; }
  get width() { return this.canvasWidth; }
  set width(value: number) {
    const before = this.pixels;
    this.canvasWidth = value;
    if (before > 0 && this.pixels === 0) this.releases++;
    this.changed();
  }
  get height() { return this.canvasHeight; }
  set height(value: number) {
    const before = this.pixels;
    this.canvasHeight = value;
    if (before > 0 && this.pixels === 0) this.releases++;
    this.changed();
  }
  get pixels() { return this.width * this.height; }
  getContext() { return this.context; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}

function fixture(t: TestContext, options: {
  pages?: number;
  pageWidth?: number;
  pageHeight?: number;
  pageSize?: (page: number) => [number, number];
} = {}) {
  const canvases: FakeCanvas[] = [];
  const renders: Render[] = [];
  const pageRequests: number[] = [];
  const pageSignals: AbortSignal[] = [];
  const pageGates = new Map<number, ReturnType<typeof deferred<void>>>();
  let peakPixels = 0;
  let peakCanvases = 0;
  let peakCanvasPixels = 0;
  let peakDimension = 0;
  const measure = () => {
    peakPixels = Math.max(peakPixels, canvases.reduce((sum, canvas) => sum + canvas.pixels, 0));
    peakCanvases = Math.max(peakCanvases, canvases.filter((canvas) => canvas.pixels > 0).length);
    for (const canvas of canvases) {
      peakCanvasPixels = Math.max(peakCanvasPixels, canvas.pixels);
      peakDimension = Math.max(peakDimension, canvas.width, canvas.height);
    }
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag: string) {
        assert.equal(tag, "canvas");
        const canvas = new FakeCanvas(measure);
        canvases.push(canvas);
        measure();
        return canvas;
      },
    },
  });
  const pages = options.pages ?? 12;
  const pdf = {
    numPages: pages,
    async getPage(page: number, signal: AbortSignal) {
      assert.ok(page >= 1 && page <= pages, `requested out-of-bounds PDF page ${page}`);
      pageRequests.push(page);
      pageSignals.push(signal);
      await pageGates.get(page)?.promise;
      return {
        getViewport({ scale }: { scale: number }) {
          const [width, height] = options.pageSize?.(page) ?? [options.pageWidth ?? 400, options.pageHeight ?? 600];
          return { width: width * scale, height: height * scale };
        },
        render(args: { canvas?: FakeCanvas; canvasContext?: { canvas: FakeCanvas } }) {
          const work = deferred<void>();
          const canvas = args.canvas ?? args.canvasContext?.canvas;
          assert.ok(canvas, "PDF.js render must receive the canvas or its context");
          const render: Render = {
            page, canvas, cancelled: false, settled: false, holdCancellation: false,
            complete() { render.settled = true; work.resolve(); },
            fail(error) { render.settled = true; work.reject(error); },
          };
          renders.push(render);
          return {
            promise: work.promise,
            cancel() {
              render.cancelled = true;
              if (!render.holdCancellation && !render.settled) {
                const error = new Error("Rendering cancelled");
                error.name = "RenderingCancelledException";
                render.fail(error);
              }
            },
          };
        },
        cleanup() {},
      };
    },
  } as unknown as PageDocument;
  const cache = new PdfPageCache(pdf);
  t.after(async () => {
    cache.dispose();
    for (const render of renders) if (!render.settled) render.complete();
    await nextTurn();
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });

  async function renderFor(page: number, occurrence = 1) {
    await until(() => renders.filter((render) => render.page === page).length >= occurrence, `page ${page} render ${occurrence} never started`);
    return renders.filter((render) => render.page === page)[occurrence - 1];
  }
  async function show(page: number, nextLayout = layout) {
    const count = renders.filter((render) => render.page === page).length;
    const requested = cache.request(page, nextLayout);
    let ready = false;
    void requested.then(() => { ready = true; }, () => { ready = true; });
    await until(() => ready || renders.filter((render) => render.page === page).length > count, `page ${page} was neither cached nor rendered`);
    const work = renders.filter((render) => render.page === page).at(-1);
    if (!ready) work!.complete();
    const canvas = await requested;
    cache.commit(canvas);
    return canvas as unknown as FakeCanvas;
  }
  return {
    cache, canvases, renders, pageRequests, pageSignals, renderFor, show,
    blockPage(page: number) {
      const gate = deferred<void>();
      pageGates.set(page, gate);
      return () => gate.resolve();
    },
    get peakPixels() { return peakPixels; },
    get peakCanvases() { return peakCanvases; },
    get peakCanvasPixels() { return peakCanvasPixels; },
    get peakDimension() { return peakDimension; },
  };
}

describe("PDF page preparation and canvas lifecycle", { timeout: 20_000 }, () => {
  it("reuses the next two pages and previous page prepared while the current page remains visible", async (t) => {
    const f = fixture(t);
    const current = await f.show(3);
    f.cache.prefetch(3, layout);
    for (const page of [4, 5, 2]) {
      const render = await f.renderFor(page);
      assert.notEqual(render.canvas, current);
      assert.ok(current.pixels > 0, "preparing a page must not blank the displayed page");
      render.complete();
    }
    await nextTurn();
    const previous = f.renders.find((render) => render.page === 2)!.canvas;
    assert.equal(await f.cache.request(2, layout), previous);
    f.cache.commit(previous as unknown as HTMLCanvasElement);
    assert.equal(await f.cache.request(3, layout), current);
    f.cache.commit(current as unknown as HTMLCanvasElement);
    const prepared = f.renders.find((render) => render.page === 4)!.canvas;
    assert.equal(await f.cache.request(4, layout), prepared);
    f.cache.commit(prepared as unknown as HTMLCanvasElement);
    assert.deepEqual(f.renders.map((render) => render.page), [3, 4, 5, 2]);
  });

  it("promotes an in-flight prefetched page without cancelling or rendering it twice", async (t) => {
    const f = fixture(t);
    await f.show(1);
    f.cache.prefetch(1, layout);
    const pending = await f.renderFor(2);
    const requested = f.cache.request(2, layout);
    await nextTurn();
    assert.equal(pending.cancelled, false);
    assert.equal(f.pageSignals[1].aborted, false);
    assert.equal(f.renders.filter((render) => render.page === 2).length, 1);
    pending.complete();
    assert.equal(await requested, pending.canvas);
  });

  it("prioritizes a page jump and waits for cancelled PDF.js work before freeing its canvas", async (t) => {
    const f = fixture(t);
    const current = await f.show(1);
    f.cache.prefetch(1, layout);
    const background = await f.renderFor(2);
    background.holdCancellation = true;
    const requested = f.cache.request(7, layout);
    await until(() => background.cancelled, "page jump did not cancel unrelated background rendering");
    assert.ok(background.canvas.pixels > 0, "PDF.js still owns the cancelled canvas until its promise settles");
    assert.ok(current.pixels > 0);
    assert.equal(f.renders.some((render) => render.page === 7), false);
    background.complete();
    const foreground = await f.renderFor(7);
    assert.equal(background.canvas.pixels, 0);
    foreground.complete();
    assert.equal(await requested, foreground.canvas);
    assert.equal(f.renders.some((render) => render.page === 3), false, "obsolete prefetch must not run ahead of the requested page");
  });

  it("invalidates layout-dependent pages but keeps the visible canvas until replacement is committed", async (t) => {
    const f = fixture(t);
    let displayed = await f.show(3);
    const layouts: PageLayout[] = [
      { ...layout, zoom: 1.5 },
      { ...layout, zoom: 1.5, fit: "width" },
      { ...layout, zoom: 1.5, fit: "width", width: 500 },
      { ...layout, zoom: 1.5, fit: "width", width: 500, pixelRatio: 2 },
    ];
    for (const [index, nextLayout] of layouts.entries()) {
      const requested = f.cache.request(3, nextLayout);
      const render = await f.renderFor(3, index + 2);
      assert.ok(displayed.pixels > 0);
      assert.notEqual(render.canvas, displayed);
      render.complete();
      const replacement = await requested;
      assert.ok(displayed.pixels > 0, "render completion alone must not clear the canvas still in the DOM");
      f.cache.commit(replacement);
      assert.equal(displayed.pixels, 0, "obsolete visible canvas should be released after replacement");
      displayed = replacement as unknown as FakeCanvas;
    }
  });

  it("discards superseded results and safely releases a still-rendering canvas on disposal", async (t) => {
    const f = fixture(t);
    await f.show(1);
    const superseded = f.cache.request(5, layout);
    const rejected = assert.rejects(superseded, abortError);
    const stale = await f.renderFor(5);
    stale.holdCancellation = true;
    const latest = f.cache.request(8, layout);
    await until(() => stale.cancelled, "superseded foreground render was not cancelled");
    stale.complete();
    const wanted = await f.renderFor(8);
    wanted.complete();
    const canvas = await latest;
    await rejected;
    f.cache.commit(canvas);
    assert.equal(stale.canvas.pixels, 0);
    assert.ok((canvas as unknown as FakeCanvas).pixels > 0);

    const duringDispose = f.cache.request(9, layout);
    const disposed = assert.rejects(duringDispose, abortError);
    const active = await f.renderFor(9);
    active.holdCancellation = true;
    f.cache.dispose();
    assert.equal(active.cancelled, true);
    assert.ok(active.canvas.pixels > 0, "dispose must let PDF.js finish cancellation before resizing its canvas");
    active.complete();
    await disposed;
    await nextTurn();
    assert.ok(f.canvases.every((item) => item.pixels === 0));
    assert.ok(f.canvases.every((item) => item.releases <= 2), "only the browser's initial allocation and page allocation should be released");
    const releaseCounts = f.canvases.map((item) => item.releases);
    f.cache.dispose();
    assert.deepEqual(f.canvases.map((item) => item.releases), releaseCounts);
    await assert.rejects(f.cache.request(1, layout), abortError);
  });

  it("retries a failed background page when it is requested in the foreground", async (t) => {
    const f = fixture(t);
    await f.show(1);
    f.cache.prefetch(1, layout);
    const failed = await f.renderFor(2);
    failed.fail(new Error("Temporary PDF image decode failure"));
    await nextTurn();
    const requested = f.cache.request(2, layout);
    const retry = await f.renderFor(2, 2);
    retry.complete();
    assert.equal(await requested, retry.canvas);
    assert.notEqual(retry.canvas, failed.canvas);
    assert.equal(failed.canvas.pixels, 0);
  });

  it("does not allocate or render pages whose PDF lookup finishes after supersession or disposal", async (t) => {
    const f = fixture(t);
    const releaseLookup = f.blockPage(1);
    const oldRequest = f.cache.request(1, layout);
    const superseded = assert.rejects(oldRequest, abortError);
    await until(() => f.pageRequests.includes(1), "initial PDF lookup did not begin");
    const newRequest = f.cache.request(5, layout);
    assert.equal(f.pageSignals[0].aborted, true, "supersession must also cancel a pending image fetch");
    releaseLookup();
    const latest = await f.renderFor(5);
    latest.complete();
    f.cache.commit(await newRequest);
    await superseded;
    assert.equal(f.renders.some((render) => render.page === 1), false);

    const releaseAfterDispose = f.blockPage(9);
    const pending = f.cache.request(9, layout);
    const disposed = assert.rejects(pending, abortError);
    await until(() => f.pageRequests.includes(9), "pending PDF lookup did not begin");
    const allocationCount = f.canvases.length;
    f.cache.dispose();
    assert.equal(f.pageSignals.at(-1)!.aborted, true, "disposal must cancel a pending image fetch");
    releaseAfterDispose();
    await disposed;
    await nextTurn();
    assert.equal(f.canvases.length, allocationCount);
    assert.equal(f.renders.some((render) => render.page === 9), false);
    assert.ok(f.canvases.every((canvas) => canvas.pixels === 0));
  });

  it("limits canvas count and pixel allocation even during large-page navigation and layout changes", async (t) => {
    const f = fixture(t);
    const large: PageLayout = { width: 10_000, height: 10_000, fit: "width", zoom: 2, pixelRatio: 4 };
    for (let page = 1; page <= 8; page++) {
      await f.show(page, { ...large, zoom: page % 2 ? 2 : 1.75 });
      f.cache.prefetch(page, { ...large, zoom: page % 2 ? 2 : 1.75 });
      await nextTurn();
      const background = f.renders.findLast((render) => !render.settled);
      if (background) background.complete();
      await nextTurn();
    }
    assert.ok(f.peakCanvases <= 4, `allocated ${f.peakCanvases} canvases at once`);
    assert.ok(f.peakPixels <= 16_000_000, `allocated ${f.peakPixels} pixels at once`);
    assert.ok(f.peakCanvasPixels <= 8_000_000, `one canvas held ${f.peakCanvasPixels} pixels`);
    assert.ok(f.peakDimension <= 8192, `canvas dimension reached ${f.peakDimension}`);
    f.cache.dispose();
    await nextTurn();
    assert.ok(f.canvases.every((canvas) => canvas.pixels === 0));
  });

  it("keeps extreme page dimensions bounded and never prefetches outside the PDF", async (t) => {
    const f = fixture(t, { pages: 2, pageWidth: 20_000, pageHeight: 1 });
    const wide: PageLayout = { width: 100_000, height: 500, fit: "width", zoom: 2, pixelRatio: 4 };
    await f.show(2, wide);
    f.cache.prefetch(2, wide);
    const previous = await f.renderFor(1);
    previous.complete();
    await nextTurn();
    assert.deepEqual(f.pageRequests, [2, 1]);
    assert.ok(f.peakDimension <= 8192);
    assert.ok(previous.canvas.width > 0 && previous.canvas.height > 0, "thin pages must retain at least one physical pixel per dimension");
  });

  it("reserves the browser's default canvas allocation when a tiny page follows two large bitmaps", async (t) => {
    const f = fixture(t, { pages: 3, pageSize: (page) => [8387, page === 3 ? 0.1 : 1000] });
    const large: PageLayout = { width: 20_000, height: 20_000, fit: "width", zoom: 1, pixelRatio: 2 };
    await f.show(1, large);
    f.cache.prefetch(1, large);
    (await f.renderFor(2)).complete();
    await until(() => f.pageRequests.includes(3), "small neighboring page was never considered");
    await nextTurn();
    assert.ok(f.peakPixels <= 16_000_000, `browser canvas defaults caused a transient ${f.peakPixels}-pixel allocation`);
    const pending = f.renders.find((render) => render.page === 3 && !render.settled);
    pending?.complete();
    await nextTurn();
    await f.show(3, large);
    assert.ok(f.peakPixels <= 16_000_000);
  });
});
