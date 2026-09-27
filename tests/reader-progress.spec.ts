import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { openReaderSettings, revealReaderControls } from "./reader-helpers";

async function openBook(page: Page) {
  const session = await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
  expect(session.ok()).toBe(true);
  const document = await PDFDocument.create();
  document.setTitle(`Progress regression ${Date.now()} ${Math.random()}`);
  for (let number = 1; number <= 4; number++) document.addPage([400, 600]);
  const response = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "reading-progress.pdf" },
    data: Buffer.from(await document.save()),
  });
  expect(response.status()).toBe(201);
  const { book } = await response.json();
  const endpoint = `/api/books/${book.id}`;
  const path = `/read/${book.id}`;
  await page.goto(path);
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
  await revealReaderControls(page);
  await expect(page.locator(".reader-save-status")).toHaveText("Saved");
  return { endpoint, path };
}

async function savedPage(page: Page, endpoint: string) {
  return (await (await page.request.get(endpoint)).json()).book.currentPage;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("library navigation waits for a delayed save and then saves the newest page", async ({ page }) => {
  const book = await openBook(page);
  const started = deferred();
  const release = deferred();
  await page.route(`**${book.endpoint}/progress`, async route => {
    if (route.request().postDataJSON().currentPage === 2) {
      started.resolve();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await started.promise;
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
    await expect(page.getByRole("link", { name: "Back to library", exact: true })).toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(new RegExp(`${book.path}$`));
    expect(await savedPage(page, book.endpoint)).toBe(1);
    release.resolve();
    await expect(page).toHaveURL("/");
    expect(await savedPage(page, book.endpoint)).toBe(3);
  } finally {
    release.resolve();
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" });
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

test("a failed save keeps the reader open and allows retrying the library navigation", async ({ page }) => {
  const book = await openBook(page);
  let offline = true;
  await page.route(`**${book.endpoint}/progress`, async route => {
    if (offline) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
    else await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
    const error = page.locator(".reader-root").getByRole("alert");
    await expect(error).toContainText("Your reading position could not be saved");
    await expect(page).toHaveURL(new RegExp(`${book.path}$`));
    expect(await savedPage(page, book.endpoint)).toBe(1);
    offline = false;
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page).toHaveURL("/");
    expect(await savedPage(page, book.endpoint)).toBe(2);
  } finally {
    offline = false;
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" });
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

test("a failed page keeps the visible reading position when changing direction and saves after retry", async ({ page }) => {
  const book = await openBook(page);
  let failPage = true;
  const positions: number[] = [];
  await page.route(`**${book.endpoint}/pages/4`, async route => {
    if (failPage) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
    else await route.continue();
  });
  await page.route(`**${book.endpoint}/progress`, async route => {
    positions.push(route.request().postDataJSON().currentPage);
    await route.continue();
  });
  try {
    // Page 4 is outside page 1's prefetched neighborhood.
    await page.getByRole("textbox", { name: "Page number", exact: true }).fill("4");
    await page.getByRole("textbox", { name: "Page number", exact: true }).press("Enter");
    const error = page.locator(".reader-workspace").getByRole("alert");
    await expect(error).toContainText("Unable to load this page");
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await openReaderSettings(page);
    await page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(book.endpoint)).json()).book.direction).toBe("rtl");
    expect(await savedPage(page, book.endpoint)).toBe(1);
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every(position => position === 1)).toBe(true);

    failPage = false;
    await error.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "4");
    await expect.poll(() => savedPage(page, book.endpoint)).toBe(4);
  } finally {
    failPage = false;
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" });
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

test("leaving while an uncached page loads saves only the page that was visible", async ({ page }) => {
  const book = await openBook(page);
  const started = deferred();
  const release = deferred();
  await page.route(`**${book.endpoint}/pages/4`, async route => {
    started.resolve();
    await release.promise;
    // Returning to the library aborts this unfinished image request.
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole("textbox", { name: "Page number", exact: true }).fill("4");
    await page.getByRole("textbox", { name: "Page number", exact: true }).press("Enter");
    await started.promise;
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
    await expect(page).toHaveURL("/");
    expect(await savedPage(page, book.endpoint)).toBe(1);
    await page.goto(book.path);
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
  } finally {
    release.resolve();
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" });
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

test("a page arriving during the library save does not replace or save the departure page", async ({ page }) => {
  const book = await openBook(page);
  const saveStarted = deferred();
  const releaseSave = deferred();
  const imageReady = deferred();
  const releaseImage = deferred();
  const positions: number[] = [];
  await page.route(`**${book.endpoint}/progress`, async route => {
    positions.push(route.request().postDataJSON().currentPage);
    saveStarted.resolve();
    await releaseSave.promise;
    await route.continue();
  });
  await page.route(`**${book.endpoint}/pages/4`, async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    imageReady.resolve();
    await releaseImage.promise;
    await route.fulfill({ response });
  });
  try {
    await openReaderSettings(page);
    await page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).click();
    await saveStarted.promise;
    await page.getByRole("textbox", { name: "Page number", exact: true }).fill("4");
    await page.getByRole("textbox", { name: "Page number", exact: true }).press("Enter");
    await imageReady.promise;
    await page.locator(".reader-back").click();
    await expect(page.locator(".reader-back")).toHaveAttribute("aria-busy", "true");

    const imageResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === `${book.endpoint}/pages/4` && response.ok());
    releaseImage.resolve();
    await (await imageResponse).finished();
    // Let the delivered image decode/render and the 450 ms save debounce elapse
    // while the original save still holds the reader on its departure snapshot.
    await page.waitForTimeout(600);
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await expect(page.locator(".reader-back")).toHaveAttribute("aria-busy", "true");
    expect(positions).toEqual([1]);

    releaseSave.resolve();
    await expect(page).toHaveURL("/");
    expect(await savedPage(page, book.endpoint)).toBe(1);
    expect(positions.every(position => position === 1)).toBe(true);
  } finally {
    releaseImage.resolve();
    releaseSave.resolve();
    await page.goto("about:blank").catch(() => {});
    await page.unrouteAll({ behavior: "wait" });
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

test("a book deleted while reading does not trap library navigation after a progress 404", async ({ page }) => {
  const book = await openBook(page);
  let deleted = false;
  let progressRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === `${book.endpoint}/progress`) progressRequests += 1;
  });
  try {
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
    deleted = true;
    const missingProgress = page.waitForResponse(response =>
      new URL(response.url()).pathname === `${book.endpoint}/progress` && response.status() === 404);
    await openReaderSettings(page);
    await page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).click();
    await missingProgress;
    await expect(page.getByText("This book is no longer in your library.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save failed. Retry", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reading direction: Right to left", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Page number", exact: true })).toBeDisabled();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    expect(progressRequests).toBe(1);
    await page.locator(".reader-back").click();
    await expect(page).toHaveURL("/");
    expect((await page.request.get(book.endpoint)).status()).toBe(404);
    expect(progressRequests).toBe(1);
  } finally {
    await page.goto("about:blank").catch(() => {});
    if (!deleted) expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

test("an expired session redirects from reading to sign-in and allows signing in again", async ({ page }) => {
  const book = await openBook(page);
  try {
    const unauthorized = page.waitForResponse(response => {
      const path = new URL(response.url()).pathname;
      return response.status() === 401 && (path === `${book.endpoint}/progress` || path.startsWith(`${book.endpoint}/pages/`));
    });
    await page.context().clearCookies();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    // Either the page image or the delayed progress save can discover expiry first.
    await unauthorized;
    await expect(page).toHaveURL("/");
    await expect(page.getByLabel("Library password")).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await page.getByLabel("Library password").fill("test-only-comic-shelf-passphrase");
    await page.getByRole("button", { name: "Open library", exact: true }).click();
    await expect(page.getByRole("link", { name: "Read reading-progress", exact: true })).toBeVisible();
  } finally {
    await page.goto("about:blank").catch(() => {});
    await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
    expect((await page.request.delete(book.endpoint)).status()).toBe(204);
  }
});

for (const exitEvent of ["pagehide", "visibilitychange"]) {
  test(`${exitEvent} immediately saves the latest page and ignores the late older request`, async ({ page }) => {
    const book = await openBook(page);
    const started = deferred();
    const release = deferred();
    const olderFinished = deferred();
    await page.route(`**${book.endpoint}/progress`, async route => {
      if (route.request().postDataJSON().currentPage === 2) {
        started.resolve();
        await release.promise;
        const response = await route.fetch();
        await route.fulfill({ response });
        olderFinished.resolve();
      } else {
        await route.continue();
      }
    });
    try {
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await started.promise;
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
      await page.evaluate(event => {
        if (event === "visibilitychange") {
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          window.dispatchEvent(new PageTransitionEvent("pagehide"));
        }
      }, exitEvent);
      await expect.poll(() => savedPage(page, book.endpoint)).toBe(3);
      release.resolve();
      await olderFinished.promise;
      expect(await savedPage(page, book.endpoint)).toBe(3);
    } finally {
      release.resolve();
      await page.goto("about:blank").catch(() => {});
      await page.unrouteAll({ behavior: "wait" });
      expect((await page.request.delete(book.endpoint)).status()).toBe(204);
    }
  });
}
