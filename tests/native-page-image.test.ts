import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { degrees, PDFDocument, rgb } from "pdf-lib";

const execFileAsync = promisify(execFile);
const width = 142;
const height = 213;
let directory: string;
let sourcePixels: Uint8ClampedArray;
let transparentPixels: Uint8ClampedArray;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "comic-native-page-test-"));
  const source = createCanvas(width, height);
  const context = source.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#202020";
  for (let y = 12; y < height - 12; y += 7) {
    for (let x = 9; x < width - 9; x += 6) {
      context.fillRect(x, y, 1, 5);
      context.fillRect(x, y + 2, 4, 1);
    }
  }
  context.fillStyle = "red";
  context.fillRect(0, 0, width, 3);
  context.fillStyle = "blue";
  context.fillRect(0, height - 3, width, 3);
  sourcePixels = context.getImageData(0, 0, width, height).data;
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(source.toBuffer("image/png"));
  const first = pdf.addPage([width, height]);
  first.drawImage(image, { x: 0, y: 0, width, height });
  // PDF points need not equal scan pixels: its original sampling must survive.
  const scaled = pdf.addPage([width / 2, height / 2]);
  scaled.drawImage(image, { x: 0, y: 0, width: width / 2, height: height / 2 });
  const rotated = pdf.addPage([width, height]);
  rotated.drawImage(image, { x: 0, y: 0, width, height });
  rotated.setRotation(degrees(90));
  const cropped = pdf.addPage([width, height]);
  cropped.drawImage(image, { x: 0, y: 0, width, height });
  cropped.setCropBox(8, 0, width - 8, height);
  const overlay = pdf.addPage([width, height]);
  overlay.drawImage(image, { x: 0, y: 0, width, height });
  overlay.drawRectangle({ x: 0, y: 0, width: 8, height: 8, color: rgb(0, 1, 0) });
  const mirrored = pdf.addPage([width, height]);
  mirrored.drawImage(image, { x: width, y: 0, width: -width, height });
  const translucent = pdf.addPage([width, height]);
  translucent.drawImage(image, { x: 0, y: 0, width, height, opacity: 0.5 });

  const transparent = createCanvas(width, height);
  const transparentContext = transparent.getContext("2d");
  transparentContext.fillStyle = "rgba(0, 0, 0, 0.5)";
  transparentContext.fillRect(0, 0, width, height / 3);
  transparentContext.fillStyle = "#123456";
  transparentContext.fillRect(0, height / 3, width, height / 3);
  const transparentPng = transparent.toBuffer("image/png");
  const transparentImage = await pdf.embedPng(transparentPng);
  const alphaPage = pdf.addPage([width, height]);
  alphaPage.drawImage(transparentImage, { x: 0, y: 0, width, height });
  transparentContext.globalCompositeOperation = "destination-over";
  transparentContext.fillStyle = "white";
  transparentContext.fillRect(0, 0, width, height);
  transparentPixels = transparentContext.getImageData(0, 0, width, height).data;

  const oversized = createCanvas(2500, 100);
  oversized.getContext("2d").fillRect(0, 0, 2500, 100);
  const oversizedImage = await pdf.embedPng(oversized.toBuffer("image/png"));
  const oversizedPage = pdf.addPage([2500, 100]);
  oversizedPage.drawImage(oversizedImage, { x: 0, y: 0, width: 2500, height: 100 });
  await writeFile(join(directory, "scans.pdf"), await pdf.save());
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function render(page: number) {
  const output = join(directory, `${page}.png`);
  const { stdout } = await execFileAsync(process.execPath, [
    "--max-old-space-size=384", "scripts/pdf-render-page.mjs", join(directory, "scans.pdf"), output, String(page),
  ], { timeout: 30_000 });
  const metadata = JSON.parse(stdout) as { width: number; height: number };
  const bytes = await readFile(output);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const image = await loadImage(bytes);
  assert.deepEqual(metadata, { width: image.width, height: image.height });
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { ...metadata, pixels: context.getImageData(0, 0, image.width, image.height).data };
}

it("preserves every scan pixel and its native resolution, independent of PDF point size", async () => {
  for (const page of [1, 2]) {
    const result = await render(page);
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.deepEqual(result.pixels, sourcePixels);
  }
});

it("keeps cropped, rotated, mirrored and translucent pages on the full PDF rendering path", async () => {
  const rotated = await render(3);
  assert.equal(rotated.width, 2400);
  assert.equal(rotated.height, 1600);
  const cropped = await render(4);
  assert.equal(cropped.width, Math.floor(2400 * (width - 8) / height));
  assert.equal(cropped.height, 2400);
  for (const page of [6, 7]) {
    const result = await render(page);
    assert.equal(result.width, 1600);
    assert.equal(result.height, 2400);
  }
});

it("retains vector content drawn over a scan", async () => {
  const result = await render(5);
  assert.equal(result.width, 1600);
  assert.equal(result.height, 2400);
  const offset = ((result.height - 10) * result.width + 10) * 4;
  assert.deepEqual(Array.from(result.pixels.subarray(offset, offset + 4)), [0, 255, 0, 255]);
});

it("renders soft masks through the full PDF path against the same white background", async () => {
  const result = await render(8);
  assert.equal(result.width, 1600);
  assert.equal(result.height, 2400);
  for (const sourceY of [10, 100, 200]) {
    const sourceOffset = (sourceY * width + 10) * 4;
    const targetOffset: number = (Math.floor(sourceY * result.height / height) * result.width + 10) * 4;
    assert.deepEqual(result.pixels.subarray(targetOffset, targetOffset + 4), transparentPixels.subarray(sourceOffset, sourceOffset + 4));
  }
});

it("retains the renderer dimension and pixel limits for oversized scans", async () => {
  const result = await render(9);
  assert.equal(result.width, 2400);
  assert.equal(result.height, 96);
  assert.ok(result.width * result.height <= 6_000_000);
});
