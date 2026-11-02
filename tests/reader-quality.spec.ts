import { test, expect } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { revealReaderControls } from "./reader-helpers";

let fixture: Uint8Array;
const originalImages: string[] = [];

test.beforeAll(async () => {
  // Dense one-pixel strokes make an extra resize or lossy re-encode measurable,
  // without relying on installed fonts or a copyrighted scan as the fixture.
  const pdf = await PDFDocument.create();
  for (const [width, height] of [[1200, 1800], [1800, 1200]]) {
    const scan = createCanvas(width, height);
    const context = scan.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, scan.width, scan.height);
    context.fillStyle = "black";
    for (let row = 0; row < Math.floor((height - 80) / 24); row++) {
      for (let column = 0; column < Math.floor((width - 80) / 25); column++) {
        const x = 40 + column * 25;
        const y = 40 + row * 24;
        const stroke = 1 + (column % 2);
        context.fillRect(x, y, stroke, 17);
        context.fillRect(x, y, 14, stroke);
        context.fillRect(x, y + 8, 14, stroke);
        context.fillRect(x + 12, y + 8, stroke, 9);
        context.fillRect(x + 18, y + (row % 5), stroke, 17);
      }
    }
    const png = scan.toBuffer("image/png");
    originalImages.push(`data:image/png;base64,${png.toString("base64")}`);
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([scan.width, scan.height]);
    page.drawImage(image, { x: 0, y: 0, width: scan.width, height: scan.height });
  }
  fixture = await pdf.save();
});

test("preserves fine scan strokes when fitting a page to the screen", async ({ page }) => {
  const session = await page.request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  });
  expect(session.ok()).toBe(true);
  const uploaded = await page.request.post("/api/books", {
    headers: { "Content-Type": "application/pdf", "X-File-Name": "reader-quality-scan.pdf" },
    data: Buffer.from(fixture),
  });
  expect(uploaded.status()).toBe(201);
  const { book } = await uploaded.json();
  try {
    await page.goto(`/read/${book.id}`);
    const visible = page.getByTestId("pdf-page");
    for (let index = 0; index < originalImages.length; index++) {
      if (index > 0) {
        await revealReaderControls(page);
        await page.getByRole("textbox", { name: "Page number", exact: true }).fill(String(index + 1));
        await page.getByRole("textbox", { name: "Page number", exact: true }).press("Enter");
      }
      await expect(visible).toHaveAttribute("data-page", String(index + 1), { timeout: 40_000 });
      const comparison = await visible.evaluate(async (element, source) => {
        const actual = element as HTMLCanvasElement;
        const image = new Image();
        image.src = source;
        await image.decode();
        const expected = document.createElement("canvas");
        expected.width = actual.width;
        expected.height = actual.height;
        const expectedContext = expected.getContext("2d", { alpha: false })!;
        expectedContext.drawImage(image, 0, 0, expected.width, expected.height);
        const wanted = expectedContext.getImageData(0, 0, expected.width, expected.height).data;
        const received = actual.getContext("2d")!.getImageData(0, 0, actual.width, actual.height).data;
        let absoluteError = 0;
        let darkPixels = 0;
        for (let index = 0; index < wanted.length; index += 4) {
          absoluteError += Math.abs(wanted[index] - received[index]);
          if (wanted[index] < 128) darkPixels++;
        }
        return { meanError: absoluteError / (wanted.length / 4), darkPixels };
      }, originalImages[index]);
      expect(comparison.darkPixels).toBeGreaterThan(10_000);
      expect(comparison.meanError, "The fitted reader should retain the original scan's thin strokes").toBeLessThan(0.5);
    }
  } finally {
    await page.goto("about:blank").catch(() => {});
    expect((await page.request.delete(`/api/books/${book.id}`)).status()).toBe(204);
  }
});
