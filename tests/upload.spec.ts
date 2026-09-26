import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { UPLOAD_CHUNK_BYTES } from "../lib/types";

let smallPdf: Buffer;
let largePdf: Buffer;
test.beforeAll(async () => {
  const small = await PDFDocument.create();
  small.addPage([200, 300]);
  smallPdf = Buffer.from(await small.save());
  const large = await PDFDocument.create();
  large.addPage([200, 300]);
  // An uncompressed, unused PDF stream makes the transport fixture large while
  // keeping page rendering inexpensive and the document fully valid.
  large.context.register(large.context.stream(Buffer.alloc(UPLOAD_CHUNK_BYTES + 128, 65)));
  largePdf = Buffer.from(await large.save({ useObjectStreams: false }));
});

test("uploads over HTTP when secure-context UUID APIs are unavailable", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  // This browser-side proxy serves the real app under an insecure, non-loopback
  // origin. No DNS changes or exposed server listener are needed for the test.
  await page.route("http://books.test:3210/**", async route => {
    const original = route.request();
    const url = new URL(original.url());
    const headers: Record<string, string> = { ...original.headers(), host: "127.0.0.1:3210" };
    if (headers.origin) headers.origin = "http://127.0.0.1:3210";
    const response = await route.fetch({ url: `http://127.0.0.1:3210${url.pathname}${url.search}`, headers });
    await route.fulfill({ response });
  });
  await page.goto("http://books.test:3210");
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Library password").fill("test-only-comic-shelf-passphrase");
  await page.getByRole("button", { name: "Open library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.locator(".shelf-header-upload")).toBeEnabled();
  await page.getByLabel("Choose PDF files").setInputFiles({ name: "HTTP Upload.pdf", mimeType: "application/pdf", buffer: smallPdf });
  const link = page.getByRole("link", { name: "Read HTTP Upload", exact: true });
  await expect(link).toBeVisible({ timeout: 50_000 });
  const id = (await link.getAttribute("href"))!.split("/").at(-1);
  expect(await page.evaluate(async id => (await fetch(`/api/books/${id}`, { method: "DELETE" })).status, id)).toBe(204);
  expect(browserErrors).toEqual([]);
});

test("sends large PDFs in bounded requests and retries a failed transfer from the beginning", async ({ page }) => {
  await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
  let failFirst = true;
  const offsets: number[] = [];
  const sizes: number[] = [];
  let starts = 0;
  let cancellations = 0;
  await page.route("**/api/uploads", async route => { starts++; await route.continue(); });
  await page.route("**/api/uploads/*", async route => {
    const request = route.request();
    if (request.method() === "DELETE") { cancellations++; await route.continue(); return; }
    if (request.method() !== "PATCH") { await route.continue(); return; }
    if (failFirst) {
      failFirst = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Connection interrupted. Please try again." }) });
      return;
    }
    offsets.push(Number(request.headers()["upload-offset"]));
    sizes.push(request.postDataBuffer()!.length);
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.locator(".shelf-header-upload")).toBeEnabled();
  await page.getByLabel("Choose PDF files").setInputFiles([
    { name: "Large Upload.pdf", mimeType: "application/pdf", buffer: largePdf },
    { name: "Queued Upload.pdf", mimeType: "application/pdf", buffer: smallPdf },
  ]);
  const retry = page.getByRole("button", { name: "Retry upload Large Upload.pdf", exact: true });
  await expect(retry).toBeVisible();
  await expect.poll(() => cancellations).toBe(1);
  const queued = page.getByRole("link", { name: "Read Queued Upload", exact: true });
  await expect(queued).toBeVisible({ timeout: 50_000 });
  await retry.click();
  const link = page.getByRole("link", { name: "Read Large Upload", exact: true });
  await expect(link).toBeVisible({ timeout: 50_000 });
  await expect(page.getByText("All uploads complete.", { exact: true })).toBeVisible();
  expect(starts).toBe(2);
  expect(offsets).toEqual([0, UPLOAD_CHUNK_BYTES]);
  expect(sizes).toEqual([UPLOAD_CHUNK_BYTES, largePdf.length - UPLOAD_CHUNK_BYTES]);
  const id = (await link.getAttribute("href"))!.split("/").at(-1);
  const stored = await page.request.get(`/api/books/${id}/file`);
  expect(await stored.body()).toEqual(largePdf);
  expect((await page.request.delete(`/api/books/${id}`)).status()).toBe(204);
  const queuedId = (await queued.getAttribute("href"))!.split("/").at(-1);
  expect((await page.request.delete(`/api/books/${queuedId}`)).status()).toBe(204);
});

test("returns to sign-in when a large upload loses its authenticated session", async ({ page }) => {
  await page.request.post("/api/session", { data: { username: "admin", password: "test-only-comic-shelf-passphrase" } });
  await page.route("**/api/uploads", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Please sign in to continue." }) }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.locator(".shelf-header-upload")).toBeEnabled();
  await page.getByLabel("Choose PDF files").setInputFiles({ name: "Signed Out.pdf", mimeType: "application/pdf", buffer: largePdf });
  await expect(page.getByLabel("Library password")).toBeVisible();
});
