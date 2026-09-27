import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openReaderSettings } from "./reader-helpers";

let fixtureDirectory: string;
let fixture: Buffer;

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "comic-reader-touch-fixture-"));
  const fixturePath = join(fixtureDirectory, "touch.pdf");
  execFileSync(process.execPath, ["scripts/create-test-pdf.mjs", fixturePath]);
  fixture = readFileSync(fixturePath);
});

test.afterAll(() => {
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function openBook(page: Page) {
  const session = await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
  expect(session.ok()).toBe(true);
  const response = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "reader-touch.pdf" },
    data: fixture,
  });
  expect(response.status()).toBe(201);
  const { book } = await response.json();
  const endpoint = `/api/books/${book.id}`;
  await page.goto(`/read/${book.id}`);
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1", { timeout: 40_000 });
  return endpoint;
}

async function removeBook(page: Page, endpoint: string) {
  await page.goto("about:blank").catch(() => {});
  expect((await page.request.delete(endpoint)).status()).toBe(204);
}

async function tapArea(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  const bounds = (await button.boundingBox())!;
  // Raw touchscreen taps also exercise disabled boundary buttons and the
  // browser's compatibility click, which must never advance a second page.
  await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function expectSavedPage(page: Page, endpoint: string, currentPage: number) {
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", String(currentPage));
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).book.currentPage).toBe(currentPage);
}

test("touch areas navigate with hidden controls, follow reading direction, and restore progress", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Requires a touchscreen context");
  const endpoint = await openBook(page);
  try {
    const reader = page.locator(".reader-root");
    await expect(reader).toHaveClass(/reader-touch/);
    await expect(reader).toHaveClass(/reader-controls-hidden/);
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Show controls", exact: true })).toHaveCount(0);

    await tapArea(page, "Previous page (left area)");
    await expectSavedPage(page, endpoint, 1);
    await tapArea(page, "Next page (right area)");
    await expectSavedPage(page, endpoint, 2);
    await expect(reader).toHaveClass(/reader-controls-hidden/);
    await tapArea(page, "Previous page (left area)");
    await expectSavedPage(page, endpoint, 1);

    await tapArea(page, "Show controls (center area)");
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
    await openReaderSettings(page);
    await page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Reading direction: Right to left", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await tapArea(page, "Hide controls (center area)");
    await tapArea(page, "Next page (left area)");
    await expectSavedPage(page, endpoint, 2);
    await tapArea(page, "Previous page (right area)");
    await expectSavedPage(page, endpoint, 1);

    await tapArea(page, "Show controls (center area)");
    await page.getByLabel("Page number").fill("8");
    await page.getByLabel("Page number").press("Enter");
    await expectSavedPage(page, endpoint, 8);
    await tapArea(page, "Hide controls (center area)");
    await tapArea(page, "Next page (left area)");
    await expectSavedPage(page, endpoint, 8);
    await tapArea(page, "Previous page (right area)");
    await expectSavedPage(page, endpoint, 7);
    await expect.poll(async () => (await (await page.request.get(endpoint)).json()).book.direction).toBe("rtl");

    await page.reload();
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "7");
    await expect(reader).toHaveClass(/reader-controls-hidden/);
    await tapArea(page, "Next page (left area)");
    await expectSavedPage(page, endpoint, 8);
  } finally {
    await removeBook(page, endpoint);
  }
});

test("mobile controls overlay the same fitted canvas in portrait and landscape", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Requires a touchscreen context");
  const endpoint = await openBook(page);
  try {
    const portrait = page.viewportSize()!;
    for (const viewport of [portrait, { width: portrait.height, height: portrait.width }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.getByTestId("pdf-page").evaluate(canvas => {
        const bounds = canvas.getBoundingClientRect();
        return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
      })).toBe(true);
      const canvas = await page.getByTestId("pdf-page").elementHandle();
      const before = await page.getByTestId("pdf-page").boundingBox();
      await tapArea(page, "Show controls (center area)");
      await expect(page.getByRole("link", { name: "Back to library", exact: true })).toBeVisible();
      expect(await page.getByTestId("pdf-page").boundingBox()).toEqual(before);
      expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
      await page.getByRole("button", { name: "Hide controls", exact: true }).tap();
      const center = page.getByRole("button", { name: "Show controls (center area)", exact: true });
      await expect(center).toBeFocused();
      await expect(center).toHaveAttribute("aria-expanded", "false");
      await center.press("Enter");
      await expect(page.getByRole("button", { name: "Hide controls (center area)", exact: true })).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("link", { name: "Back to library", exact: true })).toBeVisible();
      await tapArea(page, "Hide controls (center area)");
      await expect(page.getByRole("link", { name: "Back to library", exact: true })).toBeHidden();
      expect(await page.getByTestId("pdf-page").boundingBox()).toEqual(before);
      expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
      await canvas!.dispose();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await tapArea(page, "Next page (right area)");
    await expectSavedPage(page, endpoint, 2);
    await page.screenshot({ path: testInfo.outputPath("reader-touch-landscape.png"), fullPage: true });
  } finally {
    await removeBook(page, endpoint);
  }
});

