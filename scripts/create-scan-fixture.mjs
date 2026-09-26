// Original high-resolution raster fixture, used only for range and reader tests.
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";

const output = process.argv[2] || "/tmp/comic-shelf-scan-test.pdf";
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.HelveticaBold);
const canvas = createCanvas(1400, 1960);
const ctx = canvas.getContext("2d");
const images = [];
let seed = 312;
for (let n = 0; n < 3; n++) {
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const shade = 150 + seed % 106;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = shade;
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  ctx.strokeStyle = "#22382c";
  ctx.lineWidth = 12;
  for (let j = 0; j < 3; j++) ctx.strokeRect(75, 120 + j * 585, 1250, 535);
  images.push(await pdf.embedJpg(canvas.toBuffer("image/jpeg", 75)));
}
for (let i = 1; i <= 24; i++) {
  const page = pdf.addPage(i === 4 ? [840, 600] : [600, 840]);
  page.drawImage(images[i % images.length], { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  page.drawRectangle({ x: 35, y: 30, width: 265, height: 35, color: rgb(1, 1, .97) });
  page.drawText(`SCAN TEST / PAGE ${i}`, { x: 47, y: 40, size: 16, font, color: rgb(.1, .2, .15) });
}
await writeFile(output, await pdf.save());
console.log(output);
