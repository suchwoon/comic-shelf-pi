import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { revealReaderControls } from "./reader-helpers";

async function openBook(page: Page, landscapePages: number[] = [], prepare?: (endpoint: string) => Promise<void>) {
  const session = await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
  expect(session.ok()).toBe(true);
  const document = await PDFDocument.create();
  document.setTitle("Reader options");
  document.setSubject(`Reader options fixture ${Date.now()} ${Math.random()}`);
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  for (let number = 1; number <= 8; number++) {
    const landscape = landscapePages.includes(number);
    const sheet = document.addPage(landscape ? [800, 400] : [400, 600]);
    const { width, height } = sheet.getSize();
    const background = number % 2 === 0 ? rgb(0.91, 0.96, 0.97) : rgb(0.98, 0.92, 0.84);
    sheet.drawRectangle({ x: 0, y: 0, width, height, color: background });
    sheet.drawRectangle({ x: 20, y: 20, width: width - 40, height: height - 40, borderWidth: 2, borderColor: rgb(0.2, 0.25, 0.3) });
    sheet.drawText(`PAGE ${number}`, { x: 40, y: height - 65, font, size: 20, color: rgb(0.2, 0.25, 0.3) });
    const numberWidth = font.widthOfTextAtSize(String(number), 140);
    sheet.drawText(String(number), { x: (width - numberWidth) / 2, y: height / 2 - 45, font, size: 140, color: rgb(0.2, 0.25, 0.3) });
    sheet.drawText(landscape ? "WIDE PAGE" : "PORTRAIT PAGE", { x: 40, y: 45, font, size: 16, color: rgb(0.2, 0.25, 0.3) });
  }
  const response = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "reader-options.pdf" },
    data: Buffer.from(await document.save()),
  });
  expect(response.status()).toBe(201);
  const { book } = await response.json();
  const endpoint = `/api/books/${book.id}`;
  await prepare?.(endpoint);
  await page.goto(`/read/${book.id}`);
  await expectPages(page, [1]);
  await revealReaderControls(page);
  await expect(page.locator(".reader-save-status")).toHaveText("Saved");
  return endpoint;
}

async function removeBook(page: Page, endpoint: string) {
  await page.goto("about:blank").catch(() => {});
  await page.unrouteAll({ behavior: "wait" });
  expect((await page.request.delete(endpoint)).status()).toBe(204);
}

async function expectPages(page: Page, numbers: number[], ready = true) {
  await expect.poll(() => page.getByTestId("pdf-page").evaluateAll(canvases =>
    canvases.map(canvas => Number((canvas as HTMLCanvasElement).dataset.page)),
  )).toEqual(numbers);
  // A mode change can keep the same cover visible while its new layout loads.
  // Wait for that render before sending the next intentional navigation.
  if (ready) await expect(page.locator(".reader-page-surface")).toHaveAttribute("aria-busy", "false");
}

async function expectSavedPage(page: Page, endpoint: string, number: number) {
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).book.currentPage).toBe(number);
}

async function jumpToPage(page: Page, number: number) {
  await page.getByRole("textbox", { name: "Page number", exact: true }).fill(String(number));
  await page.getByRole("textbox", { name: "Page number", exact: true }).press("Enter");
}

async function expectPagesFit(page: Page) {
  await expect.poll(() => page.getByTestId("pdf-page").evaluateAll(canvases => canvases.every(canvas => {
    const viewport = canvas.closest(".reader-canvas-scroll")!;
    const available = viewport.getBoundingClientRect();
    const bounds = canvas.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0
      && bounds.left >= available.left - 1 && bounds.top >= available.top - 1
      && bounds.right <= available.right + 1 && bounds.bottom <= available.bottom + 1
      && viewport.scrollWidth <= viewport.clientWidth + 1 && viewport.scrollHeight <= viewport.clientHeight + 1
      && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  }))).toBe(true);
}

