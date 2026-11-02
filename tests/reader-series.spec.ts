import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PDFDocument, rgb } from "pdf-lib";
import type { Book } from "../lib/types";
import { hideReaderControls, revealReaderControls } from "./reader-helpers";

interface UploadedBooks { ids: Set<string>; titles: Set<string> }

const test = base.extend<{ uploadedBooks: UploadedBooks }>({
  uploadedBooks: [async ({ request }, use) => {
    const books: UploadedBooks = { ids: new Set(), titles: new Set() };
    await use(books);
    // Independent API cleanup still runs when a browser action exhausts the test timeout.
    await login(request);
    const failures: unknown[] = [];
    try {
      const response = await request.get("/api/books", { timeout: 10_000 });
      expect(response.status()).toBe(200);
      for (const book of (await response.json()).books as Book[]) {
        if (books.titles.has(book.title)) books.ids.add(book.id);
      }
    } catch (error) { failures.push(error); }
    for (const id of books.ids) {
      try {
        expect([204, 404]).toContain((await request.delete(`/api/books/${id}`, { timeout: 10_000 })).status());
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Could not remove reader series fixtures.");
  }, { auto: true, timeout: 45_000 }],
});

async function login(request: APIRequestContext) {
  const response = await request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" }, timeout: 10_000,
  });
  expect(response.status()).toBe(200);
}

