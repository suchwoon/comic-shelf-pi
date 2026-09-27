import { test, expect, devices, type APIRequestContext, type Page } from "@playwright/test";

async function adminLogin(request: APIRequestContext) {
  const response = await request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  });
  expect(response.status()).toBe(200);
}

function isChatRequest(url: string) {
  return new URL(url).pathname === "/api/chat";
}

async function openChat(page: Page) {
  const loaded = page.waitForResponse(response => isChatRequest(response.url()) && response.request().method() === "GET");
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  expect((await loaded).status()).toBe(200);
  const dialog = page.getByRole("dialog", { name: "Chat", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function sendMessage(page: Page, body: string) {
  const dialog = page.getByRole("dialog", { name: "Chat", exact: true });
  await dialog.getByRole("textbox", { name: "Message", exact: true }).fill(body);
  const sent = page.waitForResponse(response => isChatRequest(response.url()) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  expect((await sent).ok()).toBe(true);
  await expect(dialog.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
  await expect(dialog.getByText(body, { exact: true })).toBeVisible();
}

test("members share one chat and saved messages survive closing and reloading", async ({ page, browser }, testInfo) => {
  await adminLogin(page.request);
  const invitation = await page.request.post("/api/admin/invitations", { data: {} });
  expect(invitation.status()).toBe(201);
  const { token } = await invitation.json();
  const username = `chat_${Date.now()}`;
  const memberContext = await browser.newContext({
    ...(testInfo.project.name === "mobile" ? devices["Pixel 7"] : { viewport: { width: 1440, height: 1000 } }),
    baseURL: "http://127.0.0.1:3210",
  });
  let readerId: string | undefined;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const registered = await memberContext.request.post("/api/register", {
      data: { token, username, password: "reader12" },
    });
    expect(registered.status()).toBe(201);
    readerId = (await registered.json()).user.id;
    const reader = await memberContext.newPage();
    reader.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await reader.goto("/");
    const adminChat = await openChat(page);
    const readerChat = await openChat(reader);
    const greeting = `함께 읽어요 ${Date.now()} <b data-chat-injected>hello</b>`;
    await sendMessage(page, greeting);
    await expect(readerChat.getByText(greeting, { exact: true })).toBeVisible();
    await expect(readerChat.locator("[data-chat-injected]")).toHaveCount(0);
    await expect(readerChat.getByText("admin", { exact: true }).first()).toBeVisible();

    const reply = `좋아요! ${Date.now()}`;
    await sendMessage(reader, reply);
    await expect(adminChat.getByText(reply, { exact: true })).toBeVisible();
    await expect(adminChat.getByText(username, { exact: true })).toBeVisible();
    await expect(adminChat.locator("time").last()).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);
    await adminChat.getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(adminChat).toHaveCount(0);
    await openChat(page);
    await expect(adminChat.getByText(reply, { exact: true })).toBeVisible();
    await page.reload();
    await openChat(page);
    await expect(adminChat.getByText(greeting, { exact: true })).toBeVisible();
    await expect(adminChat.getByText(reply, { exact: true })).toBeVisible();

    await adminChat.getByRole("button", { name: "Close chat", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByLabel("Library password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open chat", exact: true })).toHaveCount(0);
    await expect(adminChat).toHaveCount(0);
    expect((await page.request.get("/api/chat")).status()).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    await memberContext.close();
    if (readerId) {
      await adminLogin(page.request);
      expect((await page.request.patch(`/api/admin/users/${readerId}`, { data: { disabled: true } })).status()).toBe(200);
    }
  }
});

test("a failed send keeps the draft and retry saves exactly one message", async ({ page }) => {
  await adminLogin(page.request);
  await page.goto("/");
  const dialog = await openChat(page);
  const draft = `연결이 돌아오면 다시 보내요 ${Date.now()}`;
  const attempted: { body: string; clientId: string }[] = [];
  await page.route("**/api/chat", async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempted.push(route.request().postDataJSON());
    if (attempted.length === 1) {
      await route.fulfill({ status: 503, json: { error: "Chat is temporarily unavailable. Please try again." } });
    } else {
      await route.continue();
    }
  });
  const input = dialog.getByRole("textbox", { name: "Message", exact: true });
  await input.fill(draft);
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue(draft);
  await expect(dialog.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  const retried = page.waitForResponse(response => isChatRequest(response.url()) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  expect((await retried).ok()).toBe(true);
  await expect(input).toHaveValue("");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByText(draft, { exact: true })).toHaveCount(1);
  const history = await page.request.get("/api/chat");
  expect(history.status()).toBe(200);
  const { messages } = await history.json();
  expect(messages.filter((message: { body: string }) => message.body === draft)).toHaveLength(1);
  expect(attempted).toHaveLength(2);
  expect(attempted[0].clientId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(attempted[1].clientId).toBe(attempted[0].clientId);
});

test("chat fits the viewport in dark mode and Korean composition does not submit early", async ({ page }, testInfo) => {
  await adminLogin(page.request);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const dialog = await openChat(page);
  const input = dialog.getByRole("textbox", { name: "Message", exact: true });
  const body = `한글 입력 확인 ${Date.now()}\n${"긴메시지".repeat(30)}`;
  const posted: string[] = [];
  page.on("request", request => {
    if (isChatRequest(request.url()) && request.method() === "POST") posted.push(request.postDataJSON().body);
  });
  await input.fill(body);
  await input.dispatchEvent("compositionstart", { data: "인" });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
  await expect(input).toHaveValue(body);
  await input.dispatchEvent("compositionend", { data: "인" });
  const sent = page.waitForResponse(response => isChatRequest(response.url()) && response.request().method() === "POST");
  await input.press("Enter");
  expect((await sent).ok()).toBe(true);
  await expect(input).toHaveValue("");
  await expect(dialog.getByText(body, { exact: true })).toBeVisible();
  expect(posted).toEqual([body]);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await dialog.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= -1 && bounds.top >= -1 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1
      && element.scrollWidth <= element.clientWidth + 1
      && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  })).toBe(true);
  await expect(input).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Send message", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("shared-chat-dark.png"), fullPage: true });
});