test("direction arrows show the current direction and spreads follow it through both boundaries", async ({ page }, testInfo) => {
  const endpoint = await openBook(page);
  try {
    const mode = page.getByRole("button", { name: "Two-page view", exact: true });
    await expect(mode).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).locator("svg")).toHaveClass(/lucide-arrow-right/);
    await mode.click();
    await expect(mode).toHaveAttribute("aria-pressed", "true");
    await expectPages(page, [1]);
    await jumpToPage(page, 0);
    await expect(page.getByRole("textbox", { name: "Page number", exact: true })).toHaveValue("1");
    await expectPages(page, [1]);
    await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectPages(page, [2, 3]);
    await expect(page.locator(".reader-pagination")).toContainText(/2[–-]3\s*\/\s*8/);
    await expectPagesFit(page);
    const bounds = await page.getByTestId("pdf-page").evaluateAll(canvases => canvases.map(canvas => canvas.getBoundingClientRect().x));
    expect(bounds[0]).toBeLessThan(bounds[1]);
    await page.screenshot({ path: testInfo.outputPath("reader-two-page-ltr.png"), fullPage: true });

    await page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reading direction: Right to left", exact: true }).locator("svg")).toHaveClass(/lucide-arrow-left/);
    await expectPages(page, [3, 2]);
    await page.screenshot({ path: testInfo.outputPath("reader-two-page-rtl.png"), fullPage: true });
    await page.locator(".reader-heading").screenshot({ path: testInfo.outputPath("reader-toolbar-rtl.png") });
    await page.keyboard.press("ArrowLeft");
    await expectPages(page, [5, 4]);
    await page.keyboard.press("ArrowRight");
    await expectPages(page, [3, 2]);
    if (testInfo.project.name === "mobile") {
      await page.getByRole("button", { name: "Hide controls", exact: true }).tap();
      await page.getByRole("button", { name: "Next page (left area)", exact: true }).tap();
      await expectPages(page, [5, 4]);
      await page.getByRole("button", { name: "Previous page (right area)", exact: true }).tap();
      await expectPages(page, [3, 2]);
      await revealReaderControls(page);
    }
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectPages(page, [5, 4]);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectPages(page, [7, 6]);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectPages(page, [8]);
    await expectSavedPage(page, endpoint, 8);
    await jumpToPage(page, 99999);
    await expect(page.getByRole("textbox", { name: "Page number", exact: true })).toHaveValue("8");
    await expectPages(page, [8]);
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Previous page", exact: true }).click();
    await expectPages(page, [7, 6]);
    await expectPagesFit(page);
  } finally {
    await removeBook(page, endpoint);
  }
});

test("changing the view preserves the exact page and remembers the preference after reload", async ({ page }) => {
  const endpoint = await openBook(page);
  try {
    const mode = page.getByRole("button", { name: "Two-page view", exact: true });
    const input = page.getByRole("textbox", { name: "Page number", exact: true });
    await jumpToPage(page, 3);
    await expectPages(page, [3]);
    await mode.click();
    await expectPages(page, [2, 3]);
    await input.focus();
    await expect(input).toHaveValue("3");
    await expectSavedPage(page, endpoint, 3);
    expect(await page.evaluate(() => localStorage.getItem("comic-shelf:two-page-view"))).toBe("true");
    await page.reload();
    await expectPages(page, [2, 3]);
    await revealReaderControls(page);
    await expect(mode).toHaveAttribute("aria-pressed", "true");
    await mode.click();
    await expectPages(page, [3]);
    await expect(input).toHaveValue("3");
    expect(await page.evaluate(() => localStorage.getItem("comic-shelf:two-page-view"))).toBe("false");
    await page.reload();
    await expectPages(page, [3]);
    await revealReaderControls(page);
    await expect(mode).toHaveAttribute("aria-pressed", "false");
  } finally {
    await removeBook(page, endpoint);
  }
});

