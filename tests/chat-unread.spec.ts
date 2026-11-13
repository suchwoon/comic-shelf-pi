import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { ChatMessage } from "../lib/types";

const password = "unread-test-reader-password";

async function signIn(request: APIRequestContext, username = "admin", accountPassword = "test-only-comic-shelf-passphrase") {
  const response = await request.post("/api/session", { data: { username, password: accountPassword } });
  expect(response.status()).toBe(200);
  return (await response.json()).user as { id: string; username: string };
}

async function registerMember(admin: APIRequestContext, request: APIRequestContext) {
  const invitation = await admin.post("/api/admin/invitations", { data: {} });
  expect(invitation.status()).toBe(201);
  const username = `unread_${randomUUID().slice(0, 12)}`;
  const response = await request.post("/api/register", {
    data: { token: (await invitation.json()).token, username, password },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).user as { id: string; username: string };
}

async function send(request: APIRequestContext, body: string) {
  const response = await request.post("/api/chat", { data: { body, clientId: randomUUID() } });
  expect(response.status()).toBe(201);
  return (await response.json()).message as ChatMessage;
}

async function refreshChat(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat"
    && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect((await response).ok()).toBe(true);
}

async function readState(request: APIRequestContext) {
  const response = await request.get("/api/chat?status=1");
  expect(response.status()).toBe(200);
  return (await response.json()).readState as { lastReadMessageId: number; latestMessageId: number; hasUnread: boolean };
}

test("unread chat survives reopening and clears only after reaching the latest incoming messages", async ({ page, request, browser }, testInfo) => {
  await signIn(request);
  const senderContext = await browser.newContext({ baseURL: "http://127.0.0.1:3210" });
  const secondDevice = await browser.newContext({ baseURL: "http://127.0.0.1:3210" });
  const members: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const viewer = await registerMember(request, page.request);
    members.push(viewer.id);
    const sender = await registerMember(request, senderContext.request);
    members.push(sender.id);
    const initialStatus = page.waitForResponse(response => new URL(response.url()).searchParams.get("status") === "1");
    await page.goto("/");
    expect((await initialStatus).ok()).toBe(true);
    const baseline = await readState(page.request);
    expect(baseline.hasUnread).toBe(false);
    const launcher = page.getByRole("button", { name: /^Open chat/ });
    await expect(launcher).toHaveAccessibleName("Open chat");
    await expect(launcher.locator(".shelf-chat-unread")).toHaveCount(0);

    let latest: ChatMessage | undefined;
    for (let index = 1; index <= 6; index++) {
      latest = await send(senderContext.request,
        `Unread message ${index}\n${Array.from({ length: 8 }, (_, line) => `Conversation line ${line + 1}`).join("\n")}`);
    }
    await refreshChat(page);
    await expect(launcher).toHaveAccessibleName("Open chat, unread messages");
    await expect(launcher.locator(".shelf-chat-unread")).toBeVisible();
    await expect.poll(async () => (await readState(page.request)).lastReadMessageId).toBe(baseline.lastReadMessageId);

    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Chat", exact: true });
    const conversation = dialog.getByRole("log", { name: "Conversation" });
    const divider = dialog.locator(".shelf-chat-divider");
    await expect(divider).toHaveText("New messages");
    await expect(divider).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "New messages", exact: true })).toBeVisible();
    expect((await readState(page.request)).lastReadMessageId).toBe(baseline.lastReadMessageId);
    await page.screenshot({ path: testInfo.outputPath("chat-unread-divider.png"), fullPage: true });

    // Closing without reaching the bottom must preserve the unread indicator.
    await dialog.getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(launcher.locator(".shelf-chat-unread")).toBeVisible();
    await launcher.click();
    await expect(divider).toBeInViewport();
    await dialog.getByRole("button", { name: "New messages", exact: true }).click();
    await expect.poll(async () => (await readState(page.request)).lastReadMessageId).toBe(latest!.id);
    await expect(dialog.getByRole("button", { name: "New messages", exact: true })).toHaveCount(0);

    // Another arrival must not move someone who has scrolled back into history.
    await conversation.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    const before = await conversation.evaluate(element => element.scrollTop);
    const incoming = await send(senderContext.request, `New reply while reading earlier messages · ${sender.username}`);
    await refreshChat(page);
    await expect(dialog.getByText(incoming.body, { exact: true })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "New messages", exact: true })).toBeVisible();
    expect(await conversation.evaluate(element => element.scrollTop)).toBe(before);
    expect((await readState(page.request)).lastReadMessageId).toBe(latest!.id);
    await dialog.getByRole("button", { name: "New messages", exact: true }).click();
    await expect.poll(async () => (await readState(page.request)).hasUnread).toBe(false);
    await dialog.getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(launcher).toHaveAccessibleName("Open chat");
    await expect(launcher.locator(".shelf-chat-unread")).toHaveCount(0);

    await send(page.request, "My own message from another session");
    await refreshChat(page);
    await expect(launcher).toHaveAccessibleName("Open chat");
    await expect(launcher.locator(".shelf-chat-unread")).toHaveCount(0);
    const reloaded = page.waitForResponse(response => new URL(response.url()).searchParams.get("status") === "1");
    await page.reload();
    expect((await reloaded).ok()).toBe(true);
    await expect(launcher).toHaveAccessibleName("Open chat");
    await expect(launcher.locator(".shelf-chat-unread")).toHaveCount(0);

    await signIn(secondDevice.request, viewer.username, password);
    const otherPage = await secondDevice.newPage();
    const synced = otherPage.waitForResponse(response => new URL(response.url()).searchParams.get("status") === "1");
    await otherPage.goto("/");
    expect((await synced).ok()).toBe(true);
    await expect(otherPage.getByRole("button", { name: "Open chat", exact: true })).toBeVisible();
    await expect(otherPage.locator(".shelf-chat-unread")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await senderContext.close();
    await secondDevice.close();
    for (const id of members) expect((await request.patch(`/api/admin/users/${id}`, { data: { disabled: true } })).ok()).toBe(true);
  }
});

