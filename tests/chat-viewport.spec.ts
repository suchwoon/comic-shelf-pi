import { test, expect } from "@playwright/test";

test("chat launcher keeps its native bottom anchor during transient visual viewport events", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Uses a tablet-sized viewport");
  await page.setViewportSize({ width: 820, height: 1180 });
  expect((await page.request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  })).ok()).toBe(true);
  await page.goto("/");
  const launcher = page.getByRole("button", { name: "Open chat", exact: true });
  await expect(launcher).toBeVisible();

  // Regression: the launcher used to chase these transient values through JS.
  // This checks removal of that feedback, not iOS native compositor behavior.
  const viewport = async (height: number, offsetTop: number, scale = 1, event = "resize") => {
    await page.evaluate(({ height, offsetTop, scale, event }) => {
      for (const [name, value] of Object.entries({ height, offsetTop, scale })) {
        Object.defineProperty(window.visualViewport!, name, { configurable: true, get: () => value });
      }
      window.visualViewport!.dispatchEvent(new Event(event));
    }, { height, offsetTop, scale, event });
  };
  const expectBottom = async (bottom: number) => {
    await expect.poll(() => launcher.evaluate(element => element.getBoundingClientRect().bottom)).toBeCloseTo(bottom, 1);
  };

  await expectBottom(1180 - 24);
  await viewport(1002.5, 0);
  await page.waitForTimeout(100);
  await expectBottom(1180 - 24);
  await viewport(1002.5, 86.5, 1, "scroll");
  await page.waitForTimeout(100);
  await expectBottom(1180 - 24);
  await viewport(501.25, 150, 2);
  await page.waitForTimeout(100);
  await expectBottom(1180 - 24);
  await viewport(1180, 0);
  await expectBottom(1180 - 24);

  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Chat", exact: true });
  await expect(dialog).toBeVisible();
  // Only the open mobile chat uses keyboard viewport positioning.
  await viewport(940, 12);
  await dialog.getByRole("button", { name: "Close chat", exact: true }).click();
  await expectBottom(1180 - 24);
});
