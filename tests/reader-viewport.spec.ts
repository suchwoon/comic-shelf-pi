import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, rgb } from "pdf-lib";
import { hideReaderControls, revealReaderControls } from "./reader-helpers";

const portrait = { width: 820, height: 1180 };

async function openTabletBook(browser: Browser, baseURL: string | undefined, retainLibraryHeight = false, initializePage?: (page: Page) => Promise<void>) {
  const context = await browser.newContext({
    baseURL,
    viewport: portrait,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  let endpoint: string | undefined;
  try {
    await initializePage?.(page);
    const session = await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
    expect(session.ok()).toBe(true);
    const pdf = await PDFDocument.create();
    pdf.setSubject(`Tablet viewport regression ${Date.now()} ${Math.random()}`);
    for (let number = 1; number <= 3; number++) {
      const sheet = pdf.addPage([400, 600]);
      sheet.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0.9, 0.92, number / 4) });
      // Full-width edge markers reveal clipping even when the reader backdrop
      // hides an uncovered part of the visible viewport.
      sheet.drawRectangle({ x: 0, y: 594, width: 400, height: 6, color: rgb(1, 0, 0) });
      sheet.drawRectangle({ x: 0, y: 0, width: 400, height: 6, color: rgb(0, 0, 1) });
    }
    const response = await page.request.post("/api/books", {
      headers: { "Content-Type": "application/pdf", "X-File-Name": "reader-viewport.pdf" },
      data: Buffer.from(await pdf.save()),
    });
    expect(response.status()).toBe(201);
    const { book } = await response.json();
    endpoint = `/api/books/${book.id}`;
    if (retainLibraryHeight) {
      await page.goto("/");
      // Keep genuine document overflow across the client-side route change,
      // as can happen when entering the fixed reader from a long library.
      await page.evaluate(() => {
        const retained = document.createElement("div");
        retained.id = "retained-library-height";
        retained.style.height = "300vh";
        document.body.append(retained);
        window.scrollTo(0, 240);
      });
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
      await page.locator(`.shelf-book-link[href="/read/${book.id}"]`).click();
      await expect(page.locator("#retained-library-height")).toHaveCount(1);
    } else {
      await page.goto(`/read/${book.id}`);
    }
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1", { timeout: 40_000 });
    await expect(page.locator(".reader-root")).toHaveClass(/reader-touch/);
    await expect(page.locator(".reader-page-surface")).toHaveAttribute("aria-busy", "false");
    return { context, page, endpoint };
  } catch (error) {
    if (endpoint) await page.request.delete(endpoint).catch(() => {});
    await context.close();
    throw error;
  }
}

async function expectViewportFilled(page: Page, visibleHeight?: number, visibleTop = 0) {
  await expect.poll(() => page.locator(".reader-root").evaluate((reader, { expectedHeight, expectedTop }) => {
    const bounds = reader.getBoundingClientRect();
    const canvas = reader.querySelector("canvas")!.getBoundingClientRect();
    const heightTolerance = expectedHeight === undefined ? 1 : 0.1;
    return scrollX === 0 && scrollY === 0
      && Math.abs(bounds.top - expectedTop) <= heightTolerance && Math.abs(bounds.left) <= 1
      && Math.abs(bounds.bottom - (expectedTop + (expectedHeight ?? innerHeight))) <= heightTolerance && Math.abs(bounds.right - innerWidth) <= 1
      && canvas.width > 0 && canvas.height > 0
      && (expectedHeight === undefined || Math.abs(canvas.height - expectedHeight) < 2)
      && canvas.top >= bounds.top - 1 && canvas.left >= bounds.left - 1
      && canvas.bottom <= bounds.bottom + 1 && canvas.right <= bounds.right + 1;
  }, { expectedHeight: visibleHeight, expectedTop: visibleTop })).toBe(true);
}

async function swipeVertically(page: Page) {
  const session = await page.context().newCDPSession(page);
  const { width, height } = page.viewportSize()!;
  const x = Math.round(width / 2);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y: Math.round(height * 0.7), id: 1 }],
    });
    for (let step = 1; step <= 6; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x, y: Math.round(height * (0.7 - step * 0.05)), id: 1 }],
      });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // The reported gap persists after release; also check once inertial
    // scrolling would have had time to move the document.
    await page.waitForTimeout(300);
  } finally {
    await session.detach();
  }
}

async function touchMovePrevented(target: Locator, fingers = 1) {
  return target.evaluate((element, count) => {
    const bounds = element.getBoundingClientRect();
    const touches = (offset: number) => Array.from({ length: count }, (_, index) => new Touch({
      identifier: index + 1, target: element,
      clientX: bounds.x + bounds.width / 2 + index * 12,
      clientY: bounds.y + bounds.height / 2 + offset,
    }));
    const start = touches(0);
    element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: start, targetTouches: start, changedTouches: start }));
    const moved = touches(-30);
    const move = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: moved, targetTouches: moved, changedTouches: moved });
    element.dispatchEvent(move);
    let prevented = move.defaultPrevented;
    if (count > 1) {
      // Lifting one finger must not turn the rest of a pinch into a blocked pan.
      const remaining = [moved[0]];
      element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: remaining, targetTouches: remaining, changedTouches: moved.slice(1) }));
      const finishPinch = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: remaining, targetTouches: remaining, changedTouches: remaining });
      element.dispatchEvent(finishPinch);
      prevented ||= finishPinch.defaultPrevented;
    }
    element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: moved }));
    return prevented;
  }, fingers);
}

