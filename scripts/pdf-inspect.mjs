import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

const [input, output] = process.argv.slice(2);
let task;
try {
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
  const pageCount = document.numPages;
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 50_000) throw new Error("Invalid page count");
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid page size");
  const scale = Math.min(680 / viewport.width, 940 / viewport.height);
  const target = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.ceil(target.width)), Math.max(1, Math.ceil(target.height)));
  await page.render({ canvasContext: canvas.getContext("2d"), canvas, viewport: target, background: "white" }).promise;
  await writeFile(output, canvas.toBuffer("image/jpeg", 80), { flag: "wx", mode: 0o600 });
  page.cleanup();
  await task.destroy();
  process.stdout.write(JSON.stringify({ pageCount }) + "\n");
} catch (error) {
  console.error(error?.name, error?.message);
  process.stdout.write(JSON.stringify({ error: error?.name === "PasswordException" ? "PASSWORD" : "INVALID" }) + "\n");
  await task?.destroy().catch(() => undefined);
  process.exitCode = 2;
}
