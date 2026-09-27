import { test, expect, type APIRequestContext } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

async function adminLogin(request: APIRequestContext) {
  const response = await request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  });
  expect(response.status()).toBe(200);
}

test("rename dialog preserves its draft on padding clicks and still closes on backdrop or Escape", async ({ page }, testInfo) => {
  await adminLogin(page.request);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Dialog padding ${Date.now()} ${testInfo.project.name}`);
  pdf.addPage([400, 600]);
  const upload = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "Dialog padding.pdf" },
    data: Buffer.from(await pdf.save()),
  });
  expect(upload.status()).toBe(201);
  const { book } = await upload.json();
  const endpoint = `/api/books/${book.id}`;
  try {
    await page.goto("/");
    const openRename = async () => {
      await page.getByLabel("Manage Dialog padding", { exact: true }).click();
      await page.getByRole("button", { name: "Rename", exact: true }).click();
    };
    await openRename();
    const dialog = page.getByRole("dialog", { name: "Rename book", exact: true });
    const title = dialog.getByLabel("Book title", { exact: true });
    await title.fill("An unfinished title");

    // This point hits the dialog itself, outside its child form.
    await dialog.click({ position: { x: 8, y: 8 } });
    await expect(dialog).toBeVisible();
    await expect(title).toHaveValue("An unfinished title");

    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    expect((await (await page.request.get(endpoint)).json()).book.title).toBe("Dialog padding");

    await openRename();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    expect((await page.request.delete(endpoint)).status()).toBe(204);
  }
});

test("account dialog retains password drafts and invitation links on padding clicks", async ({ page }) => {
  await adminLogin(page.request);
  let invitationId: string | undefined;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Account settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Account settings", exact: true });
    const currentPassword = dialog.getByLabel("Current password", { exact: true });
    const newPassword = dialog.getByLabel("New password", { exact: true });
    const confirmation = dialog.getByLabel("Confirm new password", { exact: true });
    await currentPassword.fill("unfinished-current-password");
    await newPassword.fill("unfinished-new-password");
    await confirmation.fill("unfinished-new-password");
    await dialog.click({ position: { x: 8, y: 8 } });
    await expect(dialog).toBeVisible();
    await expect(currentPassword).toHaveValue("unfinished-current-password");
    await expect(newPassword).toHaveValue("unfinished-new-password");
    await expect(confirmation).toHaveValue("unfinished-new-password");

    await dialog.getByRole("button", { name: "Manage members", exact: true }).click();
    const invitationCreated = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/admin/invitations" && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Create invitation", exact: true }).click();
    const response = await invitationCreated;
    expect(response.status()).toBe(201);
    invitationId = (await response.json()).invitation.id;
    const invitationLink = dialog.getByLabel("Invitation link", { exact: true });
    await expect(invitationLink).toHaveValue(/\/join#token=/);
    const link = await invitationLink.inputValue();
    await expect(dialog.getByRole("button", { name: "Create invitation", exact: true })).toBeEnabled();
    await dialog.click({ position: { x: 8, y: 8 } });
    await expect(dialog).toBeVisible();
    await expect(invitationLink).toHaveValue(link);

    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Account settings", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    if (invitationId) expect((await page.request.delete(`/api/admin/invitations/${invitationId}`)).status()).toBe(204);
  }
});
