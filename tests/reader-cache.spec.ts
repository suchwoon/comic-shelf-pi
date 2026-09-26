import { test, expect, type JSHandle, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revealReaderControls } from "./reader-helpers";

type ObservedWindow = Window & {
  __readerTestCanvases: HTMLCanvasElement[];
  __readerTestVisualChanges: string[];
  __readerTestObserver?: MutationObserver;
};

let fixtureDirectory: string;
let fixture: Buffer;

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "comic-reader-cache-fixture-"));
  const fixturePath = join(fixtureDirectory, "scan.pdf");
  execFileSync(process.execPath, ["scripts/create-scan-fixture.mjs", fixturePath]);
  fixture = readFileSync(fixturePath);
});

test.afterAll(() => {
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function observeCreatedCanvases(page: Page) {
  // Observe browser objects without exposing cache internals in the application.
  await page.addInitScript(() => {
    const observed = window as unknown as ObservedWindow;
    observed.__readerTestCanvases = [];
    observed.__readerTestVisualChanges = [];
    const createElement = document.createElement.bind(document);
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = createElement(tagName, options);
      if (element instanceof HTMLCanvasElement) observed.__readerTestCanvases.push(element);
      return element;
    }) as typeof document.createElement;
  });
}

async function uploadBook(page: Page) {
  const session = await page.request.post("/api/session", { data: { password: "test-only-comic-shelf-passphrase" } });
  expect(session.ok()).toBe(true);
  const response = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "reader-cache-scan.pdf" },
    data: fixture,
  });
  expect(response.status()).toBe(201);
  const { book } = await response.json();
  return { path: `/read/${book.id}`, endpoint: `/api/books/${book.id}` };
}

async function prefetchedCanvas(page: Page, pageNumber: number): Promise<JSHandle<HTMLCanvasElement>> {
  // data-page is assigned only when PDF.js has finished rendering. A completed,
  // detached canvas therefore proves that the page was prepared before navigation.
  await expect.poll(() => page.evaluate(number => (window as unknown as ObservedWindow).__readerTestCanvases.some(canvas =>
    canvas.dataset.page === String(number) && canvas.width > 0 && !canvas.isConnected,
  ), pageNumber), { message: `Page ${pageNumber} should be rendered off screen before navigation` }).toBe(true);
  return page.evaluateHandle(number => (window as unknown as ObservedWindow).__readerTestCanvases.findLast(canvas =>
    canvas.dataset.page === String(number) && canvas.width > 0 && !canvas.isConnected,
  )!, pageNumber);
}

async function observeLoadingChanges(page: Page) {
  await expect(page.locator(".reader-page-pending")).toHaveCount(0);
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await page.evaluate(() => {
    const observed = window as unknown as ObservedWindow;
    observed.__readerTestObserver?.disconnect();
    observed.__readerTestVisualChanges = [];
    observed.__readerTestObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element &&
          ((record.oldValue ?? "").includes("reader-page-pending") || record.target.classList.contains("reader-page-pending"))) {
          observed.__readerTestVisualChanges.push("page-dimmed");
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(".reader-loading") || node.querySelector(".reader-loading"))) {
            observed.__readerTestVisualChanges.push("loading-indicator");
          }
        }
      }
    });
    observed.__readerTestObserver.observe(document.querySelector(".reader-root")!, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true,
    });
  });
}

async function expectPageFits(page: Page) {
  await expect.poll(() => page.getByTestId("pdf-page").evaluate(canvas => {
    const viewport = canvas.closest(".reader-canvas-scroll")!;
    const bounds = canvas.getBoundingClientRect();
    const available = viewport.getBoundingClientRect();
    return bounds.left >= available.left - 1 && bounds.top >= available.top - 1
      && bounds.right <= available.right + 1 && bounds.bottom <= available.bottom + 1
      && viewport.scrollWidth <= viewport.clientWidth + 1
      && viewport.scrollHeight <= viewport.clientHeight + 1
      && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  }), { message: "The PDF page should stay inside the reader viewport without scrolling" }).toBe(true);
}