test("reader is dark and document scrolling is locked before hydration", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "CSS behavior is independent of the device profile");
  await page.setViewportSize(portrait);
  let blockedScripts = 0;
  await page.route(url => url.pathname.startsWith("/_next/") && url.pathname.endsWith(".js"), route => {
    blockedScripts++;
    return route.abort();
  });
  await page.goto("/read/test-placeholder");
  await expect(page.locator(".reader-root")).toBeVisible();
  expect(blockedScripts).toBeGreaterThan(0);
  for (const selector of ["html", "body"]) {
    await expect(page.locator(selector)).toHaveCSS("background-color", "rgb(20, 20, 20)");
    await expect(page.locator(selector)).toHaveCSS("overflow", "hidden");
  }
  await expect(page.locator("body")).toHaveCSS("position", "fixed");
  await page.evaluate(() => {
    const retained = document.createElement("div");
    retained.style.height = "300vh";
    document.body.append(retained);
    window.scrollTo(0, 240);
  });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
});

test("reader follows the unzoomed visual viewport while preserving its layout during pinch zoom", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  // Simulates viewport events without native browser chrome; real iPad behavior
  // still needs a device check.
  const initialHeight = 1100.5;
  const { context, page, endpoint } = await openTabletBook(browser, baseURL, false, async page => {
    await page.addInitScript(height => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: height },
        scale: { configurable: true, value: 1 },
      });
    }, initialHeight);
  });
  const setVisibleViewport = (height: number, scale = 1) => page.evaluate(({ height, scale }) => {
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: height },
      scale: { configurable: true, value: scale },
    });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, { height, scale });
  try {
    const layoutHeight = await page.evaluate(() => innerHeight);
    await expectViewportFilled(page, initialHeight);
    await setVisibleViewport(1016.25);
    await expectViewportFilled(page, 1016.25);

    await setVisibleViewport(508.125, 2);
    // Allow scheduled measurements to run before checking that zoom did not
    // shrink the reader or rerender the page at half its previous size.
    await page.waitForTimeout(300);
    await expectViewportFilled(page, 1016.25);

    await setVisibleViewport(1072.75);
    await expectViewportFilled(page, 1072.75);
    expect(await page.evaluate(() => innerHeight)).toBe(layoutHeight);
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
  } finally {
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(endpoint)).status()).toBe(204);
    await context.close();
  }
});

test("tablet reader follows visible viewport offsets when first opening a book from the shelf", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  const initialViewport = { height: 1002, offsetTop: 178 };
  const { context, page, endpoint } = await openTabletBook(browser, baseURL, true, async page => {
    await page.addInitScript(({ height, offsetTop }) => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
        scale: { configurable: true, value: 1 },
      });
    }, initialViewport);
  });
  const setVisibleViewport = (height: number, offsetTop: number, scale = 1, event: "resize" | "scroll" = "resize") => page.evaluate(({ height, offsetTop, scale, event }) => {
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: height },
      offsetTop: { configurable: true, value: offsetTop },
      scale: { configurable: true, value: scale },
    });
    window.visualViewport!.dispatchEvent(new Event(event));
  }, { height, offsetTop, scale, event });
  try {
    const layoutHeight = await page.evaluate(() => innerHeight);
    await expectViewportFilled(page, initialViewport.height, initialViewport.offsetTop);

    // Browser chrome can pan the visible area without changing its height.
    await setVisibleViewport(1002, 90.25, 1, "scroll");
    await expectViewportFilled(page, 1002, 90.25);

    await setVisibleViewport(501, 260, 2);
    await setVisibleViewport(501, 310, 2, "scroll");
    await page.waitForTimeout(300);
    await expectViewportFilled(page, 1002, 90.25);

    await setVisibleViewport(900.5, 140.25);
    await expectViewportFilled(page, 900.5, 140.25);
    // A keyboard can shrink and move the visible rectangle together.
    await setVisibleViewport(620, 560);
    await expectViewportFilled(page, 620, 560);
    await setVisibleViewport(portrait.height, 0);
    await expectViewportFilled(page, portrait.height);
    expect(await page.evaluate(() => innerHeight)).toBe(layoutHeight);
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
  } finally {
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(endpoint)).status()).toBe(204);
    await context.close();
  }
});