test("dragging, long presses, cancelled touches, multitouch, and zoom do not turn pages", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Requires a touchscreen context");
  const endpoint = await openBook(page);
  try {
    for (const gesture of ["drag", "long", "cancel", "multi"] as const) {
      await page.getByRole("button", { name: "Next page (right area)", exact: true }).evaluate((target, kind) => {
        const bounds = target.getBoundingClientRect();
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        const start = performance.now();
        function send(type: string, offset: number, pointerId = 11, clientX = x, element: Element = target) {
          const event = new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerType: "touch", pointerId,
            isPrimary: pointerId === 11, clientX, clientY: y,
            button: 0, buttons: type === "pointerup" || type === "pointercancel" || type === "click" ? 0 : 1,
            detail: type === "click" ? 1 : 0,
          });
          Object.defineProperty(event, "timeStamp", { value: start + offset });
          element.dispatchEvent(event);
        }
        send("pointerdown", 0);
        if (kind === "drag") {
          send("pointermove", 20, 11, x - 30);
          send("pointermove", 40); // Returning to the start must still cancel.
        }
        if (kind === "multi") {
          const center = document.querySelector('[aria-label="Show controls (center area)"]')!;
          send("pointerdown", 20, 12, x, center);
          send("pointerup", 60, 12, x, center);
        }
        send(kind === "cancel" ? "pointercancel" : "pointerup", kind === "long" ? 601 : 100);
        send("click", kind === "long" ? 602 : 101);
      }, gesture);
      await expect(page.getByTestId("pdf-page"), `${gesture} should not turn a page`).toHaveAttribute("data-page", "1");
      // A rejected gesture must not swallow the next deliberate tap.
      await tapArea(page, "Next page (right area)");
      await expectSavedPage(page, endpoint, 2);
      await tapArea(page, "Previous page (left area)");
      await expectSavedPage(page, endpoint, 1);
    }

    const next = page.getByRole("button", { name: "Next page (right area)", exact: true });
    expect(await next.evaluate(element => getComputedStyle(element).touchAction)).toBe("manipulation");
    await page.evaluate(() => Object.defineProperty(window.visualViewport!, "scale", { configurable: true, value: 2 }));
    try {
      await tapArea(page, "Next page (right area)");
      await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      await tapArea(page, "Show controls (center area)");
      await expect(page.getByRole("button", { name: "Hide controls", exact: true })).toBeVisible();
      await tapArea(page, "Hide controls (center area)");
    } finally {
      await page.evaluate(() => Reflect.deleteProperty(window.visualViewport!, "scale"));
    }
    await tapArea(page, "Next page (right area)");
    await expectSavedPage(page, endpoint, 2);
  } finally {
    await removeBook(page, endpoint);
  }
});

test("desktop keeps visible controls and keyboard navigation even at a narrow width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Requires a mouse context");
  await page.setViewportSize({ width: 390, height: 844 });
  const endpoint = await openBook(page);
  try {
    await expect(page.locator(".reader-root")).not.toHaveClass(/reader-touch/);
    await expect(page.getByRole("button", { name: /\((?:left|center|right) area\)/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
    await page.getByTestId("pdf-page").click();
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectSavedPage(page, endpoint, 2);
    await page.keyboard.press("ArrowRight");
    await expectSavedPage(page, endpoint, 3);
    await page.getByRole("button", { name: "Hide controls", exact: true }).click();
    await page.getByRole("button", { name: "Show controls", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
  } finally {
    await removeBook(page, endpoint);
  }
});
