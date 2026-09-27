import { test, expect, devices, type APIRequestContext, type Browser, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { Book } from "../lib/types";
import { revealReaderControls } from "./reader-helpers";

async function adminLogin(request: APIRequestContext) {
  const response = await request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).user.id as string;
}

async function uploadBook(request: APIRequestContext, title: string) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} ${randomUUID()}`);
  for (let number = 0; number < 4; number++) pdf.addPage([400, 600]);
  const response = await request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": `${title}.pdf` },
    data: Buffer.from(await pdf.save()),
  });
  expect(response.status()).toBe(201);
  return (await response.json()).book as Book;
}

async function getBook(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/books/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).book as Book;
}

async function inviteReader(admin: APIRequestContext, browser: Browser, testInfo: TestInfo) {
  const invitation = await admin.post("/api/admin/invitations", { data: {} });
  expect(invitation.status()).toBe(201);
  const { token } = await invitation.json();
  const context = await browser.newContext({
    ...(testInfo.project.name === "mobile" ? devices["Pixel 7"] : { viewport: { width: 1440, height: 1000 } }),
    baseURL: "http://127.0.0.1:3210",
  });
  const registration = await context.request.post("/api/register", {
    data: { token, username: `history_${randomUUID().slice(0, 8)}`, password: "reader12" },
  });
  expect(registration.status()).toBe(201);
  return { context, id: (await registration.json()).user.id as string };
}

test("a reader clears personal history, keeps shared books, and restarts on page one", async ({ page, browser }, testInfo) => {
  await adminLogin(page.request);
  const book = await uploadBook(page.request, "Personal reading history");
  const otherBook = await uploadBook(page.request, "Keep this reading history");
  const member = await inviteReader(page.request, browser, testInfo);
  const endpoint = `/api/books/${book.id}`;
  try {
    expect((await page.request.patch(`${endpoint}/progress`, { data: { currentPage: 4 } })).status()).toBe(200);
    expect((await member.context.request.patch(`/api/books/${otherBook.id}/progress`, { data: { currentPage: 2 } })).status()).toBe(200);
    const reader = await member.context.newPage();
    await reader.goto("/");
    await expect(reader.getByRole("link", { name: `Read ${book.title}`, exact: true })).toBeVisible();
    await expect(reader.getByLabel(`Reading options for ${book.title}`, { exact: true })).toHaveCount(0);

    expect((await member.context.request.patch(`${endpoint}/progress`, {
      data: { currentPage: 3, direction: "rtl", fit: "page" },
    })).status()).toBe(200);
    const before = await getBook(member.context.request, book.id);
    const adminBefore = await getBook(page.request, book.id);
    const otherBefore = await getBook(member.context.request, otherBook.id);
    await reader.reload();
    const card = reader.locator(".shelf-book-card").filter({
      has: reader.getByRole("link", { name: `Read ${book.title}`, exact: true }),
    });
    await expect(card).toContainText("75% read");
    await reader.getByLabel(`Reading options for ${book.title}`, { exact: true }).click();
    await expect(card.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Delete book", exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Clear history", exact: true }).click();
    const dialog = reader.getByRole("dialog", { name: "Clear reading history?", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Clear history", exact: true }).click();
    await expect(reader.getByRole("status").filter({ hasText: "Reading history cleared" })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByRole("link", { name: `Read ${book.title}`, exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: `Read ${book.title}`, exact: true })).toBeFocused();
    await expect(card).not.toContainText("% read");
    await expect(reader.getByLabel(`Reading options for ${book.title}`, { exact: true })).toHaveCount(0);
    await expect(reader.getByRole("link", { name: `Continue reading ${book.title}`, exact: true })).toHaveCount(0);
    await expect(reader.getByRole("link", { name: `Continue reading ${otherBook.title}`, exact: true })).toBeVisible();
    expect(await getBook(member.context.request, book.id)).toEqual({ ...before, currentPage: 1, lastReadAt: null });
    expect(await getBook(page.request, book.id)).toEqual(adminBefore);
    expect(await getBook(member.context.request, otherBook.id)).toEqual(otherBefore);

    await reader.reload();
    await expect(card.getByRole("link", { name: `Read ${book.title}`, exact: true })).toBeVisible();
    await expect(card).not.toContainText("% read");
    await expect(reader.getByLabel(`Reading options for ${book.title}`, { exact: true })).toHaveCount(0);
    await card.getByRole("link", { name: `Read ${book.title}`, exact: true }).click();
    await expect(reader.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await revealReaderControls(reader);
    await expect.poll(async () => (await getBook(member.context.request, book.id)).lastReadAt).not.toBeNull();
    await reader.getByRole("link", { name: "Back to library", exact: true }).click();
    await expect(reader.getByLabel(`Reading options for ${book.title}`, { exact: true })).toBeVisible();
    expect(await getBook(page.request, book.id)).toEqual(adminBefore);
  } finally {
    await member.context.close();
    await page.request.patch(`/api/admin/users/${member.id}`, { data: { disabled: true } });
    expect((await page.request.delete(endpoint)).status()).toBe(204);
    expect((await page.request.delete(`/api/books/${otherBook.id}`)).status()).toBe(204);
  }
});

test("clearing history can be cancelled and a failed confirmation can be retried", async ({ page }) => {
  await adminLogin(page.request);
  const book = await uploadBook(page.request, "Retry reading history");
  const endpoint = `/api/books/${book.id}`;
  let failClear = true;
  let clearAttempts = 0;
  await page.route(`**${endpoint}/progress`, async route => {
    if (route.request().method() !== "DELETE") { await route.continue(); return; }
    clearAttempts++;
    if (failClear) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary clearing failure" }) });
    } else await route.continue();
  });
  try {
    expect((await page.request.patch(`${endpoint}/progress`, { data: { currentPage: 4, direction: "rtl" } })).status()).toBe(200);
    const before = await getBook(page.request, book.id);
    await page.goto("/");
    const openClear = async () => {
      await page.getByLabel(`Manage ${book.title}`, { exact: true }).click();
      await page.getByRole("button", { name: "Clear history", exact: true }).click();
    };
    const dialog = page.getByRole("dialog", { name: "Clear reading history?", exact: true });
    await openClear();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(clearAttempts).toBe(0);
    expect(await getBook(page.request, book.id)).toEqual(before);

    await openClear();
    await dialog.getByRole("button", { name: "Clear history", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Temporary clearing failure");
    await expect(dialog.getByRole("button", { name: "Clear history", exact: true })).toBeEnabled();
    expect(clearAttempts).toBe(1);
    expect(await getBook(page.request, book.id)).toEqual(before);
    failClear = false;
    await dialog.getByRole("button", { name: "Clear history", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Reading history cleared" })).toBeVisible();
    expect(clearAttempts).toBe(2);
    expect(await getBook(page.request, book.id)).toEqual({ ...before, currentPage: 1, lastReadAt: null });
    await page.getByLabel(`Manage ${book.title}`, { exact: true }).click();
    await expect(page.getByRole("button", { name: "Clear history", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete book", exact: true })).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    expect((await page.request.delete(endpoint)).status()).toBe(204);
  }
});

test("history deletion requires a same-site session and ignores another user ID", async ({ page, browser }, testInfo) => {
  const adminId = await adminLogin(page.request);
  const book = await uploadBook(page.request, "History API permissions");
  const endpoint = `/api/books/${book.id}`;
  const member = await inviteReader(page.request, browser, testInfo);
  const anonymous = await browser.newContext({ baseURL: "http://127.0.0.1:3210" });
  try {
    expect((await page.request.patch(`${endpoint}/progress`, { data: { currentPage: 4 } })).status()).toBe(200);
    expect((await member.context.request.patch(`${endpoint}/progress`, {
      data: { currentPage: 3, direction: "rtl", fit: "width" },
    })).status()).toBe(200);
    const adminBefore = await getBook(page.request, book.id);
    const before = await getBook(member.context.request, book.id);
    expect((await anonymous.request.delete(`${endpoint}/progress`)).status()).toBe(401);
    expect((await member.context.request.delete(`${endpoint}/progress`, {
      headers: { Origin: "https://unrelated.example" },
    })).status()).toBe(403);
    expect((await member.context.request.delete(`/api/books/${randomUUID()}/progress`)).status()).toBe(404);
    expect(await getBook(member.context.request, book.id)).toEqual(before);

    const response = await member.context.request.delete(`${endpoint}/progress?userId=${adminId}`, {
      data: { userId: adminId },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect((await response.json()).book).toEqual({ ...before, currentPage: 1, lastReadAt: null });
    expect(await getBook(page.request, book.id)).toEqual(adminBefore);
    expect(await getBook(member.context.request, book.id)).toEqual({ ...before, currentPage: 1, lastReadAt: null });
    const repeat = await member.context.request.delete(`${endpoint}/progress`);
    expect(repeat.status()).toBe(200);
    expect((await repeat.json()).book).toEqual({ ...before, currentPage: 1, lastReadAt: null });
    expect((await member.context.request.delete(endpoint)).status()).toBe(403);
    expect((await page.request.get(`${endpoint}/file`)).status()).toBe(200);
  } finally {
    await anonymous.close();
    await member.context.close();
    await page.request.patch(`/api/admin/users/${member.id}`, { data: { disabled: true } });
    expect((await page.request.delete(endpoint)).status()).toBe(204);
  }
});