async function upload(request: APIRequestContext, title: string, books: UploadedBooks, pageCount = 4) {
  books.titles.add(title);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} ${randomUUID()}`);
  for (let index = 0; index < pageCount; index++) {
    pdf.addPage([400, 600]).drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0.85, 0.9, 0.7 + index * 0.04) });
  }
  const response = await request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(`${title}.pdf`) },
    data: Buffer.from(await pdf.save()),
  });
  expect(response.status()).toBe(201);
  const book = (await response.json()).book as Book;
  books.ids.add(book.id);
  return book;
}

async function getBook(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/books/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).book as Book;
}

async function expectPages(page: Page, numbers: number[]) {
  await expect.poll(() => page.getByTestId("pdf-page").evaluateAll(canvases =>
    canvases.map(canvas => Number((canvas as HTMLCanvasElement).dataset.page)).sort((a, b) => a - b),
  )).toEqual(numbers);
  await expect(page.locator(".reader-page-surface")).toHaveAttribute("aria-busy", "false");
}

async function jumpToPage(page: Page, number: number) {
  await page.getByRole("textbox", { name: "Page number", exact: true }).fill(String(number));
  await page.getByRole("textbox", { name: "Page number", exact: true }).press("Enter");
}

async function expectControlsFit(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  for (const control of [
    page.getByRole("combobox", { name: "Choose installment", exact: true }),
    page.getByRole("button", { name: /^Next (?:chapter|volume|installment):/ }),
  ]) {
    await expect(control).toBeVisible();
    const bounds = (await control.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("reader switches within the ordered series, resumes the next available volume, and returns after the last", async ({ page, uploadedBooks }, testInfo) => {
  await login(page.request);
  const name = `Reader sequence ${randomUUID().slice(0, 8)}`;
  const tenth = await upload(page.request, `${name} Vol. 10`, uploadedBooks);
  const second = await upload(page.request, `${name} Vol. 2`, uploadedBooks);
  const first = await upload(page.request, `${name} Vol. 1`, uploadedBooks);
  const unrelated = await upload(page.request, `Other series ${randomUUID().slice(0, 8)} Vol. 3`, uploadedBooks, 1);
  expect((await page.request.patch(`/api/books/${tenth.id}/progress`, { data: { currentPage: 2 } })).status()).toBe(200);
  await page.goto(`/read/${first.id}`);
  await expectPages(page, [1]);
  await revealReaderControls(page);
  const selector = page.getByRole("combobox", { name: "Choose installment", exact: true });
  await expect(selector).toHaveValue(first.id);
  await expect(selector.locator("option")).toHaveCount(3);
  expect(await selector.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual([first.id, second.id, tenth.id]);
  await expect(selector.locator("option")).toHaveText([/Volume 1(?:\D|$)/, /Volume 2(?:\D|$)/, /Volume 10(?:\D|$)/]);
  await expect(page.getByRole("button", { name: /^Next volume:/ })).toHaveCount(0);

  await jumpToPage(page, 2);
  await expectPages(page, [2]);
  await selector.selectOption(second.id);
  await expect(page).toHaveURL(new RegExp(`/read/${second.id}$`));
  await expectPages(page, [1]);
  expect((await getBook(page.request, first.id)).currentPage).toBe(2);
  await revealReaderControls(page);
  await jumpToPage(page, 4);
  await expectPages(page, [4]);
  const next = page.getByRole("button", { name: `Next volume: ${tenth.title}`, exact: true });
  await expect(next).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  // Page-turn gestures at the boundary must never cross into another book.
  await page.getByLabel("Comic page", { exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  const surface = await page.locator(".reader-page-surface").boundingBox();
  await page.mouse.move(surface!.x + surface!.width / 2, surface!.y + surface!.height / 2);
  await page.mouse.wheel(0, 300);
  await expectPages(page, [4]);
  await expect(page).toHaveURL(new RegExp(`/read/${second.id}$`));
  await expectControlsFit(page);
  await page.screenshot({ path: testInfo.outputPath("next-volume.png"), fullPage: true, animations: "disabled" });
  await next.click();
  await expect(page).toHaveURL(new RegExp(`/read/${tenth.id}$`));
  await expectPages(page, [2]);
  expect((await getBook(page.request, second.id)).currentPage).toBe(4);
  await revealReaderControls(page);
  await jumpToPage(page, 4);
  await expectPages(page, [4]);
  await expect(page.getByRole("button", { name: /^Next (?:chapter|volume|installment):/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to series list", exact: true }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:3210/?series=${first.seriesId}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();

  // A book removed from a series must return to the ordinary reader UI.
  expect((await page.request.patch(`/api/books/${unrelated.id}`, { data: { seriesTitle: null } })).status()).toBe(200);
  await page.goto(`/read/${unrelated.id}`);
  await expectPages(page, [1]);
  await revealReaderControls(page);
  await expect(page.getByRole("combobox", { name: "Choose installment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Next (?:chapter|volume|installment):/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to series list", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to library", exact: true })).toBeVisible();
});

test("a delayed failed save keeps the selected chapter target for navigation retry", async ({ page, uploadedBooks }) => {
  await login(page.request);
  const name = `Chapter save ${randomUUID().slice(0, 8)}`;
  const first = await upload(page.request, `${name} Chapter 1`, uploadedBooks);
  const second = await upload(page.request, `${name} Chapter 2`, uploadedBooks);
  await page.goto(`/read/${first.id}`);
  await expectPages(page, [1]);
  await revealReaderControls(page);
  await expect(page.locator(".reader-save-status")).toHaveText("Saved");
  const release = deferred();
  let saveStarted = false;
  let offline = true;
  await page.route(`**/api/books/${first.id}/progress`, async route => {
    if (route.request().postDataJSON().currentPage === 2 && offline) {
      saveStarted = true;
      await release.promise;
    }
    if (offline) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
    else await route.continue();
  });
  try {
    await jumpToPage(page, 2);
    await expectPages(page, [2]);
    await expect.poll(() => saveStarted).toBe(true);
    await jumpToPage(page, 3);
    await expectPages(page, [3]);
    const selector = page.getByRole("combobox", { name: "Choose installment", exact: true });
    await selector.selectOption(second.id);
    await expect(selector).toBeDisabled();
    await expect(page).toHaveURL(new RegExp(`/read/${first.id}$`));
    expect((await getBook(page.request, first.id)).currentPage).toBe(1);
    release.resolve();
    const error = page.locator(".reader-root").getByRole("alert");
    await expect(error).toContainText("Your reading position could not be saved");
    await expect(page).toHaveURL(new RegExp(`/read/${first.id}$`));
    offline = false;
    await error.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/read/${second.id}$`));
    await expectPages(page, [1]);
    expect((await getBook(page.request, first.id)).currentPage).toBe(3);
    await revealReaderControls(page);
    await expect(page.getByRole("combobox", { name: "Choose installment", exact: true })).toHaveValue(second.id);
  } finally {
    offline = false;
    release.resolve();
    await page.unrouteAll({ behavior: "wait" }).catch(() => undefined);
  }
});