test("wheel gestures turn one page or spread, keep their direction in RTL, and ignore other controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Requires a mouse or trackpad context");
  const endpoint = await openBook(page);
  try {
    const viewport = page.locator(".reader-canvas-scroll");
    await viewport.hover();
    // One continuous trackpad gesture may outlast an ordinary throttle window.
    // Its tail must not count as several deliberate turns. Dispatch the whole
    // burst together so image loading cannot introduce a false gesture gap.
    await viewport.evaluate(async target => {
      for (let index = 0; index < 12; index++) {
        target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 60 - index * 3 }));
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    });
    await expectPages(page, [2]);
    await page.waitForTimeout(650);
    await page.mouse.wheel(0, -120);
    await expectPages(page, [1]);
    await page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).click();
    await page.waitForTimeout(650);
    await viewport.hover();
    await page.mouse.wheel(0, 120);
    await expectPages(page, [2]);
    await page.waitForTimeout(650);
    await viewport.dispatchEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120, ctrlKey: true });
    await page.locator(".reader-heading").dispatchEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    await page.getByRole("textbox", { name: "Page number", exact: true }).dispatchEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    await expectPages(page, [2]);
    await page.getByRole("button", { name: "Two-page view", exact: true }).click();
    await expectPages(page, [3, 2]);
    await viewport.hover();
    await page.mouse.wheel(0, 120);
    await expectPages(page, [5, 4]);
    await page.waitForTimeout(650);
    await page.mouse.wheel(0, -120);
    await expectPages(page, [3, 2]);
    // The previous spread was entered through page 3, so its exact bookmark is 3.
    await expectSavedPage(page, endpoint, 3);
  } finally {
    await removeBook(page, endpoint);
  }
});

test("landscape pages split their fixed pair without shifting the following spreads", async ({ page }) => {
  const endpoint = await openBook(page, [3, 6]);
  try {
    await page.getByRole("button", { name: "Two-page view", exact: true }).click();
    const spreads = [[1], [2], [3], [4, 5], [6], [7], [8]];
    await expectPages(page, spreads[0]);
    for (const spread of spreads.slice(1)) {
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expectPages(page, spread);
      await expectPagesFit(page);
    }
    for (const spread of spreads.slice(0, -1).reverse()) {
      await page.getByRole("button", { name: "Previous page", exact: true }).click();
      await expectPages(page, spread);
    }
    await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  } finally {
    await removeBook(page, endpoint);
  }
});

test("a spread replaces the previous page and saves progress only after both images load", async ({ page }) => {
  const endpoint = await openBook(page);
  let releaseImage!: () => void;
  const heldImage = new Promise<void>(resolve => { releaseImage = resolve; });
  let imageRequested = false;
  const positions: number[] = [];
  await page.route(`**${endpoint}/pages/5`, async route => {
    imageRequested = true;
    await heldImage;
    await route.continue().catch(() => {});
  });
  await page.route(`**${endpoint}/progress`, async route => {
    positions.push(route.request().postDataJSON().currentPage);
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Two-page view", exact: true }).click();
    await expectPages(page, [1]);
    await jumpToPage(page, 4);
    await expect.poll(() => imageRequested).toBe(true);
    // Allow both rendering and the progress debounce to run while page 5 is held.
    await page.waitForTimeout(650);
    await expectPages(page, [1], false);
    await expect(page.locator(".reader-page-surface")).toHaveAttribute("aria-busy", "true");
    expect((await (await page.request.get(endpoint)).json()).book.currentPage).toBe(1);
    expect(positions.every(position => position === 1)).toBe(true);
    releaseImage();
    await expectPages(page, [4, 5]);
    await expectSavedPage(page, endpoint, 4);
    expect(positions).toContain(4);
  } finally {
    releaseImage();
    await removeBook(page, endpoint);
  }
});

test("a failed next spread keeps the visible bookmark and retries through Next page", async ({ page }) => {
  let failImage = true;
  // Single-page prefetch can also request page 3, so intercept before opening.
  const endpoint = await openBook(page, [], async path => {
    await page.route(`**${path}/pages/3`, async route => {
      if (failImage) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
      else await route.continue();
    });
  });
  const positions: number[] = [];
  await page.route(`**${endpoint}/progress`, async route => {
    positions.push(route.request().postDataJSON().currentPage);
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Two-page view", exact: true }).click();
    await expectPages(page, [1]);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.locator(".reader-workspace").getByRole("alert")).toContainText("Unable to load this page");
    await expectPages(page, [1]);
    // Let a wrongly queued bookmark reach the server before asserting it stayed put.
    await page.waitForTimeout(650);
    expect((await (await page.request.get(endpoint)).json()).book.currentPage).toBe(1);
    expect(positions.every(position => position === 1)).toBe(true);
    failImage = false;
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectPages(page, [2, 3]);
    await expect(page.locator(".reader-workspace").getByRole("alert")).toHaveCount(0);
    await expectSavedPage(page, endpoint, 2);
  } finally {
    failImage = false;
    await removeBook(page, endpoint);
  }
});
