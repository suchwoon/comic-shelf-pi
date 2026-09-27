import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

const [input, output, requestedPage] = process.argv.slice(2);
let task;
try {
  const pageNumber = Number(requestedPage);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error("Invalid page");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = join(process.cwd(), "node_modules", "pdfjs-dist");
  task = getDocument({
    url: pathToFileURL(input).href,
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    verbosity: 0,
    maxImageSize: 40_000_000,
    canvasMaxAreaInBytes: 16_000_000,
    cMapUrl: join(assets, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(assets, "standard_fonts") + "/",
    wasmUrl: join(assets, "wasm") + "/",
  });
  const document = await task.promise;
  if (pageNumber > document.numPages) throw new Error("Invalid page");
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid page size");
  const scale = Math.min(2400 / viewport.width, 2400 / viewport.height, Math.sqrt(6_000_000 / viewport.width / viewport.height));
  const target = page.getViewport({ scale });
  const width = Math.max(1, Math.min(2400, Math.floor(target.width)));
  const height = Math.max(1, Math.min(2400, Math.floor(target.height)));
  const canvas = createCanvas(width, height);
  await page.render({ canvasContext: canvas.getContext("2d"), canvas, viewport: target, background: "white" }).promise;
  await writeFile(output, canvas.toBuffer("image/jpeg", 88), { flag: "wx", mode: 0o600 });
  page.cleanup();
  await task.destroy();
  process.stdout.write(JSON.stringify({ width, height }) + "\n");
} catch {
  // Do not return PDF contents or internal paths in renderer errors.
  await task?.destroy().catch(() => undefined);
  process.exitCode = 2;
}
