import { test, expect } from "@playwright/test";

test("viewport diagnostics are opt-in, record geometry without form content, and can be disabled", async ({ page }) => {
  expect((await page.request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  })).ok()).toBe(true);
  // Exercise the copy fallback too, without requiring clipboard permissions.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Account settings", exact: true })).toBeVisible();
  await expect(page.locator("[data-viewport-diagnostics]")).toHaveCount(0);
  await expect(page.locator("[data-viewport-probe]")).toHaveCount(0);
  await page.goto("/?viewport-debug=1");
  const panel = page.getByRole("complementary", { name: "화면 진단", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^화면 진단 ·/ }).click();
  await page.getByRole("button", { name: "Account settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Account settings", exact: true });
  const privateText = "diagnostic-must-not-record-this-field";
  await dialog.getByLabel("Current password", { exact: true }).fill(privateText);
  // Samples are deliberately throttled to avoid affecting the gesture being measured.
  await page.waitForTimeout(350);
  await dialog.getByRole("button", { name: "Close account settings", exact: true }).click();
  await panel.getByRole("button", { name: "진단 내용 복사", exact: true }).click();
  const copied = await panel.getByRole("textbox", { name: "복사할 화면 진단 내용", exact: true }).inputValue();
  const data = JSON.parse(copied);
  expect(copied).not.toContain(privateText);
  expect(data.userAgent).toBeTruthy();
  expect(data.samples.length).toBeGreaterThan(1);
  expect(data.samples.some((sample: { dialogs: { kind: string }[] }) => sample.dialogs.some(dialog => dialog.kind === "account"))).toBe(true);
  expect(data.samples.at(-1).probes.fixedBottom.rect.bottom).toBeGreaterThan(0);

  // Keep the opt-in across page changes in this tab, without putting the flag
  // on every link or exposing book identifiers in exported diagnostics.
  await page.goto("/read/viewport-diagnostic-check");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "화면 진단 끄기", exact: true }).click();
  await page.reload();
  await expect(page.locator(".reader-root")).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.goto("/?viewport-debug=1");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "화면 진단 끄기", exact: true }).click();
  await expect(page).not.toHaveURL(/viewport-debug/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Account settings", exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
});
