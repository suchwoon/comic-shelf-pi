import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import { ImagePageDocument, type DocumentPage } from "../lib/reader/page-document";

const abortError = (error: unknown) => error instanceof Error && error.name === "AbortError";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "expected image work did not start");
    await nextTurn();
  }
}

function fixture(t: TestContext, pageCount = 5) {
  const images: FakeImage[] = [];
  const requests: { url: string; options: RequestInit }[] = [];
  const urls: string[] = [];
  const revoked: string[] = [];
  const redirects: string[] = [];
  class FakeImage {
    src = "";
    decoding = "auto";
    naturalWidth = 1200;
    naturalHeight = 1800;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { images.push(this); }
  }
  let respond = async (_options: RequestInit) => new Response(new Blob(["image bytes"], { type: "image/jpeg" }), {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  });
  const globals = ["Image", "window", "fetch"] as const;
  const original = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { replace: (url: string) => redirects.push(url) } },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return respond(options);
    },
  });
  t.mock.method(URL, "createObjectURL", () => {
    const url = `blob:test-${urls.length + 1}`;
    urls.push(url);
    return url;
  });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  const document = new ImagePageDocument("book/with spaces", pageCount);
  t.after(() => {
    document.destroy();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  async function load(pageNumber: number) {
    const previous = images.length;
    const requested = document.getPage(pageNumber);
    await until(() => images.length > previous);
    images.at(-1)!.onload!();
    return requested;
  }
  return {
    document, images, requests, urls, revoked, redirects, load,
    respond: (handler: typeof respond) => { respond = handler; },
  };
}

function render(page: DocumentPage) {
  const calls: unknown[][] = [];
  const context = {
    fillStyle: "",
    fillRect(...args: unknown[]) { calls.push(["fill", ...args]); },
    drawImage(...args: unknown[]) { calls.push(["draw", ...args]); },
  };
  const task = page.render({
    canvas: { width: 600, height: 900 } as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport: { width: 600, height: 900 },
    background: "#ffffff",
  });
  return { calls, context, task };
}

describe("authenticated image page documents", () => {
  it("loads only the page image, scales it onto a canvas, and releases the decoded resource", async t => {
    const f = fixture(t);
    const page = await f.load(2);
    assert.equal(f.requests[0].url, "/api/books/book%2Fwith%20spaces/pages/2");
    assert.equal(f.requests[0].options.credentials, "same-origin");
    assert.equal(f.requests[0].options.cache, "no-store");
    assert.ok(f.requests[0].options.signal instanceof AbortSignal);
    assert.deepEqual(page.getViewport({ scale: 0.5 }), { width: 600, height: 900 });
    assert.deepEqual(f.revoked, f.urls, "object URL should be released as soon as decoding finishes");
    const { task, context, calls } = render(page);
    await task.promise;
    assert.equal(context.fillStyle, "#ffffff");
    assert.deepEqual(calls, [
      ["fill", 0, 0, 600, 900],
      ["draw", f.images[0], 0, 0, 600, 900],
    ]);
    page.cleanup();
    page.cleanup();
    assert.equal(f.images[0].src, "");
    assert.deepEqual(f.revoked, f.urls, "cleanup must not revoke an object URL twice");
  });

  it("aborts a pending fetch and rejects requests already cancelled or outside the document", async t => {
    const f = fixture(t);
    f.respond(options => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const requested = f.document.getPage(1, controller.signal);
    controller.abort();
    await assert.rejects(requested, abortError);
    assert.equal(f.requests[0].options.signal!.aborted, true);
    await assert.rejects(f.document.getPage(1, controller.signal), abortError);
    for (const number of [0, 6, 1.5, NaN]) await assert.rejects(f.document.getPage(number), RangeError);
    assert.equal(f.requests.length, 1);
    assert.equal(f.images.length, 0);
  });

  it("aborts image decoding without retaining an object URL or decoded image", async t => {
    const f = fixture(t);
    const controller = new AbortController();
    const requested = f.document.getPage(1, controller.signal);
    await until(() => f.images.length === 1);
    controller.abort();
    await assert.rejects(requested, abortError);
    assert.equal(f.images[0].src, "");
    assert.equal(f.images[0].onload, null);
    assert.equal(f.images[0].onerror, null);
    assert.deepEqual(f.revoked, f.urls);
  });

  it("destroys both prepared resources and pending requests, then rejects further work", async t => {
    const f = fixture(t);
    const ready = await f.load(1);
    const pending = f.document.getPage(2);
    await until(() => f.images.length === 2);
    const { task, calls } = render(ready);
    f.document.destroy();
    f.document.destroy();
    await assert.rejects(pending, abortError);
    await assert.rejects(task.promise, abortError);
    await assert.rejects(f.document.getPage(1), abortError);
    assert.deepEqual(calls, []);
    assert.ok(f.images.every(image => image.src === ""));
    assert.deepEqual(f.revoked, f.urls);
  });

  it("cancels queued drawing before any canvas mutation", async t => {
    const f = fixture(t);
    const page = await f.load(1);
    const { task, calls } = render(page);
    task.cancel();
    await assert.rejects(task.promise, abortError);
    assert.deepEqual(calls, []);
    page.cleanup();
  });

  it("redirects an expired session and rejects failed or non-image responses", async t => {
    const f = fixture(t);
    f.respond(async () => new Response(null, { status: 401 }));
    await assert.rejects(f.document.getPage(1), /could not be loaded/);
    assert.deepEqual(f.redirects, ["/"]);
    f.respond(async () => new Response(null, { status: 404 }));
    await assert.rejects(f.document.getPage(1), /could not be loaded/);
    f.respond(async () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }));
    await assert.rejects(f.document.getPage(1), /Invalid page image response/);
    assert.equal(f.images.length, 0);
    assert.equal(f.urls.length, 0);
  });

  it("cleans up failed decodes and can retry the same page", async t => {
    const f = fixture(t);
    const failed = f.document.getPage(3);
    await until(() => f.images.length === 1);
    f.images[0].onerror!();
    await assert.rejects(failed, /could not be decoded/);
    assert.equal(f.images[0].src, "");
    const retry = await f.load(3);
    assert.deepEqual(retry.getViewport({ scale: 1 }), { width: 1200, height: 1800 });
    retry.cleanup();
    assert.deepEqual(f.revoked, f.urls);
  });

  it("discards a response arriving after its request has been cancelled", async t => {
    const f = fixture(t);
    let respond!: (response: Response) => void;
    f.respond(() => new Promise(resolve => { respond = resolve; }));
    const controller = new AbortController();
    const pending = f.document.getPage(1, controller.signal);
    controller.abort();
    respond(new Response(new Blob(["bytes"], { type: "image/jpeg" })));
    await assert.rejects(pending, abortError);
    assert.equal(f.images.length, 0);
  });

  it("warms compressed pages without decoding them and reuses them across canvas layouts", async t => {
    const f = fixture(t);
    f.document.prefetch([2, 3, 4]);
    await until(() => f.requests.length === 3);
    assert.equal(f.images.length, 0);
    assert.equal(f.urls.length, 0);
    const page = await f.load(3);
    page.cleanup();
    const resized = await f.load(3);
    resized.cleanup();
    assert.equal(f.requests.length, 3, "canvas redraws should reuse the compressed image");
    assert.ok(f.images.every(image => image.src === ""));
  });

  it("reserves a fetch lane for the foreground and promotes an in-flight prefetch", async t => {
    const f = fixture(t);
    const responses: ((response: Response) => void)[] = [];
    f.respond(options => new Promise((resolve, reject) => {
      responses.push(resolve);
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    f.document.prefetch([2, 3, 4]);
    assert.equal(f.requests.length, 1, "background warming must leave a foreground lane available");
    const foreground = f.document.getPage(5);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests[1].url.endsWith("/5"), "visible pages should bypass queued prefetches");
    const promoted = f.document.getPage(2);
    assert.equal(f.requests.length, 2, "promoting an active prefetch must share its request");
    responses[0](new Response("page 2", { headers: { "Content-Type": "image/jpeg" } }));
    responses[1](new Response("page 5", { headers: { "Content-Type": "image/jpeg" } }));
    await until(() => f.images.length === 2);
    for (const image of f.images) image.onload!();
    (await foreground).cleanup();
    (await promoted).cleanup();
    assert.equal(f.requests.filter(request => request.url.endsWith("/2")).length, 1);
  });

  it("cancels stale warming after a jump and drops queued pages outside the new window", async t => {
    const f = fixture(t);
    f.respond(options => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    f.document.prefetch([1, 2, 3]);
    const oldSignal = f.requests[0].options.signal!;
    f.document.prefetch([4, 5]);
    assert.equal(oldSignal.aborted, true);
    assert.deepEqual(f.requests.map(request => request.url.split("/").at(-1)), ["1", "4"]);
    f.document.destroy();
    assert.ok(f.requests.every(request => request.options.signal!.aborted));
    assert.equal(f.images.length, 0);
  });

  it("preempts demoted background fetches for a page jump and retries wanted displaced pages", async t => {
    const f = fixture(t, 30);
    (await f.load(1)).cleanup();
    const responses: ((response: Response) => void)[] = [];
    // Allow a cancelled response to arrive late, to exercise replacement-request ownership.
    f.respond(() => new Promise(resolve => { responses.push(resolve); }));
    f.document.prefetch([1, 2, 3]);
    const controller = new AbortController();
    const warmingCanvas = f.document.getPage(2, controller.signal);
    assert.deepEqual(f.requests.slice(1).map(request => request.url.split("/").at(-1)), ["2", "3"]);
    controller.abort();
    await assert.rejects(warmingCanvas, abortError);
    const jump = f.document.getPage(20);
    assert.ok(f.requests.at(-1)!.url.endsWith("/20"), "a jump must start without waiting for either background image");
    assert.equal(f.requests[1].options.signal!.aborted, false, "keep the nearer background image");
    assert.equal(f.requests[2].options.signal!.aborted, true, "preempt the farther background image");
    responses[1](new Response("stale page 3", { headers: { "Content-Type": "image/jpeg" } }));
    responses[2](new Response("page 20", { headers: { "Content-Type": "image/jpeg" } }));
    await until(() => f.images.length === 2);
    f.images.at(-1)!.onload!();
    (await jump).cleanup();
    responses[0](new Response("page 2", { headers: { "Content-Type": "image/jpeg" } }));
    await until(() => f.requests.length === 5);
    assert.ok(f.requests[4].url.endsWith("/3"), "the displaced wanted page should resume warming");
    const retry = f.document.getPage(3);
    assert.equal(f.requests.length, 5, "the late cancelled response must not remove the replacement request");
    responses[3](new Response("fresh page 3", { headers: { "Content-Type": "image/jpeg" } }));
    await until(() => f.images.length === 3);
    f.images.at(-1)!.onload!();
    (await retry).cleanup();
    assert.equal(f.requests.length, 5);
  });

  it("keeps a wanted prefetch alive when a canvas request using it is cancelled", async t => {
    const f = fixture(t);
    let respond!: (response: Response) => void;
    f.respond(options => new Promise((resolve, reject) => {
      respond = resolve;
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    f.document.prefetch([2]);
    const controller = new AbortController();
    const cancelled = f.document.getPage(2, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, abortError);
    assert.equal(f.requests[0].options.signal!.aborted, false);
    respond(new Response("page 2", { headers: { "Content-Type": "image/jpeg" } }));
    (await f.load(2)).cleanup();
    assert.equal(f.requests.length, 1);
  });

  it("lets callers cancel independently while sharing the same foreground image request", async t => {
    const f = fixture(t);
    let respond!: (response: Response) => void;
    f.respond(options => new Promise((resolve, reject) => {
      respond = resolve;
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const cancelled = f.document.getPage(2, controller.signal);
    const retained = f.document.getPage(2);
    controller.abort();
    await assert.rejects(cancelled, abortError);
    assert.equal(f.requests[0].options.signal!.aborted, false);
    respond(new Response("page 2", { headers: { "Content-Type": "image/jpeg" } }));
    await until(() => f.images.length === 1);
    f.images[0].onload!();
    (await retained).cleanup();
    assert.equal(f.requests.length, 1);
  });

  it("limits compressed cache bytes while keeping nearer pages ahead of distant pages", async t => {
    const f = fixture(t);
    const largeImage = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: "image/jpeg" });
    f.respond(async () => new Response(largeImage, { headers: { "Content-Type": "image/jpeg" } }));
    f.document.prefetch([1, 2]);
    (await f.load(1)).cleanup();
    (await f.load(2)).cleanup();
    f.document.prefetch([1, 2, 3]);
    (await f.load(3)).cleanup();
    (await f.load(1)).cleanup();
    (await f.load(2)).cleanup();
    assert.equal(f.requests.length, 3, "the first two 9 MiB pages fit the 24 MiB budget");
    (await f.load(3)).cleanup();
    assert.equal(f.requests.length, 4, "the distant third page must be evicted under byte pressure");
  });

  it("bounds the number of retained images and the requested prefetch window", async t => {
    const f = fixture(t, 30);
    const window = Array.from({ length: 30 }, (_, index) => index + 1);
    f.document.prefetch([NaN, 0, 1, 1, ...window]);
    await until(() => f.requests.length === 12);
    (await f.load(12)).cleanup();
    await nextTurn();
    assert.equal(f.requests.length, 12, "warming should stop after twelve distinct valid pages");
    f.document.prefetch([]);
    for (let page = 1; page <= 13; page++) (await f.load(page)).cleanup();
    const before = f.requests.length;
    (await f.load(1)).cleanup();
    assert.equal(f.requests.length, before + 1, "the oldest image should leave the twelve-page cache");
  });
});