test("the next-chapter action waits for the complete final spread and can be hidden again", async ({ page, uploadedBooks }, testInfo) => {
  await login(page.request);
  const name = `Final spread ${randomUUID().slice(0, 8)}`;
  const first = await upload(page.request, `${name} Chapter 1`, uploadedBooks, 5);
  const second = await upload(page.request, `${name} Chapter 2`, uploadedBooks);
  const release = deferred();
  let finalPageRequested = false;
  await page.route(`**/api/books/${first.id}/pages/5`, async route => {
    const response = await route.fetch();
    finalPageRequested = true;
    await release.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.goto(`/read/${first.id}`);
    await expectPages(page, [1]);
    await revealReaderControls(page);
    await page.getByRole("button", { name: "Two-page view", exact: true }).click();
    await expect(page.getByRole("button", { name: "Two-page view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expectPages(page, [1]);
    await jumpToPage(page, 4);
    await hideReaderControls(page);
    await expect.poll(() => finalPageRequested).toBe(true);
    await expect(page.locator(".reader-page-surface")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await revealReaderControls(page);
    await expect(page.getByRole("button", { name: `Next chapter: ${second.title}`, exact: true })).toHaveCount(0);
    await hideReaderControls(page);
    release.resolve();
    await expectPages(page, [4, 5]);
    const next = page.getByRole("button", { name: `Next chapter: ${second.title}`, exact: true });
    await expect(next).toBeVisible();
    await expect(page.locator(".reader-root")).not.toHaveClass(/reader-controls-hidden/);
    await hideReaderControls(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await expectPages(page, [4, 5]);
    await expect(page.locator(".reader-root")).toHaveClass(/reader-controls-hidden/);
    await expect(next).toBeHidden();
    await revealReaderControls(page);
    await expectControlsFit(page);
    await page.screenshot({ path: testInfo.outputPath("next-chapter-320px.png"), fullPage: true, animations: "disabled" });
    await expect.poll(async () => (await getBook(page.request, first.id)).currentPage).toBe(4);
    await next.click();
    await expect(page).toHaveURL(new RegExp(`/read/${second.id}$`));
    await expectPages(page, [1]);
    expect((await getBook(page.request, first.id)).currentPage).toBe(5);

    // The header exit also completes a fully displayed final spread, even
    // though its saved anchor is the first page of the pair.
    await page.goto(`/read/${first.id}`);
    await expectPages(page, [4, 5]);
    await revealReaderControls(page);
    await jumpToPage(page, 4);
    await expectPages(page, [4, 5]);
    await expect.poll(async () => (await getBook(page.request, first.id)).currentPage).toBe(4);
    await page.getByRole("link", { name: "Back to series", exact: true }).click();
    await expect(page).toHaveURL(`http://127.0.0.1:3210/?series=${first.seriesId}`);
    expect((await getBook(page.request, first.id)).currentPage).toBe(5);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" }).catch(() => undefined);
  }
});

test("fullscreen continues into the next chapter and exits when leaving the reader", async ({ page, uploadedBooks }) => {
  await login(page.request);
  await page.goto("/");
  test.skip(!await page.evaluate(() => document.fullscreenEnabled), "Fullscreen is unavailable in this browser");
  const name = `Fullscreen chapters ${randomUUID().slice(0, 8)}`;
  const first = await upload(page.request, `${name} Chapter 1`, uploadedBooks, 1);
  const second = await upload(page.request, `${name} Chapter 2`, uploadedBooks, 1);
  const seriesUrl = `http://127.0.0.1:3210/?series=${first.seriesId}`;
  const readerIsFullscreen = () => page.evaluate(() =>
    document.fullscreenElement?.contains(document.querySelector(".reader-root")) ?? false);

  await page.goto(`/read/${first.id}`);
  await expectPages(page, [1]);
  await revealReaderControls(page);
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect.poll(readerIsFullscreen).toBe(true);
  await page.getByRole("button", { name: `Next chapter: ${second.title}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/read/${second.id}$`));
  await expectPages(page, [1]);
  await expect.poll(readerIsFullscreen).toBe(true);
  await revealReaderControls(page);
  await expect(page.getByRole("combobox", { name: "Choose installment", exact: true })).toHaveValue(second.id);
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Back to series list", exact: true }).click();
  await expect(page).toHaveURL(seriesUrl);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

  // Enter through a client-side book link, then leave through browser history.
  await page.getByRole("link", { name: `Read ${first.title}`, exact: true }).click();
  await expectPages(page, [1]);
  await revealReaderControls(page);
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect.poll(readerIsFullscreen).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(seriesUrl);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});
