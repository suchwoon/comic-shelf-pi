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
  async function showSpread(page: number, nextLayout = layout, spreadOffset: 0 | 1 = 1) {
    const requested = cache.requestSpread(page, nextLayout, spreadOffset);
    let ready = false;
    void requested.then(() => { ready = true; }, () => { ready = true; });
    await until(() => {
      for (const render of renders) if (!render.settled) render.complete();
      return ready;
    }, `spread containing page ${page} was never ready`);
    const result = await requested;
    cache.commitSpread(result.canvases);
    return { pages: result.pages, canvases: result.canvases as unknown as FakeCanvas[] };
  }
  return {
    cache, canvases, renders, pageRequests, pageSignals, renderFor, show, showSpread,
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
  it("reuses the next four pages and previous page prepared while the current page remains visible", async (t) => {
    const f = fixture(t);
    const current = await f.show(3);
    f.cache.prefetch(3, layout);
    for (const page of [4, 5, 6, 7, 2]) {
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
    assert.deepEqual(f.renders.map((render) => render.page), [3, 4, 5, 6, 7, 2]);
  });

  it("displays a ready page immediately without cancelling or waiting for a later prefetch", async (t) => {
    const f = fixture(t);
    await f.show(1);
    f.cache.prefetch(1, layout);
    const next = await f.renderFor(2);
    next.complete();
    const later = await f.renderFor(3);
    later.holdCancellation = true;
    const requested = f.cache.request(2, layout);
    let ready = false;
    void requested.then(() => { ready = true; });
    await until(() => ready, "a ready page was blocked by unrelated background work");
    assert.equal(later.cancelled, false);
    assert.equal(await requested, next.canvas);
    f.cache.commit(await requested);
    later.complete();
    await nextTurn();
    assert.equal(await f.cache.request(3, layout), later.canvas);
    assert.equal(f.renders.filter(render => render.page === 3).length, 1);
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
    assert.ok(f.peakCanvases <= 10, `allocated ${f.peakCanvases} canvases at once`);
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

describe("two-page spread preparation and canvas lifecycle", { timeout: 20_000 }, () => {
  it("keeps the cover alone, uses fixed ascending pairs, and leaves the final unpaired page alone", async (t) => {
    const f = fixture(t, { pages: 8 });
    assert.deepEqual((await f.showSpread(1)).pages, [1]);
    assert.deepEqual(f.pageRequests, [1], "the cover must not load an unrelated partner");
    const pair = await f.showSpread(3);
    assert.deepEqual(pair.pages, [2, 3]);
    assert.deepEqual(pair.canvases.map(canvas => canvas.dataset.page), ["2", "3"]);
    assert.deepEqual((await f.showSpread(2)).canvases, pair.canvases, "either member should reuse the same prepared spread");
    assert.deepEqual((await f.showSpread(5)).pages, [4, 5]);
    assert.deepEqual((await f.showSpread(6)).pages, [6, 7]);
    assert.deepEqual((await f.showSpread(8)).pages, [8]);
    assert.deepEqual(f.renders.map(render => render.page), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("can pair from the first page and rebuilds complete spreads when the pairing changes", async (t) => {
    const f = fixture(t, { pages: 7 });
    const first = await f.showSpread(1, layout, 0);
    assert.deepEqual(first.pages, [1, 2]);
    assert.deepEqual((await f.showSpread(2, layout, 0)).canvases, first.canvases);
    assert.deepEqual((await f.showSpread(4, layout, 0)).pages, [3, 4]);
    assert.deepEqual((await f.showSpread(6, layout, 0)).pages, [5, 6]);
    assert.deepEqual((await f.showSpread(7, layout, 0)).pages, [7]);

    const replacement = await f.showSpread(7, layout, 1);
    assert.deepEqual(replacement.pages, [6, 7]);
    assert.equal(replacement.canvases[0].style.height, replacement.canvases[1].style.height);
    assert.deepEqual(f.renders.map(render => render.page), [1, 2, 3, 4, 5, 6, 7, 6, 7]);
  });

  it("warms three upcoming spreads and reuses them while a later spread is in flight", async (t) => {
    const f = fixture(t);
    await f.showSpread(2);
    f.cache.prefetchSpread(2, layout);
    for (const page of [4, 5, 6, 7]) (await f.renderFor(page)).complete();
    const later = await f.renderFor(8);
    later.holdCancellation = true;
    const next = await f.cache.requestSpread(5, layout);
    assert.deepEqual(next.pages, [4, 5]);
    assert.equal(later.cancelled, false);
    f.cache.commitSpread(next.canvases);
    later.complete();
    (await f.renderFor(9)).complete();
    await nextTurn();
    assert.deepEqual((await f.showSpread(7)).pages, [6, 7]);
    assert.deepEqual((await f.showSpread(9)).pages, [8, 9]);
    assert.deepEqual(f.renders.map(render => render.page), [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(f.peakPixels <= 16_000_000);
    assert.ok(f.peakCanvases <= 10);
  });

  it("promotes a spread requested through its second member without cancelling its first member", async (t) => {
    const f = fixture(t);
    await f.showSpread(1, layout, 0);
    f.cache.prefetchSpread(1, layout, 0);
    const first = await f.renderFor(3);
    const requested = f.cache.requestSpread(4, layout, 0);
    await nextTurn();
    assert.equal(first.cancelled, false);
    first.complete();
    (await f.renderFor(4)).complete();
    const spread = await requested;
    assert.deepEqual(spread.pages, [3, 4]);
    assert.equal(spread.canvases[0], first.canvas);
    assert.equal(f.renders.filter(render => render.page === 3).length, 1);
  });

  it("fits the complete spread at a common height while preserving different aspect ratios", async (t) => {
    const f = fixture(t, { pageSize: page => page === 2 ? [400, 800] : [600, 600] });
    const spread = await f.showSpread(2);
    const [first, second] = spread.canvases;
    assert.equal(first.style.height, second.style.height);
    assert.ok(Math.abs(parseFloat(first.style.width) + parseFloat(second.style.width) - layout.width) < 0.001);
    assert.equal(parseFloat(first.style.width) / parseFloat(first.style.height), 0.5);
    assert.equal(parseFloat(second.style.width) / parseFloat(second.style.height), 1);
    assert.ok(parseFloat(first.style.height) <= layout.height);

    const widthFit = await f.showSpread(2, { ...layout, fit: "width", height: 100, zoom: 1.5 });
    assert.equal(widthFit.canvases[0].style.height, widthFit.canvases[1].style.height);
    assert.ok(Math.abs(widthFit.canvases.reduce((sum, canvas) => sum + parseFloat(canvas.style.width), 0) - 1200) < 0.001);
    assert.ok(parseFloat(widthFit.canvases[0].style.height) > 100, "width fit and zoom should retain vertical overflow");
  });

  it("shows the requested page alone when either member of its fixed pair is landscape", async (t) => {
    const f = fixture(t, { pageSize: page => page === 3 || page === 4 ? [1200, 600] : [400, 600] });
    assert.deepEqual((await f.showSpread(2)).pages, [2]);
    const landscape = await f.showSpread(3);
    assert.deepEqual(landscape.pages, [3]);
    assert.equal(landscape.canvases[0].style.width, "800px");
    assert.equal(landscape.canvases[0].style.height, "400px");
    assert.deepEqual((await f.showSpread(5)).pages, [5], "the portrait page after a wide first member stays alone too");
    assert.deepEqual((await f.showSpread(4)).pages, [4]);
    assert.deepEqual((await f.showSpread(6)).pages, [6, 7], "a wide page must not shift subsequent fixed pairs");
    assert.deepEqual(f.renders.map(render => render.page), [2, 3, 5, 4, 6, 7]);
  });

  it("prefetches every member when landscape scans split future pairs with either pairing offset", async (t) => {
    for (const spreadOffset of [0, 1] as const) {
      await t.test(`offset ${spreadOffset}`, async (t) => {
        const f = fixture(t, { pages: 6, pageSize: page => page === 3 || page === 4 ? [1200, 600] : [400, 600] });
        const first = await f.showSpread(1, layout, spreadOffset);
        f.cache.prefetchSpread(1, layout, spreadOffset);
        for (let page = Math.max(...first.pages) + 1; page <= 6; page++) (await f.renderFor(page)).complete();
        await nextTurn();
        const visited = [...first.pages];
        while (visited.at(-1)! < 6) {
          const spread = await f.showSpread(visited.at(-1)! + 1, layout, spreadOffset);
          visited.push(...spread.pages);
        }
        assert.deepEqual(visited, [1, 2, 3, 4, 5, 6]);
        assert.deepEqual(f.renders.map(render => render.page), [1, 2, 3, 4, 5, 6]);
      });
    }
  });

  it("keeps an unknown landscape partner queued when navigation replans an in-flight prefetch", async (t) => {
    const f = fixture(t, { pages: 5, pageSize: page => page === 4 ? [1200, 600] : [400, 600] });
    const releaseLookup = f.blockPage(4);
    await f.showSpread(1);
    f.cache.prefetchSpread(1, layout);
    (await f.renderFor(2)).complete();
    (await f.renderFor(3)).complete();
    await until(() => f.pageRequests.includes(4), "future landscape lookup did not begin");
    const cached = await f.cache.requestSpread(2, layout);
    f.cache.commitSpread(cached.canvases);
    f.cache.prefetchSpread(2, layout);
    releaseLookup();
    (await f.renderFor(4)).complete();
    (await f.renderFor(5)).complete();
    await nextTurn();
    assert.deepEqual((await f.showSpread(4)).pages, [4]);
    assert.deepEqual((await f.showSpread(5)).pages, [5]);
    assert.deepEqual(f.renders.map(render => render.page), [1, 2, 3, 4, 5]);
  });

  it("retains both visible canvases until the complete replacement is ready and committed together", async (t) => {
    const f = fixture(t);
    const old = await f.showSpread(2);
    const requested = f.cache.requestSpread(4, { ...layout, zoom: 1.2 });
    let ready = false;
    void requested.then(() => { ready = true; });
    const first = await f.renderFor(4);
    first.complete();
    const second = await f.renderFor(5);
    assert.equal(ready, false, "one rendered member is not a completed spread");
    assert.ok(old.canvases.every(canvas => canvas.pixels > 0));
    f.cache.commitSpread([first.canvas as unknown as HTMLCanvasElement]);
    assert.ok(old.canvases.every(canvas => canvas.pixels > 0), "a partial commit must be ignored");
    second.complete();
    const replacement = await requested;
    assert.ok(old.canvases.every(canvas => canvas.pixels > 0), "render completion must not clear either visible page");
    f.cache.commitSpread(replacement.canvases);
    assert.ok(old.canvases.every(canvas => canvas.pixels === 0), "obsolete layout canvases can be released after the atomic commit");
    assert.ok(replacement.canvases.every(canvas => canvas.width > 0));
  });

  it("promotes a prefetched spread, reuses both canvases, and stays within the document bounds", async (t) => {
    const f = fixture(t, { pages: 5 });
    await f.showSpread(1);
    f.cache.prefetchSpread(1, layout);
    const first = await f.renderFor(2);
    const requested = f.cache.requestSpread(2, layout);
    await nextTurn();
    assert.equal(first.cancelled, false);
    first.complete();
    const second = await f.renderFor(3);
    second.complete();
    const prepared = await requested;
    f.cache.commitSpread(prepared.canvases);
    assert.deepEqual(prepared.canvases, [first.canvas, second.canvas]);
    f.cache.prefetchSpread(2, layout);
    (await f.renderFor(4)).complete();
    (await f.renderFor(5)).complete();
    await nextTurn();
    assert.deepEqual((await f.showSpread(5)).pages, [4, 5]);
    assert.deepEqual(f.renders.map(render => render.page), [1, 2, 3, 4, 5]);
    f.cache.prefetchSpread(5, layout);
    await nextTurn();
    assert.ok(f.pageRequests.every(page => page >= 1 && page <= 5));
  });

  it("cancels a partially prepared spread without freeing the still-rendering canvas early", async (t) => {
    const f = fixture(t, { pages: 10 });
    const visible = await f.showSpread(2);
    const oldRequest = f.cache.requestSpread(4, layout);
    const rejected = assert.rejects(oldRequest, abortError);
    const first = await f.renderFor(4);
    first.complete();
    const second = await f.renderFor(5);
    second.holdCancellation = true;
    const latest = f.cache.requestSpread(10, layout);
    await until(() => second.cancelled, "the superseded spread did not cancel its active member");
    assert.ok(second.canvas.pixels > 0);
    assert.ok(visible.canvases.every(canvas => canvas.pixels > 0));
    assert.equal(f.renders.some(render => render.page === 10), false);
    second.complete();
    const wanted = await f.renderFor(10);
    assert.equal(first.canvas.pixels, 0);
    assert.equal(second.canvas.pixels, 0);
    wanted.complete();
    const replacement = await latest;
    await rejected;
    assert.deepEqual(replacement.pages, [10]);
    f.cache.commitSpread(replacement.canvases);
    assert.ok(visible.canvases.every(canvas => canvas.pixels === 0));
  });

  it("keeps an already completed nearby page when its partially prepared spread is cancelled", async (t) => {
    const f = fixture(t);
    await f.showSpread(2);
    f.cache.prefetchSpread(2, layout);
    const first = await f.renderFor(4);
    first.complete();
    const interrupted = await f.renderFor(5);
    const requested = f.cache.requestSpread(6, layout);
    (await f.renderFor(6)).complete();
    (await f.renderFor(7)).complete();
    f.cache.commitSpread((await requested).canvases);
    assert.equal(interrupted.cancelled, true);
    assert.equal(interrupted.canvas.pixels, 0);
    assert.ok(first.canvas.pixels > 0, "completed nearby pages should remain reusable after cancellation");
    const previous = f.cache.requestSpread(4, layout);
    (await f.renderFor(5, 2)).complete();
    assert.equal((await previous).canvases[0], first.canvas);
    assert.equal(f.renders.filter(render => render.page === 4).length, 1);
  });

  it("keeps the visible spread after a member fails and retries only the failed bitmap", async (t) => {
    const f = fixture(t);
    const visible = await f.showSpread(2);
    const requested = f.cache.requestSpread(4, layout);
    const rejected = assert.rejects(requested, /Temporary image failure/);
    const first = await f.renderFor(4);
    first.complete();
    const failed = await f.renderFor(5);
    failed.fail(new Error("Temporary image failure"));
    await rejected;
    assert.ok(visible.canvases.every(canvas => canvas.pixels > 0));
    assert.equal(failed.canvas.pixels, 0);
    const retry = f.cache.requestSpread(4, layout);
    const second = await f.renderFor(5, 2);
    second.complete();
    const replacement = await retry;
    assert.equal(replacement.canvases[0], first.canvas);
    assert.equal(f.renders.filter(render => render.page === 4).length, 1);
    f.cache.commitSpread(replacement.canvases);
  });

  it("cancels partner metadata lookups before rendering and disposes an in-flight spread safely", async (t) => {
    const f = fixture(t);
    const releasePartner = f.blockPage(3);
    const oldRequest = f.cache.requestSpread(2, layout);
    const superseded = assert.rejects(oldRequest, abortError);
    await until(() => f.pageRequests.includes(3), "partner lookup did not begin");
    assert.equal(f.canvases.length, 0, "pairing should be known before allocating the spread");
    const latest = f.cache.requestSpread(6, layout);
    assert.equal(f.pageSignals.at(-1)!.aborted, true);
    releasePartner();
    (await f.renderFor(6)).complete();
    (await f.renderFor(7)).complete();
    f.cache.commitSpread((await latest).canvases);
    await superseded;
    assert.equal(f.renders.some(render => render.page === 2 || render.page === 3), false);

    const pending = f.cache.requestSpread(8, layout);
    const disposed = assert.rejects(pending, abortError);
    (await f.renderFor(8)).complete();
    const active = await f.renderFor(9);
    active.holdCancellation = true;
    f.cache.dispose();
    assert.equal(active.cancelled, true);
    assert.ok(active.canvas.pixels > 0);
    active.complete();
    await disposed;
    await nextTurn();
    assert.ok(f.canvases.every(canvas => canvas.pixels === 0));
    await assert.rejects(f.cache.requestSpread(1, layout), abortError);
  });

  it("bounds old and replacement spreads together during large-page navigation, resizing, and mode switches", async (t) => {
    const f = fixture(t);
    const large: PageLayout = { width: 20_000, height: 20_000, fit: "width", zoom: 2, pixelRatio: 4 };
    await f.show(1, large);
    for (const page of [2, 4, 6, 8]) {
      const nextLayout = { ...large, zoom: page / 4 + 1 };
      const spread = await f.showSpread(page, nextLayout);
      assert.equal(spread.canvases.length, 2);
      f.cache.prefetchSpread(page, nextLayout);
      await nextTurn();
      const background = f.renders.findLast(render => !render.settled);
      if (background) background.complete();
      await nextTurn();
    }
    await f.show(9, large);
    await f.showSpread(10, large);
    assert.ok(f.peakCanvases <= 10, `allocated ${f.peakCanvases} canvases at once`);
    assert.ok(f.peakPixels <= 16_000_000, `allocated ${f.peakPixels} pixels at once`);
    assert.ok(f.peakCanvasPixels <= 8_000_000, `one canvas held ${f.peakCanvasPixels} pixels`);
    assert.ok(f.peakDimension <= 8192, `canvas dimension reached ${f.peakDimension}`);
    f.cache.dispose();
    await nextTurn();
    assert.ok(f.canvases.every(canvas => canvas.pixels === 0));
  });
});
