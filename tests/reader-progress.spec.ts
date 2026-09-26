import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { revealReaderControls } from "./reader-helpers";

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

test("an expired session redirects to sign-in instead of trapping the reader in a failed save", async ({ page }) => {
  const book = await openBook(page);
  try {
    await page.context().clearCookies();
    const unauthorized = page.waitForResponse(response => response.url().endsWith(`${book.endpoint}/progress`) && response.status() === 401);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
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