test("tablet reader keeps both PDF edge markers visible in an offset browser viewport", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile" || browser.browserType().name() !== "chromium", "Uses a tablet context and Chromium's render viewport override");
  const visibleViewport = { height: 1002, offsetTop: 178 };
  const { context, page, endpoint } = await openTabletBook(browser, baseURL, false, async page => {
    await page.addInitScript(({ height, offsetTop }) => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
        scale: { configurable: true, value: 1 },
      });
    }, visibleViewport);
  });
  const session = await context.newCDPSession(page);
  let screenshot: Buffer | undefined;
  try {
    // CDP shifts actual rendered pixels without changing layout coordinates.
    // It does not expose that crop through visualViewport, hence the matching
    // metric overrides above. This models clipping, not native iPad chrome.
    await session.send("Emulation.setDeviceMetricsOverride", {
      ...portrait, deviceScaleFactor: 1, mobile: true,
      viewport: { x: 0, y: visibleViewport.offsetTop, width: portrait.width, height: visibleViewport.height, scale: 1 },
    });
    await expect.poll(async () => {
      const captured = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const image = await loadImage(Buffer.from(captured.data, "base64"));
      const visible = createCanvas(portrait.width, visibleViewport.height);
      const pixels = visible.getContext("2d");
      // The CDP image retains the full display's height. Only the first
      // visualViewport.height pixels represent the simulated visible area.
      const ratio = image.width / portrait.width;
      pixels.drawImage(image, 0, 0, image.width, visibleViewport.height * ratio, 0, 0, portrait.width, visibleViewport.height);
      screenshot = visible.toBuffer("image/png");
      const matches = (y: number, color: number[]) => {
        const actual = pixels.getImageData(portrait.width / 2, y, 1, 1).data;
        return color.every((channel, index) => Math.abs(actual[index] - channel) <= 6);
      };
      return { top: matches(4, [255, 0, 0]), bottom: matches(visibleViewport.height - 5, [0, 0, 255]) };
    }).toEqual({ top: true, bottom: true });
    expect(await page.evaluate(() => scrollY)).toBe(0);
  } finally {
    if (screenshot) await testInfo.attach("offset-visible-viewport", { body: screenshot, contentType: "image/png" });
    await session.detach();
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(endpoint)).status()).toBe(204);
    await context.close();
  }
});

test("tablet reader contains document scrolling through rotation and restores the library", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  const { context, page, endpoint } = await openTabletBook(browser, baseURL, true);
  try {
    for (const viewport of [portrait, { width: 1180, height: 820 }, { width: 1180, height: 740 }, portrait]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 240));
      await expectViewportFilled(page);
      if (browser.browserType().name() === "chromium") {
        await swipeVertically(page);
        await expectViewportFilled(page);
      }
      await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      await revealReaderControls(page);
      const input = page.getByRole("textbox", { name: "Page number", exact: true });
      expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await expectViewportFilled(page);
      await hideReaderControls(page);
      await expectViewportFilled(page);
    }
    await revealReaderControls(page);
    const input = page.getByRole("textbox", { name: "Page number", exact: true });
    await input.tap();
    await expect(input).toBeFocused();
    await input.fill("2");
    await input.press("Enter");
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
    await expectViewportFilled(page);
    await page.screenshot({ path: testInfo.outputPath("reader-tablet-viewport.png") });

    await page.getByRole("link", { name: "Back to library", exact: true }).tap();
    await expect(page.locator(".reader-root")).toHaveCount(0);
    await expect(page.locator("#retained-library-height")).toHaveCount(1);
    await page.evaluate(() => window.scrollTo(0, 240));
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  } finally {
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(endpoint)).status()).toBe(204);
    await context.close();
  }
});

test("tablet swipes cannot pan the unzoomed reader while pinch, zoomed pan, and input gestures remain available", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  const { context, page, endpoint } = await openTabletBook(browser, baseURL);
  try {
    const center = page.getByRole("button", { name: "Show controls (center area)", exact: true });
    expect(await touchMovePrevented(center)).toBe(true);
    expect(await touchMovePrevented(center, 2)).toBe(false);
    expect(await touchMovePrevented(page.getByTestId("pdf-page"))).toBe(true);
    await revealReaderControls(page);
    const toggle = page.getByRole("button", { name: "Two-page view", exact: true });
    expect(await touchMovePrevented(toggle)).toBe(true);
    expect(await touchMovePrevented(page.locator(".reader-pagination"))).toBe(true);
    expect(await touchMovePrevented(page.getByRole("textbox", { name: "Page number", exact: true }))).toBe(false);

    await page.evaluate(() => Object.defineProperty(window.visualViewport!, "scale", { configurable: true, value: 2 }));
    try {
      expect(await touchMovePrevented(page.getByRole("button", { name: "Hide controls (center area)", exact: true }))).toBe(false);
      expect(await touchMovePrevented(toggle)).toBe(false);
    } finally {
      await page.evaluate(() => Reflect.deleteProperty(window.visualViewport!, "scale"));
    }
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await hideReaderControls(page);
    await page.getByRole("button", { name: "Next page (left area)", exact: true }).tap();
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
  } finally {
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(endpoint)).status()).toBe(204);
    await context.close();
  }
});
