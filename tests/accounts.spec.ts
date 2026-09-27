import { test, expect, devices, type APIRequestContext } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { revealReaderControls } from "./reader-helpers";

const adminPassword = "test-only-comic-shelf-passphrase";
const readerPassword = "private-reader-test-passphrase";

async function adminLogin(request: APIRequestContext) {
  const response = await request.post("/api/session", { data: { username: "admin", password: adminPassword } });
  expect(response.status()).toBe(200);
}

test("an invited reader can read with personal progress but cannot download originals or manage the library", async ({ page, browser }, testInfo) => {
  await adminLogin(page.request);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Account permissions ${Date.now()} ${testInfo.project.name}`);
  for (let number = 0; number < 4; number++) pdf.addPage([400, 600]);
  const file = Buffer.from(await pdf.save());
  const upload = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "Members test.pdf" }, data: file,
  });
  expect(upload.status()).toBe(201);
  const { book } = await upload.json();
  const endpoint = `/api/books/${book.id}`;
  const memberContext = await browser.newContext({
    ...(testInfo.project.name === "mobile" ? devices["Pixel 7"] : { viewport: { width: 1440, height: 1000 } }),
    baseURL: "http://127.0.0.1:3210",
  });
  let uploadSessionId: string | undefined;
  let readerId: string | undefined;
  try {
    expect((await page.request.patch(`${endpoint}/progress`, { data: { currentPage: 3 } })).status()).toBe(200);
    await page.goto("/");
    await page.getByRole("button", { name: "Account settings", exact: true }).click();
    await page.getByRole("button", { name: "Manage members", exact: true }).click();
    await page.getByRole("button", { name: "Create invitation", exact: true }).click();
    const invitationLink = page.getByLabel("Invitation link", { exact: true });
    await expect(invitationLink).toHaveValue(/\/join#token=/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("account-invitation.png"), fullPage: true });
    const url = await invitationLink.inputValue();
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token");
    const reader = await memberContext.newPage();
    const errors: string[] = [];
    const originalRequests: string[] = [];
    const pdfResponses: string[] = [];
    const pageImages: string[] = [];
    reader.on("pageerror", error => errors.push(error.message));
    reader.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/file")) originalRequests.push(request.url());
    });
    reader.on("response", response => {
      if (response.headers()["content-type"]?.includes("application/pdf")) pdfResponses.push(response.url());
      if (new URL(response.url()).pathname.startsWith(`${endpoint}/pages/`) && response.ok()
        && response.headers()["content-type"]?.startsWith("image/jpeg")) pageImages.push(new URL(response.url()).pathname);
    });
    await reader.goto(url);
    await reader.getByLabel("Username", { exact: true }).fill(`reader_${Date.now()}`);
    await reader.getByLabel("Password", { exact: true }).fill(readerPassword);
    await reader.getByLabel("Confirm password", { exact: true }).fill(readerPassword);
    await reader.screenshot({ path: testInfo.outputPath("invited-reader-signup.png"), fullPage: true });
    await reader.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(reader).toHaveURL("http://127.0.0.1:3210/");
    await expect(reader.getByRole("link", { name: "Read Members test", exact: true })).toBeVisible();
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await expect(reader.getByRole("button", { name: "Upload PDF", exact: true })).toHaveCount(0);
    await expect(reader.getByLabel("Choose PDF files")).toHaveCount(0);
    await expect(reader.getByLabel("Manage Members test", { exact: true })).toHaveCount(0);
    await expect(reader.getByRole("link", { name: "Download Members test", exact: true })).toHaveCount(0);
    await expect(reader.locator(`a[href*="${endpoint}/file"]`)).toHaveCount(0);
    const session = await (await memberContext.request.get("/api/session")).json();
    expect(session.user.role).toBe("reader");
    readerId = session.user.id;
    expect((await memberContext.request.post("/api/register", {
      data: { token, username: `reuse_${Date.now()}`, password: readerPassword, role: "admin" },
    })).ok()).toBe(false);

    expect((await memberContext.request.post("/api/books", {
      headers: { "Content-Type": "application/pdf", "X-File-Name": "forbidden.pdf" }, data: file,
    })).status()).toBe(403);
    expect((await memberContext.request.patch(endpoint, { data: { title: "Forbidden rename" } })).status()).toBe(403);
    expect((await memberContext.request.delete(endpoint)).status()).toBe(403);
    expect((await memberContext.request.get("/api/admin/users")).status()).toBe(403);
    expect((await memberContext.request.post("/api/admin/invitations", { data: {} })).status()).toBe(403);
    expect((await memberContext.request.post("/api/uploads", { data: { name: "forbidden.pdf", size: 9 * 1024 * 1024 } })).status()).toBe(403);
    const start = await page.request.post("/api/uploads", { data: { name: "unfinished.pdf", size: 9 * 1024 * 1024 } });
    expect(start.status()).toBe(201);
    uploadSessionId = (await start.json()).id;
    expect((await memberContext.request.patch(`/api/uploads/${uploadSessionId}`, {
      headers: { "Content-Type": "application/octet-stream", "Upload-Offset": "0" }, data: Buffer.from("blocked"),
    })).status()).toBe(403);
    expect((await memberContext.request.post(`/api/uploads/${uploadSessionId}/complete`)).status()).toBe(403);
    expect((await memberContext.request.delete(`/api/uploads/${uploadSessionId}`)).status()).toBe(403);

    const before = await (await memberContext.request.get(endpoint)).json();
    expect(before.book.currentPage).toBe(1);
    expect(before.book.lastReadAt).toBeNull();
    for (const attempt of [
      { method: "GET" },
      { method: "HEAD" },
      { method: "GET", headers: { Range: "bytes=0-4" } },
      { method: "HEAD", headers: { Range: "bytes=0-4" } },
      { method: "GET", headers: { Range: "bytes=999999999-" } },
    ]) {
      const denied = await memberContext.request.fetch(`${endpoint}/file`, attempt);
      expect(denied.status()).toBe(403);
      expect(denied.headers()["content-type"]).not.toContain("application/pdf");
      expect(denied.headers()["content-range"]).toBeUndefined();
      expect((await denied.body()).includes(Buffer.from("%PDF-"))).toBe(false);
    }
    for (const query of ["?download=1", "?raw=true", "?role=admin", "?inline=1"]) {
      expect((await memberContext.request.get(`${endpoint}/file${query}`)).status()).toBe(403);
    }
    const image = await memberContext.request.get(`${endpoint}/pages/1`);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toMatch(/^image\/jpeg/);
    expect(image.headers()["cache-control"]).toContain("no-store");
    expect((await image.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    await reader.getByRole("link", { name: "Read Members test", exact: true }).click();
    await expect(reader.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    await revealReaderControls(reader);
    await reader.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(reader.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
    await expect.poll(async () => (await (await memberContext.request.get(endpoint)).json()).book.currentPage).toBe(2);
    await reader.reload();
    await expect(reader.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
    await revealReaderControls(reader);
    await reader.getByRole("link", { name: "Back to library", exact: true }).click();
    await expect(reader).toHaveURL("http://127.0.0.1:3210/");
    expect((await (await memberContext.request.get(endpoint)).json()).book.currentPage).toBe(2);
    expect((await (await page.request.get(endpoint)).json()).book.currentPage).toBe(3);
    expect(pageImages).toContain(`${endpoint}/pages/1`);
    expect(pageImages).toContain(`${endpoint}/pages/2`);
    expect(originalRequests).toEqual([]);
    expect(pdfResponses).toEqual([]);
    expect(errors).toEqual([]);

    expect((await page.request.patch(`/api/admin/users/${readerId}`, { data: { disabled: true } })).status()).toBe(200);
    expect((await memberContext.request.get(endpoint)).status()).toBe(401);
    expect((await memberContext.request.get(`${endpoint}/file`)).status()).toBe(401);
    expect((await memberContext.request.head(`${endpoint}/file`)).status()).toBe(401);
    expect((await memberContext.request.get(`${endpoint}/pages/1`)).status()).toBe(401);
    expect((await memberContext.request.head(`${endpoint}/pages/1`)).status()).toBe(401);
    expect((await page.request.get(endpoint)).status()).toBe(200);
  } finally {
    await memberContext.close();
    if (readerId) await page.request.patch(`/api/admin/users/${readerId}`, { data: { disabled: true } });
    if (uploadSessionId) await page.request.delete(`/api/uploads/${uploadSessionId}`);
    expect((await page.request.delete(endpoint)).status()).toBe(204);
  }
});

test("members change their password and administrators provide one-use recovery links", async ({ page, browser }, testInfo) => {
  await adminLogin(page.request);
  const invitation = await page.request.post("/api/admin/invitations", { data: {} });
  expect(invitation.status()).toBe(201);
  const { token } = await invitation.json();
  const username = `password_${Date.now()}`;
  const context = await browser.newContext({
    ...(testInfo.project.name === "mobile" ? devices["Pixel 7"] : { viewport: { width: 1440, height: 1000 } }),
    baseURL: "http://127.0.0.1:3210",
  });
  const secondContext = await browser.newContext({ baseURL: "http://127.0.0.1:3210" });
  let readerId: string | undefined;
  try {
    const registered = await context.request.post("/api/register", { data: { token, username, password: readerPassword } });
    expect(registered.status()).toBe(201);
    readerId = (await registered.json()).user.id;
    expect((await secondContext.request.post("/api/session", { data: { username, password: readerPassword } })).status()).toBe(200);
    const reader = await context.newPage();
    await reader.goto("/");
    await reader.getByRole("button", { name: "Account settings", exact: true }).click();
    await expect(reader.getByRole("button", { name: "Create invitation", exact: true })).toHaveCount(0);
    await reader.getByLabel("Current password", { exact: true }).fill(readerPassword);
    await reader.getByLabel("New password", { exact: true }).fill("changed-private-test-password");
    await reader.getByLabel("Confirm new password", { exact: true }).fill("changed-private-test-password");
    const changed = reader.waitForResponse(response => response.url().endsWith("/api/session") && response.request().method() === "PATCH");
    await reader.getByRole("button", { name: "Change password", exact: true }).click();
    expect((await changed).status()).toBe(200);
    expect((await secondContext.request.get("/api/books")).status()).toBe(401);
    expect((await context.request.get("/api/books")).status()).toBe(200);
    const recovery = await page.request.post("/api/admin/invitations", { data: { userId: readerId } });
    expect(recovery.status()).toBe(201);
    const recoveryToken = (await recovery.json()).token;
    await reader.goto(`/join#token=${recoveryToken}`);
    await expect(reader.getByLabel("Username", { exact: true })).toHaveValue(username);
    await reader.getByLabel("Password", { exact: true }).fill("recovered-private-test-password");
    await reader.getByLabel("Confirm password", { exact: true }).fill("recovered-private-test-password");
    await reader.getByRole("button", { name: "Save new password", exact: true }).click();
    await expect(reader).toHaveURL("http://127.0.0.1:3210/");
    expect((await context.request.post("/api/register", { data: { token: recoveryToken, username, password: readerPassword } })).ok()).toBe(false);
    expect((await secondContext.request.post("/api/session", { data: { username, password: "recovered-private-test-password" } })).status()).toBe(200);
    expect((await secondContext.request.delete("/api/session")).status()).toBe(200);
    expect((await secondContext.request.get("/api/books")).status()).toBe(401);
  } finally {
    await context.close();
    await secondContext.close();
    if (readerId) await page.request.patch(`/api/admin/users/${readerId}`, { data: { disabled: true } });
  }
});
