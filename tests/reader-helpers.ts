import { expect, type Page } from "@playwright/test";

export async function revealReaderControls(page: Page) {
  const reader = page.locator(".reader-root");
  await expect(reader).toBeVisible();
  if (await reader.evaluate(element => element.classList.contains("reader-touch"))) {
    const reveal = page.getByRole("button", { name: "Show controls (center area)", exact: true });
    if (await reveal.isVisible()) await reveal.tap();
  }
  await expect(page.getByRole("button", { name: "Hide controls", exact: true })).toBeVisible();
}

export async function openReaderSettings(page: Page) {
  await revealReaderControls(page);
  const toggle = page.getByRole("button", { name: "Reading settings", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("dialog", { name: "Reading settings", exact: true })).toBeVisible();
}
