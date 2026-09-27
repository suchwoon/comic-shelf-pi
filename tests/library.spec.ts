import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openReaderSettings, revealReaderControls } from "./reader-helpers";

const fixture = join(tmpdir(), `comic-shelf-fixture-${process.pid}.pdf`);
const scanFixture = join(tmpdir(), `comic-shelf-scan-fixture-${process.pid}.pdf`);
test.beforeAll(() => {
  execFileSync(process.execPath, ["scripts/create-test-pdf.mjs", fixture]);
  execFileSync(process.execPath, ["scripts/create-scan-fixture.mjs", scanFixture]);
});

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
  }), { message: "The complete PDF page should fit the reader without scroll overflow" }).toBe(true);
}

test("reads scanned page images, normalizes legacy width fit, and restores reading progress", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
  const uploaded = await page.request.post("/api/books", { headers: { "Content-Type": "application/pdf", "X-File-Name": "scan-test.pdf" }, data: readFileSync(scanFixture) });
  expect(uploaded.status()).toBe(201);
  const { book } = await uploaded.json();
  expect(book.size).toBeGreaterThan(512 * 1024);
  const endpoint = `/api/books/${book.id}`;
  expect((await page.request.patch(`${endpoint}/progress`, { data: { fit: "width" } })).ok()).toBe(true);
  const originalRequests: string[] = [];
  const pageImages: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === `${endpoint}/file`) originalRequests.push(request.url());
  });
  page.on("response", response => {
    if (new URL(response.url()).pathname.startsWith(`${endpoint}/pages/`) && response.ok()
      && response.headers()["content-type"]?.startsWith("image/jpeg")) pageImages.push(new URL(response.url()).pathname);
  });
  await page.goto(`/read/${book.id}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1", { timeout: 40_000 });
  await expectPageFits(page);
  await expect(page.getByRole("button", { name: /zoom|fit (?:to )?width|width fit/i })).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).book.fit).toBe("page");
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).book.lastReadAt).not.toBeNull();
  await revealReaderControls(page);
  await page.getByLabel("Page number").fill("4");
  await page.getByLabel("Page number").press("Enter");
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "4");
  const dimensions = await page.getByTestId("pdf-page").boundingBox();
  expect(dimensions!.width).toBeGreaterThan(dimensions!.height);
  await expectPageFits(page);
  await openReaderSettings(page);
  await page.getByRole("button", { name: "Reading direction: Left to right", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click({ clickCount: 3 });
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "7");
  await expect(page.getByTestId("pdf-page")).toHaveCount(1);
  await expect.poll(async () => {
    const { book: saved } = await (await page.request.get(endpoint)).json();
    return [saved.currentPage, saved.direction, saved.fit];
  }).toEqual([7, "rtl", "page"]);
  await page.reload();
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "7");
  await revealReaderControls(page);
  await openReaderSettings(page);
  await expect(page.getByRole("button", { name: "Reading direction: Right to left", exact: true })).toBeVisible();
  await expectPageFits(page);
  expect(pageImages).toContain(`${endpoint}/pages/1`);
  expect(pageImages).toContain(`${endpoint}/pages/4`);
  expect(pageImages).toContain(`${endpoint}/pages/7`);
  expect(originalRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("scan-reader.png"), fullPage: true });
  expect(browserErrors).toEqual([]);
  expect((await page.request.delete(endpoint)).status()).toBe(204);
});

test("signs in, uploads, resumes across devices, manages books, and signs out", async ({ page, browser }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  const anon = await browser.newContext({ baseURL: "http://127.0.0.1:3210" });
  expect((await anon.request.get("/api/books")).status()).toBe(401);

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel("Library password")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("login.png"), fullPage: true });
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Library password").fill("incorrect-password");
  await page.getByRole("button", { name: "Open library", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Incorrect username or password. Please try again.");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Library password").fill("test-only-comic-shelf-passphrase");
  await page.getByRole("button", { name: "Open library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your library is empty", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("empty-shelf.png"), fullPage: true });

  await page.getByLabel("Choose PDF files").setInputFiles({ name: "My Comic 01.pdf", mimeType: "application/pdf", buffer: readFileSync(fixture) });
  const bookLink = page.getByRole("link", { name: "Read My Comic 01", exact: true });
  await expect(bookLink).toBeVisible({ timeout: 50_000 });
  const readerPath = await bookLink.getAttribute("href");
  const id = readerPath!.split("/").at(-1);
  const endpoint = `/api/books/${id}`;

  // Originals, rendered pages, and covers all require an active session.
  expect((await anon.request.get(`${endpoint}/file`)).status()).toBe(401);
  expect((await anon.request.head(`${endpoint}/file`)).status()).toBe(401);
  expect((await anon.request.get(`${endpoint}/file`, { headers: { Range: "bytes=0-4" } })).status()).toBe(401);
  expect((await anon.request.get(`${endpoint}/pages/1`)).status()).toBe(401);
  expect((await anon.request.head(`${endpoint}/pages/1`)).status()).toBe(401);
  expect((await anon.request.get(`${endpoint}/cover`)).status()).toBe(401);
  await anon.close();
  await expect(page.getByRole("link", { name: "Download My Comic 01", exact: true })).toBeVisible();
  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download My Comic 01", exact: true }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("My Comic 01.pdf");
  const downloadPath = await download.path();
  expect(readFileSync(downloadPath!)).toEqual(readFileSync(fixture));
  const head = await page.request.head(`${endpoint}/file`);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-type"]).toContain("application/pdf");
  expect(head.headers()["cache-control"]).toContain("no-store");
  const part = await page.request.get(`${endpoint}/file`, { headers: { Range: "bytes=0-4" } });
  expect(part.status()).toBe(206);
  expect(await part.text()).toBe("%PDF-");
  expect(part.headers()["content-range"]).toMatch(/^bytes 0-4\/\d+$/);
  expect((await page.request.get(`${endpoint}/file`, { headers: { Range: "bytes=999999999-" } })).status()).toBe(416);
  const duplicate = await page.request.post("/api/books", { headers: { "Content-Type": "application/pdf", "X-File-Name": "duplicate.pdf" }, data: readFileSync(fixture) });
  expect(duplicate.status()).toBe(409);
  const corrupt = await page.request.post("/api/books", { headers: { "Content-Type": "application/pdf", "X-File-Name": "broken.pdf" }, data: Buffer.from("%PDF-1.7\nnot a real PDF") });
  expect(corrupt.status()).toBe(422);
  const invalidProgress = await page.request.patch(`${endpoint}/progress`, { data: { currentPage: 999 } });
  expect(invalidProgress.status()).toBe(400);

  await page.screenshot({ path: testInfo.outputPath("bookshelf.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await bookLink.click();
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "1", { timeout: 40_000 });
  await expectPageFits(page);
  await revealReaderControls(page);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).book.currentPage).toBe(2);
  await page.reload();
  await expect(page.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
  await revealReaderControls(page);

  // A second session sees server progress, not a browser-local bookmark.
  const otherDevice = await browser.newContext({ baseURL: "http://127.0.0.1:3210" });
  await otherDevice.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
  expect((await (await otherDevice.request.get(endpoint)).json()).book.currentPage).toBe(2);
  await otherDevice.close();
  await page.screenshot({ path: testInfo.outputPath("reader.png"), fullPage: true });

  await page.getByRole("link", { name: "Back to library", exact: true }).click();
  await page.getByLabel("Manage My Comic 01", { exact: true }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Book title", { exact: true }).fill("Quiet Afternoon 01");
  await page.screenshot({ path: testInfo.outputPath("rename-dialog.png"), fullPage: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("link", { name: "Read Quiet Afternoon 01", exact: true })).toBeVisible();
  await page.getByLabel("Search books").fill("A missing title");
  await expect(page.getByRole("heading", { name: "No books found", exact: true })).toBeVisible();
  await page.getByLabel("Search books").clear();
  await page.getByLabel("Manage Quiet Afternoon 01", { exact: true }).click();
  await page.getByRole("button", { name: "Delete book", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("delete-dialog.png"), fullPage: true });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your library is empty", exact: true })).toBeVisible();
  expect((await page.request.get(`${endpoint}/file`)).status()).toBe(404);
  expect((await page.request.get(`${endpoint}/cover`)).status()).toBe(404);
  expect((await page.request.get(`${endpoint}/pages/1`)).status()).toBe(404);
  expect(browserErrors).toEqual([]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Library password")).toBeVisible();
  expect((await page.request.get("/api/books")).status()).toBe(401);
});
