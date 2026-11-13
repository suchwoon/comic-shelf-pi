import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PDFDocument, rgb } from "pdf-lib";
import type { Book } from "../lib/types";

interface CoverFixtures { books: Book[]; titles: Set<string> }

async function signIn(request: APIRequestContext) {
  const response = await request.post("/api/session", {
    data: { username: "admin", password: "test-only-comic-shelf-passphrase" },
  });
  expect(response.status()).toBe(200);
}

const test = base.extend<{ coverFixtures: CoverFixtures }>({
  coverFixtures: [async ({ request }, use) => {
    const fixtures: CoverFixtures = { books: [], titles: new Set() };
    await use(fixtures);
    // Use a separate request context so teardown still works after closing the page.
    await signIn(request);
    const library = await request.get("/api/books");
    expect(library.status()).toBe(200);
    for (const book of (await library.json()).books as Book[]) {
      if (fixtures.titles.has(book.title)) {
        expect((await request.delete(`/api/books/${book.id}`)).status()).toBe(204);
      }
    }
  }, { timeout: 45_000 }],
});

test("renders responsive covers and revalidates them when returning to the shelf", async ({ page, context, coverFixtures }, testInfo) => {
  await signIn(page.request);
  const aspectRatios = new Map<string, number>();
  for (let index = 0; index < 6; index++) {
    const title = `Cover ${randomUUID()} story`;
    coverFixtures.titles.add(title);
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    const [width, height] = index % 2 ? [600, 400] : [400, 600];
    const cover = pdf.addPage([width, height]);
    cover.drawRectangle({ x: 0, y: 0, width, height, color: rgb(.15 + index * .1, .25, .65) });
    cover.drawRectangle({ x: 30, y: 30, width: width - 60, height: height - 60, borderWidth: 8, borderColor: rgb(1, 1, 1) });
    pdf.addPage([width, height]);
    const uploaded = await page.request.post("/api/books", {
      headers: { "Content-Type": "application/pdf", "X-File-Name": `${title}.pdf` },
      data: Buffer.from(await pdf.save()),
    });
    expect(uploaded.status()).toBe(201);
    const book = (await uploaded.json()).book as Book;
    coverFixtures.books.push(book);
    aspectRatios.set(book.id, width / height);
  }
  const readingBook = coverFixtures.books[0];
  expect((await page.request.patch(`/api/books/${readingBook.id}/progress`, {
    data: { currentPage: 1 },
  })).status()).toBe(200);

  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const coverPaths = new Set(coverFixtures.books.map(book => `/api/books/${book.id}/cover`));
  const webpResponses: string[] = [];
  page.on("response", response => {
    if (coverPaths.has(new URL(response.url()).pathname) && response.headers()["content-type"]?.startsWith("image/webp")) {
      webpResponses.push(response.url());
    }
  });

  // Browser-facing responses merge a 304 with cached headers into a 200. CDP
  // exposes the actual network status without disabling the browser cache.
  const network = await context.newCDPSession(page);
  await network.send("Network.enable");
  const requestUrls = new Map<string, string>();
  const wireResponses: Array<{ requestId: string; status: number }> = [];
  network.on("Network.requestWillBeSent", event => requestUrls.set(event.requestId, event.request.url));
  network.on("Network.responseReceivedExtraInfo", event => wireResponses.push({ requestId: event.requestId, status: event.statusCode }));

  try {
    await page.goto("/");
    const gridImages = page.locator(".shelf-book-grid .shelf-cover > img");
    await expect(gridImages).toHaveCount(6);
    for (let index = 0; index < 6; index++) {
      const image = gridImages.nth(index);
      await expect(image).toHaveAttribute("loading", index < 5 ? "eager" : "lazy");
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(element => {
        const img = element as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      })).toBe(true);
      const dimensions = await image.evaluate(element => {
        const img = element as HTMLImageElement;
        const bounds = img.getBoundingClientRect();
        const parent = img.parentElement!.getBoundingClientRect();
        return {
          src: img.currentSrc, width: bounds.width, height: bounds.height, dpr: devicePixelRatio,
          fits: bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1
            && bounds.top >= parent.top - 1 && bounds.bottom <= parent.bottom + 1,
        };
      });
      const source = new URL(dimensions.src);
      expect(coverPaths.has(source.pathname)).toBe(true);
      const variantWidth = Number(source.searchParams.get("w"));
      expect([320, 480, 680]).toContain(variantWidth);
      expect(variantWidth).toBeGreaterThanOrEqual(Math.min(dimensions.width * dimensions.dpr, 680) * .9);
      expect(dimensions.width).toBeGreaterThan(0);
      expect(dimensions.height).toBeGreaterThan(0);
      const bookId = source.pathname.split("/")[3];
      expect(dimensions.width / dimensions.height).toBeCloseTo(aspectRatios.get(bookId)!, 2);
      expect(dimensions.fits).toBe(true);
    }
    const continueImage = page.locator(".shelf-continue img");
    await expect(continueImage).toHaveAttribute("loading", "eager");
    await expect.poll(() => continueImage.evaluate(element => {
      const img = element as HTMLImageElement;
      return img.complete && img.naturalWidth > 0 && new URL(img.currentSrc).searchParams.get("w") === "96";
    })).toBe(true);
    await expect(page.locator(".shelf-cover-fallback")).toHaveCount(0);
    expect(webpResponses.length).toBeGreaterThanOrEqual(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("responsive-covers.png"), fullPage: true });

    wireResponses.length = 0;
    await page.reload();
    await expect.poll(() => gridImages.first().evaluate(element => {
      const img = element as HTMLImageElement;
      return img.complete && img.naturalWidth > 0;
    })).toBe(true);
    await expect.poll(() => wireResponses.some(response => {
      const url = requestUrls.get(response.requestId);
      return response.status === 304 && !!url && coverPaths.has(new URL(url).pathname);
    }), { message: "Returning to the shelf should validate cached covers with a body-free 304 response" }).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await network.detach().catch(() => undefined);
    await page.goto("about:blank").catch(() => undefined);
  }
});
