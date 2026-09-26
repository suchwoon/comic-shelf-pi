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
