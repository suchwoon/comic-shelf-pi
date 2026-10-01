import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";

const tablet = { width: 820, height: 1180 };

async function openLongLibrary(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({
    // Chromium exercises mobile touch scrolling. WebKit's public wheel API
    // requires desktop mode; its tablet-width fallback is not native iPad coverage.
    baseURL, viewport: tablet, deviceScaleFactor: 2, hasTouch: true, isMobile: browser.browserType().name() === "chromium",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  try {
    const session = await page.request.post("/api/session", {
      data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
    });
    expect(session.ok()).toBe(true);
    // Real book cards and member rows provide genuine scrollable content.
    // Only list data is mocked; browser viewport and scrolling stay native.
    const books = Array.from({ length: 32 }, (_, index) => ({
      id: `scroll-fixture-${index}`, title: `Scroll fixture ${String(index + 1).padStart(2, "0")}`,
      originalName: "scroll.pdf", size: 1024, pageCount: 3, currentPage: 1,
      direction: "rtl", fit: "page", createdAt: "2026-01-01T00:00:00.000Z", lastReadAt: null,
    }));
    await page.route("**/api/books", route => route.fulfill({
      json: { books, totalBytes: books.length * 1024, maxUploadBytes: 16 * 1024 * 1024 },
    }));
    await page.route("**/api/books/scroll-fixture-*/cover", route => route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#d6dedf"/></svg>',
    }));
    await page.route("**/api/admin/users", route => route.fulfill({
      json: { users: Array.from({ length: 24 }, (_, index) => ({
        id: `scroll-member-${index}`, username: `Scroll reader ${index + 1}`, role: "reader",
        createdAt: "2026-01-01T00:00:00.000Z", disabled: false,
      })) },
    }));
    await page.route("**/api/admin/invitations", route => route.fulfill({ json: { invitations: [] } }));
    await page.goto("/");
    await expect(page.locator(".shelf-book-card")).toHaveCount(books.length);
    await expect(page.getByRole("button", { name: "Open chat", exact: true })).toBeVisible();
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function shelfTop(page: Page) {
  return page.locator(".shelf-book-card").first().evaluate(element => element.getBoundingClientRect().top);
}

async function expectShelfAt(page: Page, top: number) {
  expect(Math.abs(await shelfTop(page) - top)).toBeLessThanOrEqual(1);
}

async function swipe(page: Page, x: number, fromY: number, toY: number, observe?: () => Promise<void>, shouldCancel?: boolean) {
  const chromium = page.context().browser()!.browserType().name() === "chromium";
  const session = chromium ? await page.context().newCDPSession(page) : undefined;
  const observation = session && shouldCancel !== undefined ? await page.evaluateHandle(() => {
    const moves: { trusted: boolean; cancelable: boolean; prevented: boolean }[] = [];
    const record = (event: TouchEvent) => moves.push({
      trusted: event.isTrusted, cancelable: event.cancelable, prevented: event.defaultPrevented,
    });
    // Observe after the dialog's handler without changing browser behavior.
    window.addEventListener("touchmove", record, { passive: true });
    return { moves, stop: () => window.removeEventListener("touchmove", record) };
  }) : undefined;
  try {
    if (session) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart", touchPoints: [{ x, y: fromY, id: 1 }],
      });
    } else {
      // Public Playwright APIs cannot perform a native WebKit touch drag.
      // Wheel input still verifies actual scrolling and boundary chaining.
      await page.mouse.move(x, fromY);
    }
    for (let step = 1; step <= 8; step++) {
      if (session) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove", touchPoints: [{ x, y: fromY + (toY - fromY) * step / 8, id: 1 }],
        });
      } else {
        await page.mouse.wheel(0, (fromY - toY) / 8);
      }
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      await observe?.();
    }
    if (session) await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
    await observe?.();
    if (observation) {
      const moves = await observation.evaluate(value => value.moves);
      expect(moves.some(move => move.trusted)).toBe(true);
      if (shouldCancel) expect(moves.some(move => move.trusted && move.cancelable && move.prevented)).toBe(true);
      else expect(moves.some(move => move.prevented)).toBe(false);
    }
  } finally {
    if (observation) {
      await observation.evaluate(value => value.stop());
      await observation.dispose();
    }
    await session?.detach();
  }
}