test("immediately displays prepared next and previous pages using the same canvases", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await observeCreatedCanvases(page);
  const book = await uploadBook(page);
  try {
    await page.goto(book.path);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const visibleCanvas = page.getByTestId("pdf-page");
    await expect(visibleCanvas).toHaveAttribute("data-page", "1", { timeout: 40_000 });
    await revealReaderControls(page);
    const firstCanvas = await visibleCanvas.elementHandle();
    const secondCanvas = await prefetchedCanvas(page, 2);
    await observeLoadingChanges(page);

    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(visibleCanvas).toHaveAttribute("data-page", "2");
    expect(await secondCanvas.evaluate(canvas => canvas === document.querySelector('[data-testid="pdf-page"]'))).toBe(true);

    await page.getByRole("button", { name: "Previous page", exact: true }).click();
    await expect(visibleCanvas).toHaveAttribute("data-page", "1");
    expect(await firstCanvas!.evaluate(canvas => canvas === document.querySelector('[data-testid="pdf-page"]'))).toBe(true);

    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(visibleCanvas).toHaveAttribute("data-page", "2");
    expect(await secondCanvas.evaluate(canvas => canvas === document.querySelector('[data-testid="pdf-page"]'))).toBe(true);
    await expect(visibleCanvas).toHaveCount(1);
    await expectPageFits(page);
    expect(await page.evaluate(() => (window as unknown as ObservedWindow).__readerTestVisualChanges)).toEqual([]);
    expect(browserErrors).toEqual([]);
    await firstCanvas!.dispose();
    await secondCanvas.dispose();
  } finally {
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

test("resizing replaces outdated canvases and rapid navigation displays the final fitted page", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await observeCreatedCanvases(page);
  const book = await uploadBook(page);
  try {
    await page.goto(book.path);
    const visibleCanvas = page.getByTestId("pdf-page");
    await expect(visibleCanvas).toHaveAttribute("data-page", "1", { timeout: 40_000 });
    await revealReaderControls(page);
    const initialCanvas = await visibleCanvas.elementHandle();
    const initialBounds = await visibleCanvas.boundingBox();
    const oldSecondCanvas = await prefetchedCanvas(page, 2);
    await expectPageFits(page);
    await expect(page.getByRole("button", { name: /zoom|fit (?:to )?width|width fit/i })).toHaveCount(0);

    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: Math.max(320, Math.floor(viewport.width * 0.82)), height: Math.max(600, Math.floor(viewport.height * 0.8)) });
    await expect.poll(() => initialCanvas!.evaluate(canvas => canvas.isConnected)).toBe(false);
    await expect(visibleCanvas).toHaveAttribute("data-page", "1");
    await expect.poll(() => initialCanvas!.evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBe(0);
    await expect.poll(() => oldSecondCanvas.evaluate(canvas => canvas.width)).toBe(0);
    const resizedBounds = await visibleCanvas.boundingBox();
    expect(Math.abs(resizedBounds!.width - initialBounds!.width)).toBeGreaterThan(10);
    expect(resizedBounds!.width / resizedBounds!.height).toBeCloseTo(600 / 840, 2);
    await expectPageFits(page);

    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(visibleCanvas).toHaveAttribute("data-page", "2");
    expect(await oldSecondCanvas.evaluate(canvas => canvas === document.querySelector('[data-testid="pdf-page"]'))).toBe(false);
    const secondBounds = await visibleCanvas.boundingBox();
    expect(secondBounds!.width).toBeCloseTo(resizedBounds!.width, 0);
    expect(secondBounds!.height).toBeCloseTo(resizedBounds!.height, 0);

    await page.getByRole("button", { name: "Next page", exact: true }).click({ clickCount: 5 });
    await expect(visibleCanvas).toHaveAttribute("data-page", "7");
    await expect(visibleCanvas).toHaveCount(1);
    await expect.poll(async () => (await (await page.request.get(book.endpoint)).json()).book.currentPage).toBe(7);
    await expectPageFits(page);
    await page.screenshot({ path: testInfo.outputPath("reader-resized.png"), fullPage: true });

    const beforeHideCanvas = await visibleCanvas.elementHandle();
    const touchReader = await page.locator(".reader-root").evaluate(element => element.classList.contains("reader-touch"));
    await page.getByRole("button", { name: "Hide controls", exact: true }).click();
    const reveal = page.getByRole("button", { name: touchReader ? "Show controls (center area)" : "Show controls", exact: true });
    await expect(reveal).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeHidden();
    await expect.poll(() => beforeHideCanvas!.evaluate(canvas => canvas.isConnected)).toBe(touchReader);
    await expect(visibleCanvas).toHaveAttribute("data-page", "7");
    await expectPageFits(page);
    await page.screenshot({ path: testInfo.outputPath("reader-controls-hidden.png"), fullPage: true });
    if (touchReader) await reveal.tap();
    else await reveal.click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
    await expectPageFits(page);
    expect(browserErrors).toEqual([]);
    await initialCanvas!.dispose();
    await oldSecondCanvas.dispose();
    await beforeHideCanvas!.dispose();
  } finally {
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});