test("a chat response delivered after the tab becomes hidden does not mark messages read", async ({ page }) => {
  const user = await signIn(page.request);
  const messages: ChatMessage[] = [{ id: 1, userId: "another-reader", username: "reader", body: "Earlier message", createdAt: "2026-01-01T00:00:00.000Z" }];
  let cursor = 1;
  let holdNextHistory = false;
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes: number[] = [];
  const status = () => ({ lastReadMessageId: cursor, latestMessageId: messages.at(-1)!.id,
    hasUnread: messages.some(message => message.id > cursor && message.userId !== user.id) });
  await page.route("**/api/chat**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/chat/read") {
      const messageId = route.request().postDataJSON().messageId as number;
      writes.push(messageId);
      cursor = Math.max(cursor, messageId);
      return route.fulfill({ json: { readState: status() } });
    }
    if (url.pathname !== "/api/chat") return route.continue();
    if (url.searchParams.has("status")) return route.fulfill({ json: { readState: status() } });
    if (holdNextHistory) {
      holdNextHistory = false;
      received.resolve();
      await release.promise;
    }
    return route.fulfill({ json: { messages, readState: status() } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^Open chat/ }).click();
  const dialog = page.getByRole("dialog", { name: "Chat", exact: true });
  await expect(dialog.getByText("Earlier message", { exact: true })).toBeVisible();
  messages.push({ id: 2, userId: "another-reader", username: "reader", body: "Arrived while hidden", createdAt: "2026-01-01T00:01:00.000Z" });
  holdNextHistory = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await received.promise;
  // Model visibility changing just before an in-flight response is processed.
  // Delaying the event isolates the read guard from the request-abort handler.
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat"
    && !new URL(response.url()).searchParams.has("status"));
  release.resolve();
  await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(writes).toEqual([]);
  expect(cursor).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(dialog.getByText("Arrived while hidden", { exact: true })).toBeVisible();
  await expect.poll(() => writes).toContain(2);
});

test("sending a reply cannot mark an intervening unseen message read before history arrives", async ({ page }) => {
  const user = await signIn(page.request);
  const earlier: ChatMessage = { id: 1, userId: "another-reader", username: "reader", body: "Already read", createdAt: "2026-01-01T00:00:00.000Z" };
  const incoming: ChatMessage = { id: 2, userId: "another-reader", username: "reader", body: "Intervening reply", createdAt: "2026-01-01T00:01:00.000Z" };
  const own: ChatMessage = { id: 3, userId: user.id, username: user.username, body: "My reply", createdAt: "2026-01-01T00:02:00.000Z" };
  let posted = false;
  let includeNewHistory = false;
  let cursor = 1;
  const writes: number[] = [];
  const status = () => ({ lastReadMessageId: cursor, latestMessageId: posted ? 3 : 1, hasUnread: posted && cursor < 2 });
  await page.route("**/api/chat**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/chat/read") {
      const messageId = route.request().postDataJSON().messageId as number;
      writes.push(messageId);
      cursor = Math.max(cursor, messageId);
      return route.fulfill({ json: { readState: status() } });
    }
    if (url.pathname !== "/api/chat") return route.continue();
    if (route.request().method() === "POST") {
      posted = true;
      return route.fulfill({ status: 201, json: { message: own } });
    }
    if (url.searchParams.has("status")) return route.fulfill({ json: { readState: status() } });
    return route.fulfill({ json: { messages: includeNewHistory ? [earlier, incoming, own] : [earlier], readState: status() } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^Open chat/ }).click();
  const dialog = page.getByRole("dialog", { name: "Chat", exact: true });
  await expect(dialog.getByText(earlier.body, { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Message", exact: true }).fill(own.body);
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(dialog.getByText(own.body, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(dialog.getByText(incoming.body, { exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(cursor).toBe(1);

  includeNewHistory = true;
  await refreshChat(page);
  await expect(dialog.getByText(incoming.body, { exact: true })).toBeVisible();
  await expect.poll(() => writes).toContain(3);
});