async function touchMoveCanceled(target: Locator, distance: number, { fingers = 1, backdrop = false, horizontal = false }: { fingers?: number; backdrop?: boolean; horizontal?: boolean } = {}) {
  return target.evaluate((element, { distance, fingers, backdrop, horizontal }) => {
    const bounds = element.getBoundingClientRect();
    const touches = (offset: number) => Array.from({ length: fingers }, (_, index) => new Touch({
      identifier: index + 1, target: element,
      clientX: (backdrop ? bounds.left - 24 : bounds.left + bounds.width / 2) + index * 8 + (horizontal ? offset : 0),
      clientY: bounds.top + bounds.height / 2 + (horizontal ? 0 : offset),
    }));
    const start = touches(0);
    element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: start, changedTouches: start }));
    const moved = touches(distance);
    const move = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: moved, changedTouches: moved });
    element.dispatchEvent(move);
    let canceled = move.defaultPrevented;
    if (fingers > 1) {
      const remaining = [moved[0]];
      element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: remaining, changedTouches: moved.slice(1) }));
      const continued = [touches(distance * 1.5)[0]];
      const finish = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: continued, changedTouches: continued });
      element.dispatchEvent(finish);
      canceled ||= finish.defaultPrevented;
    }
    element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: moved }));
    return canceled;
  }, { distance, fingers, backdrop, horizontal });
}

test("tablet account modal scrolls its contents without moving the library at its boundaries", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  const { context, page } = await openLongLibrary(browser, baseURL);
  try {
    const initialTop = await shelfTop(page);
    await swipe(page, 410, 900, 540);
    expect(initialTop - await shelfTop(page)).toBeGreaterThan(100);
    const backgroundTop = await shelfTop(page);
    const unchanged = () => expectShelfAt(page, backgroundTop);
    // Open without Playwright scrolling the off-screen header into view;
    // this specifically verifies preserving a nonzero library position.
    await page.getByRole("button", { name: "Account settings", exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    const dialog = page.getByRole("dialog", { name: "Account settings", exact: true });
    await expect(dialog).toBeVisible();
    await unchanged();
    expect(await dialog.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    let bounds = (await dialog.boundingBox())!;
    await swipe(page, bounds.x + 12, bounds.y + bounds.height * 0.7, bounds.y + bounds.height * 0.3, unchanged, true);
    await swipe(page, bounds.x / 2, 850, 450, unchanged, true);
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Manage members", exact: true }).tap();
    await expect(dialog.locator(".shelf-account-list > li")).toHaveCount(24);
    await expect.poll(() => dialog.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300);
    bounds = (await dialog.boundingBox())!;
    const x = bounds.x + 50;
    const high = bounds.y + bounds.height * 0.3;
    const low = bounds.y + bounds.height * 0.7;
    await swipe(page, x, low, high, unchanged, false);
    expect(await dialog.evaluate(element => element.scrollTop)).toBeGreaterThan(100);

    await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const bottom = await dialog.evaluate(element => element.scrollTop);
    await swipe(page, x, low, high, unchanged, true);
    expect(await dialog.evaluate(element => element.scrollTop)).toBeCloseTo(bottom, 0);
    await dialog.evaluate(element => { element.scrollTop = 0; });
    await swipe(page, x, high, low, unchanged, true);
    expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
    await dialog.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
    const middle = await dialog.evaluate(element => element.scrollTop);
    await swipe(page, bounds.x / 2, low, high, unchanged, true);
    // Only the native touch path exercises the touch guard. WebKit's wheel
    // fallback may scroll the modal here, while the library must stay still.
    if (browser.browserType().name() === "chromium") {
      expect(await dialog.evaluate(element => element.scrollTop)).toBeCloseTo(middle, 0);
    }
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("tablet-account-scroll-contained.png") });

    await dialog.evaluate(element => { element.scrollTop = 0; });
    await dialog.getByRole("button", { name: "Close account settings", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await unchanged();
    await swipe(page, 410, 900, 540);
    expect(backgroundTop - await shelfTop(page)).toBeGreaterThan(100);
  } finally {
    await context.close();
  }
});

test("modal touch cancellation preserves inputs, pinch, and scrolling toward available content", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  const { context, page } = await openLongLibrary(browser, baseURL);
  try {
    test.skip(!await page.evaluate(() => {
      try {
        const touch = new Touch({ identifier: 1, target: document.body });
        return new TouchEvent("touchmove", { touches: [touch] }).touches.length === 1;
      } catch { return false; }
    }), "Touch event constructors are unavailable");
    await page.getByRole("button", { name: "Account settings", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "Account settings", exact: true });
    await expect(dialog).toBeVisible();
    // These are cancellation contracts, not a simulation of iPad rubber-band
    // rendering. The test above separately exercises actual browser scrolling.
    for (const distance of [-40, 40]) expect(await touchMoveCanceled(dialog, distance)).toBe(true);
    const description = dialog.locator(".shelf-account-description");
    await description.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    expect(await touchMoveCanceled(description, -40)).toBe(false);
    expect(await touchMoveCanceled(dialog.getByRole("heading", { name: "Account settings", exact: true }), -40)).toBe(true);
    expect(await touchMoveCanceled(dialog, -40, { backdrop: true })).toBe(true);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    const password = dialog.getByLabel("Current password", { exact: true });
    await password.fill("unfinished-password");
    await password.evaluate(element => (element as HTMLInputElement).setSelectionRange(19, 19));
    expect(await touchMoveCanceled(password, -40)).toBe(true);
    expect(await touchMoveCanceled(password, -40, { horizontal: true })).toBe(false);
    await password.evaluate(element => (element as HTMLInputElement).setSelectionRange(0, 5));
    expect(await touchMoveCanceled(password, -40)).toBe(false);
    await password.evaluate(element => (element as HTMLInputElement).setSelectionRange(19, 19));
    const timedDrags = await password.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      let startedAt = performance.now();
      const send = (type: string, elapsed: number, offset: number) => {
        const touch = new Touch({ identifier: 1, target: element, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 + offset });
        const touches = type === "touchend" ? [] : [touch];
        const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [touch] });
        // Deterministic gesture timing; no browser viewport values are mocked.
        Object.defineProperty(event, "timeStamp", { value: startedAt + elapsed });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const drag = (firstMoveAt: number) => {
        send("touchstart", 0, 0);
        const canceled = [send("touchmove", firstMoveAt, -40), send("touchmove", firstMoveAt + 600, -80)];
        send("touchend", firstMoveAt + 601, -80);
        startedAt += 2000;
        return canceled;
      };
      return { continuous: drag(100), stationaryHold: drag(600) };
    });
    expect(timedDrags).toEqual({ continuous: [true, true], stationaryHold: [false, false] });
    expect(await touchMoveCanceled(dialog, -40, { fingers: 2, backdrop: true })).toBe(false);
    expect(await touchMoveCanceled(dialog, -40, { backdrop: true })).toBe(true);

    if (browser.browserType().name() === "chromium") {
      const session = await context.newCDPSession(page);
      try {
        await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
        await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(2);
        expect(await touchMoveCanceled(dialog, -40, { backdrop: true })).toBe(false);
      } finally {
        await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
        await session.detach();
      }
    }

    await dialog.getByRole("button", { name: "Manage members", exact: true }).tap();
    await expect(dialog.locator(".shelf-account-list > li")).toHaveCount(24);
    await expect.poll(() => dialog.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300);
    await dialog.evaluate(element => { element.scrollTop = 0; });
    expect(await touchMoveCanceled(dialog, 40)).toBe(true);
    expect(await touchMoveCanceled(dialog, -40)).toBe(false);
    await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await touchMoveCanceled(dialog, -40)).toBe(true);
    expect(await touchMoveCanceled(dialog, 40)).toBe(false);
    await dialog.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
    for (const distance of [-40, 40]) {
      expect(await touchMoveCanceled(dialog, distance)).toBe(false);
      expect(await touchMoveCanceled(dialog, distance, { backdrop: true })).toBe(true);
    }
  } finally {
    await context.close();
  }
});

