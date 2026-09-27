import { expect, type Page } from "@playwright/test";

async function setReaderControls(page: Page, visible: boolean) {
  const reader = page.locator(".reader-root");
  await expect(reader).toBeVisible();
  const touchReader = await reader.evaluate(element => element.classList.contains("reader-touch"));
  const toggle = page.getByRole("button", {
    name: `${visible ? "Show" : "Hide"} controls (${touchReader ? "center" : "page"} area)`, exact: true,
  });
  if (await toggle.isVisible()) {
    if (touchReader) await toggle.tap();
    else await toggle.click();
  }
  if (visible) await expect(page.getByRole("button", { name: "Two-page view", exact: true })).toBeVisible();
  else await expect(reader).toHaveClass(/reader-controls-hidden/);
}

export async function revealReaderControls(page: Page) {
  await setReaderControls(page, true);
}

export async function hideReaderControls(page: Page) {
  await setReaderControls(page, false);
}
