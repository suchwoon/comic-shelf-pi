import { test as base, expect, devices, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { Book } from "../lib/types";
import { revealReaderControls } from "./reader-helpers";

interface LibraryCleanup {
  bookIds: Set<string>;
  bookTitles: Set<string>;
  readerIds: Set<string>;
}

// Teardown has its own timeout and request context, so a timed-out page or
// beforeunload handler cannot leave PDFs behind for the next scenario.
const test = base.extend<{ libraryCleanup: LibraryCleanup }>({
  libraryCleanup: [async ({ request }, use) => {
    const cleanup: LibraryCleanup = { bookIds: new Set(), bookTitles: new Set(), readerIds: new Set() };
    await use(cleanup);
    await adminLogin(request);
    const failures: unknown[] = [];
    try {
      const response = await request.get("/api/books", { timeout: 10_000 });
      expect(response.status()).toBe(200);
      for (const book of (await response.json()).books as Book[]) {
        if (cleanup.bookTitles.has(book.title)) cleanup.bookIds.add(book.id);
      }
    } catch (error) { failures.push(error); }
    for (const id of cleanup.bookIds) {
      try {
        const response = await request.delete(`/api/books/${id}`, { timeout: 10_000 });
        expect([204, 404]).toContain(response.status());
      } catch (error) { failures.push(error); }
    }
    for (const id of cleanup.readerIds) {
      try {
        const response = await request.patch(`/api/admin/users/${id}`, { data: { disabled: true }, timeout: 10_000 });
        expect(response.status()).toBe(200);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Could not clean up series test data.");
  }, { auto: true, timeout: 45_000 }],
});

async function adminLogin(request: APIRequestContext) {
  const response = await request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
    timeout: 10_000,
  });
  expect(response.status()).toBe(200);
}

async function uploadBook(request: APIRequestContext, title: string, cleanup: LibraryCleanup) {
  cleanup.bookTitles.add(title);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} ${randomUUID()}`);
  for (let index = 0; index < 4; index++) pdf.addPage([400, 600]);
  const response = await request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": `${title}.pdf` },
    data: Buffer.from(await pdf.save()),
  });
  expect(response.status()).toBe(201);
  const book = (await response.json()).book as Book;
  cleanup.bookIds.add(book.id);
  return book;
}

async function getBook(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/books/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).book as Book;
}

async function expectPageFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function editSeries(page: Page, book: Book) {
  await page.getByLabel(`Manage ${book.title}`, { exact: true }).click();
  await page.getByRole("button", { name: "Edit series", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit series", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a series occupies one shelf card, keeps numeric reading order, and resumes directly", async ({ page, libraryCleanup }, testInfo) => {
  await adminLogin(page.request);
  const seriesTitle = `Ordered adventures ${randomUUID().slice(0, 8)}`;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const tenth = await uploadBook(page.request, `${seriesTitle} Vol. 10`, libraryCleanup);
    const second = await uploadBook(page.request, `${seriesTitle} Vol. 2`, libraryCleanup);
    const first = await uploadBook(page.request, `${seriesTitle} Vol. 1`, libraryCleanup);
    const standalone = await uploadBook(page.request, `Standalone story ${randomUUID().slice(0, 8)} ending`, libraryCleanup);
    const renamedTitle = `${seriesTitle} — Skyline finale`;
    expect((await page.request.patch(`/api/books/${tenth.id}`, { data: { title: renamedTitle } })).status()).toBe(200);
    expect((await page.request.patch(`/api/books/${first.id}/progress`, { data: { currentPage: 4 } })).status()).toBe(200);
    expect((await page.request.patch(`/api/books/${second.id}/progress`, { data: { currentPage: 2 } })).status()).toBe(200);
    const savedSecond = await getBook(page.request, second.id);
    expect(savedSecond.seriesId).toBeTruthy();
    expect((await getBook(page.request, first.id)).seriesId).toBe(savedSecond.seriesId);
    expect((await getBook(page.request, tenth.id)).seriesId).toBe(savedSecond.seriesId);

    await page.goto("/");
    const seriesLink = page.getByRole("link", { name: `Open series ${seriesTitle}`, exact: true });
    await expect(seriesLink).toHaveCount(1);
    await expect(seriesLink).toBeVisible();
    await expect(page.getByRole("link", { name: `Read ${first.title}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: `Read ${standalone.title}`, exact: true })).toHaveAttribute("href", `/read/${standalone.id}`);
    const homeContinue = page.getByRole("link", { name: `Continue reading ${second.title}`, exact: true });
    await expect(homeContinue).toHaveAttribute("href", `/read/${second.id}`);
    await expectPageFits(page);
    await page.screenshot({ path: testInfo.outputPath("series-library.png"), fullPage: true });
    await homeContinue.click();
    await expect(page).toHaveURL(new RegExp(`/read/${second.id}$`));
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
    await page.goBack();
    await expect(seriesLink).toBeVisible();

    // A child title can locate its series even when that title is hidden on the shelf.
    await page.getByRole("searchbox", { name: "Search books", exact: true }).fill("Skyline finale");
    await expect(seriesLink).toBeVisible();
    await expect(page.getByRole("link", { name: `Read ${standalone.title}`, exact: true })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search books", exact: true }).fill("");
    await seriesLink.click();
    const seriesPath = `http://127.0.0.1:3210/?series=${savedSecond.seriesId}`;
    await expect(page).toHaveURL(seriesPath);
    await expect(page.getByRole("heading", { name: seriesTitle, exact: true })).toBeVisible();
    const books = page.locator(".shelf-book-grid").getByRole("link", { name: /^Read / });
    await expect(books).toHaveCount(3);
    expect(await books.evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual([
      `/read/${first.id}`, `/read/${second.id}`, `/read/${tenth.id}`,
    ]);
    const firstCard = page.locator(".shelf-book-card").filter({ has: page.getByRole("link", { name: `Read ${first.title}`, exact: true }) });
    const secondCard = page.locator(".shelf-book-card").filter({ has: page.getByRole("link", { name: `Read ${second.title}`, exact: true }) });
    await expect(firstCard).toContainText("Completed");
    await expect(secondCard).toContainText("In progress");
    await expect(page.getByRole("link", { name: `Continue reading ${second.title}`, exact: true })).toHaveAttribute("href", `/read/${second.id}`);
    await expectPageFits(page);
    await page.screenshot({ path: testInfo.outputPath("series-volumes.png"), fullPage: true });

    await page.reload();
    await expect(page).toHaveURL(seriesPath);
    await expect(page.getByRole("heading", { name: seriesTitle, exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL("http://127.0.0.1:3210/");
    await expect(seriesLink).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(seriesPath);
    await expect(page.getByRole("heading", { name: seriesTitle, exact: true })).toBeVisible();
    await page.getByRole("link", { name: `Continue reading ${second.title}`, exact: true }).click();
    await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
    await revealReaderControls(page);
    await page.getByRole("link", { name: "Back to series", exact: true }).click();
    await expect(page).toHaveURL(seriesPath);
    await expect(page.getByRole("heading", { name: seriesTitle, exact: true })).toBeVisible();

    expect((await page.request.patch(`/api/books/${second.id}/progress`, { data: { currentPage: 4 } })).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("link", { name: `Read next ${renamedTitle}`, exact: true })).toHaveAttribute("href", `/read/${tenth.id}`);
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
    await expect(seriesLink).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await page.goto("about:blank", { timeout: 5_000 }).catch(() => undefined);
  }
});

test("administrators can correct chapter grouping while readers keep personal progress and cannot edit it", async ({ page, browser, libraryCleanup }, testInfo) => {
  await adminLogin(page.request);
  const seriesTitle = `Chapter collection ${randomUUID().slice(0, 8)}`;
  const readerContext = await browser.newContext({
    ...(testInfo.project.name === "mobile" ? devices["Pixel 7"] : { viewport: { width: 1440, height: 1000 } }),
    baseURL: "http://127.0.0.1:3210",
  });
  try {
    const second = await uploadBook(page.request, `${seriesTitle} Chapter 2`, libraryCleanup);
    const unassigned = await uploadBook(page.request, `Opening scene ${randomUUID().slice(0, 8)} original`, libraryCleanup);
    expect((await page.request.patch(`/api/books/${unassigned.id}/progress`, { data: { currentPage: 3 } })).status()).toBe(200);
    const before = await getBook(page.request, unassigned.id);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const dialog = await editSeries(page, unassigned);
    await dialog.getByLabel("Series name", { exact: true }).fill(seriesTitle);
    await dialog.getByLabel("Numbering", { exact: true }).selectOption("chapter");
    await dialog.getByLabel("Volume or chapter number", { exact: true }).fill("1");
    await expectPageFits(page);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("edit-series-dark.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const assigned = await getBook(page.request, unassigned.id);
    expect(assigned.seriesId).toBe(second.seriesId);
    expect(assigned.installmentType).toBe("chapter");
    expect(assigned.installmentNumber).toBe(1);
    expect(assigned.currentPage).toBe(before.currentPage);
    expect(assigned.lastReadAt).toBe(before.lastReadAt);
    await expect(page.getByRole("link", { name: `Read ${unassigned.title}`, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: `Open series ${seriesTitle}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: seriesTitle, exact: true })).toBeVisible();
    const ordered = page.locator(".shelf-book-grid").getByRole("link", { name: /^Read / });
    await expect(ordered).toHaveCount(2);
    expect(await ordered.evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual([
      `/read/${unassigned.id}`, `/read/${second.id}`,
    ]);

    const invitation = await page.request.post("/api/admin/invitations", { data: {} });
    expect(invitation.status()).toBe(201);
    const registration = await readerContext.request.post("/api/register", {
      data: { token: (await invitation.json()).token, username: `series_${randomUUID().slice(0, 8)}`, password: "reader12" },
    });
    expect(registration.status()).toBe(201);
    libraryCleanup.readerIds.add((await registration.json()).user.id);
    const reader = await readerContext.newPage();
    await reader.goto(`/?series=${assigned.seriesId}`);
    await expect(reader.getByRole("heading", { name: seriesTitle, exact: true })).toBeVisible();
    await expect(reader.getByRole("link", { name: `Start reading ${unassigned.title}`, exact: true })).toHaveAttribute("href", `/read/${unassigned.id}`);
    await expect(reader.getByLabel(`Manage ${unassigned.title}`, { exact: true })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Edit series", exact: true })).toHaveCount(0);
    expect((await readerContext.request.patch(`/api/books/${unassigned.id}`, {
      data: { seriesTitle: "Forbidden change", installmentType: "volume", installmentNumber: 99 },
    })).status()).toBe(403);
    expect((await getBook(readerContext.request, unassigned.id)).currentPage).toBe(1);
    await expectPageFits(reader);

    const detach = await editSeries(page, unassigned);
    await detach.getByLabel("Series name", { exact: true }).fill("");
    await detach.getByRole("button", { name: "Save", exact: true }).click();
    await expect(detach).toHaveCount(0);
    await expect(page.getByRole("link", { name: `Read ${unassigned.title}`, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
    await expect(page.getByRole("link", { name: `Read ${unassigned.title}`, exact: true })).toHaveAttribute("href", `/read/${unassigned.id}`);
    const detached = await getBook(page.request, unassigned.id);
    expect(detached.seriesId).toBeNull();
    expect(detached.installmentType).toBeNull();
    expect(detached.installmentNumber).toBeNull();
    expect(detached.currentPage).toBe(before.currentPage);
    expect(detached.lastReadAt).toBe(before.lastReadAt);
    await page.reload();
    await expect(page.getByRole("link", { name: `Read ${unassigned.title}`, exact: true })).toBeVisible();
    await page.getByRole("link", { name: `Open series ${seriesTitle}`, exact: true }).click();
    const lastBook = await editSeries(page, second);
    await lastBook.getByLabel("Series name", { exact: true }).fill("");
    await lastBook.getByRole("button", { name: "Save", exact: true }).click();
    await expect(lastBook).toHaveCount(0);
    await expect(page).toHaveURL("http://127.0.0.1:3210/");
    await expect(page.getByRole("link", { name: `Read ${second.title}`, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `Open series ${seriesTitle}`, exact: true })).toHaveCount(0);
  } finally {
    await readerContext.close().catch(() => undefined);
    await page.goto("about:blank", { timeout: 5_000 }).catch(() => undefined);
  }
});

test("uploading numbered siblings groups both cards in the current session", async ({ page, libraryCleanup }) => {
  await adminLogin(page.request);
  const seriesTitle = `Upload grouping ${randomUUID().slice(0, 8)}`;
  const titles = [`${seriesTitle} 01`, `${seriesTitle} 02`];
  const files = [];
  for (const title of titles) {
    libraryCleanup.bookTitles.add(title);
    const pdf = await PDFDocument.create();
    pdf.setTitle(`${title} ${randomUUID()}`);
    pdf.addPage([400, 600]);
    files.push({ name: `${title}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  }
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Upload PDF", exact: true }).first()).toBeEnabled();
    await page.getByLabel("Choose PDF files", { exact: true }).setInputFiles(files);
    await expect(page.getByText("All uploads complete.", { exact: true })).toBeVisible({ timeout: 50_000 });
    const seriesLink = page.getByRole("link", { name: `Open series ${seriesTitle}`, exact: true });
    await expect(seriesLink).toHaveCount(1);
    await expect(seriesLink).toBeVisible();
    for (const title of titles) await expect(page.getByRole("link", { name: `Read ${title}`, exact: true })).toHaveCount(0);
    await seriesLink.click();
    const installments = page.locator(".shelf-book-grid").getByRole("link", { name: /^Read / });
    await expect(installments).toHaveCount(2);
    await expect(installments.nth(0)).toHaveAttribute("aria-label", `Read ${titles[0]}`);
    await expect(installments.nth(1)).toHaveAttribute("aria-label", `Read ${titles[1]}`);
    await expectPageFits(page);
  } finally {
    await page.goto("about:blank", { timeout: 5_000 }).catch(() => undefined);
  }
});
