import { test, expect, type Locator, type Page } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";

const storageKey = "comic-shelf-theme";

async function expectTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
  await expect(page.locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(20, 20, 20)" : "rgb(250, 250, 250)");
}

async function expectReadableDarkControl(locator: Locator) {
  const colors = await locator.evaluate(element => {
    const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const luminance = (color: number[]) => color.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(channels(getComputedStyle(element).color));
    let ancestor: Element | null = element;
    let background = [255, 255, 255];
    while (ancestor) {
      const candidate = channels(getComputedStyle(ancestor).backgroundColor);
      if (candidate.length === 3 || candidate[3] === 1) {
        background = candidate;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    const backdrop = luminance(background);
    return { contrast: (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05), backdrop };
  });
  expect(colors.backdrop).toBeLessThan(0.08);
  expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
}

test("appearance follows the system until overridden and keeps the choice after reload", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
  await expect(appearance).toHaveValue("system");
  await expectTheme(page, "dark");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("dark-sign-in.png"), fullPage: true });

  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  await appearance.selectOption("dark");
  await expectTheme(page, "dark");
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe("dark");
  await page.reload();
  await expect(appearance).toHaveValue("dark");
  await expectTheme(page, "dark");

  await appearance.selectOption("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#fafafa");
  await page.reload();
  await expect(appearance).toHaveValue("light");
  await expectTheme(page, "light");
  await appearance.selectOption("system");
  await expectTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  expect(errors).toEqual([]);
});

test("saved appearance and invalid-preference fallback apply before hydration", async ({ context }) => {
  for (const saved of ["dark", "invalid-preference"]) {
    const page = await context.newPage();
    try {
      await page.emulateMedia({ colorScheme: saved === "dark" ? "light" : "dark" });
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: saved });
      // The inline head initializer still runs, but React cannot hydrate the page.
      await page.route(/\/_next\/.*\.js(?:\?|$)/, route => route.abort());
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expectTheme(page, "dark");
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#141414");
    } finally {
      await page.close();
    }
  }
});

test("appearance still works when browser storage is unavailable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage is unavailable", "SecurityError"); },
    });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
  await expectTheme(page, "dark");
  await appearance.selectOption("light");
  await expectTheme(page, "light");
  await appearance.selectOption("system");
  await expectTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("appearance persists on invitations and synchronizes between tabs", async ({ page, context }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
  await page.goto("/join");
  await expectTheme(page, "dark");
  await expect(page.getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue("dark");
  await expect(page.getByRole("heading", { name: "Invitation unavailable", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("dark-invitation.png"), fullPage: true });

  const otherTab = await context.newPage();
  try {
    await otherTab.emulateMedia({ colorScheme: "dark" });
    await otherTab.goto("/");
    await expect(otherTab.getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue("dark");
    await otherTab.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("light");
    await expectTheme(page, "light");
    await expect(page.getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue("light");
    await otherTab.evaluate(key => localStorage.removeItem(key), storageKey);
    await expectTheme(page, "dark");
    await expect(page.getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue("system");
  } finally {
    await otherTab.close();
  }
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3210/");
  await expectTheme(page, "dark");
});

test("dark admin controls and account dialog remain readable and fit a 320px screen", async ({ page }, testInfo) => {
  const session = await page.request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  });
  expect(session.status()).toBe(200);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
  await expect(page.getByRole("button", { name: "Account settings", exact: true })).toBeVisible();
  await expectTheme(page, "dark");
  await page.screenshot({ path: testInfo.outputPath("dark-library.png"), fullPage: true });

  await page.setViewportSize({ width: 320, height: 800 });
  const header = page.locator(".shelf-header");
  for (const control of [
    header.getByRole("combobox", { name: "Appearance", exact: true }),
    header.getByRole("button", { name: "Upload PDF", exact: true }),
    header.getByRole("button", { name: "Account settings", exact: true }),
    header.getByRole("button", { name: "Sign out", exact: true }),
  ]) {
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectReadableDarkControl(page.getByRole("combobox", { name: "Appearance", exact: true }));
  await page.screenshot({ path: testInfo.outputPath("dark-library-320px.png"), fullPage: true });
  await page.getByRole("button", { name: "Account settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Account settings", exact: true });
  await expect(dialog).toBeVisible();
  await expectReadableDarkControl(dialog);
  await expectReadableDarkControl(dialog.getByLabel("Current password", { exact: true }));
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("dark-account-320px.png"), fullPage: true });
});

test("dark appearance preserves cover and PDF colors and the reader stays dark in light mode", async ({ page, context }, testInfo) => {
  const session = await page.request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  });
  expect(session.status()).toBe(200);
  const pdf = await PDFDocument.create();
  pdf.setSubject(`Theme colors ${Date.now()} ${testInfo.project.name}`);
  pdf.addPage([400, 600]).drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0.8, 0.2, 0.1) });
  const upload = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "Theme colors.pdf" },
    data: Buffer.from(await pdf.save()),
  });
  expect(upload.status()).toBe(201);
  const { book } = await upload.json();
  let otherTab: Page | undefined;
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
    const cover = page.getByRole("link", { name: "Read Theme colors", exact: true }).locator("img");
    await expect.poll(() => cover.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await cover.evaluate(element => {
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).filter !== "none") return false;
      }
      return true;
    })).toBe(true);
    const coverPixel = await cover.evaluate(element => {
      const image = element as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const drawing = canvas.getContext("2d")!;
      drawing.drawImage(image, 0, 0, 1, 1);
      return Array.from(drawing.getImageData(0, 0, 1, 1).data).slice(0, 3);
    });
    for (const [index, channel] of [204, 51, 26].entries()) expect(Math.abs(coverPixel[index] - channel)).toBeLessThanOrEqual(4);
    await page.getByRole("link", { name: "Read Theme colors", exact: true }).click();
    const canvas = page.getByTestId("pdf-page");
    await expect(canvas).toHaveAttribute("data-page", "1");
    await expect(page.locator(".reader-page-surface")).toHaveAttribute("aria-busy", "false");
    const pixel = async () => canvas.evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      return Array.from(canvas.getContext("2d")!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data).slice(0, 3);
    });
    const original = await pixel();
    for (const [index, channel] of [204, 51, 26].entries()) expect(Math.abs(original[index] - channel)).toBeLessThanOrEqual(4);
    expect(await canvas.evaluate(element => {
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).filter !== "none") return false;
      }
      return true;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("dark-reader-original-colors.png"), fullPage: true });

    otherTab = await context.newPage();
    await otherTab.goto("/");
    await otherTab.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("light");
    await expectTheme(page, "light");
    await expect(page.locator(".reader-root")).toHaveCSS("background-color", "rgb(20, 20, 20)");
    await expect(page.locator(".reader-root")).toHaveCSS("color-scheme", "dark");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#141414");
    expect(await pixel()).toEqual(original);
  } finally {
    await otherTab?.close();
    await page.goto("about:blank");
    expect((await page.request.delete(`/api/books/${book.id}`)).status()).toBe(204);
  }
});