test("closing one of two dialogs keeps the library locked until the last dialog closes", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  const { context, page } = await openLongLibrary(browser, baseURL);
  try {
    await swipe(page, 410, 900, 540);
    await page.getByLabel("Manage Scroll fixture 08", { exact: true }).click();
    const backgroundTop = await shelfTop(page);
    const unchanged = () => expectShelfAt(page, backgroundTop);
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename book", exact: true });
    await expect(rename).toBeVisible();
    await unchanged();

    // Exercise independent lock owners: normal modal input makes the header
    // inert, so dispatch only the second opening programmatically.
    await page.getByRole("button", { name: "Account settings", exact: true, includeHidden: true }).evaluate(button => (button as HTMLButtonElement).click());
    const account = page.getByRole("dialog", { name: "Account settings", exact: true });
    await expect(account).toBeVisible();
    await unchanged();
    await account.getByRole("button", { name: "Close account settings", exact: true }).tap();
    await expect(account).toHaveCount(0);
    await expect(rename).toBeVisible();
    await swipe(page, 12, 850, 450, unchanged, true);
    await expect(rename).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(rename).toHaveCount(0);
    await unchanged();
    await swipe(page, 410, 900, 540);
    expect(backgroundTop - await shelfTop(page)).toBeGreaterThan(100);
  } finally {
    await context.close();
  }
});

test("tablet chat launcher stays at the visible bottom edge while the library scrolls", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses its own tablet context");
  const { context, page } = await openLongLibrary(browser, baseURL);
  try {
    const launcher = page.getByRole("button", { name: "Open chat", exact: true });
    const insets = () => launcher.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const viewport = window.visualViewport!;
      return { bottom: viewport.offsetTop + viewport.height - bounds.bottom, right: viewport.offsetLeft + viewport.width - bounds.right };
    });
    const initial = await insets();
    const initialTop = await shelfTop(page);
    const anchored = async () => {
      const current = await insets();
      expect(Math.abs(current.bottom - initial.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(current.right - initial.right)).toBeLessThanOrEqual(1);
    };
    await swipe(page, 410, 900, 540, anchored);
    expect(initialTop - await shelfTop(page)).toBeGreaterThan(100);
    await swipe(page, 410, 540, 900, anchored);
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect.poll(insets).toEqual(initial);
    await swipe(page, 500, 650, 300, anchored);
    await launcher.tap();
    await expect(page.getByRole("dialog", { name: "Chat", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
